import { createHmac, randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PostgresDatabase, type Database } from '../src/db.js';
import { migrate } from '../src/cli/migrations.js';
import { buildApp } from '../src/app.js';
import { TestEmailSender } from '../src/email.js';
import type { AppConfig } from '../src/config.js';

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3000,
  APP_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgres://unused',
  TOKEN_PEPPER: 'test-token-pepper-with-more-than-32-characters',
  RATE_LIMIT_SECRET: 'test-rate-secret-with-more-than-32-characters',
  SESSION_TTL_HOURS: 24,
  COOKIE_SECURE: false,
  EMAIL_MODE: 'capture',
  EMAIL_FROM: 'Test <test@example.invalid>',
  PAYMENTS_MODE: 'disabled',
  STRIPE_WEBHOOK_SECRET: 'whsec_local_test_only',
  MASTER_BOOTSTRAP_TOKEN: 'bootstrap-token-long-enough-for-tests',
};

describe('Rota Certa public site API', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;

  beforeEach(async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
    memory.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'test' });
    memory.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length });
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();
    db = new PostgresDatabase(pool);
    await migrate(db);
    email = new TestEmailSender();
    app = await buildApp({ db, config, emailSender: email });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('registers, verifies, creates a revocable cookie session and persists planner data', async () => {
    const auth = await createVerifiedUser(app, email, 'ana@example.com', 'Ana Silva');
    expect(auth.cookie).toContain('rc_session=');
    expect(auth.csrf).toBeTruthy();

    const planner = await app.inject({ method: 'GET', url: '/api/planner', headers: { cookie: auth.cookie } });
    expect(planner.statusCode, planner.body).toBe(200);
    const tripId = planner.json().trip.id as string;

    const rejected = await app.inject({ method: 'POST', url: `/api/planner/${tripId}/itinerary`, headers: { cookie: auth.cookie, origin: config.APP_ORIGIN }, payload: { day: 1, title: 'Museu', kind: 'Atividade' } });
    expect(rejected.statusCode).toBe(403);

    const created = await app.inject({ method: 'POST', url: `/api/planner/${tripId}/itinerary`, headers: mutationHeaders(auth), payload: { day: 1, time: '10:30', title: 'Museu', kind: 'Atividade', notes: 'Ingresso antecipado' } });
    expect(created.statusCode).toBe(201);

    const refreshed = await app.inject({ method: 'GET', url: '/api/planner', headers: { cookie: auth.cookie } });
    expect(refreshed.json().itinerary).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Museu' })]));

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: mutationHeaders(auth) });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/planner', headers: { cookie: auth.cookie } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('isolates each customer planner by owner on every mutation', async () => {
    const first = await createVerifiedUser(app, email, 'first@example.com', 'Primeira Pessoa');
    const firstPlanner = await app.inject({ method: 'GET', url: '/api/planner', headers: { cookie: first.cookie } });
    const tripId = firstPlanner.json().trip.id as string;
    const item = await app.inject({ method: 'POST', url: `/api/planner/${tripId}/places`, headers: mutationHeaders(first), payload: { name: 'Torre de Belém', category: 'Atrações' } });
    const itemId = item.json().id as string;

    const second = await createVerifiedUser(app, email, 'second@example.com', 'Segunda Pessoa');
    const forbidden = await app.inject({ method: 'DELETE', url: `/api/planner/${tripId}/places/${itemId}`, headers: mutationHeaders(second) });
    expect(forbidden.statusCode).toBe(404);

    const stillThere = await app.inject({ method: 'GET', url: '/api/planner', headers: { cookie: first.cookie } });
    expect(stillThere.json().places).toEqual(expect.arrayContaining([expect.objectContaining({ id: itemId })]));
  });

  it('imports browser planner data into a separate trip without overwriting existing data', async () => {
    const auth = await createVerifiedUser(app, email, 'import@example.com', 'Importação Segura');
    const original = await app.inject({ method: 'GET', url: '/api/planner', headers: { cookie: auth.cookie } });
    const originalTrip = original.json().trip.id;
    const imported = await app.inject({
      method: 'POST', url: '/api/planner/import-local', headers: mutationHeaders(auth),
      payload: { budget: 2200, itinerary: [{ day: 1, time: '09:00', what: 'Passeio', type: 'Atividade', notes: '' }], places: [], expenses: [], checklist: [{ text: 'Passaporte', done: true }] },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().id).not.toBe(originalTrip);
    const trips = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM trips WHERE owner_user_id=(SELECT id FROM users WHERE email=$1)', ['import@example.com']);
    expect(trips.rows[0]?.count).toBe(2);
  });

  it('keeps password reset enumeration-safe and revokes existing sessions', async () => {
    const auth = await createVerifiedUser(app, email, 'reset@example.com', 'Reset Teste');
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: 'missing@example.com' } });
    const existing = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: 'reset@example.com' } });
    expect(unknown.statusCode).toBe(202);
    expect(existing.statusCode).toBe(202);
    expect(unknown.json()).toEqual(existing.json());
    const resetMessage = email.messages.findLast((message) => message.template === 'password_reset');
    const token = /token=([^"&]+)/.exec(resetMessage?.html ?? '')?.[1];
    expect(token).toBeTruthy();
    const changed = await app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token: decodeURIComponent(token!), password: 'NovaSenhaSegura123' } });
    expect(changed.statusCode).toBe(200);
    const revoked = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: auth.cookie } });
    expect(revoked.statusCode).toBe(401);
  });

  it('creates the first master only through a one-time expiring invite', async () => {
    const invite = await app.inject({
      method: 'POST', url: '/api/admin/bootstrap/master-invites',
      headers: { authorization: `Bearer ${config.MASTER_BOOTSTRAP_TOKEN}` },
      payload: { email: 'master@example.com', name: 'Pessoa Master' },
    });
    expect(invite.statusCode).toBe(201);
    const message = email.messages.findLast((item) => item.template === 'master_invite');
    const token = /token=([^"&]+)/.exec(message?.html ?? '')?.[1];
    const accepted = await app.inject({ method: 'POST', url: '/api/admin/master-invites/accept', payload: { token: decodeURIComponent(token!), password: 'MasterSegura123' } });
    expect(accepted.statusCode).toBe(200);
    const reused = await app.inject({ method: 'POST', url: '/api/admin/master-invites/accept', payload: { token: decodeURIComponent(token!), password: 'MasterSegura123' } });
    expect(reused.statusCode).toBe(400);
    const secondBootstrap = await app.inject({ method: 'POST', url: '/api/admin/bootstrap/master-invites', headers: { authorization: `Bearer ${config.MASTER_BOOTSTRAP_TOKEN}` }, payload: { email: 'other@example.com', name: 'Outra Pessoa' } });
    expect(secondBootstrap.statusCode).toBe(409);
  });

  it('does not create a checkout when sandbox credentials are absent', async () => {
    const auth = await createVerifiedUser(app, email, 'pay@example.com', 'Pagamento Teste');
    const response = await app.inject({ method: 'POST', url: '/api/payments/checkout', headers: mutationHeaders(auth), payload: { planCode: 'planner-30d' } });
    expect(response.statusCode).toBe(503);
    const payments = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM payments');
    expect(payments.rows[0]?.count).toBe(0);
  });

  it('activates sandbox access only from a signed idempotent webhook', async () => {
    await createVerifiedUser(app, email, 'webhook@example.com', 'Webhook Teste');
    const user = await db.query<{ id: string }>('SELECT id FROM users WHERE email=$1', ['webhook@example.com']);
    const plan = await db.query<{ id: string }>("SELECT id FROM plans WHERE code='planner-30d'");
    const paymentId = randomUUID();
    await db.query(
      "INSERT INTO payments (id,user_id,plan_id,amount_cents,currency,status,provider) VALUES ($1,$2,$3,999,'EUR','processing','stripe_sandbox')",
      [paymentId, user.rows[0]!.id, plan.rows[0]!.id],
    );
    const event = { id: 'evt_local_test', type: 'checkout.session.completed', data: { object: { payment_status: 'paid', metadata: { payment_id: paymentId } } } };
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', config.STRIPE_WEBHOOK_SECRET!).update(`${timestamp}.${body}`).digest('hex');
    const request = { method: 'POST' as const, url: '/api/payments/stripe-webhook', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` }, payload: body };
    const first = await app.inject(request);
    const repeated = await app.inject(request);
    expect(first.statusCode, first.body).toBe(200);
    expect(repeated.statusCode, repeated.body).toBe(200);
    const access = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM subscriptions WHERE user_id=$1 AND status='active' AND provider_reference=$2", [user.rows[0]!.id, paymentId]);
    expect(access.rows[0]?.count).toBe(1);
  });
});

async function createVerifiedUser(app: FastifyInstance, email: TestEmailSender, address: string, name: string) {
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { name, email: address, password: 'SenhaSegura123', termsAccepted: true } });
  expect(signup.statusCode).toBe(202);
  const message = email.messages.findLast((item) => item.template === 'verify_email' && item.to === address);
  const code = /<strong>(\d{6})<\/strong>/.exec(message?.html ?? '')?.[1];
  expect(code).toBeTruthy();
  const verified = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { email: address, code } });
  expect(verified.statusCode).toBe(200);
  const cookies = verified.cookies;
  const sessionCookie = cookies.find((item) => item.name === 'rc_session');
  const csrfCookie = cookies.find((item) => item.name === 'rc_csrf');
  return { cookie: `${sessionCookie!.name}=${sessionCookie!.value}; ${csrfCookie!.name}=${csrfCookie!.value}`, csrf: csrfCookie!.value };
}

function mutationHeaders(auth: { cookie: string; csrf: string }) {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: config.APP_ORIGIN };
}
