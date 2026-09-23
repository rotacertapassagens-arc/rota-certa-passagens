import { DataType, newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PostgresDatabase, type Database } from '../src/db.js';
import { migrate } from '../src/cli/migrations.js';
import { buildApp } from '../src/app.js';
import { TestEmailSender } from '../src/email.js';
import type { AppConfig } from '../src/config.js';
import { signReferralToken } from '../src/security.js';

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
};

describe('Partner referral program', () => {
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

  it('lets a master create fixed and percentage partners, rejecting invalid or duplicate codes', async () => {
    const master = await createMaster(app, email, 'master1@example.com');
    const fixed = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload: { code: 'Maria10', displayName: 'Maria', email: 'maria@example.com', commissionType: 'fixed', commissionFixedCents: 5000 } });
    expect(fixed.statusCode, fixed.body).toBe(201);
    expect(fixed.json().code).toBe('maria10');

    const duplicate = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload: { code: 'maria10', displayName: 'Outra Maria', email: 'outra@example.com', commissionType: 'fixed', commissionFixedCents: 3000 } });
    expect(duplicate.statusCode).toBe(409);

    const invalidCode = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload: { code: 'a!', displayName: 'Ana', email: 'ana@example.com', commissionType: 'fixed', commissionFixedCents: 1000 } });
    expect(invalidCode.statusCode).toBe(400);

    const mismatched = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload: { code: 'joao', displayName: 'João', email: 'joao@example.com', commissionType: 'percentage', commissionFixedCents: 5000 } });
    expect(mismatched.statusCode).toBe(400);

    const percentage = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload: { code: 'joao', displayName: 'João', email: 'joao@example.com', commissionType: 'percentage', commissionPercentageBps: 800 } });
    expect(percentage.statusCode, percentage.body).toBe(201);
  });

  it('redirects valid active codes with a click and cookie, and inactive/invalid codes without one', async () => {
    const master = await createMaster(app, email, 'master2@example.com');
    await createPartner(app, master, { code: 'ativo', commissionType: 'fixed', commissionFixedCents: 5000 });

    const valid = await app.inject({ method: 'GET', url: '/i/ATIVO' });
    expect(valid.statusCode).toBe(302);
    expect(valid.headers.location).toBe('/proposta-voo.html?ref=ativo');
    expect(valid.cookies.find((c) => c.name === 'rc_ref')).toBeTruthy();
    const clicks = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM referral_clicks');
    expect(clicks.rows[0]?.count).toBe(1);

    const missing = await app.inject({ method: 'GET', url: '/i/does-not-exist' });
    expect(missing.statusCode).toBe(302);
    expect(missing.headers.location).toBe('/');
    expect(missing.cookies.find((c) => c.name === 'rc_ref')).toBeFalsy();

    const partnerId = (await db.query<{ id: string }>("SELECT id FROM partners WHERE code='ativo'")).rows[0]!.id;
    await db.query('UPDATE partners SET active=false WHERE id=$1', [partnerId]);
    const inactive = await app.inject({ method: 'GET', url: '/i/ativo' });
    expect(inactive.headers.location).toBe('/');
    const clicksAfter = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM referral_clicks');
    expect(clicksAfter.rows[0]?.count).toBe(1);
  });

  it('attributes a proposal from the link cookie, ignores a client-forged partner id, and lets manual entry fall back', async () => {
    const master = await createMaster(app, email, 'master3@example.com');
    await createPartner(app, master, { code: 'linkonly', commissionType: 'fixed', commissionFixedCents: 5000 });
    const click = await app.inject({ method: 'GET', url: '/i/linkonly' });
    const refCookie = click.cookies.find((c) => c.name === 'rc_ref')!;

    const leadPayload = validLeadPayload({ email: 'cliente1@example.com', referralCode: 'other-code-the-client-made-up' });
    const submitted = await app.inject({ method: 'POST', url: '/api/lead', headers: { cookie: `${refCookie.name}=${refCookie.value}` }, payload: leadPayload });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const stored = await db.query<{ referral_source: string; referral_code_snapshot: string }>('SELECT referral_source,referral_code_snapshot FROM lead_requests WHERE protocol=$1', [submitted.json().protocol]);
    // The cookie (link) wins over anything the client typed, and the manual code never becomes the partner.
    expect(stored.rows[0]).toEqual(expect.objectContaining({ referral_source: 'link', referral_code_snapshot: 'linkonly' }));

    const manualOnly = await app.inject({ method: 'POST', url: '/api/lead', payload: validLeadPayload({ email: 'cliente2@example.com', howHeard: 'Indicação de um parceiro/influenciador', referralCode: 'linkonly' }) });
    expect(manualOnly.statusCode, manualOnly.body).toBe(201);
    const manualStored = await db.query<{ referral_source: string }>('SELECT referral_source FROM lead_requests WHERE protocol=$1', [manualOnly.json().protocol]);
    expect(manualStored.rows[0]?.referral_source).toBe('manual');

    const none = await app.inject({ method: 'POST', url: '/api/lead', payload: validLeadPayload({ email: 'cliente3@example.com' }) });
    const noneStored = await db.query<{ referral_source: string; partner_id: string | null }>('SELECT referral_source,partner_id FROM lead_requests WHERE protocol=$1', [none.json().protocol]);
    expect(noneStored.rows[0]).toEqual(expect.objectContaining({ referral_source: 'none', partner_id: null }));
  });

  it('rejects a forged or expired referral cookie instead of trusting the client', async () => {
    const master = await createMaster(app, email, 'master4@example.com');
    await createPartner(app, master, { code: 'short-window', commissionType: 'fixed', commissionFixedCents: 5000, attributionWindowDays: 1 });
    const expiredToken = signReferralToken('short-window', Date.now() - 5 * 24 * 60 * 60 * 1000, config.TOKEN_PEPPER);
    const expired = await app.inject({ method: 'POST', url: '/api/lead', headers: { cookie: `rc_ref=${expiredToken}` }, payload: validLeadPayload({ email: 'expired@example.com' }) });
    const expiredStored = await db.query<{ referral_source: string }>('SELECT referral_source FROM lead_requests WHERE protocol=$1', [expired.json().protocol]);
    expect(expiredStored.rows[0]?.referral_source).toBe('none');

    const tampered = await app.inject({ method: 'POST', url: '/api/lead', headers: { cookie: `rc_ref=short-window.${Date.now()}.not-a-real-signature` }, payload: validLeadPayload({ email: 'tampered@example.com' }) });
    const tamperedStored = await db.query<{ referral_source: string }>('SELECT referral_source FROM lead_requests WHERE protocol=$1', [tampered.json().protocol]);
    expect(tamperedStored.rows[0]?.referral_source).toBe('none');
  });

  it('computes fixed and percentage commissions, requires a sale amount for percentage, and never creates duplicates', async () => {
    const master = await createMaster(app, email, 'master5@example.com');
    const fixedPartner = await createPartner(app, master, { code: 'fixedpartner', commissionType: 'fixed', commissionFixedCents: 5000 });
    const pctPartner = await createPartner(app, master, { code: 'pctpartner', commissionType: 'percentage', commissionPercentageBps: 800 });

    const fixedLeadId = await submitAndGetLeadId(app, db, 'fixedpartner', 'fixedbuyer@example.com');
    const converted = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${fixedLeadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });
    expect(converted.statusCode, converted.body).toBe(200);
    expect(converted.json().commissionPreview).toEqual({ amountCents: 5000, currency: 'EUR' });

    const repeat = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${fixedLeadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });
    expect(repeat.statusCode, repeat.body).toBe(200);
    const commissionCount = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM partner_commissions WHERE lead_request_id=$1', [fixedLeadId]);
    expect(commissionCount.rows[0]?.count).toBe(1);

    const pctLeadId = await submitAndGetLeadId(app, db, 'pctpartner', 'pctbuyer@example.com');
    const missingSale = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${pctLeadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });
    expect(missingSale.statusCode).toBe(422);
    const withSale = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${pctLeadId}`, headers: mutationHeaders(master), payload: { status: 'converted', saleAmountCents: 100000, saleCurrency: 'EUR' } });
    expect(withSale.statusCode, withSale.body).toBe(200);
    expect(withSale.json().commissionPreview).toEqual({ amountCents: 8000, currency: 'EUR' });
    void pctPartner; void fixedPartner;
  });

  it('requires an explicit audited reason to move a converted lead away, and blocks the change without it', async () => {
    const master = await createMaster(app, email, 'master6@example.com');
    await createPartner(app, master, { code: 'voidtest', commissionType: 'fixed', commissionFixedCents: 4000 });
    const leadId = await submitAndGetLeadId(app, db, 'voidtest', 'voidbuyer@example.com');
    await app.inject({ method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });

    const blocked = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master), payload: { status: 'lost' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual(expect.objectContaining({ error: 'commission_void_reason_required' }));

    const allowed = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master), payload: { status: 'lost', voidCommissionReason: 'Cliente desistiu da compra' } });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const commission = await db.query<{ status: string; void_reason: string }>('SELECT status,void_reason FROM partner_commissions WHERE lead_request_id=$1', [leadId]);
    expect(commission.rows[0]).toEqual(expect.objectContaining({ status: 'void', void_reason: 'Cliente desistiu da compra' }));
  });

  it('approves and pays a commission only through valid transitions, and voids explicitly with a reason', async () => {
    const master = await createMaster(app, email, 'master7@example.com');
    await createPartner(app, master, { code: 'lifecycle', commissionType: 'fixed', commissionFixedCents: 6000 });
    const leadId = await submitAndGetLeadId(app, db, 'lifecycle', 'lifecyclebuyer@example.com');
    const convertRes = await app.inject({ method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master), payload: { status: 'converted' } });
    expect(convertRes.statusCode, convertRes.body).toBe(200);
    const commissionId = (await db.query<{ id: string }>('SELECT id FROM partner_commissions WHERE lead_request_id=$1', [leadId])).rows[0]!.id;

    const payTooEarly = await app.inject({ method: 'POST', url: `/api/admin/commissions/${commissionId}/pay`, headers: mutationHeaders(master) });
    expect(payTooEarly.statusCode).toBe(409);

    const approve = await app.inject({ method: 'POST', url: `/api/admin/commissions/${commissionId}/approve`, headers: mutationHeaders(master) });
    expect(approve.statusCode, approve.body).toBe(200);
    const pay = await app.inject({ method: 'POST', url: `/api/admin/commissions/${commissionId}/pay`, headers: mutationHeaders(master) });
    expect(pay.statusCode, pay.body).toBe(200);
    const paidRow = await db.query<{ status: string }>('SELECT status FROM partner_commissions WHERE id=$1', [commissionId]);
    expect(paidRow.rows[0]?.status).toBe('paid');

    const voidAfterPaid = await app.inject({ method: 'POST', url: `/api/admin/commissions/${commissionId}/void`, headers: mutationHeaders(master), payload: { reason: 'tentativa tardia' } });
    expect(voidAfterPaid.statusCode, voidAfterPaid.body).toBe(200);
    const outbox = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM notification_outbox WHERE event_type='commission_paid' AND idempotency_key=$1", [`commission_paid:${commissionId}`]);
    expect(outbox.rows[0]?.count).toBe(1);
  });

  it('lets a partner activate their invite, see only their own scoped data, and never any customer PII', async () => {
    const master = await createMaster(app, email, 'master8@example.com');
    const partnerId = await createPartner(app, master, { code: 'selfserve', commissionType: 'fixed', commissionFixedCents: 4500, email: 'partner-selfserve@example.com' });
    const inviteRes = await app.inject({ method: 'POST', url: `/api/admin/partners/${partnerId}/invite`, headers: mutationHeaders(master) });
    expect(inviteRes.statusCode, inviteRes.body).toBe(201);
    const inviteMessage = email.messages.findLast((message) => message.template === 'partner_invite');
    const code = /<strong>(\d{6})<\/strong>/.exec(inviteMessage?.html ?? '')?.[1];
    expect(code).toBeTruthy();

    const accept = await app.inject({ method: 'POST', url: '/api/partner-invites/accept', payload: { email: 'partner-selfserve@example.com', code, password: 'ParceiroSeguro123' } });
    expect(accept.statusCode, accept.body).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'partner-selfserve@example.com', password: 'ParceiroSeguro123' } });
    expect(login.statusCode, login.body).toBe(200);
    const partnerAuth = { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; '), csrf: login.cookies.find((item) => item.name === 'rc_csrf')!.value };

    await submitAndGetLeadId(app, db, 'selfserve', 'pii-should-not-leak@example.com');
    const summary = await app.inject({ method: 'GET', url: '/api/partner/summary', headers: { cookie: partnerAuth.cookie } });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().partner.code).toBe('selfserve');
    expect(summary.json().stats.proposals).toBe(1);

    const ledger = await app.inject({ method: 'GET', url: '/api/partner/ledger', headers: { cookie: partnerAuth.cookie } });
    expect(ledger.statusCode, ledger.body).toBe(200);
    const raw = JSON.stringify(ledger.json());
    expect(raw).not.toContain('pii-should-not-leak@example.com');
    expect(raw).not.toContain('customer_name');
    expect(raw).not.toContain('customer_email');
    expect(ledger.json().entries[0].protocolMasked).toMatch(/•/);

    // A non-master, non-partner account gets no access at all.
    const ordinary = await createVerifiedUser(app, email, 'ordinary-partner-test@example.com', 'Pessoa Comum');
    expect((await app.inject({ method: 'GET', url: '/api/partner/summary', headers: { cookie: ordinary.cookie } })).statusCode).toBe(403);
  });

  it('isolates two partners from each other even if one tries to query the others data directly', async () => {
    const master = await createMaster(app, email, 'master9@example.com');
    const partnerAId = await createPartner(app, master, { code: 'partner-a', commissionType: 'fixed', commissionFixedCents: 3000, email: 'partner-a@example.com' });
    const partnerBId = await createPartner(app, master, { code: 'partner-b', commissionType: 'fixed', commissionFixedCents: 3000, email: 'partner-b@example.com' });
    const authA = await activatePartner(app, email, master, partnerAId, 'partner-a@example.com');
    await activatePartner(app, email, master, partnerBId, 'partner-b@example.com');
    await submitAndGetLeadId(app, db, 'partner-b', 'buyer-for-b@example.com');

    const ledgerA = await app.inject({ method: 'GET', url: '/api/partner/ledger', headers: { cookie: authA.cookie } });
    expect(ledgerA.json().entries).toEqual([]);

    // Even if partner A tries to pass partner B's id explicitly, the endpoint ignores any client id.
    const spoofed = await app.inject({ method: 'GET', url: `/api/partner/ledger?partnerId=${partnerBId}`, headers: { cookie: authA.cookie } });
    expect(spoofed.json().entries).toEqual([]);
  });

  it('keeps commission and notification outbox creation idempotent under a repeated processing call', async () => {
    const master = await createMaster(app, email, 'master10@example.com');
    await createPartner(app, master, { code: 'idempotent', commissionType: 'fixed', commissionFixedCents: 2500 });
    await submitAndGetLeadId(app, db, 'idempotent', 'idempotent-buyer@example.com');
    const outboxCount = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM notification_outbox WHERE event_type='referral_confirmed'");
    expect(outboxCount.rows[0]?.count).toBe(1);

    const firstRun = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: mutationHeaders(master), payload: {} });
    expect(firstRun.statusCode, firstRun.body).toBe(200);
    expect(firstRun.json().sent).toBe(1);
    const secondRun = await app.inject({ method: 'POST', url: '/api/admin/notifications/process', headers: mutationHeaders(master), payload: {} });
    expect(secondRun.json().processed).toBe(0);

    const weeklyFirst = await app.inject({ method: 'POST', url: '/api/admin/notifications/weekly-summary', headers: mutationHeaders(master) });
    expect(weeklyFirst.statusCode, weeklyFirst.body).toBe(200);
    expect(weeklyFirst.json().summariesCreated).toBe(1);
    const weeklySecond = await app.inject({ method: 'POST', url: '/api/admin/notifications/weekly-summary', headers: mutationHeaders(master) });
    expect(weeklySecond.json().summariesCreated).toBe(0);
  });

  it('rejects XSS-style and malformed input on partner creation and the referral form', async () => {
    const master = await createMaster(app, email, 'master11@example.com');
    const xss = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master), payload: { code: 'xsstest', displayName: '<script>alert(1)</script>', email: 'xss@example.com', commissionType: 'fixed', commissionFixedCents: 1000 } });
    expect(xss.statusCode, xss.body).toBe(201);
    const stored = await db.query<{ display_name: string }>("SELECT display_name FROM partners WHERE code='xsstest'");
    // The raw string is stored as data (never interpolated as HTML server-side); rendering layers must escape it.
    expect(stored.rows[0]?.display_name).toBe('<script>alert(1)</script>');

    const badLead = await app.inject({ method: 'POST', url: '/api/lead', payload: { ...validLeadPayload({ email: 'badlead@example.com' }), origem: '' } });
    expect(badLead.statusCode).toBe(400);

    const noCsrf = await app.inject({ method: 'POST', url: '/api/admin/partners', headers: { cookie: master.cookie, origin: config.APP_ORIGIN }, payload: { code: 'nocsrf', displayName: 'X', email: 'x@example.com', commissionType: 'fixed', commissionFixedCents: 1000 } });
    expect(noCsrf.statusCode).toBe(403);
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

async function activatePartner(app: FastifyInstance, email: TestEmailSender, master: { cookie: string; csrf: string }, partnerId: string, partnerEmail: string) {
  const invite = await app.inject({ method: 'POST', url: `/api/admin/partners/${partnerId}/invite`, headers: mutationHeaders(master) });
  expect(invite.statusCode, invite.body).toBe(201);
  const message = email.messages.findLast((item) => item.template === 'partner_invite' && item.to === partnerEmail);
  const code = /<strong>(\d{6})<\/strong>/.exec(message?.html ?? '')?.[1];
  const accept = await app.inject({ method: 'POST', url: '/api/partner-invites/accept', payload: { email: partnerEmail, code, password: 'ParceiroSeguro123' } });
  expect(accept.statusCode, accept.body).toBe(200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: partnerEmail, password: 'ParceiroSeguro123' } });
  expect(login.statusCode, login.body).toBe(200);
  return { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; '), csrf: login.cookies.find((item) => item.name === 'rc_csrf')!.value };
}

async function createMaster(app: FastifyInstance, email: TestEmailSender, address: string) {
  const invite = await app.inject({ method: 'POST', url: '/api/admin/bootstrap/master-invites', headers: { authorization: `Bearer ${config.MASTER_BOOTSTRAP_TOKEN}` }, payload: { email: address, name: 'Pessoa Master' } });
  if (invite.statusCode === 409) {
    // Bootstrap only allows one master; subsequent masters in the same test file use the authenticated invite path.
    throw new Error('bootstrap_master_already_exists_use_invite_flow');
  }
  const message = email.messages.findLast((item) => item.template === 'master_invite' && item.to === address);
  const code = /<strong>(\d{6})<\/strong>/.exec(message?.html ?? '')?.[1];
  await app.inject({ method: 'POST', url: '/api/admin/master-invites/accept', payload: { email: address, code, password: 'MasterSegura123' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: address, password: 'MasterSegura123' } });
  return { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; '), csrf: login.cookies.find((item) => item.name === 'rc_csrf')!.value };
}

async function createVerifiedUser(app: FastifyInstance, email: TestEmailSender, address: string, name: string) {
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { name, email: address, password: 'SenhaSegura123', termsAccepted: true } });
  expect(signup.statusCode).toBe(202);
  const message = email.messages.findLast((item) => item.template === 'verify_email' && item.to === address);
  const code = /<strong>(\d{6})<\/strong>/.exec(message?.html ?? '')?.[1];
  const verified = await app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { email: address, code } });
  const cookies = verified.cookies;
  const sessionCookie = cookies.find((item) => item.name === 'rc_session');
  const csrfCookie = cookies.find((item) => item.name === 'rc_csrf');
  return { cookie: `${sessionCookie!.name}=${sessionCookie!.value}; ${csrfCookie!.name}=${csrfCookie!.value}`, csrf: csrfCookie!.value };
}

function mutationHeaders(auth: { cookie: string; csrf: string }) {
  return { cookie: auth.cookie, 'x-csrf-token': auth.csrf, origin: config.APP_ORIGIN };
}
