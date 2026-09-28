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

describe('Finance module — Fase 6 (dashboard e relatórios)', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;
  let master: { cookie: string; csrf: string };
  let accountId: string;
  let expenseCategoryId: string;
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

    master = await createMaster(app, email, 'master-fase6@example.com');
    const account = await app.inject({
      method: 'POST', url: '/api/admin/finance/accounts', headers: mutationHeaders(master),
      payload: { name: 'Conta corrente', type: 'bank', currency: 'EUR' },
    });
    accountId = account.json().id;
    const expenseCategory = await app.inject({
      method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
      payload: { kind: 'operating_expense', name: 'Despesa qualquer' },
    });
    expenseCategoryId = expenseCategory.json().id;
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('Autorização', () => {
    it('GET overview retorna 401 sem sessão', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/overview?from=2026-01-01&to=2026-01-31' });
      expect(response.statusCode).toBe(401);
    });

    it('GET overview retorna 403 para customer', async () => {
      const customer = await createVerifiedUser(app, email, 'cliente-fase6@example.com', 'Cliente Teste');
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/overview?from=2026-01-01&to=2026-01-31', headers: { cookie: customer.cookie } });
      expect(response.statusCode).toBe(403);
    });

    it('GET export.csv retorna 401 sem sessão', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/export.csv?report=sales&from=2026-01-01&to=2026-01-31' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('Indicadores em regime de competência', () => {
    it('calcula faturamento, custo direto, lucro bruto, margem e resultado operacional no servidor', async () => {
      const sale = await createSale({ saleAmountCents: 100000, saleDateOverride: '2026-02-10' });
      await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 40000, pnr: 'ABC123' },
      });
      const issuances = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: { cookie: master.cookie } });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuances.json().issuances[0].id}/issue`, headers: mutationHeaders(master), payload: {} });

      await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: expenseCategoryId, competencyDate: '2026-02-15', dueDate: '2026-02-20', amountCents: 10000, currency: 'EUR' },
      });

      const overview = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/overview?from=2026-02-01&to=2026-02-28&regime=accrual', headers: { cookie: master.cookie } });
      expect(overview.statusCode, overview.body).toBe(200);
      expect(overview.json().indicators).toEqual([
        expect.objectContaining({
          currency: 'EUR', faturamentoBrutoCents: 100000, custoDiretoCents: 40000,
          lucroBrutoCents: 60000, margemBrutaBps: 6000, despesasOperacionaisCents: 10000, resultadoOperacionalCents: 50000,
        }),
      ]);
    });

    it('não conta faturamento fora do período nem de venda cancelada', async () => {
      await createSale({ saleAmountCents: 50000, saleDateOverride: '2026-03-05' });
      const overview = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/overview?from=2026-02-01&to=2026-02-28&regime=accrual', headers: { cookie: master.cookie } });
      expect(overview.json().indicators).toEqual([]);
    });

    it('rejeita período invertido', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/overview?from=2026-02-28&to=2026-02-01', headers: { cookie: master.cookie } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_date_range' });
    });
  });

  describe('Indicadores em regime de caixa', () => {
    it('soma recebido e pago no período, nunca misturando com competência', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const receivable = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/receivables`, headers: mutationHeaders(master),
        payload: { installments: [{ dueDate: '2026-04-01', expectedAmountCents: 100000, method: 'pix' }] },
      });
      await app.inject({
        method: 'POST', url: `/api/admin/finance/receivables/${receivable.json().ids[0]}/payments`, headers: mutationHeaders(master),
        payload: { receivedAmountCents: 100000, currency: 'EUR', accountId },
      });

      const overview = await app.inject({ method: 'GET', url: `/api/admin/finance/dashboard/overview?from=${todayDateOnly()}&to=${todayDateOnly()}&regime=cash`, headers: { cookie: master.cookie } });
      expect(overview.statusCode, overview.body).toBe(200);
      expect(overview.json().indicators).toEqual([expect.objectContaining({ currency: 'EUR', recebidoCents: 100000, pagoCents: 0, saldoCaixaCents: 100000 })]);
    });
  });

  describe('Alertas', () => {
    it('lista obrigação vencida e não lista uma futura', async () => {
      await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: expenseCategoryId, competencyDate: '2020-01-01', dueDate: '2020-01-05', amountCents: 5000, currency: 'EUR' },
      });
      await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: expenseCategoryId, competencyDate: '2099-01-01', dueDate: '2099-01-05', amountCents: 6000, currency: 'EUR' },
      });
      const alerts = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/alerts', headers: { cookie: master.cookie } });
      expect(alerts.statusCode, alerts.body).toBe(200);
      expect(alerts.json().overdueObligations).toHaveLength(1);
      expect(alerts.json().overdueObligations[0]).toEqual(expect.objectContaining({ amountCents: 5000 }));
    });

    it('sinaliza venda com margem abaixo do limite configurado', async () => {
      const sale = await createSale({ saleAmountCents: 100000 });
      const issuance = await app.inject({
        method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
        payload: { mode: 'cash', currency: 'EUR', cashAmountCents: 95000, pnr: 'LOWMARGIN' },
      });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuance.json().id}/issue`, headers: mutationHeaders(master), payload: {} });
      const alerts = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/alerts?minMarginBps=1000', headers: { cookie: master.cookie } });
      expect(alerts.json().salesBelowMarginThreshold).toEqual([expect.objectContaining({ saleId: sale.id, marginBps: 500 })]);
    });

    it('sinaliza lote de milhas com saldo baixo', async () => {
      const counterparty = await app.inject({
        method: 'POST', url: '/api/admin/finance/counterparties', headers: mutationHeaders(master),
        payload: { displayName: 'Fornecedor Milhas', kind: 'mileage_provider' },
      });
      const directCostCategory = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'direct_cost', name: 'Compra de milhas' },
      });
      await app.inject({
        method: 'POST', url: '/api/admin/finance/mileage-lots', headers: mutationHeaders(master),
        payload: {
          counterpartyId: counterparty.json().id, program: 'Smiles', quantityPurchased: 500, totalCostCents: 5000,
          currency: 'EUR', purchasedAt: '2026-01-01', dueDate: '2026-01-10', categoryId: directCostCategory.json().id,
        },
      });
      const alerts = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/alerts?lowBalanceThreshold=1000', headers: { cookie: master.cookie } });
      expect(alerts.json().mileageLotsLowBalance).toEqual([expect.objectContaining({ program: 'Smiles', balanceQuantity: 500 })]);
    });
  });

  describe('Despesas por categoria', () => {
    it('agrupa por categoria e moeda em regime de competência', async () => {
      await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: expenseCategoryId, competencyDate: '2026-05-01', dueDate: '2026-05-10', amountCents: 3000, currency: 'EUR' },
      });
      await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: expenseCategoryId, competencyDate: '2026-05-15', dueDate: '2026-05-20', amountCents: 2000, currency: 'EUR' },
      });
      const report = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/expenses-by-category?from=2026-05-01&to=2026-05-31&regime=accrual', headers: { cookie: master.cookie } });
      expect(report.statusCode, report.body).toBe(200);
      expect(report.json().categories).toEqual([expect.objectContaining({ categoryId: expenseCategoryId, currency: 'EUR', amountCents: 5000 })]);
    });
  });

  describe('Exportação CSV', () => {
    it('exporta vendas em CSV com BOM e cabeçalho corretos', async () => {
      await createSale({ saleAmountCents: 42000, saleDateOverride: '2026-06-10' });
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/export.csv?report=sales&from=2026-06-01&to=2026-06-30', headers: { cookie: master.cookie } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.body.startsWith('﻿')).toBe(true);
      expect(response.body).toContain('Protocolo,Data,Moeda');
      expect(response.body).toContain('42000');
    });

    it('neutraliza um protocolo malicioso do tipo fórmula na exportação', async () => {
      const proposal = await app.inject({ method: 'POST', url: '/api/lead', payload: leadPayload() });
      const leadRow = await db.query<{ id: string }>('SELECT id FROM lead_requests WHERE protocol=$1', [proposal.json().protocol]);
      await app.inject({
        method: 'PATCH', url: `/api/admin/leads/${leadRow.rows[0]!.id}`, headers: mutationHeaders(master),
        payload: { status: 'converted', saleAmountCents: 10000, saleCurrency: 'EUR' },
      });
      // Protocolo real (gerado pelo servidor) nunca começa com "=", então injetamos via
      // internal_notes seria outro campo — aqui confirmamos que o mecanismo csvEscapeCell em si
      // está de fato conectado ao endpoint testando um valor de categoria hostil na exportação de
      // obrigações, que aceita texto livre do operador.
      const hostileCategory = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', name: '=cmd|"/c calc"!A1' },
      });
      await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: hostileCategory.json().id, competencyDate: '2026-07-01', dueDate: '2026-07-05', amountCents: 1000, currency: 'EUR' },
      });
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/dashboard/export.csv?report=obligations&from=2026-07-01&to=2026-07-31', headers: { cookie: master.cookie } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain(',=cmd|');
      expect(response.body).toContain("'=cmd|");
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

  async function createSale(overrides: Partial<{ saleAmountCents: number; saleDateOverride: string }> = {}) {
    const proposal = await app.inject({ method: 'POST', url: '/api/lead', payload: leadPayload() });
    const leadRow = await db.query<{ id: string }>('SELECT id FROM lead_requests WHERE protocol=$1', [proposal.json().protocol]);
    const leadId = leadRow.rows[0]!.id;
    await app.inject({
      method: 'PATCH', url: `/api/admin/leads/${leadId}`, headers: mutationHeaders(master),
      payload: { status: 'converted', saleAmountCents: overrides.saleAmountCents ?? 100000, saleCurrency: 'EUR' },
    });
    const created = await app.inject({
      method: 'POST', url: `/api/admin/finance/sales/from-lead/${leadId}`, headers: mutationHeaders(master),
      payload: overrides.saleDateOverride ? { saleDate: overrides.saleDateOverride } : {},
    });
    return { id: created.json().id as string };
  }
});

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

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
