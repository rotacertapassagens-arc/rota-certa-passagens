import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { ALLOWED_CURRENCIES, isUniqueViolation } from '../security.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);

const categoryKindSchema = z.enum(['revenue', 'direct_cost', 'operating_expense']);
const accountTypeSchema = z.enum(['bank', 'cash', 'card', 'digital_wallet', 'other']);
const counterpartyKindSchema = z.enum(['supplier', 'airline', 'consolidator', 'mileage_provider', 'other']);

const costCenterCreateSchema = z.object({ name: z.string().trim().min(2).max(120) });
const costCenterUpdateSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), active: z.boolean().optional() });

const categoryCreateSchema = z.object({
  kind: categoryKindSchema,
  name: z.string().trim().min(2).max(120),
  parentId: z.string().uuid().optional(),
  defaultCostCenterId: z.string().uuid().optional(),
});
const categoryUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  defaultCostCenterId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
});

const accountCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: accountTypeSchema,
  institution: z.string().trim().max(160).optional().or(z.literal('')),
  last4: z.string().regex(/^\d{4}$/).optional(),
  currency: CURRENCY_ENUM,
  openingBalanceCents: z.number().int().min(-100_000_000_00).max(100_000_000_00).optional(),
  openingBalanceAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
}).superRefine((data, ctx) => {
  if ((data.openingBalanceCents === undefined) !== (data.openingBalanceAt === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['openingBalanceAt'], message: 'opening_balance_pair_required' });
  }
});
const accountUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  institution: z.string().trim().max(160).optional().or(z.literal('')),
  last4: z.string().regex(/^\d{4}$/).nullable().optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  active: z.boolean().optional(),
});

const counterpartyCreateSchema = z.object({
  displayName: z.string().trim().min(2).max(160),
  kind: counterpartyKindSchema,
  taxId: z.string().trim().max(60).optional().or(z.literal('')),
  contact: z.string().trim().max(200).optional().or(z.literal('')),
  preferredCurrency: CURRENCY_ENUM.optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
});
const counterpartyUpdateSchema = z.object({
  displayName: z.string().trim().min(2).max(160).optional(),
  contact: z.string().trim().max(200).optional().or(z.literal('')),
  taxId: z.string().trim().max(60).optional().or(z.literal('')),
  preferredCurrency: CURRENCY_ENUM.optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  active: z.boolean().optional(),
});

