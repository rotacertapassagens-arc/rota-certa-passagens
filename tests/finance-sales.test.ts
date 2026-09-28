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
  WHATSAPP_NOTIFICATIONS_ENABLED: false,
  NOTIFICATIONS_CRON_TOKEN: 'cron-token-long-enough-for-tests-000000',
};

describe('Finance module — Fase 3 (vendas e contas a receber)', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;
  let master: { cookie: string; csrf: string };
  let accountId: string;
  let leadCounter = 0;

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

    master = await createMaster(app, email, 'master-fase3@example.com');
    const account = await app.inject({
      method: 'POST', url: '/api/admin/finance/accounts', headers: mutationHeaders(master),
      payload: { name: 'Conta corrente', type: 'bank', currency: 'EUR' },
    });
    accountId = account.json().id;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('Autorização', () => {
    it('GET /api/admin/finance/sales retorna 401 sem sessão', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/sales' });
      expect(response.statusCode).toBe(401);
    });

    it('GET /api/admin/finance/sales retorna 403 para customer', async () => {
      const customer = await createVerifiedUser(app, email, 'cliente-fase3@example.com', 'Cliente Teste');
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/sales', headers: { cookie: customer.cookie } });
      expect(response.statusCode).toBe(403);
    });

    it('POST from-lead sem CSRF retorna 403', async () => {
      const lead = await createConvertedLead();
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`,
        headers: { cookie: master.cookie, origin: config.APP_ORIGIN },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('Criação idempotente a partir da proposta', () => {
    it('cria a venda a partir de uma proposta convertida', async () => {
      const lead = await createConvertedLead({ saleAmountCents: 100000 });
      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`, headers: mutationHeaders(master), payload: {},
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toEqual(expect.objectContaining({ alreadyExisted: false }));

      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/sales', headers: { cookie: master.cookie } });
      expect(list.json().sales).toHaveLength(1);
      expect(list.json().sales[0]).toEqual(expect.objectContaining({
        leadRequestId: lead.leadId, grossAmountCents: 100000, netAmountCents: 100000, currency: 'EUR', status: 'confirmed', financialStatus: 'no_receivables',
      }));
    });

    it('repetir a conversão da mesma proposta nunca duplica a venda', async () => {
      const lead = await createConvertedLead();
      const first = await app.inject({ method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`, headers: mutationHeaders(master), payload: {} });
      const second = await app.inject({ method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`, headers: mutationHeaders(master), payload: {} });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({ id: first.json().id, alreadyExisted: true });
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/sales', headers: { cookie: master.cookie } });
      expect(list.json().sales).toHaveLength(1);
    });

    it('rejeita criar venda para proposta ainda não convertida', async () => {
      const proposal = await app.inject({
        method: 'POST', url: '/api/lead', payload: leadPayload(),
      });
      const leadRow = await db.query<{ id: string }>('SELECT id FROM lead_requests WHERE protocol=$1', [proposal.json().protocol]);
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/from-lead/${leadRow.rows[0]!.id}`, headers: mutationHeaders(master), payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'lead_not_converted' });
    });

    it('rejeita desconto maior ou igual ao valor bruto', async () => {
      const lead = await createConvertedLead({ saleAmountCents: 100000 });
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`, headers: mutationHeaders(master),
        payload: { discountCents: 100000 },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'discount_exceeds_gross_amount' });
    });

    it('não cria uma segunda comissão de parceiro: a venda só referencia, nunca duplica', async () => {
      const partnerCode = await createActivePartner();
      const lead = await createConvertedLead({ saleAmountCents: 100000, partnerCode });
      const before = await db.query('SELECT count(*)::int AS n FROM partner_commissions');
      await app.inject({ method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`, headers: mutationHeaders(master), payload: {} });
      const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM partner_commissions');
      expect(after.rows[0]!.n).toBe((before.rows[0] as { n: number }).n);
      expect(after.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  describe('Parcelas e recebimentos', () => {
    it('cria parcelas e bloqueia soma acima do valor líquido da venda', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const ok = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-03-01', expectedAmountCents: 50000, method: 'pix' }, { dueDate: '2026-04-01', expectedAmountCents: 50000, method: 'pix' }] },
      });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().ids).toHaveLength(2);

      const excess = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-05-01', expectedAmountCents: 1, method: 'pix' }] },
      });
      expect(excess.statusCode).toBe(409);
      expect(excess.json()).toEqual({ error: 'installments_exceed_sale_amount' });
    });

    it('financialStatus evolui de open para partial e para paid conforme os recebimentos', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-03-01', expectedAmountCents: 100000, method: 'pix' }] },
      });
      const receivableId = created.json().ids[0];

      let detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().sale.financialStatus).toBe('open');

      await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 40000, currency: 'EUR', accountId },
      });
      detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().sale.financialStatus).toBe('partial');

      await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 60000, currency: 'EUR', accountId },
      });
      detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().sale.financialStatus).toBe('paid');
    });

    it('rejeita pagamento em moeda diferente da parcela', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-03-01', expectedAmountCents: 100000, method: 'pix' }] },
      });
      const receivableId = created.json().ids[0];
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 100000, currency: 'BRL', accountId },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'payment_currency_must_match_receivable' });
    });

    it('estorna recebimento como novo lançamento e bloqueia um segundo estorno do mesmo pagamento', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-03-01', expectedAmountCents: 100000, method: 'pix' }] },
      });
      const receivableId = created.json().ids[0];
      const payment = await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 100000, currency: 'EUR', accountId },
      });
      const paymentId = payment.json().id;

      const reversal = await app.inject({
        method: 'POST', url: `/api/admin/finance/receivable-payments/${paymentId}/reverse`, headers: mutationHeaders(master),
        payload: { reason: 'Pagamento incorreto' },
      });
      expect(reversal.statusCode, reversal.body).toBe(201);

      const payments = await app.inject({ method: 'GET', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: { cookie: master.cookie } });
      expect(payments.json().payments).toHaveLength(2);
      expect(payments.json().payments[1]).toEqual(expect.objectContaining({ receivedAmountCents: -100000, reversalOf: paymentId }));

      const secondReversal = await app.inject({
        method: 'POST', url: `/api/admin/finance/receivable-payments/${paymentId}/reverse`, headers: mutationHeaders(master),
        payload: { reason: 'De novo' },
      });
      expect(secondReversal.statusCode).toBe(409);
      expect(secondReversal.json()).toEqual({ error: 'payment_already_reversed' });
    });
  });

  describe('Cancelamento e reembolso', () => {
    it('cancela venda sem recebimento e bloqueia cancelar uma que já tem recebimento (use reembolso)', async () => {
      const openSale = await createSale({ saleAmountCents: 50000 });
      const canceled = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${openSale.id}/cancel`, headers: mutationHeaders(master),
        payload: { reason: 'Cliente desistiu antes de qualquer pagamento' },
      });
      expect(canceled.statusCode, canceled.body).toBe(200);

      const paidSale = await createSale({ saleAmountCents: 50000 });
      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${paidSale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-03-01', expectedAmountCents: 50000, method: 'pix' }] },
      });
      const receivableId = created.json().ids[0];
      await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 10000, currency: 'EUR', accountId },
      });
      const blocked = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${paidSale.id}/cancel`, headers: mutationHeaders(master),
        payload: { reason: 'Tentativa indevida' },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toEqual({ error: 'sale_has_payments_use_refund' });
    });

    it('bloqueia reembolso sem nenhum recebimento e permite depois de um recebimento', async () => {
      const sale = await createSale({ saleAmountCents: 50000 });
      const blocked = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/refund`, headers: mutationHeaders(master),
        payload: { reason: 'Nada recebido ainda' },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toEqual({ error: 'sale_has_no_payments_use_cancel' });

      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-03-01', expectedAmountCents: 50000, method: 'pix' }] },
      });
      const receivableId = created.json().ids[0];
      await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivableId}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 50000, currency: 'EUR', accountId },
      });
      const refunded = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/refund`, headers: mutationHeaders(master),
        payload: { reason: 'Cliente cancelou a viagem' },
      });
      expect(refunded.statusCode, refunded.body).toBe(200);
      const detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().sale.status).toBe('refunded');
      expect(detail.json().sale.financialStatus).toBe('refunded');
    });
  });

  function leadPayload(overrides: Partial<{ ref: string }> = {}) {
    leadCounter += 1;
    return {
      type: 'quote', name: `Cliente Teste ${leadCounter}`, email: `cliente${leadCounter}@example.com`, phone: '+351 912 345 678',
      origem: 'Lisboa', destino: 'Recife', ida: '2026-11-10', volta: '2026-11-25', adults: 2,
      children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada',
      flexibility: 'Até 3 dias', paymentPreference: 'Dinheiro ou milhas', observacoes: '', contactConsent: true,
      ...(overrides.ref ? { ref: overrides.ref } : {}),
    };
  }

  async function createActivePartner(): Promise<string> {
    const code = `parceiro${leadCounter + 1}${Date.now()}`.slice(0, 20);
    const created = await app.inject({
      method: 'POST', url: '/api/admin/partners', headers: mutationHeaders(master),
      payload: { code, displayName: 'Parceiro Teste', email: `${code}@example.com`, commissionType: 'fixed', commissionFixedCents: 2500, currency: 'EUR', attributionWindowDays: 30 },
    });
    expect(created.statusCode, created.body).toBe(201);
    return code;
  }

  async function createConvertedLead(overrides: Partial<{ saleAmountCents: number; partnerCode: string }> = {}) {
    let cookie: string | undefined;
    if (overrides.partnerCode) {
      const attribution = await app.inject({ method: 'GET', url: `/i/${overrides.partnerCode}` });
      cookie = attribution.cookies.find((item) => item.name === 'rc_ref') ? `${attribution.cookies.find((item) => item.name === 'rc_ref')!.name}=${attribution.cookies.find((item) => item.name === 'rc_ref')!.value}` : undefined;
    }
    const proposal = await app.inject({ method: 'POST', url: '/api/lead', headers: cookie ? { cookie } : {}, payload: leadPayload() });
    expect(proposal.statusCode, proposal.body).toBe(201);
    const leadRow = await db.query<{ id: string }>('SELECT id FROM lead_requests WHERE protocol=$1', [proposal.json().protocol]);
    const leadId = leadRow.rows[0]!.id;
    const converted = await app.inject({
      method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master),
      payload: { status: 'converted', saleAmountCents: overrides.saleAmountCents ?? 100000, saleCurrency: 'EUR' },
    });
    expect(converted.statusCode, converted.body).toBe(200);
    return { leadId, protocol: proposal.json().protocol as string };
  }

  async function createSale(overrides: Partial<{ saleAmountCents: number }> = {}) {
    const lead = await createConvertedLead(overrides);
    const created = await app.inject({ method: 'POST', url: `/api/admin/finance/sales/from-lead/${lead.leadId}`, headers: mutationHeaders(master), payload: {} });
    expect(created.statusCode, created.body).toBe(201);
    return { id: created.json().id as string, leadId: lead.leadId };
  }
});

async function createMaster(app: FastifyInstance, email: TestEmailSender, address: string) {
  await app.inject({ method: 'POST', url: '/api/admin/bootstrap/master-invites', headers: { authorization: `Bearer ${config.MASTER_BOOTSTRAP_TOKEN}` }, payload: { email: address, name: 'Pessoa Master' } });
  const message = email.messages.findLast((item) => item.template === 'master_invite' && item.to === address);
  const code = /<strong>(\d{6})<\/strong>/.exec(message?.html ?? '')?.[1];
  await app.inject({ method: 'POST', url: '/api/admin/master-invites/accept', payload: { email: address, code, password: 'MasterSegura123' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: address, password: 'MasterSegura123' } });
  return { cookie: login.cookies.map((item) => `${item.name}=${item.value}`).join('; '), csrf: login.cookies.find((item) => item.name === 'rc_csrf')!.value };
}

async function createVerifiedUser(app: FastifyInstance, email: TestEmailSender, address: string, name: string) {
  await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { name, email: address, password: 'SenhaSegura123', termsAccepted: true } });
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
