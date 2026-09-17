import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { hashPassword, normalizeEmail, randomToken, safeEqualText, tokenDigest } from '../security.js';

const inviteSchema = z.object({ email: z.string().email().max(254), name: z.string().trim().min(2).max(120) });
const acceptSchema = z.object({ token: z.string().min(32).max(200), password: z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/) });

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
    const tokens = await db.query<{ id: string; user_id: string }>(
      `SELECT id,user_id FROM account_tokens WHERE token_hash=$1 AND purpose='master_invite'
        AND used_at IS NULL AND expires_at > now() LIMIT 1`,
      [tokenDigest(parsed.data.token, config.TOKEN_PEPPER)],
    );
    const token = tokens.rows[0];
    if (!token) return reply.code(400).send({ error: 'invalid_or_expired_invite' });
    const passwordHash = await hashPassword(parsed.data.password);
    await db.transaction(async (tx) => {
      await tx.query("UPDATE users SET password_hash=$1,status='active',email_verified_at=now(),updated_at=now() WHERE id=$2", [passwordHash, token.user_id]);
      await tx.query("INSERT INTO user_roles (user_id,role) VALUES ($1,'master') ON CONFLICT DO NOTHING", [token.user_id]);
      await tx.query('UPDATE account_tokens SET used_at=now() WHERE id=$1', [token.id]);
    });
    await audit(db, config, request, 'admin.master_invite_accepted', token.user_id, 'user', token.user_id);
    return reply.send({ ok: true });
  });

  app.get('/api/admin/overview', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply);
    if (!auth) return;
    const counts = await db.query<{ users: number; active_access: number; pending_payments: number; paid_payments: number }>(
      `SELECT
        (SELECT count(*)::int FROM users WHERE status<>'deleted') AS users,
        (SELECT count(*)::int FROM subscriptions WHERE status IN ('trialing','active') AND ends_at>now()) AS active_access,
        (SELECT count(*)::int FROM payments WHERE status IN ('pending','processing')) AS pending_payments,
        (SELECT count(*)::int FROM payments WHERE status='paid') AS paid_payments`,
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
  const rawToken = randomToken();
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
       VALUES ($1,$2,'master_invite',$3,now()+interval '24 hours')`,
      [randomUUID(), userId, tokenDigest(rawToken, config.TOKEN_PEPPER)],
    );
  });
  const link = `${config.APP_ORIGIN}/master-invite.html?token=${encodeURIComponent(rawToken)}`;
  await emailSender.send({ userId: userId!, to: email, template: 'master_invite', subject: 'Convite master - Rota Certa Passagens', html: `<p><a href="${link}">Aceitar convite master</a></p><p>O link expira em 24 horas, é de uso único e confirma este e-mail.</p>` });
  await audit(db, config, request, 'admin.master_invite_created', actorUserId, 'user', userId!);
  return reply.code(201).send({ ok: true });
}
