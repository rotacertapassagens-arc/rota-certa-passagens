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

describe('Finance module — Fase 4 (emissões, custos e lucro)', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;
  let master: { cookie: string; csrf: string };
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

    master = await createMaster(app, email, 'master-fase4@example.com');
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('Autorização', () => {
    it('GET issuances de uma venda retorna 401 sem sessão', async () => {
      const sale = await createSale();
      const response = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}/issuances` });
      expect(response.statusCode).toBe(401);
    });

    it('GET issuances retorna 403 para customer', async () => {
      const sale = await createSale();
      const customer = await createVerifiedUser(app, email, 'cliente-fase4@example.com', 'Cliente Teste');
      const response = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: { cookie: customer.cookie } });
      expect(response.statusCode).toBe(403);
    });

    it('POST issuance sem CSRF retorna 403', async () => {
      const sale = await createSale();
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`,
        headers: { cookie: master.cookie, origin: config.APP_ORIGIN },
        payload: { mode: 'cash', currency: 'EUR' },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('Criação e validação de moeda', () => {
    it('cria emissão em dinheiro e rejeita moeda diferente da venda', async () => {
      const sale = await createSale({ currency: 'EUR' });
      const ok = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 60000, airportFeesCents: 2000 },
      });
      expect(ok.statusCode, ok.body).toBe(201);

      const mismatched = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'BRL', cashAmountCents: 60000 },
      });
      expect(mismatched.statusCode).toBe(422);
      expect(mismatched.json()).toEqual({ error: 'issuance_currency_must_match_sale' });
    });
  });

  describe('Ciclo de vida da emissão', () => {
    it('exige PNR para emitir e bloqueia edição depois de emitida (custo histórico travado)', async () => {
      const sale = await createSale();
      const created = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 50000 },
      });
      const issuanceId = created.json().id;

      const blockedIssue = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuanceId}/issue`, headers: mutationHeaders(master), payload: {} });
      expect(blockedIssue.statusCode).toBe(422);
      expect(blockedIssue.json()).toEqual({ error: 'pnr_required_to_issue' });

      await app.inject({
        method: 'PATCH', url: `/api/admin/finance/issuances/${issuanceId}`, headers: mutationHeaders(master),
        payload: { pnr: 'ABC123' },
      });
      const issued = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuanceId}/issue`, headers: mutationHeaders(master), payload: {} });
      expect(issued.statusCode, issued.body).toBe(200);

      const editAfterIssued = await app.inject({
        method: 'PATCH', url: `/api/admin/finance/issuances/${issuanceId}`, headers: mutationHeaders(master),
        payload: { cashAmountCents: 1 },
      });
      expect(editAfterIssued.statusCode).toBe(409);
      expect(editAfterIssued.json()).toEqual({ error: 'issuance_locked_after_issued' });
    });

    it('só permite cancelar emissão pendente, e só permite reembolsar emissão já emitida', async () => {
      const sale = await createSale();
      const pending = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 1000, pnr: 'XYZ999' },
      });
      const pendingId = pending.json().id;
      const canceled = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${pendingId}/cancel`, headers: mutationHeaders(master), payload: { reason: 'Erro de digitação' } });
      expect(canceled.statusCode, canceled.body).toBe(200);

      const blockedRefundOfPending = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${pendingId}/refund`, headers: mutationHeaders(master), payload: { reason: 'Tentativa indevida' },
      });
      expect(blockedRefundOfPending.statusCode).toBe(409);
      expect(blockedRefundOfPending.json()).toEqual({ error: 'invalid_transition' });

      const issuedFlow = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 1000, pnr: 'AAA111' },
      });
      const issuedId = issuedFlow.json().id;
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuedId}/issue`, headers: mutationHeaders(master), payload: {} });
      const blockedCancelOfIssued = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuedId}/cancel`, headers: mutationHeaders(master), payload: { reason: 'Tentativa indevida' } });
      expect(blockedCancelOfIssued.statusCode).toBe(409);
      expect(blockedCancelOfIssued.json()).toEqual({ error: 'invalid_transition' });
      const refunded = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuedId}/refund`, headers: mutationHeaders(master), payload: { reason: 'Cliente cancelou o voo' } });
      expect(refunded.statusCode, refunded.body).toBe(200);
    });
  });

  describe('Lucro e margem por venda (calculados no servidor)', () => {
    it('calcula lucro realizado a partir de emissão emitida, e projetado a partir de emissão pendente', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const issuance = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 50000, airportFeesCents: 5000, pnr: 'PROFIT1' },
      });
      const issuanceId = issuance.json().id;

      let detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().profit).toEqual(expect.objectContaining({
        realizedDirectCostCents: 0, projectedDirectCostCents: 55000,
        realizedGrossProfitCents: 100000, realizedMarginBps: 10000,
        projectedGrossProfitCents: 45000, projectedMarginBps: 4500,
      }));

      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuanceId}/issue`, headers: mutationHeaders(master), payload: {} });
      detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().profit).toEqual(expect.objectContaining({
        realizedDirectCostCents: 55000, projectedDirectCostCents: 0,
        realizedGrossProfitCents: 45000, realizedMarginBps: 4500,
        projectedGrossProfitCents: 45000, projectedMarginBps: 4500,
      }));
    });

    it('emissão cancelada nunca entra no custo realizado nem no projetado', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const issuance = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 90000 },
      });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuance.json().id}/cancel`, headers: mutationHeaders(master), payload: { reason: 'Cotação errada' } });
      const detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}`, headers: { cookie: master.cookie } });
      expect(detail.json().profit).toEqual(expect.objectContaining({ realizedDirectCostCents: 0, projectedDirectCostCents: 0 }));
    });
  });

  function leadPayload() {
    leadCounter += 1;
    return {
      type: 'quote', name: `Cliente Teste ${leadCounter}`, email: `cliente${leadCounter}@example.com`, phone: '+351 912 345 678',
      origem: 'Lisboa', destino: 'Recife', ida: '2026-11-10', volta: '2026-11-25', adults: 2,
      children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada',
      flexibility: 'Até 3 dias', paymentPreference: 'Dinheiro ou milhas', observacoes: '', contactConsent: true,
    };
  }

  async function createSale(overrides: Partial<{ saleAmountCents: number; currency: string }> = {}) {
    const proposal = await app.inject({ method: 'POST', url: '/api/lead', payload: leadPayload() });
    const leadRow = await db.query<{ id: string }>('SELECT id FROM lead_requests WHERE protocol=$1', [proposal.json().protocol]);
    const leadId = leadRow.rows[0]!.id;
    await app.inject({
      method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master),
      payload: { status: 'converted', saleAmountCents: overrides.saleAmountCents ?? 100000, saleCurrency: overrides.currency ?? 'EUR' },
    });
    const created = await app.inject({ method: 'POST', url: `/api/admin/finance/sales/from-lead/${leadId}`, headers: mutationHeaders(master), payload: {} });
    return { id: created.json().id as string };
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
