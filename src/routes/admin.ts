import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { audit, enforceRateLimit, requireAuth, requireMutationAuth } from '../auth.js';
import { hashPassword, normalizeEmail, randomEmailCode, safeEqualText, tokenDigest } from '../security.js';

const inviteSchema = z.object({ email: z.string().email().max(254), name: z.string().trim().min(2).max(120) });
const acceptSchema = z.object({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/), password: z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/) });
const leadStatusSchema = z.enum(['new', 'reviewing', 'awaiting_customer', 'ready', 'sent', 'converted', 'lost', 'canceled', 'closed']);
const leadUpdateSchema = z.object({
  status: leadStatusSchema,
  internalNotes: z.string().trim().max(3000).optional(),
  assignToMe: z.boolean().optional(),
  saleAmountCents: z.number().int().min(0).max(100_000_000).optional(),
  saleCurrency: z.string().length(3).optional(),
  voidCommissionReason: z.string().trim().min(3).max(500).optional(),
});

export function registerAdminRoutes(app: FastifyInstance, db: Database, config: AppConfig, emailSender: EmailSender) {
  app.post('/api/admin/bootstrap/master-invites', async (request, reply) => {
    const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (!config.MASTER_BOOTSTRAP_TOKEN || !safeEqualText(provided, config.MASTER_BOOTSTRAP_TOKEN)) return reply.code(404).send({ error: 'not_found' });
    const existing = await db.query("SELECT 1 FROM user_roles WHERE role='master' LIMIT 1");
    if (existing.rowCount) return reply.code(409).send({ error: 'master_already_exists' });
    return createMasterInvite(db, config, emailSender, request, reply, null);
  });

  app.post('/api/admin/master-invites', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth || !auth.roles.includes('master')) return auth ? reply.code(403).send({ error: 'forbidden' }) : undefined;
    return createMasterInvite(db, config, emailSender, request, reply, auth.userId);
  });

  app.post('/api/admin/master-invites/accept', async (request, reply) => {
    const parsed = acceptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_or_expired_invite' });
    const email = normalizeEmail(parsed.data.email);
    if (!(await enforceRateLimit(db, config, request, 'master_invite_accept', email, 8, 15 * 60))) return reply.code(429).send({ error: 'too_many_attempts' });
    const tokens = await db.query<{ id: string; user_id: string }>(
      `SELECT t.id,t.user_id FROM account_tokens t JOIN users u ON u.id=t.user_id
        WHERE u.email=$1 AND t.token_hash=$2 AND t.purpose='master_invite'
          AND t.used_at IS NULL AND t.expires_at > now() AND t.failed_attempts < 5 LIMIT 1`,
      [email, tokenDigest(parsed.data.code, config.TOKEN_PEPPER)],
    );
    const token = tokens.rows[0];
    if (!token) {
      await db.query(
        `UPDATE account_tokens SET failed_attempts=failed_attempts+1 WHERE id=(
          SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id
           WHERE u.email=$1 AND t.purpose='master_invite' AND t.used_at IS NULL AND t.expires_at>now()
           ORDER BY t.created_at DESC LIMIT 1)`,
        [email],
      );
      return reply.code(400).send({ error: 'invalid_or_expired_invite' });
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const tripId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query("UPDATE users SET password_hash=$1,status='active',email_verified_at=now(),updated_at=now() WHERE id=$2", [passwordHash, token.user_id]);
      await tx.query("INSERT INTO user_roles (user_id,role) VALUES ($1,'master') ON CONFLICT DO NOTHING", [token.user_id]);
      await tx.query('UPDATE account_tokens SET used_at=now() WHERE id=$1', [token.id]);
      await tx.query("INSERT INTO trips (id,owner_user_id,name) SELECT $1,$2,'Minha viagem' WHERE NOT EXISTS(SELECT 1 FROM trips WHERE owner_user_id=$2)", [tripId, token.user_id]);
      await tx.query("INSERT INTO budgets (trip_id,owner_user_id,amount_cents,currency) SELECT id,owner_user_id,0,'EUR' FROM trips WHERE id=$1 ON CONFLICT DO NOTHING", [tripId]);
    });
    await audit(db, config, request, 'admin.master_invite_accepted', token.user_id, 'user', token.user_id);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/overview', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const counts = await db.query<{ users: number; active_access: number; pending_payments: number; paid_payments: number; new_leads: number; overdue_leads: number }>(
      `SELECT
        (SELECT count(*)::int FROM users WHERE status<>'deleted') AS users,
        (SELECT count(*)::int FROM users u WHERE u.status='active') AS active_access,
        (SELECT count(*)::int FROM payments WHERE status IN ('pending','processing')) AS pending_payments,
        (SELECT count(*)::int FROM payments WHERE status='paid') AS paid_payments,
        (SELECT count(*)::int FROM lead_requests WHERE kind='flight_quote' AND status='new') AS new_leads,
        (SELECT count(*)::int FROM lead_requests WHERE kind='flight_quote' AND deadline_at<now() AND status NOT IN ('sent','converted','lost','canceled','closed')) AS overdue_leads`,
    );
    return reply.send(counts.rows[0]);
  });

  app.get('/api/admin/users', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const users = await db.query<{ id: string } & Record<string, unknown>>(
      `SELECT u.id,u.email,p.display_name,u.status,u.email_verified_at,u.created_at,u.last_login_at
         FROM users u JOIN profiles p ON p.user_id=u.id
        ORDER BY u.created_at DESC LIMIT 200`,
    );
    const roles = await db.query<{ user_id: string; role: string }>('SELECT user_id,role FROM user_roles ORDER BY role');
    const rolesByUser = new Map<string, string[]>();
    for (const row of roles.rows) rolesByUser.set(row.user_id, [...(rolesByUser.get(row.user_id) ?? []), row.role]);
    return reply.send({ users: users.rows.map((user) => ({ ...user, roles: rolesByUser.get(user.id) ?? [] })) });
  });

  app.get('/api/admin/plans', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const plans = await db.query('SELECT id,code,name,price_cents,currency,duration_days,checkout_enabled,active FROM plans ORDER BY price_cents NULLS LAST');
    return reply.send({ plans: plans.rows });
  });

  app.get('/api/admin/payments', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const payments = await db.query(
      `SELECT p.id,p.amount_cents,p.currency,p.status,p.provider,p.created_at,u.email,pl.code AS plan_code
         FROM payments p JOIN users u ON u.id=p.user_id LEFT JOIN plans pl ON pl.id=p.plan_id
        ORDER BY p.created_at DESC LIMIT 200`,
    );
    return reply.send({ payments: payments.rows });
  });

  app.get('/api/admin/leads', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const query = z.object({ status: leadStatusSchema.optional(), partnerId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const leads = await db.query(
      `SELECT l.id,l.protocol,l.customer_name,l.customer_email,l.customer_phone,l.origin,l.destination,
              l.outbound_on,l.return_on,l.adults,l.children,l.infants,l.trip_type,l.cabin_class,l.baggage,
              l.date_flexibility,l.payment_preference,l.notes,l.internal_notes,l.status,l.deadline_at,
              l.created_at,l.updated_at,l.assigned_to,p.display_name AS assigned_name,
              l.partner_id,l.referral_code_snapshot,l.referral_source,l.sale_amount_cents,l.sale_currency,l.converted_at,
              partner.code AS partner_code,partner.display_name AS partner_display_name,
              pc.id AS commission_id,pc.status AS commission_status,pc.amount_cents AS commission_amount_cents,pc.currency AS commission_currency
         FROM lead_requests l
         LEFT JOIN profiles p ON p.user_id=l.assigned_to
         LEFT JOIN partners partner ON partner.id=l.partner_id
         LEFT JOIN partner_commissions pc ON pc.lead_request_id=l.id
        WHERE l.kind='flight_quote' AND ($1::text IS NULL OR l.status=$1) AND ($2::uuid IS NULL OR l.partner_id=$2)
        ORDER BY CASE WHEN l.status IN ('new','reviewing','awaiting_customer','ready') THEN 0 ELSE 1 END,
                 l.deadline_at ASC NULLS LAST,l.created_at DESC LIMIT 200`,
      [query.data.status ?? null, query.data.partnerId ?? null],
    );
    return reply.send({ leads: leads.rows });
  });

  app.patch('/api/admin/leads/:id', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth || !auth.roles.includes('master')) return auth ? reply.code(403).send({ error: 'forbidden' }) : undefined;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = leadUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const existing = await db.query<{ id: string; status: string; partner_id: string | null; protocol: string; destination: string | null }>(
      "SELECT id,status,partner_id,protocol,destination FROM lead_requests WHERE id=$1 AND kind='flight_quote'",
      [params.data.id],
    );
    const lead = existing.rows[0];
    if (!lead) return reply.code(404).send({ error: 'not_found' });

    // Moving a proposal away from "converted" never silently drops commission history: an
    // active (pending/approved) commission requires an explicit, audited void reason first.
    if (lead.status === 'converted' && parsed.data.status !== 'converted') {
      const active = await db.query('SELECT id FROM partner_commissions WHERE lead_request_id=$1 AND status IN (\'pending\',\'approved\')', [lead.id]);
      if (active.rowCount) {
        if (!parsed.data.voidCommissionReason) return reply.code(409).send({ error: 'commission_void_reason_required' });
        await db.query(
          "UPDATE partner_commissions SET status='void',voided_at=now(),voided_by=$1,void_reason=$2,updated_at=now() WHERE lead_request_id=$3 AND status IN ('pending','approved')",
          [auth.userId, parsed.data.voidCommissionReason, lead.id],
        );
        await audit(db, config, request, 'admin.commission_voided', auth.userId, 'lead_request', lead.id, { reason: parsed.data.voidCommissionReason });
      }
    }

    let commissionPreview: { amountCents: number; currency: string } | null = null;
    let updatedRow: Record<string, unknown> | undefined;
    await db.transaction(async (tx) => {
      if (parsed.data.status === 'converted' && lead.partner_id) {
        commissionPreview = await createCommissionForLead(tx, config, request, auth.userId, lead.id, lead.partner_id, parsed.data.saleAmountCents, parsed.data.saleCurrency);
      }
      const updated = await tx.query(
        `UPDATE lead_requests SET status=$1,internal_notes=$2,
                assigned_to=CASE WHEN $3 THEN $4 ELSE assigned_to END,
                sale_amount_cents=CASE WHEN $1='converted' THEN $6 ELSE sale_amount_cents END,
                sale_currency=CASE WHEN $1='converted' THEN $7 ELSE sale_currency END,
                converted_at=CASE WHEN $1='converted' THEN COALESCE(converted_at,now()) ELSE converted_at END,
                updated_at=now()
          WHERE id=$5 AND kind='flight_quote'
        RETURNING id,protocol,status,internal_notes,assigned_to,updated_at`,
        [parsed.data.status, parsed.data.internalNotes || null, parsed.data.assignToMe === true, auth.userId, params.data.id,
         parsed.data.saleAmountCents ?? null, parsed.data.saleCurrency?.toUpperCase() ?? null],
      );
      updatedRow = updated.rows[0];
    });
    if (!updatedRow) return reply.code(404).send({ error: 'not_found' });
    const updated = { rows: [updatedRow], rowCount: 1 };
    await audit(db, config, request, 'admin.lead_updated', auth.userId, 'lead_request', params.data.id, { status: parsed.data.status });

    if (parsed.data.status === 'converted' && lead.partner_id) {
      await db.query(
        `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload)
         VALUES ($1,$2,'proposal_converted',$3,$4::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
        [randomUUID(), `proposal_converted:${lead.id}`, lead.partner_id, JSON.stringify({ leadId: lead.id, protocol: lead.protocol })],
      );
    }
    return reply.send({ lead: updated.rows[0], commissionPreview });
  });
}

/**
 * Creates (or returns) the commission for a converted proposal. Idempotent via the unique
 * constraint on lead_request_id: a repeated conversion request never creates a second
 * commission row. Percentage commissions require a valid sale amount; fixed commissions are
 * computed from the partner's rule snapshot at conversion time so later rule edits never
 * change commissions that were already created.
 */
async function createCommissionForLead(
  db: Database,
  config: AppConfig,
  request: FastifyRequest,
  actorUserId: string,
  leadId: string,
  partnerId: string,
  saleAmountCents: number | undefined,
  saleCurrency: string | undefined,
) {
  const existing = await db.query<{ amount_cents: number; currency: string }>('SELECT amount_cents,currency FROM partner_commissions WHERE lead_request_id=$1', [leadId]);
  if (existing.rows[0]) return { amountCents: existing.rows[0].amount_cents, currency: existing.rows[0].currency };

  const partner = await db.query<{ commission_type: 'fixed' | 'percentage'; commission_fixed_cents: number | null; commission_percentage_bps: number | null; currency: string }>(
    'SELECT commission_type,commission_fixed_cents,commission_percentage_bps,currency FROM partners WHERE id=$1',
    [partnerId],
  );
  const rule = partner.rows[0];
  if (!rule) return null;

  let amountCents: number;
  let currency: string;
  let rateSnapshot: number;
  if (rule.commission_type === 'percentage') {
    if (saleAmountCents === undefined || !saleCurrency) throw Object.assign(new Error('sale_amount_required'), { statusCode: 422 });
    amountCents = Math.round((saleAmountCents * (rule.commission_percentage_bps ?? 0)) / 10_000);
    currency = saleCurrency.toUpperCase();
    rateSnapshot = rule.commission_percentage_bps ?? 0;
  } else {
    amountCents = rule.commission_fixed_cents ?? 0;
    currency = rule.currency;
    rateSnapshot = rule.commission_fixed_cents ?? 0;
  }

  const id = randomUUID();
  const inserted = await db.query<{ amount_cents: number; currency: string }>(
    `INSERT INTO partner_commissions
      (id,partner_id,lead_request_id,amount_cents,currency,status,commission_type_snapshot,commission_rate_snapshot,sale_amount_cents_snapshot,created_by)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)
     ON CONFLICT (lead_request_id) DO NOTHING
     RETURNING amount_cents,currency`,
    [id, partnerId, leadId, amountCents, currency, rule.commission_type, rateSnapshot, saleAmountCents ?? null, actorUserId],
  );
  if (!inserted.rows[0]) {
    const raceExisting = await db.query<{ amount_cents: number; currency: string }>('SELECT amount_cents,currency FROM partner_commissions WHERE lead_request_id=$1', [leadId]);
    const row = raceExisting.rows[0];
    return row ? { amountCents: row.amount_cents, currency: row.currency } : null;
  }
  await audit(db, config, request, 'admin.commission_created', actorUserId, 'partner_commission', id, { amountCents, currency });
  return { amountCents: inserted.rows[0].amount_cents, currency: inserted.rows[0].currency };
}

async function requireMaster(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return auth;
}

async function createMasterInvite(db: Database, config: AppConfig, emailSender: EmailSender, request: FastifyRequest, reply: FastifyReply, actorUserId: string | null) {
  const parsed = inviteSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_invite' });
  const email = normalizeEmail(parsed.data.email);
  const code = randomEmailCode();
  let userId: string;
  await db.transaction(async (tx) => {
    const users = await tx.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [email]);
    userId = users.rows[0]?.id ?? randomUUID();
    if (!users.rowCount) {
      await tx.query('INSERT INTO users (id,email,status) VALUES ($1,$2,\'pending\')', [userId, email]);
      await tx.query('INSERT INTO profiles (user_id,display_name) VALUES ($1,$2)', [userId, parsed.data.name]);
    }
    await tx.query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='master_invite' AND used_at IS NULL", [userId]);
    await tx.query(
      `INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at)
       VALUES ($1,$2,'master_invite',$3,now()+interval '15 minutes')`,
      [randomUUID(), userId, tokenDigest(code, config.TOKEN_PEPPER)],
    );
  });
  await emailSender.send({ userId: userId!, to: email, template: 'master_invite', subject: 'Código de ativação master - Rota Certa Passagens', html: `<p>Seu código de ativação master é:</p><p><strong>${code}</strong></p><p>Digite-o em ${config.APP_ORIGIN}/master-invite.html. O código expira em 15 minutos, aceita no máximo cinco tentativas e só pode ser usado uma vez.</p>` });
  await audit(db, config, request, 'admin.master_invite_created', actorUserId, 'user', userId!);
  return reply.code(201).send({ ok: true });
}
