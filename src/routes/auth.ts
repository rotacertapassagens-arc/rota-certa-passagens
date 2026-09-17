import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import type { EmailSender } from '../email.js';
import { audit, createSession, enforceRateLimit, getAuth, requireMutationAuth, sessionCookieName } from '../auth.js';
import { hashPassword, normalizeEmail, randomEmailCode, randomToken, tokenDigest, verifyPassword } from '../security.js';

const passwordSchema = z.string().min(12).max(128).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/);
const signupSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  password: passwordSchema,
  termsAccepted: z.literal(true),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });
const verifySchema = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) });
const resetRequestSchema = z.object({ email: z.string().email() });
const resetConfirmSchema = z.object({ token: z.string().min(32).max(200), password: passwordSchema });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  status: string;
  email_verified_at: Date | null;
}

export function registerAuthRoutes(app: FastifyInstance, db: Database, config: AppConfig, emailSender: EmailSender) {
  app.post('/api/auth/signup', async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_signup' });
    const email = normalizeEmail(parsed.data.email);
    if (!(await enforceRateLimit(db, config, request, 'signup', email, 5, 15 * 60))) {
      return reply.code(429).send({ error: 'try_again_later' });
    }
    const existing = await db.query<UserRow>('SELECT id,email,password_hash,status,email_verified_at FROM users WHERE email=$1', [email]);
    let user = existing.rows[0];
    if (!user) {
      const userId = randomUUID();
      const passwordHash = await hashPassword(parsed.data.password);
      await db.transaction(async (tx) => {
        await tx.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,$3)', [userId, email, passwordHash]);
        await tx.query('INSERT INTO profiles (user_id,display_name) VALUES ($1,$2)', [userId, parsed.data.name]);
        await tx.query("INSERT INTO user_roles (user_id,role) VALUES ($1,'customer')", [userId]);
      });
      user = { id: userId, email, password_hash: passwordHash, status: 'pending', email_verified_at: null };
      await audit(db, config, request, 'auth.signup_created', userId, 'user', userId);
    }
    if (!user.email_verified_at && user.status === 'pending') {
      const code = randomEmailCode();
      await db.transaction(async (tx) => {
        await tx.query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='email_verification' AND used_at IS NULL", [user!.id]);
        await tx.query(
          `INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at)
           VALUES ($1,$2,'email_verification',$3,now()+interval '10 minutes')`,
          [randomUUID(), user!.id, tokenDigest(code, config.TOKEN_PEPPER)],
        );
      });
      await emailSender.send({
        userId: user.id,
        to: email,
        template: 'verify_email',
        subject: 'Confirme seu e-mail - Rota Certa Passagens',
        html: `<p>Seu código de confirmação é <strong>${code}</strong>.</p><p>Ele expira em 10 minutos e só pode ser usado uma vez.</p>`,
      });
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/auth/verify-email', async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_code' });
    const email = normalizeEmail(parsed.data.email);
    if (!(await enforceRateLimit(db, config, request, 'verify-email', email, 6, 10 * 60))) {
      return reply.code(429).send({ error: 'try_again_later' });
    }
    const users = await db.query<UserRow>('SELECT id,email,password_hash,status,email_verified_at FROM users WHERE email=$1', [email]);
    const user = users.rows[0];
    if (!user) return reply.code(400).send({ error: 'invalid_or_expired_code' });
    const tokens = await db.query<{ id: string; token_hash: string; failed_attempts: number }>(
      `SELECT id,token_hash,failed_attempts FROM account_tokens
        WHERE user_id=$1 AND purpose='email_verification' AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    const token = tokens.rows[0];
    if (!token || token.token_hash !== tokenDigest(parsed.data.code, config.TOKEN_PEPPER)) {
      if (token) {
        await db.query(
          'UPDATE account_tokens SET failed_attempts=failed_attempts+1, used_at=CASE WHEN failed_attempts+1>=5 THEN now() ELSE used_at END WHERE id=$1',
          [token.id],
        );
      }
      return reply.code(400).send({ error: 'invalid_or_expired_code' });
    }
    await db.transaction(async (tx) => {
      await tx.query('UPDATE account_tokens SET used_at=now() WHERE id=$1', [token.id]);
      await tx.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),status='active',updated_at=now() WHERE id=$1", [user.id]);
      const trial = await tx.query('SELECT 1 FROM subscriptions WHERE user_id=$1 LIMIT 1', [user.id]);
      if (!trial.rowCount) {
        await tx.query(
          `INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,provider)
           VALUES ($1,$2,'00000000-0000-4000-8000-000000000001','trialing',now(),now()+interval '10 days','internal')`,
          [randomUUID(), user.id],
        );
      }
      const trip = await tx.query<{ id: string }>('SELECT id FROM trips WHERE owner_user_id=$1 LIMIT 1', [user.id]);
      if (!trip.rowCount) await createStarterTrip(tx, user.id);
    });
    const csrfToken = await createSession(db, config, request, reply, user.id);
    await audit(db, config, request, 'auth.email_verified', user.id, 'user', user.id);
    return reply.send({ ok: true, csrfToken });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credentials' });
    const email = normalizeEmail(parsed.data.email);
    if (!(await enforceRateLimit(db, config, request, 'login', email, 8, 15 * 60))) {
      return reply.code(429).send({ error: 'try_again_later' });
    }
    const users = await db.query<UserRow>('SELECT id,email,password_hash,status,email_verified_at FROM users WHERE email=$1', [email]);
    const user = users.rows[0];
    const valid = user?.password_hash ? await verifyPassword(parsed.data.password, user.password_hash) : await verifyPassword(parsed.data.password, await hashPassword('Missing-user-password-123'));
    if (!user || !valid || user.status !== 'active' || !user.email_verified_at) {
      await audit(db, config, request, 'auth.login_failed', user?.id ?? null);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const csrfToken = await createSession(db, config, request, reply, user.id);
    await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
    await audit(db, config, request, 'auth.login_succeeded', user.id, 'user', user.id);
    return reply.send({ ok: true, csrfToken });
  });

  app.get('/api/auth/session', async (request, reply) => {
    const auth = await getAuth(db, config, request);
    if (!auth) return reply.code(401).send({ authenticated: false });
    const access = await db.query<{ status: string; ends_at: Date }>(
      `SELECT status,ends_at FROM subscriptions
        WHERE user_id=$1 AND status IN ('trialing','active') AND ends_at > now()
        ORDER BY ends_at DESC LIMIT 1`,
      [auth.userId],
    );
    return reply.send({
      authenticated: true,
      user: { id: auth.userId, email: auth.email, name: auth.displayName, roles: auth.roles },
      access: access.rows[0] ?? null,
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth) return;
    await db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [auth.sessionId]);
    reply.clearCookie(sessionCookieName(config), { path: '/' });
    reply.clearCookie('rc_csrf', { path: '/' });
    await audit(db, config, request, 'auth.logout', auth.userId, 'session', auth.sessionId);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/password-reset/request', async (request, reply) => {
    const parsed = resetRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(202).send({ ok: true });
    const email = normalizeEmail(parsed.data.email);
    if (!(await enforceRateLimit(db, config, request, 'password-reset-request', email, 4, 30 * 60))) {
      return reply.code(202).send({ ok: true });
    }
    const users = await db.query<UserRow>("SELECT id,email,password_hash,status,email_verified_at FROM users WHERE email=$1 AND status='active'", [email]);
    const user = users.rows[0];
    if (user) {
      const rawToken = randomToken();
      await db.transaction(async (tx) => {
        await tx.query("UPDATE account_tokens SET used_at=now() WHERE user_id=$1 AND purpose='password_reset' AND used_at IS NULL", [user.id]);
        await tx.query(
          `INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at)
           VALUES ($1,$2,'password_reset',$3,now()+interval '45 minutes')`,
          [randomUUID(), user.id, tokenDigest(rawToken, config.TOKEN_PEPPER)],
        );
      });
      const link = `${config.APP_ORIGIN}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
      await emailSender.send({ userId: user.id, to: email, template: 'password_reset', subject: 'Redefina sua senha - Rota Certa Passagens', html: `<p><a href="${link}">Redefinir senha</a></p><p>O link expira em 45 minutos e só pode ser usado uma vez.</p>` });
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/auth/password-reset/confirm', async (request, reply) => {
    const parsed = resetConfirmSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    if (!(await enforceRateLimit(db, config, request, 'password-reset-confirm', tokenDigest(parsed.data.token, config.TOKEN_PEPPER), 6, 30 * 60))) {
      return reply.code(429).send({ error: 'try_again_later' });
    }
    const tokens = await db.query<{ id: string; user_id: string }>(
      `SELECT id,user_id FROM account_tokens WHERE token_hash=$1 AND purpose='password_reset'
        AND used_at IS NULL AND expires_at > now() LIMIT 1`,
      [tokenDigest(parsed.data.token, config.TOKEN_PEPPER)],
    );
    const token = tokens.rows[0];
    if (!token) return reply.code(400).send({ error: 'invalid_or_expired_token' });
    const passwordHash = await hashPassword(parsed.data.password);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [passwordHash, token.user_id]);
      await tx.query('UPDATE account_tokens SET used_at=now() WHERE id=$1', [token.id]);
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [token.user_id]);
    });
    await audit(db, config, request, 'auth.password_reset', token.user_id, 'user', token.user_id);
    return reply.send({ ok: true });
  });

  app.post('/api/auth/change-password', async (request, reply) => {
    const auth = await requireMutationAuth(db, config, request, reply);
    if (!auth) return;
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_password' });
    const users = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [auth.userId]);
    const hash = users.rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(parsed.data.currentPassword, hash))) return reply.code(400).send({ error: 'invalid_password' });
    const newHash = await hashPassword(parsed.data.newPassword);
    await db.transaction(async (tx) => {
      await tx.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [newHash, auth.userId]);
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [auth.userId, auth.sessionId]);
    });
    await audit(db, config, request, 'auth.password_changed', auth.userId, 'user', auth.userId);
    return reply.send({ ok: true });
  });
}

async function createStarterTrip(db: Database, userId: string) {
  const tripId = randomUUID();
  await db.query("INSERT INTO trips (id,owner_user_id,name) VALUES ($1,$2,'Minha viagem')", [tripId, userId]);
  await db.query("INSERT INTO budgets (trip_id,owner_user_id,amount_cents,currency) VALUES ($1,$2,150000,'EUR')", [tripId, userId]);
  const items = ['Passaporte válido','Seguro viagem','Documentos de viagem','Check-in online','Bagagem despachada','Dinheiro / cartões','Adaptador de tomada','Medicamentos'];
  for (const [index, text] of items.entries()) {
    await db.query('INSERT INTO checklist_items (id,trip_id,owner_user_id,text,sort_order) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), tripId, userId, text, index]);
  }
}
