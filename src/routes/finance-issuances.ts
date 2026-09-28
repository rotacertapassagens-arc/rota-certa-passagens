import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { ALLOWED_CURRENCIES } from '../security.js';
import { isValidIssuanceTransition } from '../../shared/salesProfit.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);
const MODE_ENUM = z.enum(['cash', 'miles', 'hybrid', 'consolidator', 'airline', 'other']);
const costField = z.number().int().min(0).max(100_000_000_00).default(0);

const issuanceCreateSchema = z.object({
  mode: MODE_ENUM,
  airline: z.string().trim().max(120).optional().or(z.literal('')),
  loyaltyProgram: z.string().trim().max(120).optional().or(z.literal('')),
  pnr: z.string().trim().max(20).optional().or(z.literal('')),
  ticketNumbers: z.string().trim().max(500).optional().or(z.literal('')),
  currency: CURRENCY_ENUM,
  cashAmountCents: costField,
  milesQuantity: z.number().int().min(0).max(100_000_000).default(0),
  milesCostCents: costField,
  airportFeesCents: costField,
  issuanceFeeCents: costField,
  consolidatorFeeCents: costField,
  gatewayFeeCents: costField,
  agentCommissionCents: costField,
  otherCostsCents: costField,
  mileageProviderId: z.string().uuid().optional(),
  consolidatorId: z.string().uuid().optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
});

const issuanceUpdateSchema = issuanceCreateSchema.partial().omit({ currency: true });
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const refundSchema = z.object({ reason: z.string().trim().min(3).max(500) });

class RequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

