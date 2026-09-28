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

describe('Finance module — Fase 5 (milhas e fornecedores)', () => {
  let app: FastifyInstance;
  let db: Database;
  let email: TestEmailSender;
  let master: { cookie: string; csrf: string };
  let mileageProviderId: string;
  let directCostCategoryId: string;
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

    master = await createMaster(app, email, 'master-fase5@example.com');
    const counterparty = await app.inject({
      method: 'POST', url: '/api/admin/finance/counterparties', headers: mutationHeaders(master),
      payload: { displayName: 'Fornecedor de Milhas Teste', kind: 'mileage_provider' },
    });
    mileageProviderId = counterparty.json().id;
    const directCostCategory = await app.inject({
      method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
      payload: { kind: 'direct_cost', name: 'Compra de milhas' },
    });
    directCostCategoryId = directCostCategory.json().id;
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
    it('GET mileage-lots retorna 401 sem sessão', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/mileage-lots' });
      expect(response.statusCode).toBe(401);
    });

    it('GET mileage-lots retorna 403 para customer', async () => {
      const customer = await createVerifiedUser(app, email, 'cliente-fase5@example.com', 'Cliente Teste');
      const response = await app.inject({ method: 'GET', url: '/api/admin/finance/mileage-lots', headers: { cookie: customer.cookie } });
      expect(response.statusCode).toBe(403);
    });

    it('POST mileage-lots sem CSRF retorna 403', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/mileage-lots',
        headers: { cookie: master.cookie, origin: config.APP_ORIGIN },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('Compra de lote', () => {
    it('cria o lote e a obrigação de pagamento na mesma operação', async () => {
      const lot = await createLot({ quantityPurchased: 100_000, totalCostCents: 100_000 });
      expect(lot.obligationId).toBeTruthy();
      const obligations = await app.inject({ method: 'GET', url: '/api/admin/finance/obligations?kind=direct_cost', headers: { cookie: master.cookie } });
      const obligation = obligations.json().obligations.find((item: { id: string }) => item.id === lot.obligationId);
      expect(obligation).toEqual(expect.objectContaining({ amountCents: 100_000, currency: 'EUR', status: 'open' }));
    });

    it('rejeita categoria que não é custo direto', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/mileage-lots', headers: mutationHeaders(master),
        payload: {
          counterpartyId: mileageProviderId, program: 'Smiles', quantityPurchased: 10000, totalCostCents: 10000,
          currency: 'EUR', purchasedAt: '2026-01-01', dueDate: '2026-01-10', categoryId: expenseCategoryId,
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'category_must_be_direct_cost' });
    });
  });

  describe('Alocação e saldo', () => {
    it('bloqueia alocar mais milhas do que o saldo disponível', async () => {
      const lot = await createLot({ quantityPurchased: 1000, totalCostCents: 10000 });
      const issuance = await createIssuance({ mode: 'miles' });
      const excess = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 1001 },
      });
      expect(excess.statusCode).toBe(409);
      expect(excess.json()).toEqual({ error: 'insufficient_mileage_balance' });

      const ok = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 1000 },
      });
      expect(ok.statusCode, ok.body).toBe(201);

      const lotDetail = await app.inject({ method: 'GET', url: `/api/admin/finance/mileage-lots/${lot.id}`, headers: { cookie: master.cookie } });
      expect(lotDetail.json().mileageLot).toEqual(expect.objectContaining({ balanceQuantity: 0, status: 'depleted' }));
    });

    it('calcula o custo da alocação com precisão exata (arredondamento consistente, nunca float)', async () => {
      const lot = await createLot({ quantityPurchased: 3, totalCostCents: 100 });
      const issuance = await createIssuance({ mode: 'miles' });
      const allocation = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 1 },
      });
      expect(allocation.statusCode, allocation.body).toBe(201);
      const allocations = await app.inject({ method: 'GET', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: { cookie: master.cookie } });
      expect(allocations.json().allocations[0].costCentsSnapshot).toBe(33);
    });

    it('permite emissão híbrida alocando milhas de mais de um lote', async () => {
      const lotA = await createLot({ quantityPurchased: 500, totalCostCents: 5000 });
      const lotB = await createLot({ quantityPurchased: 500, totalCostCents: 6000 });
      const issuance = await createIssuance({ mode: 'hybrid' });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master), payload: { lotId: lotA.id, quantity: 300 } });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master), payload: { lotId: lotB.id, quantity: 200 } });
      const allocations = await app.inject({ method: 'GET', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: { cookie: master.cookie } });
      expect(allocations.json().allocations).toHaveLength(2);
    });

    it('rejeita alocação para emissão que não usa milhas', async () => {
      const lot = await createLot({ quantityPurchased: 1000, totalCostCents: 10000 });
      const issuance = await createIssuance({ mode: 'cash' });
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 100 },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'issuance_mode_does_not_use_miles' });
    });

    it('rejeita alocação depois que a emissão já foi emitida (custo travado)', async () => {
      const lot = await createLot({ quantityPurchased: 1000, totalCostCents: 10000 });
      const issuance = await createIssuance({ mode: 'miles', pnr: 'MIL123' });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/issue`, headers: mutationHeaders(master), payload: {} });
      const response = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 100 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'issuance_locked_after_issued' });
    });

    it('atualiza miles_quantity e miles_cost_cents da emissão automaticamente ao alocar', async () => {
      const lot = await createLot({ quantityPurchased: 1000, totalCostCents: 10000 });
      const issuance = await createIssuance({ mode: 'miles' });
      await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master), payload: { lotId: lot.id, quantity: 400 } });
      const detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${issuance.saleId}`, headers: { cookie: master.cookie } });
      const issuanceRow = detail.json().issuances.find((item: { id: string }) => item.id === issuance.id);
      expect(issuanceRow).toEqual(expect.objectContaining({ milesQuantity: 400, milesCostCents: 4000 }));
    });
  });

  describe('Estorno de alocação e cancelamento de lote', () => {
    it('estorna alocação como novo estado, devolve o saldo e reabre o lote esgotado', async () => {
      const lot = await createLot({ quantityPurchased: 100, totalCostCents: 1000 });
      const issuance = await createIssuance({ mode: 'miles' });
      const allocation = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 100 },
      });
      const allocationId = allocation.json().id;

      let lotDetail = await app.inject({ method: 'GET', url: `/api/admin/finance/mileage-lots/${lot.id}`, headers: { cookie: master.cookie } });
      expect(lotDetail.json().mileageLot.status).toBe('depleted');

      const voided = await app.inject({ method: 'POST', url: `/api/admin/finance/mileage-allocations/${allocationId}/void`, headers: mutationHeaders(master), payload: { reason: 'Alocado no lote errado' } });
      expect(voided.statusCode, voided.body).toBe(200);

      lotDetail = await app.inject({ method: 'GET', url: `/api/admin/finance/mileage-lots/${lot.id}`, headers: { cookie: master.cookie } });
      expect(lotDetail.json().mileageLot).toEqual(expect.objectContaining({ status: 'active', balanceQuantity: 100 }));

      const detail = await app.inject({ method: 'GET', url: `/api/admin/finance/sales/${issuance.saleId}`, headers: { cookie: master.cookie } });
      const issuanceRow = detail.json().issuances.find((item: { id: string }) => item.id === issuance.id);
      expect(issuanceRow).toEqual(expect.objectContaining({ milesQuantity: 0, milesCostCents: 0 }));
    });

    it('bloqueia cancelar lote com alocação ativa, e permite depois de estornada', async () => {
      const lot = await createLot({ quantityPurchased: 100, totalCostCents: 1000 });
      const issuance = await createIssuance({ mode: 'miles' });
      const allocation = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 50 },
      });
      const blocked = await app.inject({ method: 'POST', url: `/api/admin/finance/mileage-lots/${lot.id}/cancel`, headers: mutationHeaders(master), payload: { reason: 'Tentativa indevida' } });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toEqual({ error: 'mileage_lot_has_active_allocations' });

      await app.inject({ method: 'POST', url: `/api/admin/finance/mileage-allocations/${allocation.json().id}/void`, headers: mutationHeaders(master), payload: { reason: 'Erro' } });
      const canceled = await app.inject({ method: 'POST', url: `/api/admin/finance/mileage-lots/${lot.id}/cancel`, headers: mutationHeaders(master), payload: { reason: 'Fornecedor cancelou a compra' } });
      expect(canceled.statusCode, canceled.body).toBe(200);
    });

    it('bloqueia estornar a mesma alocação duas vezes', async () => {
      const lot = await createLot({ quantityPurchased: 100, totalCostCents: 1000 });
      const issuance = await createIssuance({ mode: 'miles' });
      const allocation = await app.inject({
        method: 'POST', url: `/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, headers: mutationHeaders(master),
        payload: { lotId: lot.id, quantity: 50 },
      });
      const allocationId = allocation.json().id;
      await app.inject({ method: 'POST', url: `/api/admin/finance/mileage-allocations/${allocationId}/void`, headers: mutationHeaders(master), payload: { reason: 'Erro' } });
      const secondVoid = await app.inject({ method: 'POST', url: `/api/admin/finance/mileage-allocations/${allocationId}/void`, headers: mutationHeaders(master), payload: { reason: 'De novo' } });
      expect(secondVoid.statusCode).toBe(409);
      expect(secondVoid.json()).toEqual({ error: 'allocation_already_voided' });
    });
  });

  describe('Contenção sequencial na última unidade disponível', () => {
    // Prova a lógica de negócio (a segunda chamada vê o saldo já reduzido pela primeira e é
    // rejeitada) contra o motor de teste padrão do projeto (pg-mem). Isto NÃO prova segurança sob
    // concorrência real — pg-mem processa comandos efetivamente em série e, como documentado em
    // tests/outbox-claim.pg-real.test.ts, nem sequer implementa o bloqueio de linha do jeito que o
    // Postgres real implementa. A prova real de concorrência (duas transações Postgres genuínas
    // disputando a mesma última unidade) está em tests/mileage-allocation-concurrency.pg-real.test.ts,
    // gated por ROTA_CERTA_TEST_REAL_PG_URL e não executada por `pnpm test`.
    it('a segunda chamada sequencial pela última unidade é rejeitada por saldo insuficiente', async () => {
      const lot = await createLot({ quantityPurchased: 10, totalCostCents: 1000 });
      const issuanceA = await createIssuance({ mode: 'miles' });
      const issuanceB = await createIssuance({ mode: 'miles' });
      const first = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuanceA.id}/mileage-allocations`, headers: mutationHeaders(master), payload: { lotId: lot.id, quantity: 7 } });
      const second = await app.inject({ method: 'POST', url: `/api/admin/finance/issuances/${issuanceB.id}/mileage-allocations`, headers: mutationHeaders(master), payload: { lotId: lot.id, quantity: 7 } });
      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'insufficient_mileage_balance' });
      const lotDetail = await app.inject({ method: 'GET', url: `/api/admin/finance/mileage-lots/${lot.id}`, headers: { cookie: master.cookie } });
      expect(lotDetail.json().mileageLot.balanceQuantity).toBe(3);
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

  async function createLot(overrides: Partial<{ quantityPurchased: number; totalCostCents: number; currency: string }> = {}) {
    const created = await app.inject({
      method: 'POST', url: '/api/admin/finance/mileage-lots', headers: mutationHeaders(master),
      payload: {
        counterpartyId: mileageProviderId, program: 'Smiles',
        quantityPurchased: overrides.quantityPurchased ?? 100_000, totalCostCents: overrides.totalCostCents ?? 100_000,
        currency: overrides.currency ?? 'EUR', purchasedAt: '2026-01-01', dueDate: '2026-01-10', categoryId: directCostCategoryId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return { id: created.json().id as string, obligationId: created.json().obligationId as string };
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

  async function createIssuance(overrides: Partial<{ mode: string; currency: string; pnr: string }> = {}) {
    const sale = await createSale(overrides.currency ? { currency: overrides.currency } : {});
    const created = await app.inject({
      method: 'POST', url: `/api/admin/finance/sales/${sale.id}/issuances`, headers: mutationHeaders(master),
      payload: { mode: overrides.mode ?? 'miles', currency: overrides.currency ?? 'EUR', pnr: overrides.pnr },
    });
    expect(created.statusCode, created.body).toBe(201);
    return { id: created.json().id as string, saleId: sale.id };
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
