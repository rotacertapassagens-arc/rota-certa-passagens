import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { audit, enforceRateLimit, requireAuth, requireMutationAuth } from '../auth.js';
import { hashPassword, isUniqueViolation, isValidCurrency, normalizeEmail, randomEmailCode, safeEqualText, tokenDigest } from '../security.js';
import { calculateProgramCommission, lisbonMonthStartUtc } from '../../shared/partnerCommission.js';
import { getPartnerProgramPolicy } from './partners.js';

/**
 * Thrown from inside a db.transaction() callback to abort with ROLLBACK while still producing
 * a precise, non-500 HTTP response. Caught once around the transaction call at the top of the
 * route handler; anything else propagates to Fastify's generic error handler as a 500.
 */
class RequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

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
    const leads = await db.query<{ id: string } & Record<string, unknown>>(
      `SELECT l.id,l.protocol,l.customer_name,l.customer_email,l.customer_phone,l.origin,l.destination,
              l.outbound_on,l.return_on,l.adults,l.children,l.infants,l.trip_type,l.cabin_class,l.baggage,
              l.date_flexibility,l.payment_preference,l.notes,l.internal_notes,l.status,l.deadline_at,
              l.created_at,l.updated_at,l.assigned_to,p.display_name AS assigned_name,
              l.partner_id,l.referral_code_snapshot,l.referral_source,l.sale_amount_cents,l.sale_currency,l.converted_at,
              partner.code AS partner_code,partner.display_name AS partner_display_name
         FROM lead_requests l
         LEFT JOIN profiles p ON p.user_id=l.assigned_to
         LEFT JOIN partners partner ON partner.id=l.partner_id
        WHERE l.kind='flight_quote' AND ($1::text IS NULL OR l.status=$1) AND ($2::uuid IS NULL OR l.partner_id=$2)
        ORDER BY CASE WHEN l.status IN ('new','reviewing','awaiting_customer','ready') THEN 0 ELSE 1 END,
                 l.deadline_at ASC NULLS LAST,l.created_at DESC LIMIT 200`,
      [query.data.status ?? null, query.data.partnerId ?? null],
    );
    // A lead can now have more than one *historical* commission row (converted -> voided ->
    // reconverted), so this listing must attach exactly one "current" commission per lead
    // without duplicating the lead row. Fetched separately (rather than via a correlated
    // subquery in the JOIN, which the pg-mem test harness cannot parse) and merged here in a
    // fully deterministic order: the SQL ORDER BY guarantees the first row seen per
    // lead_request_id is always the active (non-void) one if any exists, otherwise the most
    // recently voided one — so building a Map from it is safe and documented, unlike relying on
    // an unspecified row order.
    const leadIdSet = new Set(leads.rows.map((row) => row.id));
    const commissionByLead = new Map<string, { id: string; status: string; amount_cents: number; currency: string }>();
    if (leadIdSet.size) {
      // Filtered in application code against leadIdSet (rather than
      // `lead_request_id = ANY($1)`) for the same portability reason as the partner ledger
      // query: not every SQL engine this repo tests against infers a bind array's element type
      // the same way real Postgres does. Bounded to a generous cap since this backs a 200-row
      // admin listing, not an unbounded export.
      const commissions = await db.query<{ id: string; lead_request_id: string; status: string; amount_cents: number; currency: string }>(
        `SELECT pc.id,pc.lead_request_id,pc.status,pc.amount_cents,pc.currency FROM partner_commissions pc
           JOIN lead_requests l ON l.id=pc.lead_request_id
          WHERE l.kind='flight_quote' ORDER BY (pc.status='void') ASC, pc.created_at DESC LIMIT 2000`,
      );
      for (const row of commissions.rows) {
        if (leadIdSet.has(row.lead_request_id) && !commissionByLead.has(row.lead_request_id)) commissionByLead.set(row.lead_request_id, row);
      }
    }
    return reply.send({
      leads: leads.rows.map((row) => {
        const commission = commissionByLead.get(row.id);
        return { ...row, commission_id: commission?.id ?? null, commission_status: commission?.status ?? null, commission_amount_cents: commission?.amount_cents ?? null, commission_currency: commission?.currency ?? null };
      }),
    });
  });

  app.patch('/api/admin/leads/:id', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth || !auth.roles.includes('master')) return auth ? reply.code(403).send({ error: 'forbidden' }) : undefined;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = leadUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const existing = await db.query<{ id: string; status: string; partner_id: string | null; protocol: string; destination: string | null; sale_amount_cents: number | null; sale_currency: string | null }>(
      "SELECT id,status,partner_id,protocol,destination,sale_amount_cents,sale_currency FROM lead_requests WHERE id=$1 AND kind='flight_quote'",
      [params.data.id],
    );
    const lead = existing.rows[0];
    if (!lead) return reply.code(404).send({ error: 'not_found' });

    if (parsed.data.saleCurrency !== undefined && !isValidCurrency(parsed.data.saleCurrency)) {
      return reply.code(422).send({ error: 'invalid_currency' });
    }

    // Everything below — voiding an active commission, creating/reconverting a commission,
    // updating the proposal row itself, the audit trail entry, and the outbox event — happens
    // inside a single database transaction. A failure partway through never leaves a converted
    // proposal without its expected commission, nor a commission without its proposal update.
    let commissionPreview: { amountCents: number; currency: string } | null = null;
    let updatedRow: Record<string, unknown> | undefined;
    try {
      await db.transaction(async (tx) => {
        if (lead.status === 'converted' && parsed.data.status !== 'converted') {
          // A paid commission is a settled financial fact: it can never be silently unwound by
          // moving the proposal away from "converted", with or without a void reason. A real
          // adjustment/refund flow (not built in this pass) is required first.
          const paid = await tx.query('SELECT id FROM partner_commissions WHERE lead_request_id=$1 AND status=\'paid\'', [lead.id]);
          if (paid.rowCount) throw new RequestError(409, 'commission_paid_immutable');

          // A still-active (pending/approved) commission requires an explicit, audited void
          // reason before the proposal can leave "converted".
          const active = await tx.query('SELECT id FROM partner_commissions WHERE lead_request_id=$1 AND status IN (\'pending\',\'approved\')', [lead.id]);
          if (active.rowCount) {
            if (!parsed.data.voidCommissionReason) throw new RequestError(409, 'commission_void_reason_required');
            await tx.query(
              "UPDATE partner_commissions SET status='void',voided_at=now(),voided_by=$1,void_reason=$2,updated_at=now() WHERE lead_request_id=$3 AND status IN ('pending','approved')",
              [auth.userId, parsed.data.voidCommissionReason, lead.id],
            );
            await audit(tx, config, request, 'admin.commission_voided', auth.userId, 'lead_request', lead.id, { reason: parsed.data.voidCommissionReason });
          }
        }

        let finalSaleAmountCents = lead.sale_amount_cents;
        let finalSaleCurrency = lead.sale_currency;
        if (parsed.data.status === 'converted' && lead.partner_id) {
          commissionPreview = await createCommissionForLead(
            tx, config, request, auth.userId, lead.id, lead.partner_id,
            parsed.data.saleAmountCents, parsed.data.saleCurrency,
            lead.sale_amount_cents, lead.sale_currency,
          );
          // A repeated/idempotent conversion call that omits saleAmountCents/saleCurrency must
          // never null out financial data that already exists on the proposal.
          finalSaleAmountCents = parsed.data.saleAmountCents ?? lead.sale_amount_cents;
          finalSaleCurrency = (parsed.data.saleCurrency ?? lead.sale_currency ?? undefined)?.toUpperCase() ?? null;
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
           finalSaleAmountCents, finalSaleCurrency],
        );
        updatedRow = updated.rows[0];
        await audit(tx, config, request, 'admin.lead_updated', auth.userId, 'lead_request', params.data.id, { status: parsed.data.status });

        if (parsed.data.status === 'converted' && lead.partner_id) {
          await tx.query(
            `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload)
             VALUES ($1,$2,'proposal_converted',$3,$4::jsonb) ON CONFLICT (idempotency_key) DO NOTHING`,
            [randomUUID(), `proposal_converted:${lead.id}`, lead.partner_id, JSON.stringify({ leadId: lead.id, protocol: lead.protocol })],
          );
        }
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    if (!updatedRow) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ lead: updatedRow, commissionPreview });
  });
}