export function registerFinanceIssuanceRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/admin/finance/sales/:saleId/issuances', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ saleId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await db.query(issuanceSelect('WHERE sale_id=$1 ORDER BY created_at'), [params.data.saleId]);
    return reply.send({ issuances: rows.rows.map(serializeIssuance) });
  });

  app.post('/api/admin/finance/sales/:saleId/issuances', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ saleId: z.string().uuid() }).safeParse(request.params);
    const parsed = issuanceCreateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_issuance' });
    const data = parsed.data;

    const sale = await db.query<{ status: string; currency: string }>('SELECT status,currency FROM fin_sales WHERE id=$1', [params.data.saleId]);
    const saleRow = sale.rows[0];
    if (!saleRow) return reply.code(404).send({ error: 'sale_not_found' });
    if (saleRow.status !== 'confirmed') return reply.code(409).send({ error: 'sale_not_confirmed' });
    if (data.currency !== saleRow.currency) return reply.code(422).send({ error: 'issuance_currency_must_match_sale' });

    if (data.mileageProviderId) {
      const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.mileageProviderId]);
      if (!counterparty.rowCount) return reply.code(422).send({ error: 'mileage_provider_not_found' });
    }
    if (data.consolidatorId) {
      const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.consolidatorId]);
      if (!counterparty.rowCount) return reply.code(422).send({ error: 'consolidator_not_found' });
    }

    const id = randomUUID();
    await db.query(
      `INSERT INTO fin_issuances
        (id,sale_id,mode,airline,loyalty_program,pnr,ticket_numbers,currency,cash_amount_cents,miles_quantity,miles_cost_cents,
         airport_fees_cents,issuance_fee_cents,consolidator_fee_cents,gateway_fee_cents,agent_commission_cents,other_costs_cents,
         mileage_provider_id,consolidator_id,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        id, params.data.saleId, data.mode, data.airline || null, data.loyaltyProgram || null, data.pnr || null, data.ticketNumbers || null,
        data.currency, data.cashAmountCents, data.milesQuantity, data.milesCostCents,
        data.airportFeesCents, data.issuanceFeeCents, data.consolidatorFeeCents, data.gatewayFeeCents, data.agentCommissionCents, data.otherCostsCents,
        data.mileageProviderId ?? null, data.consolidatorId ?? null, data.notes || null, auth.userId,
      ],
    );
    await audit(db, config, request, 'finance.issuance_created', auth.userId, 'fin_issuance', id, { saleId: params.data.saleId, mode: data.mode });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/issuances/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = issuanceUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const data = parsed.data;

    const existing = await db.query<{ status: string }>('SELECT status FROM fin_issuances WHERE id=$1', [params.data.id]);
    if (!existing.rows[0]) return reply.code(404).send({ error: 'not_found' });
    // Custo histórico de uma emissão já emitida nunca é alterado retroativamente — só campos
    // ainda em 'pending' podem ser corrigidos antes do compromisso real.
    if (existing.rows[0].status !== 'pending') return reply.code(409).send({ error: 'issuance_locked_after_issued' });

    if (data.mileageProviderId) {
      const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.mileageProviderId]);
      if (!counterparty.rowCount) return reply.code(422).send({ error: 'mileage_provider_not_found' });
    }
    if (data.consolidatorId) {
      const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.consolidatorId]);
      if (!counterparty.rowCount) return reply.code(422).send({ error: 'consolidator_not_found' });
    }

    const result = await db.query(
      `UPDATE fin_issuances SET
          mode=COALESCE($1,mode),
          airline=CASE WHEN $2::boolean THEN $3 ELSE airline END,
          loyalty_program=CASE WHEN $4::boolean THEN $5 ELSE loyalty_program END,
          pnr=CASE WHEN $6::boolean THEN $7 ELSE pnr END,
          ticket_numbers=CASE WHEN $8::boolean THEN $9 ELSE ticket_numbers END,
          cash_amount_cents=COALESCE($10,cash_amount_cents),
          miles_quantity=COALESCE($11,miles_quantity),
          miles_cost_cents=COALESCE($12,miles_cost_cents),
          airport_fees_cents=COALESCE($13,airport_fees_cents),
          issuance_fee_cents=COALESCE($14,issuance_fee_cents),
          consolidator_fee_cents=COALESCE($15,consolidator_fee_cents),
          gateway_fee_cents=COALESCE($16,gateway_fee_cents),
          agent_commission_cents=COALESCE($17,agent_commission_cents),
          other_costs_cents=COALESCE($18,other_costs_cents),
          mileage_provider_id=CASE WHEN $19::boolean THEN $20 ELSE mileage_provider_id END,
          consolidator_id=CASE WHEN $21::boolean THEN $22 ELSE consolidator_id END,
          notes=CASE WHEN $23::boolean THEN $24 ELSE notes END,
          updated_at=now()
        WHERE id=$25 AND status='pending' RETURNING id`,
      [
        data.mode ?? null,
        'airline' in data, data.airline || null,
        'loyaltyProgram' in data, data.loyaltyProgram || null,
        'pnr' in data, data.pnr || null,
        'ticketNumbers' in data, data.ticketNumbers || null,
        data.cashAmountCents ?? null, data.milesQuantity ?? null, data.milesCostCents ?? null,
        data.airportFeesCents ?? null, data.issuanceFeeCents ?? null, data.consolidatorFeeCents ?? null, data.gatewayFeeCents ?? null,
        data.agentCommissionCents ?? null, data.otherCostsCents ?? null,
        'mileageProviderId' in data, data.mileageProviderId ?? null,
        'consolidatorId' in data, data.consolidatorId ?? null,
        'notes' in data, data.notes || null,
        params.data.id,
      ],
    );
    if (!result.rowCount) return reply.code(409).send({ error: 'issuance_locked_after_issued' });
    await audit(db, config, request, 'finance.issuance_updated', auth.userId, 'fin_issuance', params.data.id, {});
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/issuances/:id/issue', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ status: string; pnr: string | null }>('SELECT status,pnr FROM fin_issuances WHERE id=$1 FOR UPDATE', [params.data.id]);
        const issuance = existing.rows[0];
        if (!issuance) throw new RequestError(404, 'not_found');
        if (!isValidIssuanceTransition(issuance.status, 'issued')) throw new RequestError(409, 'invalid_transition');
        if (!issuance.pnr) throw new RequestError(422, 'pnr_required_to_issue');
        await tx.query("UPDATE fin_issuances SET status='issued',issued_at=now(),issued_by=$1,updated_at=now() WHERE id=$2", [auth.userId, params.data.id]);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.issuance_issued', auth.userId, 'fin_issuance', params.data.id, {});
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/issuances/:id/cancel', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = cancelSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ status: string }>('SELECT status FROM fin_issuances WHERE id=$1 FOR UPDATE', [params.data.id]);
        const issuance = existing.rows[0];
        if (!issuance) throw new RequestError(404, 'not_found');
        if (!isValidIssuanceTransition(issuance.status, 'canceled')) throw new RequestError(409, 'invalid_transition');
        await tx.query(
          "UPDATE fin_issuances SET status='canceled',terminated_at=now(),terminated_by=$1,termination_reason=$2,updated_at=now() WHERE id=$3",
          [auth.userId, parsed.data.reason, params.data.id],
        );
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.issuance_canceled', auth.userId, 'fin_issuance', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/issuances/:id/refund', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = refundSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ status: string }>('SELECT status FROM fin_issuances WHERE id=$1 FOR UPDATE', [params.data.id]);
        const issuance = existing.rows[0];
        if (!issuance) throw new RequestError(404, 'not_found');
        if (!isValidIssuanceTransition(issuance.status, 'refunded')) throw new RequestError(409, 'invalid_transition');
        await tx.query(
          "UPDATE fin_issuances SET status='refunded',terminated_at=now(),terminated_by=$1,termination_reason=$2,updated_at=now() WHERE id=$3",
          [auth.userId, parsed.data.reason, params.data.id],
        );
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.issuance_refunded', auth.userId, 'fin_issuance', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });
}

function issuanceSelect(tail: string) {
  return `SELECT id,sale_id,mode,airline,loyalty_program,pnr,ticket_numbers,currency,cash_amount_cents,miles_quantity,miles_cost_cents,
                 airport_fees_cents,issuance_fee_cents,consolidator_fee_cents,gateway_fee_cents,agent_commission_cents,other_costs_cents,
                 mileage_provider_id,consolidator_id,status,issued_at,issued_by,terminated_at,terminated_by,termination_reason,notes,
                 created_at,updated_at
            FROM fin_issuances ${tail}`;
}

export function serializeIssuance(row: Record<string, unknown>) {
  return {
    id: row.id,
    saleId: row.sale_id,
    mode: row.mode,
    airline: row.airline,
    loyaltyProgram: row.loyalty_program,
    pnr: row.pnr,
    ticketNumbers: row.ticket_numbers,
    currency: row.currency,
    cashAmountCents: row.cash_amount_cents,
    milesQuantity: row.miles_quantity,
    milesCostCents: row.miles_cost_cents,
    airportFeesCents: row.airport_fees_cents,
    issuanceFeeCents: row.issuance_fee_cents,
    consolidatorFeeCents: row.consolidator_fee_cents,
    gatewayFeeCents: row.gateway_fee_cents,
    agentCommissionCents: row.agent_commission_cents,
    otherCostsCents: row.other_costs_cents,
    mileageProviderId: row.mileage_provider_id,
    consolidatorId: row.consolidator_id,
    status: row.status,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    terminatedAt: row.terminated_at,
    terminationReason: row.termination_reason,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
