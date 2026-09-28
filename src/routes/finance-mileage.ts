import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { ALLOWED_CURRENCIES } from '../security.js';
import { allocationCostCents, unitCostMicros } from '../../shared/mileageCost.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE);

const lotCreateSchema = z.object({
  counterpartyId: z.string().uuid(),
  program: z.string().trim().min(2).max(120),
  quantityPurchased: z.number().int().min(1).max(100_000_000),
  totalCostCents: z.number().int().min(1).max(100_000_000_00),
  currency: CURRENCY_ENUM,
  purchasedAt: dateSchema,
  expiresAt: dateSchema.optional(),
  categoryId: z.string().uuid(),
  dueDate: dateSchema,
  accountId: z.string().uuid().optional(),
  costCenterId: z.string().uuid().optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
});

const cancelLotSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const allocationCreateSchema = z.object({
  lotId: z.string().uuid(),
  quantity: z.number().int().min(1).max(100_000_000),
});

const voidAllocationSchema = z.object({ reason: z.string().trim().min(3).max(500) });

class RequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

export function registerFinanceMileageRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/admin/finance/mileage-lots', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = z.object({
      counterpartyId: z.string().uuid().optional(),
      program: z.string().trim().max(120).optional(),
      status: z.enum(['active', 'depleted', 'expired', 'canceled']).optional(),
      currency: CURRENCY_ENUM.optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const rows = await db.query(
      `SELECT id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,
              expires_at,status,obligation_id,notes,created_at,updated_at
         FROM fin_mileage_lots
        WHERE ($1::uuid IS NULL OR counterparty_id=$1) AND ($2::text IS NULL OR program=$2)
          AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR currency=$4)
        ORDER BY purchased_at DESC,created_at DESC LIMIT 500`,
      [query.data.counterpartyId ?? null, query.data.program ?? null, query.data.status ?? null, query.data.currency ?? null],
    );
    const allocated = await allocatedQuantityByLot(db);
    return reply.send({ mileageLots: rows.rows.map((row) => serializeLot(row, allocated.get(String(row.id)) ?? 0)) });
  });

  app.get('/api/admin/finance/mileage-lots/:id', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const lot = await db.query(
      `SELECT id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,
              expires_at,status,obligation_id,notes,created_at,updated_at
         FROM fin_mileage_lots WHERE id=$1`,
      [params.data.id],
    );
    const row = lot.rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const allocations = await db.query(
      'SELECT id,lot_id,issuance_id,quantity,cost_cents_snapshot,voided_at,voided_by,void_reason,created_at FROM fin_mileage_allocations WHERE lot_id=$1 ORDER BY created_at',
      [params.data.id],
    );
    const allocatedQuantity = allocations.rows.filter((allocation) => !allocation.voided_at).reduce((sum, allocation) => sum + Number(allocation.quantity), 0);
    return reply.send({ mileageLot: serializeLot(row, allocatedQuantity), allocations: allocations.rows.map(serializeAllocation) });
  });

  // Cria a obrigação de pagamento e o lote na mesma transação — nunca um lote comprado sem
  // registro do que é devido ao fornecedor (seção 9.8 do prompt mestre).
  app.post('/api/admin/finance/mileage-lots', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = lotCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_mileage_lot' });
    const data = parsed.data;

    const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.counterpartyId]);
    if (!counterparty.rowCount) return reply.code(422).send({ error: 'counterparty_not_found' });
    const category = await db.query<{ kind: string; default_cost_center_id: string | null }>(
      'SELECT kind,default_cost_center_id FROM fin_categories WHERE id=$1 AND active=true', [data.categoryId],
    );
    const categoryRow = category.rows[0];
    if (!categoryRow) return reply.code(422).send({ error: 'category_not_found' });
    if (categoryRow.kind !== 'direct_cost') return reply.code(422).send({ error: 'category_must_be_direct_cost' });
    if (data.accountId) {
      const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
      if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });
    }
    const costCenterId = data.costCenterId ?? categoryRow.default_cost_center_id ?? null;
    if (data.costCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [data.costCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }

    const lotId = randomUUID();
    const obligationId = randomUUID();
    const unitCost = unitCostMicros(data.totalCostCents, data.quantityPurchased);
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO fin_obligations
          (id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,account_id,notes,created_by)
         VALUES ($1,'direct_cost',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [obligationId, data.counterpartyId, data.categoryId, costCenterId, data.purchasedAt, data.dueDate,
         data.totalCostCents, data.currency, data.accountId ?? null, `Compra de lote de milhas: ${data.program}`, auth.userId],
      );
      await tx.query(
        `INSERT INTO fin_mileage_lots
          (id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,expires_at,obligation_id,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [lotId, data.counterpartyId, data.program, data.quantityPurchased, data.totalCostCents, data.currency,
         unitCost, data.purchasedAt, data.expiresAt ?? null, obligationId, data.notes || null, auth.userId],
      );
    });
    await audit(db, config, request, 'finance.mileage_lot_created', auth.userId, 'fin_mileage_lot', lotId, { program: data.program, quantityPurchased: data.quantityPurchased, totalCostCents: data.totalCostCents, currency: data.currency });
    return reply.code(201).send({ id: lotId, obligationId });
  });

  app.post('/api/admin/finance/mileage-lots/:id/cancel', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = cancelLotSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const lot = await tx.query<{ status: string }>('SELECT status FROM fin_mileage_lots WHERE id=$1 FOR UPDATE', [params.data.id]);
        if (!lot.rows[0]) throw new RequestError(404, 'not_found');
        if (lot.rows[0].status === 'canceled') throw new RequestError(409, 'mileage_lot_already_canceled');
        const active = await tx.query('SELECT 1 FROM fin_mileage_allocations WHERE lot_id=$1 AND voided_at IS NULL LIMIT 1', [params.data.id]);
        // Lote com alocação ativa nunca pode ser cancelado — estorne cada alocação primeiro.
        if (active.rowCount) throw new RequestError(409, 'mileage_lot_has_active_allocations');
        await tx.query('UPDATE fin_mileage_lots SET status=\'canceled\',updated_at=now() WHERE id=$1', [params.data.id]);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.mileage_lot_canceled', auth.userId, 'fin_mileage_lot', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/finance/issuances/:issuanceId/mileage-allocations', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ issuanceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await db.query(
      'SELECT id,lot_id,issuance_id,quantity,cost_cents_snapshot,voided_at,voided_by,void_reason,created_at FROM fin_mileage_allocations WHERE issuance_id=$1 ORDER BY created_at',
      [params.data.issuanceId],
    );
    return reply.send({ allocations: rows.rows.map(serializeAllocation) });
  });

  // Aloca milhas de um lote para uma emissão, dentro de uma transação com FOR UPDATE no lote —
  // nunca permite saldo negativo mesmo sob concorrência (duas chamadas simultâneas disputando a
  // última unidade disponível: a segunda a obter o lock vê o saldo já reduzido pela primeira).
  app.post('/api/admin/finance/issuances/:issuanceId/mileage-allocations', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ issuanceId: z.string().uuid() }).safeParse(request.params);
    const parsed = allocationCreateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_allocation' });
    const data = parsed.data;

    let allocationId = '';
    try {
      await db.transaction(async (tx) => {
        const issuance = await tx.query<{ status: string; mode: string; currency: string }>(
          'SELECT status,mode,currency FROM fin_issuances WHERE id=$1 FOR UPDATE', [params.data.issuanceId],
        );
        const issuanceRow = issuance.rows[0];
        if (!issuanceRow) throw new RequestError(404, 'issuance_not_found');
        if (issuanceRow.status !== 'pending') throw new RequestError(409, 'issuance_locked_after_issued');
        if (issuanceRow.mode !== 'miles' && issuanceRow.mode !== 'hybrid') throw new RequestError(422, 'issuance_mode_does_not_use_miles');

        const lot = await tx.query<{ status: string; currency: string; quantity_purchased: number; total_cost_cents: number; expires_at: string | null }>(
          'SELECT status,currency,quantity_purchased,total_cost_cents,expires_at FROM fin_mileage_lots WHERE id=$1 FOR UPDATE', [data.lotId],
        );
        const lotRow = lot.rows[0];
        if (!lotRow) throw new RequestError(404, 'mileage_lot_not_found');
        if (lotRow.status !== 'active' && lotRow.status !== 'depleted') throw new RequestError(409, 'mileage_lot_not_active');
        if (lotRow.expires_at && lotRow.expires_at < todayDateOnly()) throw new RequestError(409, 'mileage_lot_expired');
        if (lotRow.currency !== issuanceRow.currency) throw new RequestError(422, 'mileage_lot_currency_must_match_issuance');

        const allocatedTotal = await tx.query<{ sum: number }>(
          'SELECT COALESCE(sum(quantity),0)::int AS sum FROM fin_mileage_allocations WHERE lot_id=$1 AND voided_at IS NULL', [data.lotId],
        );
        const alreadyAllocated = allocatedTotal.rows[0]?.sum ?? 0;
        const remaining = lotRow.quantity_purchased - alreadyAllocated;
        if (data.quantity > remaining) throw new RequestError(409, 'insufficient_mileage_balance');

        const costCentsSnapshot = allocationCostCents(lotRow.total_cost_cents, lotRow.quantity_purchased, data.quantity);
        allocationId = randomUUID();
        await tx.query(
          'INSERT INTO fin_mileage_allocations (id,lot_id,issuance_id,quantity,cost_cents_snapshot,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [allocationId, data.lotId, params.data.issuanceId, data.quantity, costCentsSnapshot, auth.userId],
        );

        const newRemaining = remaining - data.quantity;
        await tx.query('UPDATE fin_mileage_lots SET status=$1,updated_at=now() WHERE id=$2', [newRemaining === 0 ? 'depleted' : 'active', data.lotId]);
        await recomputeIssuanceMiles(tx, params.data.issuanceId);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.mileage_allocation_created', auth.userId, 'fin_mileage_allocation', allocationId, { lotId: data.lotId, issuanceId: params.data.issuanceId, quantity: data.quantity });
    return reply.code(201).send({ id: allocationId });
  });

  app.post('/api/admin/finance/mileage-allocations/:id/void', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = voidAllocationSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const allocation = await tx.query<{ lot_id: string; issuance_id: string; voided_at: string | null }>(
          'SELECT lot_id,issuance_id,voided_at FROM fin_mileage_allocations WHERE id=$1 FOR UPDATE', [params.data.id],
        );
        const allocationRow = allocation.rows[0];
        if (!allocationRow) throw new RequestError(404, 'not_found');
        if (allocationRow.voided_at) throw new RequestError(409, 'allocation_already_voided');
        const issuance = await tx.query<{ status: string }>('SELECT status FROM fin_issuances WHERE id=$1 FOR UPDATE', [allocationRow.issuance_id]);
        if (issuance.rows[0]?.status !== 'pending') throw new RequestError(409, 'issuance_locked_after_issued');

        await tx.query('UPDATE fin_mileage_allocations SET voided_at=now(),voided_by=$1,void_reason=$2 WHERE id=$3', [auth.userId, parsed.data.reason, params.data.id]);
        // Estornar sempre pode reativar um lote que tinha ficado 'depleted' — nunca o contrário
        // (voidar não pode, por si só, esgotar um lote).
        await tx.query('UPDATE fin_mileage_lots SET status=\'active\',updated_at=now() WHERE id=$1 AND status=\'depleted\'', [allocationRow.lot_id]);
        await recomputeIssuanceMiles(tx, allocationRow.issuance_id);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.mileage_allocation_voided', auth.userId, 'fin_mileage_allocation', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });
}

async function recomputeIssuanceMiles(tx: Database, issuanceId: string) {
  const totals = await tx.query<{ qty: number; cost: number }>(
    "SELECT COALESCE(sum(quantity),0)::int AS qty,COALESCE(sum(cost_cents_snapshot),0)::int AS cost FROM fin_mileage_allocations WHERE issuance_id=$1 AND voided_at IS NULL",
    [issuanceId],
  );
  const row = totals.rows[0];
  await tx.query('UPDATE fin_issuances SET miles_quantity=$1,miles_cost_cents=$2,updated_at=now() WHERE id=$3', [row?.qty ?? 0, row?.cost ?? 0, issuanceId]);
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

async function allocatedQuantityByLot(db: Database): Promise<Map<string, number>> {
  const rows = await db.query<{ lot_id: string; quantity: number }>('SELECT lot_id,quantity FROM fin_mileage_allocations WHERE voided_at IS NULL');
  const totals = new Map<string, number>();
  for (const row of rows.rows) {
    const key = String(row.lot_id);
    totals.set(key, (totals.get(key) ?? 0) + Number(row.quantity));
  }
  return totals;
}

function serializeLot(row: Record<string, unknown>, allocatedQuantity: number) {
  const quantityPurchased = Number(row.quantity_purchased);
  const isExpired = Boolean(row.expires_at) && String(row.expires_at) < todayDateOnly();
  return {
    id: row.id,
    counterpartyId: row.counterparty_id,
    program: row.program,
    quantityPurchased,
    totalCostCents: row.total_cost_cents,
    currency: row.currency,
    unitCostMicros: row.unit_cost_micros,
    purchasedAt: row.purchased_at,
    expiresAt: row.expires_at,
    status: row.status,
    isExpired,
    obligationId: row.obligation_id,
    notes: row.notes,
    balanceQuantity: quantityPurchased - allocatedQuantity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeAllocation(row: Record<string, unknown>) {
  return {
    id: row.id,
    lotId: row.lot_id,
    issuanceId: row.issuance_id,
    quantity: row.quantity,
    costCentsSnapshot: row.cost_cents_snapshot,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
    createdAt: row.created_at,
  };
}

async function requireMaster(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply, mutation = false) {
  const auth = mutation ? await requireMutationAuth(db, config, request, reply) : await requireAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return auth;
}