/**
 * Creates, reuses, or reconverts the commission for a converted proposal.
 *
 * - At most one *active* (non-void) commission exists per lead, enforced by the partial unique
 *   index `partner_commissions_active_unique_idx` (WHERE status <> 'void'), not an absolute
 *   uniqueness constraint. That lets convert -> void -> reconvert create real history instead of
 *   silently returning the voided row.
 * - A repeat call while an active commission already exists is idempotent: it returns that same
 *   commission and never creates a duplicate. If the caller tries to change the sale amount or
 *   currency on that repeat call, it is rejected (409) rather than silently reinterpreting
 *   financial data that was already used to compute a live commission — an explicit void +
 *   reconvert is required for that.
 * - Percentage commissions require a valid sale amount in the partner's own configured currency
 *   (never a client-chosen one), so aggregate totals are always in a single currency per partner.
 * - Fixed commissions are computed from the partner's rule snapshot at conversion time so later
 *   rule edits never change commissions that were already created.
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
  currentSaleAmountCents: number | null,
  currentSaleCurrency: string | null,
) {
  const active = await db.query<{ id: string; amount_cents: number; currency: string }>(
    "SELECT id,amount_cents,currency FROM partner_commissions WHERE lead_request_id=$1 AND status<>'void'",
    [leadId],
  );
  const activeRow = active.rows[0];
  if (activeRow) {
    const amountChanged = saleAmountCents !== undefined && saleAmountCents !== currentSaleAmountCents;
    const currencyChanged = saleCurrency !== undefined && saleCurrency.toUpperCase() !== currentSaleCurrency;
    if (amountChanged || currencyChanged) throw new RequestError(409, 'sale_amount_locked');
    return { amountCents: activeRow.amount_cents, currency: activeRow.currency };
  }

  const partner = await db.query<{ currency: string }>(
    'SELECT currency FROM partners WHERE id=$1',
    [partnerId],
  );
  const rule = partner.rows[0];
  if (!rule) return null;

  const effectiveAmount = saleAmountCents ?? currentSaleAmountCents ?? undefined;
  const effectiveCurrency = (saleCurrency ?? currentSaleCurrency ?? undefined)?.toUpperCase();
  if (effectiveAmount === undefined || !effectiveCurrency) throw new RequestError(422, 'sale_amount_required');
  if (!isValidCurrency(effectiveCurrency)) throw new RequestError(422, 'invalid_currency');
  if (effectiveCurrency !== rule.currency) throw new RequestError(409, 'sale_currency_must_match_partner_currency');
  const leadPassengers = await db.query<{ count: number }>(
    'SELECT (adults+children+infants)::int AS count FROM lead_requests WHERE id=$1', [leadId],
  );
  const passengerCount = leadPassengers.rows[0]?.count ?? 0;
  if (passengerCount < 1) throw new RequestError(422, 'invalid_passenger_count');
  const monthStart = lisbonMonthStartUtc(new Date()).toISOString();
  const monthPassengers = await db.query<{ count: number }>(
    `SELECT COALESCE(sum(l.adults+l.children+l.infants),0)::int AS count
       FROM partner_commissions pc JOIN lead_requests l ON l.id=pc.lead_request_id
      WHERE pc.partner_id=$1 AND pc.status<>'void' AND pc.created_at>=$2`,
    [partnerId, monthStart],
  );
  const alreadyClosedPassengers = monthPassengers.rows[0]?.count ?? 0;
  const policy = await getPartnerProgramPolicy(db);
  const calculated = calculateProgramCommission(effectiveAmount, passengerCount, alreadyClosedPassengers, policy);
  const amountCents = calculated.amountCents;
  const currency = effectiveCurrency;
  const rateSnapshot = calculated.effectiveRateBps;
  const effectiveSaleAmountCents = effectiveAmount;

  const id = randomUUID();
  // No ON CONFLICT clause: the arbiter here is a *partial* unique index
  // (partner_commissions_active_unique_idx, WHERE status<>'void'), and Postgres requires the
  // ON CONFLICT target's own WHERE clause to exactly match a partial index's predicate to use it
  // as an inference target — supported by real Postgres, but not by pg-mem (this repo's test
  // harness), which cannot parse `ON CONFLICT (...) WHERE ... DO NOTHING`. A plain try/insert
  // and catching the resulting unique-violation is equally correct and portable across both.
  let insertedRow: { amount_cents: number; currency: string } | undefined;
  try {
    const inserted = await db.query<{ amount_cents: number; currency: string }>(
      `INSERT INTO partner_commissions
        (id,partner_id,lead_request_id,amount_cents,currency,status,commission_type_snapshot,commission_rate_snapshot,sale_amount_cents_snapshot,created_by,commission_policy_snapshot,passenger_count_snapshot,month_passenger_start_snapshot)
       VALUES ($1,$2,$3,$4,$5,'pending','percentage',$6,$7,$8,$9::jsonb,$10,$11)
       RETURNING amount_cents,currency`,
      [id, partnerId, leadId, amountCents, currency, rateSnapshot, effectiveSaleAmountCents, actorUserId,
       JSON.stringify(policy), passengerCount, calculated.startPosition],
    );
    insertedRow = inserted.rows[0];
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost a race against a concurrent conversion request: fall back to whatever the winner
    // created rather than creating (or reporting) a second active commission.
  }
  if (!insertedRow) {
    const raceExisting = await db.query<{ amount_cents: number; currency: string }>(
      "SELECT amount_cents,currency FROM partner_commissions WHERE lead_request_id=$1 AND status<>'void'",
      [leadId],
    );
    const row = raceExisting.rows[0];
    return row ? { amountCents: row.amount_cents, currency: row.currency } : null;
  }
  await audit(db, config, request, 'admin.commission_created', actorUserId, 'partner_commission', id, { amountCents, currency });
  return { amountCents: insertedRow.amount_cents, currency: insertedRow.currency };
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
