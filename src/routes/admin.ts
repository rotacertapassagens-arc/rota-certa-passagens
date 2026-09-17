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
const leadUpdateSchema = z.object({ status: leadStatusSchema, internalNotes: z.string().trim().max(3000).optional(), assignToMe: z.boolean().optional() });

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
    const query = z.object({ status: leadStatusSchema.optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const leads = await db.query(
      `SELECT l.id,l.protocol,l.customer_name,l.customer_email,l.customer_phone,l.origin,l.destination,
              l.outbound_on,l.return_on,l.adults,l.children,l.infants,l.trip_type,l.cabin_class,l.baggage,
              l.date_flexibility,l.payment_preference,l.notes,l.internal_notes,l.status,l.deadline_at,
              l.created_at,l.updated_at,l.assigned_to,p.display_name AS assigned_name
         FROM lead_requests l LEFT JOIN profiles p ON p.user_id=l.assigned_to
        WHERE l.kind='flight_quote' AND ($1::text IS NULL OR l.status=$1)
        ORDER BY CASE WHEN l.status IN ('new','reviewing','awaiting_customer','ready') THEN 0 ELSE 1 END,
                 l.deadline_at ASC NULLS LAST,l.created_at DESC LIMIT 200`,
      [query.data.status ?? null],
    );
    return reply.send({ leads: leads.rows });
  });

  app.patch('/api/admin/leads/:id', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth || !auth.roles.includes('master')) return auth ? reply.code(403).send({ error: 'forbidden' }) : undefined;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = leadUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const updated = await db.query(
      `UPDATE lead_requests SET status=$1,internal_notes=$2,
              assigned_to=CASE WHEN $3 THEN $4 ELSE assigned_to END,updated_at=now()
        WHERE id=$5 AND kind='flight_quote'
      RETURNING id,protocol,status,internal_notes,assigned_to,updated_at`,
      [parsed.data.status, parsed.data.internalNotes || null, parsed.data.assignToMe === true, auth.userId, params.data.id],
    );
    if (!updated.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'admin.lead_updated', auth.userId, 'lead_request', params.data.id);
    return reply.send({ lead: updated.rows[0] });
  });
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
