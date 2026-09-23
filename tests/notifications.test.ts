import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PostgresDatabase, type Database } from '../src/db.js';
import { migrate } from '../src/cli/migrations.js';
import { buildApp } from '../src/app.js';
import { TestEmailSender, type EmailMessage, type EmailSender } from '../src/email.js';
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
  WHATSAPP_NOTIFICATIONS_ENABLED: false,
  NOTIFICATIONS_CRON_TOKEN: 'cron-token-long-enough-for-tests-000000',
};

/**
 * Fix #1 (weekly summary currency contract) + fix #3 (lease-loss / idempotency-key semantics).
 * pg-mem does not implement `FOR UPDATE SKIP LOCKED` (see src/db.ts's DatabaseCapabilities
 * comment and tests/outbox-claim.pg-real.test.ts), so this suite constructs its Database with
 * `supportsSkipLocked: false`, matching every other pg-mem-backed test file in this repo.
 */
describe('Notification outbox: payload contract and lease semantics', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;

  beforeEach(async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
    memory.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'test' });
    memory.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length });
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();
    db = new PostgresDatabase(pool, { supportsSkipLocked: false });
    await migrate(db);
    email = new TestEmailSender();
    app = await buildApp({ db, config, emailSender: email });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('renders the weekly summary commission in the partner\'s own currency for EUR and BRL partners', async () => {
    const master = await createMaster(app, email, 'master-weekly-currency@example.com');
    const eurPartnerId = await createPartner(app, master, { code: 'weekly-eur', displayName: 'Parceiro EUR', email: 'weekly-eur@example.com', commissionType: 'fixed', commissionFixedCents: 3000, currency: 'EUR' });
    const brlPartnerId = await createPartner(app, master, { code: 'weekly-brl', displayName: 'Parceiro BRL', email: 'weekly-brl@example.com', commissionType: 'fixed', commissionFixedCents: 4000, currency: 'BRL' });
    void eurPartnerId; void brlPartnerId;

    const eurLeadId = await submitAndGetLeadId(app, db, 'weekly-eur', 'weekly-eur-buyer@example.com');
    const brlLeadId = await submitAndGetLeadId(app, db, 'weekly-brl', 'weekly-brl-buyer@example.com');
    await app.inject({ method: 'PATCH', url: `/api/admin/leads/${eurLeadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });
    await app.inject({ method: 'PATCH', url: `/api/admin/leads/${brlLeadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });

    const weekly = await app.inject({ method: 'POST', url: '/api/admin/notifications/weekly-summary', headers: mutationHeaders(master) });
    expect(weekly.statusCode, weekly.body).toBe(200);
    expect(weekly.json().summariesCreated).toBe(2);

    // The payload actually written to the outbox must carry the partner's own currency —
    // never a hardcoded default — under the documented camelCase field names (see
    // shared/notificationPayloads.ts).
    const outboxRows = await db.query<{ partner_id: string; payload: unknown }>("SELECT partner_id,payload FROM notification_outbox WHERE event_type='weekly_summary'");
    for (const row of outboxRows.rows) {
      const payload = row.payload as Record<string, unknown>;
      expect(payload).toHaveProperty('commissionCents');
      expect(payload).toHaveProperty('currency');
      expect(payload).not.toHaveProperty('commission_cents');
    }

    const processed = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: mutationHeaders(master), payload: { limit: 50 } });
    expect(processed.statusCode, processed.body).toBe(200);

    const eurMessage = email.messages.find((m) => m.template === 'partner_weekly_summary' && m.to === 'weekly-eur@example.com');
    const brlMessage = email.messages.find((m) => m.template === 'partner_weekly_summary' && m.to === 'weekly-brl@example.com');
    expect(eurMessage?.html).toContain('30.00 EUR');
    expect(eurMessage?.html).not.toContain('BRL');
    expect(brlMessage?.html).toContain('40.00 BRL');
    expect(brlMessage?.html).not.toContain('30.00 EUR');
  });

  it('fails (and retries) a weekly_summary or commission_paid outbox row with a malformed payload instead of rendering a wrong amount', async () => {
    const master = await createMaster(app, email, 'master-malformed-payload@example.com');
    const partnerId = await createPartner(app, master, { code: 'malformed-payload', displayName: 'Parceiro Payload', email: 'malformed-payload@example.com', commissionType: 'fixed', commissionFixedCents: 1000, currency: 'EUR' });

    // A payload missing `currency` entirely (the exact bug class fix #1 addresses) must never be
    // silently rendered as "0.00 EUR" — it must fail closed and go through the normal retry path.
    await db.query(
      `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload) VALUES ($1,$2,'weekly_summary',$3,$4::jsonb)`,
      [randomUUID(), `weekly_summary:malformed:${randomUUID()}`, partnerId, JSON.stringify({ weekStart: new Date().toISOString(), clicks: 0, proposals: 0, conversions: 0, commissionCents: 500 })],
    );

    const processed = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: mutationHeaders(master), payload: { limit: 50 } });
    expect(processed.statusCode, processed.body).toBe(200);
    expect(processed.json().failed).toBeGreaterThanOrEqual(1);
    expect(processed.json().sent).toBe(0);
    expect(email.messages.some((m) => m.template === 'partner_weekly_summary')).toBe(false);

    const row = await db.query<{ status: string; attempts: number; last_error: string | null }>("SELECT status,attempts,last_error FROM notification_outbox WHERE event_type='weekly_summary'");
    expect(row.rows[0]?.status).toBe('pending');
    expect(row.rows[0]?.attempts).toBe(1);
    expect(row.rows[0]?.last_error).toContain('invalid_weekly_summary_payload');
  });

  it('reclaims and resends (with the same idempotency key) an outbox row whose lease already expired', async () => {
    const master = await createMaster(app, email, 'master-lease-expired@example.com');
    const partnerId = await createPartner(app, master, { code: 'lease-expired', displayName: 'Parceiro Lease', email: 'lease-expired@example.com', commissionType: 'fixed', commissionFixedCents: 1000 });
    const idempotencyKey = `referral_confirmed:lease-expired:${randomUUID()}`;

    // Simulate a previous worker that claimed this row and then crashed mid-send: status is
    // 'processing' under a lock_token nobody holds anymore, with a lease that already expired.
    await db.query(
      `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload,status,lock_token,lease_expires_at,attempts)
       VALUES ($1,$2,'referral_confirmed',$3,'{}'::jsonb,'processing',$4,now() - interval '10 minutes',1)`,
      [randomUUID(), idempotencyKey, partnerId, randomUUID()],
    );

    const processed = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: mutationHeaders(master), payload: { limit: 50 } });
    expect(processed.statusCode, processed.body).toBe(200);
    expect(processed.json().sent).toBe(1);
    expect(processed.json().lockLost).toBe(0);

    // The retry after lease expiration is delivered with the *same* idempotency key, so a
    // provider capable of deduplicating on it (see src/email.ts's EmailMessage.idempotencyKey)
    // never double-delivers even though this outbox row was, from the outbox's own point of
    // view, sent more than once across its lifetime (at least once, not exactly once).
    const message = email.messages.find((m) => m.template === 'partner_referral_confirmed' && m.to === 'lease-expired@example.com');
    expect(message?.idempotencyKey).toBe(idempotencyKey);

    const row = await db.query<{ status: string }>('SELECT status FROM notification_outbox WHERE idempotency_key=$1', [idempotencyKey]);
    expect(row.rows[0]?.status).toBe('sent');
  });

  it('reports lock_lost (never counts as sent) when the lock is stolen mid-send, and never overwrites the new owner\'s row', async () => {
    const master = await createMaster(app, email, 'master-lock-stolen@example.com');
    await createPartner(app, master, { code: 'lock-stolen', displayName: 'Parceiro Lock', email: 'lock-stolen@example.com', commissionType: 'fixed', commissionFixedCents: 1000 });
    await submitAndGetLeadId(app, db, 'lock-stolen', 'lock-stolen-buyer@example.com');

    // A hostile/slow EmailSender that steals this row's lock_token (simulating a concurrent
    // worker reclaiming it after the lease expired) *during* the external send — the exact race
    // fix #3 addresses. The real outbox row is identified by the idempotency key threaded through
    // EmailMessage.idempotencyKey.
    const stolenLockToken = randomUUID();
    class LockStealingEmailSender implements EmailSender {
      readonly messages: EmailMessage[] = [];
      constructor(private readonly db: Database) {}
      async send(message: EmailMessage) {
        this.messages.push(message);
        await this.db.query('UPDATE notification_outbox SET lock_token=$1 WHERE idempotency_key=$2', [stolenLockToken, message.idempotencyKey]);
      }
    }
    const stealingSender = new LockStealingEmailSender(db);
    const stealingApp = await buildApp({ db, config, emailSender: stealingSender });
    await stealingApp.ready();
    try {
      const processed = await stealingApp.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: mutationHeaders(master), payload: { limit: 50 } });
      expect(processed.statusCode, processed.body).toBe(200);
      expect(processed.json().sent).toBe(0);
      expect(processed.json().lockLost).toBe(1);
      expect(stealingSender.messages).toHaveLength(1);

      // The row now belongs to `stolenLockToken`, still 'processing' — the original caller never
      // clobbered it back to 'sent' or any other state.
      const row = await db.query<{ status: string; lock_token: string }>("SELECT status,lock_token FROM notification_outbox WHERE event_type='referral_confirmed'");
      expect(row.rows[0]?.status).toBe('processing');
      expect(row.rows[0]?.lock_token).toBe(stolenLockToken);
    } finally {
      await stealingApp.close();
    }
  });
});

function validLeadPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'quote', name: 'Cliente Teste', email: 'cliente@example.com', phone: '+351 912 345 678',
    origem: 'Lisboa', destino: 'Recife', ida: '2026-11-10', volta: '2026-11-25', adults: 2,
    children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada',
    flexibility: 'Até 3 dias', paymentPreference: 'Dinheiro ou milhas', observacoes: '', contactConsent: true,
    ...overrides,
  };
}

async function submitAndGetLeadId(app: FastifyInstance, db: Database, code: string, buyerEmail: string) {
  const click = await app.inject({ method: 'GET', url: `/i/${code}` });
  const refCookie = click.cookies.find((c) => c.name === 'rc_ref')!;
  const submitted = await app.inject({ method: 'POST', url: '/api/lead', headers: { cookie: `${refCookie.name}=${refCookie.value}` }, payload: validLeadPayload({ email: buyerEmail }) });
  const row = await db.query<{ id: string }>('SELECT id FROM lead_requests WHERE protocol=$1', [submitted.json().protocol]);
  return row.rows[0]!.id;
}

async function createPartner(app: FastifyInstance, master: { cookie: string; csrf: string }, overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = { code: 'partner', displayName: 'Parceiro', email: `${overrides.code ?? 'partner'}@example.com`, commissionType: 'fixed', commissionFixedCents: 5000 };
  if (overrides.commissionType === 'percentage') delete defaults.commissionFixedCents;
  const payload = { ...defaults, ...overrides };
  const created = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id as string;
}

async function createMaster(app: FastifyInstance, email: TestEmailSender, address: string) {
  const invite = await app.inject({ method: 'POST', url: '/api/admin/bootstrap/master-invites', headers: { authorization: `Bearer ${config.MASTER_BOOTSTRAP_TOKEN}` }, payload: { email: address, name: 'Pessoa Master' } });
  if (invite.statusCode === 409) {
    throw new Error('bootstrap_master_already_exists_use_invite_flow');
  }
  const message = email.messages.findLast((item) => item.template === 'master_invite' && item.to === address);
  const code = /<strong>(\d{6})<\/strong>/.exec(message?.html ?? '')?.[1];
  await app.inject({ method: 'POST', url: '/api/admin/master-invites/accept', payload: { email: address, code, password: 'MasterSegura123' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: address, password: 'MasterSegura123' } });
  return { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; '), csrf: login.cookies.find((item) => item.name === 'rc_csrf')!.value };
}

function mutationHeaders(auth: { cookie: string; csrf: string }) {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: config.APP_ORIGIN };
}
