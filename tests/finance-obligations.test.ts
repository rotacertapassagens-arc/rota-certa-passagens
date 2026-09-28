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

describe('Finance module — Fase 2 (assinaturas, despesas e contas a pagar)', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;
  let master: { cookie: string; csrf: string };
  let counterpartyId: string;
  let expenseCategoryId: string;
  let directCostCategoryId: string;
  let accountId: string;

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

    master = await createMaster(app, email, 'master-fase2@example.com');
    const counterparty = await app.inject({
      method: 'POST', url: '/api/admin/finance/counterparties', headers: mutationHeaders(master),
      payload: { displayName: 'Fornecedor de Software LTDA', kind: 'supplier' },
    });
    counterpartyId = counterparty.json().id;
    const expenseCategory = await app.inject({
      method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
      payload: { kind: 'operating_expense', name: 'Assinaturas de software' },
    });
    expenseCategoryId = expenseCategory.json().id;
    const directCostCategory = await app.inject({
      method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
      payload: { kind: 'direct_cost', name: 'Custos de emissão' },
    });
    directCostCategoryId = directCostCategory.json().id;
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
    it('GET /api/admin/finance/subscriptions retorna 401 sem sessão', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/subscriptions' });
      expect(response.statusCode).toBe(401);
    });

    it('GET /api/admin/finance/obligations retorna 403 para customer', async () => {
      const customer = await createVerifiedUser(app, email, 'cliente-fase2@example.com', 'Cliente Teste');
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations', headers: { cookie: customer.cookie } });
      expect(response.statusCode).toBe(403);
    });

    it('POST de pagamento sem CSRF retorna 403', async () => {
      const obligation = await createObligation();
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`,
        headers: { cookie: master.cookie, origin: config.APP_ORIGIN },
        payload: { paidAmountCents: 1000, currency: 'EUR', accountId },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('Assinaturas', () => {
    it('cria assinatura mensal com histórico de preço inicial', async () => {
      const created = await app.inject({
        method: 'POST', url: '/api/admin/finance/subscriptions', headers: mutationHeaders(master),
        payload: {
          counterpartyId, categoryId: expenseCategoryId, service: 'Ferramenta de e-mail',
          amountCents: 5000, currency: 'EUR', periodicity: 'monthly', startedAt: '2026-01-15',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id;
      const history = await app.inject({ method: 'GET', url: `/api/admin/finance/subscriptions/${id}/price-history`, headers: { cookie: master.cookie } });
      expect(history.json().priceHistory).toHaveLength(1);
      expect(history.json().priceHistory[0]).toEqual(expect.objectContaining({ amountCents: 5000, currency: 'EUR' }));
    });

    it('rejeita categoria que não é despesa operacional', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/subscriptions', headers: mutationHeaders(master),
        payload: {
          counterpartyId, categoryId: directCostCategoryId, service: 'Ferramenta X',
          amountCents: 5000, currency: 'EUR', periodicity: 'monthly', startedAt: '2026-01-15',
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'category_must_be_operating_expense' });
    });

    it('reajusta preço preservando histórico anterior', async () => {
      const created = await createSubscription({ amountCents: 5000, periodicity: 'monthly', startedAt: '2026-01-15' });
      const reprice = await app.inject({
        method: 'POST', url: `/api/admin/finance/subscriptions/${created.id}/reprice`, headers: mutationHeaders(master),
        payload: { amountCents: 6000, currency: 'EUR', effectiveAt: '2026-03-15' },
      });
      expect(reprice.statusCode, reprice.body).toBe(200);
      const history = await app.inject({ method: 'GET', url: `/api/admin/finance/subscriptions/${created.id}/price-history`, headers: { cookie: master.cookie } });
      expect(history.json().priceHistory).toHaveLength(2);
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/subscriptions', headers: { cookie: master.cookie } });
      expect(list.json().subscriptions[0].amountCents).toBe(6000);
    });

    it('segue a máquina de estado e rejeita transição inválida', async () => {
      const created = await createSubscription({ status: 'trial' });
      const invalid = await app.inject({
        method: 'POST', url: `/api/admin/finance/subscriptions/${created.id}/status`, headers: mutationHeaders(master),
        payload: { status: 'ended' },
      });
      expect(invalid.statusCode).toBe(409);
      expect(invalid.json()).toEqual({ error: 'invalid_transition' });

      const valid = await app.inject({
        method: 'POST', url: `/api/admin/finance/subscriptions/${created.id}/status`, headers: mutationHeaders(master),
        payload: { status: 'active' },
      });
      expect(valid.statusCode).toBe(200);
    });

    it('cancelamento não apaga cobranças anteriores geradas pela assinatura', async () => {
      const created = await createSubscription({ amountCents: 4000, periodicity: 'monthly', startedAt: '2020-01-01' });
      const generated = await app.inject({ method: 'POST', url: '/api/admin/finance/subscriptions/generate-charges', headers: mutationHeaders(master) });
      expect(generated.statusCode, generated.body).toBe(200);
      expect(generated.json().created).toBeGreaterThan(0);

      await app.inject({
        method: 'POST', url: `/api/admin/finance/subscriptions/${created.id}/status`, headers: mutationHeaders(master),
        payload: { status: 'canceled' },
      });

      const obligations = await app.inject({ method: 'GET', url: `/api/admin/finance/obligations?counterpartyId=${counterpartyId}`, headers: { cookie: master.cookie } });
      expect(obligations.json().obligations.length).toBeGreaterThan(0);
    });

    it('gera cobranças idempotentemente através de meses com quantidade diferente de dias, sem duplicar ao rodar duas vezes', async () => {
      // 31/01 mensal cruzando fevereiro (28/29 dias) — a mesma checagem da suíte de
      // shared/subscriptionSchedule.ts, agora ponta a ponta contra o banco.
      await createSubscription({ amountCents: 2500, periodicity: 'monthly', startedAt: '2026-01-31' });
      const first = await app.inject({ method: 'POST', url: '/api/admin/finance/subscriptions/generate-charges', headers: mutationHeaders(master) });
      expect(first.statusCode, first.body).toBe(200);
      const createdCount = first.json().created;
      expect(createdCount).toBeGreaterThan(0);

      const second = await app.inject({ method: 'POST', url: '/api/admin/finance/subscriptions/generate-charges', headers: mutationHeaders(master) });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().created).toBe(0);

      const obligations = await app.inject({ method: 'GET', url: `/api/admin/finance/obligations?counterpartyId=${counterpartyId}`, headers: { cookie: master.cookie } });
      expect(obligations.json().obligations).toHaveLength(createdCount);
    });
  });

  describe('Obrigações (contas a pagar / despesas)', () => {
    it('cria obrigação manual e bloqueia categoria de kind divergente', async () => {
      const mismatched = await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'direct_cost', categoryId: expenseCategoryId, competencyDate: '2026-02-01', dueDate: '2026-02-10', amountCents: 10000, currency: 'EUR' },
      });
      expect(mismatched.statusCode).toBe(422);
      expect(mismatched.json()).toEqual({ error: 'category_kind_mismatch' });

      const ok = await app.inject({
        method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', categoryId: expenseCategoryId, competencyDate: '2026-02-01', dueDate: '2026-02-10', amountCents: 10000, currency: 'EUR' },
      });
      expect(ok.statusCode, ok.body).toBe(201);
    });

    it('registra pagamento total e move status para paga', async () => {
      const obligation = await createObligation({ amountCents: 10000 });
      const payment = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 10000, currency: 'EUR', accountId },
      });
      expect(payment.statusCode, payment.body).toBe(201);
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations', headers: { cookie: master.cookie } });
      const row = list.json().obligations.find((item: { id: string }) => item.id === obligation.id);
      expect(row.status).toBe('paid');
    });

    it('registra pagamento parcial e depois completa', async () => {
      const obligation = await createObligation({ amountCents: 10000 });
      await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 4000, currency: 'EUR', accountId },
      });
      let list = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations', headers: { cookie: master.cookie } });
      expect(list.json().obligations.find((item: { id: string }) => item.id === obligation.id).status).toBe('partial');

      await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 6000, currency: 'EUR', accountId },
      });
      list = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations', headers: { cookie: master.cookie } });
      expect(list.json().obligations.find((item: { id: string }) => item.id === obligation.id).status).toBe('paid');
    });

    it('rejeita pagamento em moeda diferente da obrigação', async () => {
      const obligation = await createObligation({ amountCents: 10000, currency: 'EUR' });
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 10000, currency: 'BRL', accountId },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'payment_currency_must_match_obligation' });
    });

    it('estorna um pagamento como um novo lançamento, nunca apagando o original', async () => {
      const obligation = await createObligation({ amountCents: 10000 });
      const payment = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 10000, currency: 'EUR', accountId },
      });
      const paymentId = payment.json().id;

      const reversal = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligation-payments/${paymentId}/reverse`, headers: mutationHeaders(master),
        payload: { reason: 'Pagamento duplicado por engano' },
      });
      expect(reversal.statusCode, reversal.body).toBe(201);

      const payments = await app.inject({ method: 'GET', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: { cookie: master.cookie } });
      expect(payments.json().payments).toHaveLength(2);
      expect(payments.json().payments[0]).toEqual(expect.objectContaining({ paidAmountCents: 10000 }));
      expect(payments.json().payments[1]).toEqual(expect.objectContaining({ paidAmountCents: -10000, reversalOf: paymentId }));

      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations', headers: { cookie: master.cookie } });
      expect(list.json().obligations.find((item: { id: string }) => item.id === obligation.id).status).toBe('open');
    });

    it('bloqueia estornar o mesmo pagamento duas vezes', async () => {
      const obligation = await createObligation({ amountCents: 10000 });
      const payment = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${obligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 10000, currency: 'EUR', accountId },
      });
      const paymentId = payment.json().id;
      await app.inject({ method: 'POST', url: `/api/admin/finance/obligation-payments/${paymentId}/reverse`, headers: mutationHeaders(master), payload: { reason: 'Erro' } });
      const secondReversal = await app.inject({ method: 'POST', url: `/api/admin/finance/obligation-payments/${paymentId}/reverse`, headers: mutationHeaders(master), payload: { reason: 'De novo' } });
      expect(secondReversal.statusCode).toBe(409);
      expect(secondReversal.json()).toEqual({ error: 'payment_already_reversed' });
    });

    it('cancela obrigação sem pagamentos e bloqueia cancelar uma que já tem pagamento', async () => {
      const openObligation = await createObligation({ amountCents: 5000 });
      const canceled = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${openObligation.id}/cancel`, headers: mutationHeaders(master),
        payload: { reason: 'Cobrança duplicada' },
      });
      expect(canceled.statusCode, canceled.body).toBe(200);

      const paidObligation = await createObligation({ amountCents: 5000 });
      await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${paidObligation.id}/payments`, headers: mutationHeaders(master),
        payload: { paidAmountCents: 1000, currency: 'EUR', accountId },
      });
      const blocked = await app.inject({
        method: 'POST', url: `/api/admin/finance/obligations/${paidObligation.id}/cancel`, headers: mutationHeaders(master),
        payload: { reason: 'Tentativa indevida' },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toEqual({ error: 'obligation_has_payments_or_terminal' });
    });

    it('marca vencida (is_overdue) sem alterar o status armazenado', async () => {
      const obligation = await createObligation({ amountCents: 5000, dueDate: '2020-01-01' });
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations?status=open', headers: { cookie: master.cookie } });
      const row = list.json().obligations.find((item: { id: string }) => item.id === obligation.id);
      expect(row.status).toBe('open');
      expect(row.isOverdue).toBe(true);
    });
  });

  async function createSubscription(overrides: Partial<{ amountCents: number; currency: string; periodicity: string; startedAt: string; status: string }> = {}) {
    const created = await app.inject({
      method: 'POST', url: '/api/admin/finance/subscriptions', headers: mutationHeaders(master),
      payload: {
        counterpartyId, categoryId: expenseCategoryId, service: 'Assinatura de teste',
        amountCents: overrides.amountCents ?? 5000, currency: overrides.currency ?? 'EUR',
        periodicity: overrides.periodicity ?? 'monthly', startedAt: overrides.startedAt ?? '2026-01-15',
        status: overrides.status,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return { id: created.json().id as string };
  }

  async function createObligation(overrides: Partial<{ amountCents: number; currency: string; dueDate: string }> = {}) {
    const created = await app.inject({
      method: 'POST', url: '/api/admin/finance/obligations', headers: mutationHeaders(master),
      payload: {
        kind: 'operating_expense', categoryId: expenseCategoryId,
        competencyDate: '2026-02-01', dueDate: overrides.dueDate ?? '2026-02-10',
        amountCents: overrides.amountCents ?? 10000, currency: overrides.currency ?? 'EUR',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
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