export function registerFinanceRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  // Centros de custo
  app.get('/api/admin/finance/cost-centers', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const rows = await db.query('SELECT id,name,active,created_at,updated_at FROM fin_cost_centers ORDER BY name');
    return reply.send({ costCenters: rows.rows.map(serializeCostCenter) });
  });

  app.post('/api/admin/finance/cost-centers', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = costCenterCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_cost_center' });
    const id = randomUUID();
    try {
      await db.query('INSERT INTO fin_cost_centers (id,name) VALUES ($1,$2)', [id, parsed.data.name]);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'cost_center_name_taken' });
      throw error;
    }
    await audit(db, config, request, 'finance.cost_center_created', auth.userId, 'fin_cost_center', id, { name: parsed.data.name });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/cost-centers/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = costCenterUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    let result;
    try {
      result = await db.query(
        `UPDATE fin_cost_centers SET name=COALESCE($1,name),active=COALESCE($2,active),updated_at=now() WHERE id=$3 RETURNING id`,
        [parsed.data.name ?? null, parsed.data.active ?? null, params.data.id],
      );
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'cost_center_name_taken' });
      throw error;
    }
    if (!result.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'finance.cost_center_updated', auth.userId, 'fin_cost_center', params.data.id, sanitizeMetadata(parsed.data));
    return reply.send({ ok: true });
  });

  // Categorias
  app.get('/api/admin/finance/categories', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const rows = await db.query(
      'SELECT id,parent_id,kind,name,default_cost_center_id,active,created_at,updated_at FROM fin_categories ORDER BY kind,name',
    );
    return reply.send({ categories: rows.rows.map(serializeCategory) });
  });

  app.post('/api/admin/finance/categories', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = categoryCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_category' });
    if (parsed.data.parentId) {
      const parent = await db.query('SELECT kind FROM fin_categories WHERE id=$1', [parsed.data.parentId]);
      const parentRow = parent.rows[0] as { kind: string } | undefined;
      if (!parentRow) return reply.code(422).send({ error: 'parent_not_found' });
      if (parentRow.kind !== parsed.data.kind) return reply.code(422).send({ error: 'parent_kind_mismatch' });
    }
    if (parsed.data.defaultCostCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [parsed.data.defaultCostCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }
    const id = randomUUID();
    await db.query(
      'INSERT INTO fin_categories (id,parent_id,kind,name,default_cost_center_id) VALUES ($1,$2,$3,$4,$5)',
      [id, parsed.data.parentId ?? null, parsed.data.kind, parsed.data.name, parsed.data.defaultCostCenterId ?? null],
    );
    await audit(db, config, request, 'finance.category_created', auth.userId, 'fin_category', id, { kind: parsed.data.kind, name: parsed.data.name });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/categories/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = categoryUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (parsed.data.active === false) {
      const referenced = await db.query('SELECT 1 FROM fin_categories WHERE parent_id=$1 AND active=true LIMIT 1', [params.data.id]);
      if (referenced.rowCount) return reply.code(409).send({ error: 'category_has_active_children' });
    }
    if (parsed.data.defaultCostCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [parsed.data.defaultCostCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }
    const result = await db.query(
      `UPDATE fin_categories SET name=COALESCE($1,name),
              default_cost_center_id=CASE WHEN $2::boolean THEN $3 ELSE default_cost_center_id END,
              active=COALESCE($4,active),updated_at=now()
        WHERE id=$5 RETURNING id`,
      [parsed.data.name ?? null, 'defaultCostCenterId' in parsed.data, parsed.data.defaultCostCenterId ?? null, parsed.data.active ?? null, params.data.id],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'finance.category_updated', auth.userId, 'fin_category', params.data.id, sanitizeMetadata(parsed.data));
    return reply.send({ ok: true });
  });

  // Contas financeiras internas
  app.get('/api/admin/finance/accounts', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const rows = await db.query(
      'SELECT id,name,type,institution,last4,currency,opening_balance_cents,opening_balance_at,active,notes,created_at,updated_at FROM fin_accounts ORDER BY name',
    );
    return reply.send({ accounts: rows.rows.map(serializeAccount) });
  });

  app.post('/api/admin/finance/accounts', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = accountCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_account' });
    const id = randomUUID();
    await db.query(
      `INSERT INTO fin_accounts (id,name,type,institution,last4,currency,opening_balance_cents,opening_balance_at,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, parsed.data.name, parsed.data.type,
        parsed.data.institution || null, parsed.data.last4 ?? null, parsed.data.currency,
        parsed.data.openingBalanceCents ?? null, parsed.data.openingBalanceAt ?? null,
        parsed.data.notes || null,
      ],
    );
    await audit(db, config, request, 'finance.account_created', auth.userId, 'fin_account', id, { name: parsed.data.name, type: parsed.data.type });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/accounts/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = accountUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await db.query(
      `UPDATE fin_accounts SET name=COALESCE($1,name),
              institution=CASE WHEN $2::boolean THEN $3 ELSE institution END,
              last4=CASE WHEN $4::boolean THEN $5 ELSE last4 END,
              notes=CASE WHEN $6::boolean THEN $7 ELSE notes END,
              active=COALESCE($8,active),updated_at=now()
        WHERE id=$9 RETURNING id`,
      [
        parsed.data.name ?? null,
        'institution' in parsed.data, parsed.data.institution || null,
        'last4' in parsed.data, parsed.data.last4 ?? null,
        'notes' in parsed.data, parsed.data.notes || null,
        parsed.data.active ?? null, params.data.id,
      ],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'finance.account_updated', auth.userId, 'fin_account', params.data.id, sanitizeMetadata(parsed.data));
    return reply.send({ ok: true });
  });

  // Contrapartes (fornecedores, companhias, consolidadoras, fornecedores de milhas)
  app.get('/api/admin/finance/counterparties', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const rows = await db.query(
      'SELECT id,display_name,kind,tax_id,contact,preferred_currency,active,notes,created_at,updated_at FROM fin_counterparties ORDER BY display_name',
    );
    return reply.send({ counterparties: rows.rows.map(serializeCounterparty) });
  });

  app.post('/api/admin/finance/counterparties', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = counterpartyCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_counterparty' });
    const id = randomUUID();
    await db.query(
      `INSERT INTO fin_counterparties (id,display_name,kind,tax_id,contact,preferred_currency,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id, parsed.data.displayName, parsed.data.kind,
        parsed.data.taxId || null, parsed.data.contact || null,
        parsed.data.preferredCurrency ?? null, parsed.data.notes || null,
      ],
    );
    await audit(db, config, request, 'finance.counterparty_created', auth.userId, 'fin_counterparty', id, { displayName: parsed.data.displayName, kind: parsed.data.kind });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/counterparties/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = counterpartyUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await db.query(
      `UPDATE fin_counterparties SET display_name=COALESCE($1,display_name),
              contact=CASE WHEN $2::boolean THEN $3 ELSE contact END,
              tax_id=CASE WHEN $4::boolean THEN $5 ELSE tax_id END,
              preferred_currency=COALESCE($6,preferred_currency),
              notes=CASE WHEN $7::boolean THEN $8 ELSE notes END,
              active=COALESCE($9,active),updated_at=now()
        WHERE id=$10 RETURNING id`,
      [
        parsed.data.displayName ?? null,
        'contact' in parsed.data, parsed.data.contact || null,
        'taxId' in parsed.data, parsed.data.taxId || null,
        parsed.data.preferredCurrency ?? null,
        'notes' in parsed.data, parsed.data.notes || null,
        parsed.data.active ?? null, params.data.id,
      ],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'finance.counterparty_updated', auth.userId, 'fin_counterparty', params.data.id, sanitizeMetadata(parsed.data));
    return reply.send({ ok: true });
  });
}

function serializeCostCenter(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at };
}

function serializeCategory(row: Record<string, unknown>) {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    defaultCostCenterId: row.default_cost_center_id,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeAccount(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    institution: row.institution,
    last4: row.last4,
    currency: row.currency,
    openingBalanceCents: row.opening_balance_cents,
    openingBalanceAt: row.opening_balance_at,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeCounterparty(row: Record<string, unknown>) {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    taxId: row.tax_id,
    contact: row.contact,
    preferredCurrency: row.preferred_currency,
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Strips any value that is not a plain primitive before it is written to audit_events.metadata — never logs a full record, matching docs/financeiro/SEGURANCA_E_PERMISSOES.md. */
function sanitizeMetadata(data: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * Same 401/403 gate used by every other /api/admin/* route (see src/routes/admin.ts
 * requireMaster). `mutation` additionally enforces CSRF + Origin via requireMutationAuth —
 * required for every POST/PATCH, never for a GET.
 */
async function requireMaster(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply, mutation = false) {
  const auth = mutation ? await requireMutationAuth(db, config, request, reply) : await requireAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return auth;
}
