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

describe('Finance module — Fase 1 (fundação segura)', () => {
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

  describe('Autorização — sem sessão e sem papel master', () => {
    const getRoutes = [
      '/api/admin/finance/cost-centers',
      '/api/admin/finance/categories',
      '/api/admin/finance/accounts',
      '/api/admin/finance/counterparties',
    ];

    it.each(getRoutes)('GET %s retorna 401 sem cookie de sessão', async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    });

    it.each(getRoutes)('GET %s retorna 403 para usuário autenticado sem papel master', async (url) => {
      const customer = await createVerifiedUser(app, email, 'cliente-financeiro@example.com', 'Cliente Teste');
      const response = await app.inject({ method: 'GET', url, headers: { cookie: customer.cookie } });
      expect(response.statusCode).toBe(403);
    });

    it('POST /api/admin/finance/categories retorna 401 sem sessão', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/admin/finance/categories', payload: { kind: 'operating_expense', name: 'Assinaturas' } });
      expect(response.statusCode).toBe(401);
    });

    it('POST /api/admin/finance/categories retorna 403 para customer autenticado', async () => {
      const customer = await createVerifiedUser(app, email, 'cliente-financeiro-2@example.com', 'Cliente Teste 2');
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/finance/categories',
        headers: mutationHeaders(customer),
        payload: { kind: 'operating_expense', name: 'Assinaturas' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('POST /api/admin/finance/accounts com sessão master mas sem CSRF retorna 403', async () => {
      const master = await createMaster(app, email, 'master-financeiro@example.com');
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/finance/accounts',
        headers: { cookie: master.cookie, origin: config.APP_ORIGIN },
        payload: { name: 'Conta principal', type: 'bank', currency: 'EUR' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'csrf_rejected' });
    });

    it('master autenticado com CSRF válido consegue criar e listar', async () => {
      const master = await createMaster(app, email, 'master-financeiro-2@example.com');
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/finance/accounts',
        headers: mutationHeaders(master),
        payload: { name: 'Conta principal', type: 'bank', currency: 'EUR' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/accounts', headers: { cookie: master.cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().accounts).toHaveLength(1);
    });
  });

  describe('Categorias', () => {
    it('cria categoria de despesa operacional e bloqueia kind divergente da categoria-pai', async () => {
      const master = await createMaster(app, email, 'master-cat@example.com');
      const parent = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', name: 'Assinaturas' },
      });
      expect(parent.statusCode, parent.body).toBe(201);
      const parentId = parent.json().id;

      const mismatched = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'direct_cost', name: 'Cloud', parentId },
      });
      expect(mismatched.statusCode).toBe(422);
      expect(mismatched.json()).toEqual({ error: 'parent_kind_mismatch' });

      const child = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'operating_expense', name: 'Ferramentas de marketing', parentId },
      });
      expect(child.statusCode, child.body).toBe(201);
    });

    it('bloqueia desativar categoria que ainda tem subcategoria ativa', async () => {
      const master = await createMaster(app, email, 'master-cat-2@example.com');
      const parent = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'revenue', name: 'Vendas de passagens' },
      });
      const parentId = parent.json().id;
      await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'revenue', name: 'Vendas nacionais', parentId },
      });

      const deactivate = await app.inject({
        method: 'PATCH', url: `/api/admin/finance/categories/${parentId}`, headers: mutationHeaders(master),
        payload: { active: false },
      });
      expect(deactivate.statusCode).toBe(409);
      expect(deactivate.json()).toEqual({ error: 'category_has_active_children' });
    });

    it('rejeita categoria referenciando centro de custo inexistente', async () => {
      const master = await createMaster(app, email, 'master-cat-3@example.com');
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/categories', headers: mutationHeaders(master),
        payload: { kind: 'direct_cost', name: 'Milhas', defaultCostCenterId: '00000000-0000-4000-8000-000000000000' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'cost_center_not_found' });
    });
  });

  describe('Centros de custo', () => {
    it('não permite dois centros de custo com o mesmo nome (case-insensitive)', async () => {
      const master = await createMaster(app, email, 'master-cc@example.com');
      const first = await app.inject({ method: 'POST', url: '/api/admin/finance/cost-centers', headers: mutationHeaders(master), payload: { name: 'Comercial' } });
      expect(first.statusCode).toBe(201);
      const duplicate = await app.inject({ method: 'POST', url: '/api/admin/finance/cost-centers', headers: mutationHeaders(master), payload: { name: 'comercial' } });
      expect(duplicate.statusCode).toBe(409);
    });

    it('atualiza nome e desativa sem apagar o registro', async () => {
      const master = await createMaster(app, email, 'master-cc-2@example.com');
      const created = await app.inject({ method: 'POST', url: '/api/admin/finance/cost-centers', headers: mutationHeaders(master), payload: { name: 'Operações' } });
      const id = created.json().id;
      const updated = await app.inject({ method: 'PATCH', url: `/api/admin/finance/cost-centers/${id}`, headers: mutationHeaders(master), payload: { active: false } });
      expect(updated.statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/cost-centers', headers: { cookie: master.cookie } });
      const row = list.json().costCenters.find((item: { id: string }) => item.id === id);
      expect(row).toEqual(expect.objectContaining({ id, name: 'Operações', active: false }));
    });
  });

  describe('Contas financeiras internas', () => {
    it('exige par completo (valor + data) para saldo inicial', async () => {
      const master = await createMaster(app, email, 'master-acc@example.com');
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/accounts', headers: mutationHeaders(master),
        payload: { name: 'Carteira EUR', type: 'digital_wallet', currency: 'EUR', openingBalanceCents: 10000 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('nunca aceita dado de cartão completo, apenas os últimos 4 dígitos', async () => {
      const master = await createMaster(app, email, 'master-acc-2@example.com');
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/accounts', headers: mutationHeaders(master),
        payload: { name: 'Cartão corporativo', type: 'card', currency: 'BRL', last4: '4242' },
      });
      expect(response.statusCode, response.body).toBe(201);
      const list = await app.inject({ method: 'GET', url: '/api/admin/finance/accounts', headers: { cookie: master.cookie } });
      expect(list.json().accounts[0].last4).toBe('4242');
    });
  });

  describe('Contrapartes — distintas de parceiros de indicação', () => {
    it('cria fornecedor de milhas sem interferir na tabela partners existente', async () => {
      const master = await createMaster(app, email, 'master-cp@example.com');
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/counterparties', headers: mutationHeaders(master),
        payload: { displayName: 'Fornecedor de Milhas XYZ', kind: 'mileage_provider', preferredCurrency: 'BRL' },
      });
      expect(response.statusCode, response.body).toBe(201);

      const partners = await app.inject({ method: 'GET', url: '/api/admin/partners', headers: { cookie: master.cookie } });
      expect(partners.statusCode).toBe(200);
      expect(partners.json().partners).toEqual([]);

      const counterparties = await app.inject({ method: 'GET', url: '/api/admin/finance/counterparties', headers: { cookie: master.cookie } });
      expect(counterparties.json().counterparties).toHaveLength(1);
      expect(counterparties.json().counterparties[0]).toEqual(expect.objectContaining({ displayName: 'Fornecedor de Milhas XYZ', kind: 'mileage_provider' }));
    });

    it('rejeita moeda preferida fora da lista suportada', async () => {
      const master = await createMaster(app, email, 'master-cp-2@example.com');
      const response = await app.inject({
        method: 'POST', url: '/api/admin/finance/counterparties', headers: mutationHeaders(master),
        payload: { displayName: 'Consolidadora ABC', kind: 'consolidator', preferredCurrency: 'JPY' },
      });
      expect(response.statusCode).toBe(400);
    });
  });
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
