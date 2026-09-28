import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { ALLOWED_CURRENCIES } from '../security.js';
import { calculateSaleProfit, sumIssuanceDirectCostCents } from '../../shared/salesProfit.js';
import { serializeIssuance } from './finance-issuances.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE);
const METHOD_ENUM = z.enum(['pix', 'transfer', 'card', 'cash', 'boleto', 'other']);

const fromLeadSchema = z.object({
  discountCents: z.number().int().min(0).max(100_000_000_00).default(0),
  saleDate: dateSchema.optional(),
});

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const refundSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const installmentSchema = z.object({
  dueDate: dateSchema,
  expectedAmountCents: z.number().int().min(1).max(100_000_000_00),
  method: METHOD_ENUM,
  accountId: z.string().uuid().optional(),
});
const receivablesCreateSchema = z.object({ installments: z.array(installmentSchema).min(1).max(24) });

const receivablePaymentSchema = z.object({
  receivedAmountCents: z.number().int().min(1).max(100_000_000_00),
  currency: CURRENCY_ENUM,
  receivedAt: z.string().datetime().optional(),
  accountId: z.string().uuid(),
  gatewayFeeCents: z.number().int().min(0).max(100_000_000_00).optional(),
  reference: z.string().trim().max(120).optional().or(z.literal('')),
});

const reversalSchema = z.object({ reason: z.string().trim().min(3).max(500) });

class RequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

export function registerFinanceSalesRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/admin/finance/sales', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = z.object({
      status: z.enum(['confirmed', 'canceled', 'refunded']).optional(),
      partnerId: z.string().uuid().optional(),
      currency: CURRENCY_ENUM.optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const rows = await db.query(
      `SELECT id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,
              passenger_count,owner_user_id,partner_id,status,internal_notes,terminated_at,termination_reason,created_at,updated_at
         FROM fin_sales
        WHERE ($1::text IS NULL OR status=$1) AND ($2::uuid IS NULL OR partner_id=$2) AND ($3::text IS NULL OR currency=$3)
        ORDER BY sale_date DESC,created_at DESC LIMIT 500`,
      [query.data.status ?? null, query.data.partnerId ?? null, query.data.currency ?? null],
    );
    const totals = await receivableTotalsBySale(db);
    return reply.send({ sales: rows.rows.map((row) => serializeSale(row, totals.get(String(row.id)))) });
  });

  app.get('/api/admin/finance/sales/:id', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const sale = await db.query(
      `SELECT id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,
              passenger_count,owner_user_id,partner_id,status,internal_notes,terminated_at,termination_reason,created_at,updated_at
         FROM fin_sales WHERE id=$1`,
      [params.data.id],
    );
    const row = sale.rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const receivables = await db.query(
      'SELECT id,installment_number,due_date,expected_amount_cents,currency,account_id,method,status,canceled_at,cancel_reason,created_at,updated_at FROM fin_receivables WHERE sale_id=$1 ORDER BY installment_number',
      [params.data.id],
    );
    const totals = await receivableTotalsBySale(db, params.data.id);
    const issuances = await db.query(
      `SELECT id,sale_id,mode,airline,loyalty_program,pnr,ticket_numbers,currency,cash_amount_cents,miles_quantity,miles_cost_cents,
              airport_fees_cents,issuance_fee_cents,consolidator_fee_cents,gateway_fee_cents,agent_commission_cents,other_costs_cents,
              mileage_provider_id,consolidator_id,status,issued_at,issued_by,terminated_at,terminated_by,termination_reason,notes,
              created_at,updated_at
         FROM fin_issuances WHERE sale_id=$1 ORDER BY created_at`,
      [params.data.id],
    );
    const profit = calculateSaleProfitSummary(row.net_amount_cents as number, issuances.rows as Array<Record<string, unknown>>);
    return reply.send({
      sale: serializeSale(row, totals.get(params.data.id)),
      receivables: receivables.rows.map(serializeReceivable),
      issuances: issuances.rows.map(serializeIssuance),
      profit,
    });
  });

  // Idempotente: uma proposta já convertida (lead_requests.status='converted') nunca gera mais
  // de uma fin_sales — chamar de novo devolve a venda já existente em vez de criar/errar. Nunca
  // recria a comissão do parceiro nem altera lead_requests: apenas referencia.
  app.post('/api/admin/finance/sales/from-lead/:leadRequestId', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ leadRequestId: z.string().uuid() }).safeParse(request.params);
    const parsed = fromLeadSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const existing = await db.query<{ id: string }>('SELECT id FROM fin_sales WHERE lead_request_id=$1', [params.data.leadRequestId]);
    if (existing.rows[0]) return reply.send({ id: existing.rows[0].id, alreadyExisted: true });

    const lead = await db.query<{
      id: string; status: string; protocol: string | null; sale_amount_cents: number | null; sale_currency: string | null;
      partner_id: string | null; adults: number; children: number; infants: number;
    }>(
      "SELECT id,status,protocol,sale_amount_cents,sale_currency,partner_id,adults,children,infants FROM lead_requests WHERE id=$1 AND kind='flight_quote'",
      [params.data.leadRequestId],
    );
    const leadRow = lead.rows[0];
    if (!leadRow) return reply.code(404).send({ error: 'lead_not_found' });
    if (leadRow.status !== 'converted') return reply.code(409).send({ error: 'lead_not_converted' });
    if (leadRow.sale_amount_cents === null || !leadRow.sale_currency) return reply.code(422).send({ error: 'sale_amount_missing' });
    if (!leadRow.protocol) return reply.code(422).send({ error: 'lead_protocol_missing' });

    const grossAmountCents = leadRow.sale_amount_cents;
    const discountCents = parsed.data.discountCents;
    if (discountCents >= grossAmountCents) return reply.code(422).send({ error: 'discount_exceeds_gross_amount' });
    const netAmountCents = grossAmountCents - discountCents;
    const passengerCount = leadRow.adults + leadRow.children + leadRow.infants;
    const saleDate = parsed.data.saleDate ?? new Date().toISOString().slice(0, 10);

    const id = randomUUID();
    try {
      await db.query(
        `INSERT INTO fin_sales
          (id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,passenger_count,owner_user_id,partner_id,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, leadRow.id, leadRow.protocol, saleDate, leadRow.sale_currency, grossAmountCents, discountCents, netAmountCents,
         passengerCount, auth.userId, leadRow.partner_id, auth.userId],
      );
    } catch {
      // Lost a race against a concurrent call for the same lead: fall back to whichever row won,
      // never report a duplicate creation nor a second sale for the same proposal.
      const raceExisting = await db.query<{ id: string }>('SELECT id FROM fin_sales WHERE lead_request_id=$1', [params.data.leadRequestId]);
      if (raceExisting.rows[0]) return reply.send({ id: raceExisting.rows[0].id, alreadyExisted: true });
      throw new RequestError(500, 'sale_creation_failed');
    }
    await audit(db, config, request, 'finance.sale_created', auth.userId, 'fin_sale', id, { leadRequestId: leadRow.id, grossAmountCents, currency: leadRow.sale_currency });
    return reply.code(201).send({ id, alreadyExisted: false });
  });

  app.post('/api/admin/finance/sales/:id/cancel', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = cancelSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const sale = await tx.query<{ status: string }>('SELECT status FROM fin_sales WHERE id=$1 FOR UPDATE', [params.data.id]);
        if (!sale.rows[0]) throw new RequestError(404, 'not_found');
        if (sale.rows[0].status !== 'confirmed') throw new RequestError(409, 'sale_not_cancelable');
        const received = await tx.query<{ sum: number }>(
          `SELECT COALESCE(sum(p.received_amount_cents),0)::int AS sum FROM fin_receivable_payments p
             JOIN fin_receivables r ON r.id=p.receivable_id WHERE r.sale_id=$1`,
          [params.data.id],
        );
        if ((received.rows[0]?.sum ?? 0) !== 0) throw new RequestError(409, 'sale_has_payments_use_refund');
        await tx.query(
          "UPDATE fin_sales SET status='canceled',terminated_at=now(),terminated_by=$1,termination_reason=$2,updated_at=now() WHERE id=$3",
          [auth.userId, parsed.data.reason, params.data.id],
        );
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.sale_canceled', auth.userId, 'fin_sale', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/sales/:id/refund', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = refundSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const sale = await tx.query<{ status: string }>('SELECT status FROM fin_sales WHERE id=$1 FOR UPDATE', [params.data.id]);
        if (!sale.rows[0]) throw new RequestError(404, 'not_found');
        if (sale.rows[0].status !== 'confirmed') throw new RequestError(409, 'sale_not_refundable');
        const received = await tx.query<{ sum: number }>(
          `SELECT COALESCE(sum(p.received_amount_cents),0)::int AS sum FROM fin_receivable_payments p
             JOIN fin_receivables r ON r.id=p.receivable_id WHERE r.sale_id=$1`,
          [params.data.id],
        );
        if ((received.rows[0]?.sum ?? 0) <= 0) throw new RequestError(409, 'sale_has_no_payments_use_cancel');
        await tx.query(
          "UPDATE fin_sales SET status='refunded',terminated_at=now(),terminated_by=$1,termination_reason=$2,updated_at=now() WHERE id=$3",
          [auth.userId, parsed.data.reason, params.data.id],
        );
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.sale_refunded', auth.userId, 'fin_sale', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/finance/sales/:id/receivables', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await db.query(
      'SELECT id,installment_number,due_date,expected_amount_cents,currency,account_id,method,status,canceled_at,cancel_reason,created_at,updated_at FROM fin_receivables WHERE sale_id=$1 ORDER BY installment_number',
      [params.data.id],
    );
    return reply.send({ receivables: rows.rows.map(serializeReceivable) });
  });

  app.post('/api/admin/finance/sales/:id/receivables', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = receivablesCreateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const createdIds: string[] = [];
    try {
      await db.transaction(async (tx) => {
        const sale = await tx.query<{ status: string; currency: string; net_amount_cents: number }>(
          'SELECT status,currency,net_amount_cents FROM fin_sales WHERE id=$1 FOR UPDATE', [params.data.id],
        );
        const saleRow = sale.rows[0];
        if (!saleRow) throw new RequestError(404, 'not_found');
        if (saleRow.status !== 'confirmed') throw new RequestError(409, 'sale_not_confirmed');

        for (const installment of parsed.data.installments) {
          if (installment.accountId) {
            const account = await tx.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [installment.accountId]);
            if (!account.rowCount) throw new RequestError(422, 'account_not_found');
          }
        }

        const existingTotal = await tx.query<{ sum: number; max_installment: number }>(
          "SELECT COALESCE(sum(expected_amount_cents),0)::int AS sum,COALESCE(max(installment_number),0)::int AS max_installment FROM fin_receivables WHERE sale_id=$1 AND status<>'canceled'",
          [params.data.id],
        );
        const alreadyCommitted = existingTotal.rows[0]?.sum ?? 0;
        let nextNumber = (existingTotal.rows[0]?.max_installment ?? 0) + 1;
        const newTotal = parsed.data.installments.reduce((sum, item) => sum + item.expectedAmountCents, 0);
        if (alreadyCommitted + newTotal > saleRow.net_amount_cents) throw new RequestError(409, 'installments_exceed_sale_amount');

        for (const installment of parsed.data.installments) {
          const id = randomUUID();
          await tx.query(
            'INSERT INTO fin_receivables (id,sale_id,installment_number,due_date,expected_amount_cents,currency,account_id,method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [id, params.data.id, nextNumber, installment.dueDate, installment.expectedAmountCents, saleRow.currency, installment.accountId ?? null, installment.method],
          );
          createdIds.push(id);
          nextNumber += 1;
        }
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.receivables_created', auth.userId, 'fin_sale', params.data.id, { count: createdIds.length });
    return reply.code(201).send({ ids: createdIds });
  });

  app.get('/api/admin/finance/receivables/:id/payments', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await db.query(
      'SELECT id,received_amount_cents,currency,received_at,account_id,gateway_fee_cents,reference,reversal_of,reversal_reason,created_at FROM fin_receivable_payments WHERE receivable_id=$1 ORDER BY created_at',
      [params.data.id],
    );
    return reply.send({ payments: rows.rows.map(serializeReceivablePayment) });
  });

  app.post('/api/admin/finance/receivables/:id/payments', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = receivablePaymentSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_payment' });
    const data = parsed.data;

    const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
    if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });

    let paymentId = '';
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ status: string; currency: string; expected_amount_cents: number }>(
          'SELECT status,currency,expected_amount_cents FROM fin_receivables WHERE id=$1 FOR UPDATE', [params.data.id],
        );
        const receivable = existing.rows[0];
        if (!receivable) throw new RequestError(404, 'not_found');
        if (receivable.status === 'canceled' || receivable.status === 'refunded' || receivable.status === 'paid') {
          throw new RequestError(409, 'receivable_not_payable');
        }
        if (data.currency !== receivable.currency) throw new RequestError(422, 'payment_currency_must_match_receivable');
        paymentId = randomUUID();
        await tx.query(
          'INSERT INTO fin_receivable_payments (id,receivable_id,received_amount_cents,currency,received_at,account_id,gateway_fee_cents,reference,created_by) VALUES ($1,$2,$3,$4,COALESCE($5,now()),$6,$7,$8,$9)',
          [paymentId, params.data.id, data.receivedAmountCents, data.currency, data.receivedAt ?? null, data.accountId, data.gatewayFeeCents ?? null, data.reference || null, auth.userId],
        );
        const total = await tx.query<{ sum: number }>('SELECT COALESCE(sum(received_amount_cents),0)::int AS sum FROM fin_receivable_payments WHERE receivable_id=$1', [params.data.id]);
        const totalReceived = total.rows[0]?.sum ?? 0;
        const newStatus = totalReceived >= receivable.expected_amount_cents ? 'paid' : totalReceived > 0 ? 'partial' : 'open';
        await tx.query('UPDATE fin_receivables SET status=$1,updated_at=now() WHERE id=$2', [newStatus, params.data.id]);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.receivable_payment_created', auth.userId, 'fin_receivable', params.data.id, { receivedAmountCents: data.receivedAmountCents, currency: data.currency });
    return reply.code(201).send({ id: paymentId });
  });

  app.post('/api/admin/finance/receivable-payments/:id/reverse', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = reversalSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    let reversalId = '';
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ receivable_id: string; received_amount_cents: number; currency: string; account_id: string }>(
          'SELECT receivable_id,received_amount_cents,currency,account_id FROM fin_receivable_payments WHERE id=$1 FOR UPDATE', [params.data.id],
        );
        const payment = existing.rows[0];
        if (!payment) throw new RequestError(404, 'not_found');
        if (payment.received_amount_cents < 0) throw new RequestError(409, 'cannot_reverse_a_reversal');

        const receivable = await tx.query<{ expected_amount_cents: number }>('SELECT expected_amount_cents FROM fin_receivables WHERE id=$1 FOR UPDATE', [payment.receivable_id]);
        const receivableRow = receivable.rows[0];
        if (!receivableRow) throw new RequestError(404, 'not_found');

        reversalId = randomUUID();
        try {
          await tx.query(
            'INSERT INTO fin_receivable_payments (id,receivable_id,received_amount_cents,currency,account_id,reversal_of,reversal_reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [reversalId, payment.receivable_id, -payment.received_amount_cents, payment.currency, payment.account_id, params.data.id, parsed.data.reason, auth.userId],
          );
        } catch (error) {
          throw new RequestError(409, 'payment_already_reversed');
        }
        const total = await tx.query<{ sum: number }>('SELECT COALESCE(sum(received_amount_cents),0)::int AS sum FROM fin_receivable_payments WHERE receivable_id=$1', [payment.receivable_id]);
        const totalReceived = total.rows[0]?.sum ?? 0;
        const newStatus = totalReceived >= receivableRow.expected_amount_cents ? 'paid' : totalReceived > 0 ? 'partial' : 'open';
        await tx.query('UPDATE fin_receivables SET status=$1,updated_at=now() WHERE id=$2', [newStatus, payment.receivable_id]);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.receivable_payment_reversed', auth.userId, 'fin_receivable_payment', params.data.id, { reason: parsed.data.reason });
    return reply.code(201).send({ id: reversalId });
  });
}

interface SaleTotals {
  expectedTotal: number;
  receivedTotal: number;
  receivableCount: number;
}

/**
 * Aggregates receivable/payment totals per sale in application code rather than a single SQL
 * join with FILTER (WHERE ...) and a correlated subquery — mirrors the exact reasoning already
 * documented in src/routes/admin.ts (commissionByLead): not every SQL engine this repo tests
 * against (pg-mem) parses those constructs the same way real Postgres does. `saleId` narrows to
 * a single sale (used by the detail endpoint); omitted, it aggregates every sale (list endpoint,
 * bounded by the same 500-row cap as the sales query itself).
 */
async function receivableTotalsBySale(db: Database, saleId?: string): Promise<Map<string, SaleTotals>> {
  const receivables = await db.query<{ sale_id: string; status: string; expected_amount_cents: number }>(
    saleId
      ? 'SELECT sale_id,status,expected_amount_cents FROM fin_receivables WHERE sale_id=$1'
      : 'SELECT sale_id,status,expected_amount_cents FROM fin_receivables',
    saleId ? [saleId] : [],
  );
  const payments = await db.query<{ sale_id: string; received_amount_cents: number }>(
    `SELECT r.sale_id,p.received_amount_cents FROM fin_receivable_payments p
       JOIN fin_receivables r ON r.id=p.receivable_id ${saleId ? 'WHERE r.sale_id=$1' : ''}`,
    saleId ? [saleId] : [],
  );
  const totals = new Map<string, SaleTotals>();
  for (const row of receivables.rows) {
    const key = String(row.sale_id);
    const entry = totals.get(key) ?? { expectedTotal: 0, receivedTotal: 0, receivableCount: 0 };
    if (row.status !== 'canceled') {
      entry.expectedTotal += row.expected_amount_cents;
      entry.receivableCount += 1;
    }
    totals.set(key, entry);
  }
  for (const row of payments.rows) {
    const key = String(row.sale_id);
    const entry = totals.get(key) ?? { expectedTotal: 0, receivedTotal: 0, receivableCount: 0 };
    entry.receivedTotal += row.received_amount_cents;
    totals.set(key, entry);
  }
  return totals;
}

function serializeSale(row: Record<string, unknown>, totals?: SaleTotals) {
  const expectedTotal = totals?.expectedTotal ?? 0;
  const receivedTotal = totals?.receivedTotal ?? 0;
  const receivableCount = totals?.receivableCount ?? 0;
  let financialStatus: string;
  if (row.status === 'canceled') financialStatus = 'canceled';
  else if (row.status === 'refunded') financialStatus = 'refunded';
  else if (receivableCount === 0) financialStatus = 'no_receivables';
  else if (receivedTotal >= expectedTotal && expectedTotal > 0) financialStatus = 'paid';
  else if (receivedTotal > 0) financialStatus = 'partial';
  else financialStatus = 'open';
  return {
    id: row.id,
    leadRequestId: row.lead_request_id,
    protocol: row.protocol,
    saleDate: row.sale_date,
    currency: row.currency,
    grossAmountCents: row.gross_amount_cents,
    discountCents: row.discount_cents,
    netAmountCents: row.net_amount_cents,
    passengerCount: row.passenger_count,
    ownerUserId: row.owner_user_id,
    partnerId: row.partner_id,
    status: row.status,
    financialStatus,
    internalNotes: row.internal_notes,
    terminatedAt: row.terminated_at,
    terminationReason: row.termination_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lucro/margem por venda, calculado no servidor a partir das emissões — nunca aceito pronto do
 * cliente. `realized` soma custo de emissões já `issued`/`refunded` (o compromisso financeiro já
 * aconteceu); `projected` soma custo de emissões ainda `pending`. Emissões `canceled` nunca
 * entram em nenhuma das duas somas. Ambas usam calculateSaleProfit (shared/salesProfit.ts), que
 * já bloqueia dividir por um net_amount_cents <= 0 — impossível aqui pela própria CHECK de
 * fin_sales, mas a função continua sendo a única fonte da regra de cálculo.
 */
function calculateSaleProfitSummary(netAmountCents: number, issuanceRows: Array<Record<string, unknown>>) {
  let realizedDirectCostCents = 0;
  let projectedDirectCostCents = 0;
  for (const row of issuanceRows) {
    const directCost = sumIssuanceDirectCostCents({
      cashAmountCents: Number(row.cash_amount_cents),
      milesCostCents: Number(row.miles_cost_cents),
      airportFeesCents: Number(row.airport_fees_cents),
      issuanceFeeCents: Number(row.issuance_fee_cents),
      consolidatorFeeCents: Number(row.consolidator_fee_cents),
      gatewayFeeCents: Number(row.gateway_fee_cents),
      agentCommissionCents: Number(row.agent_commission_cents),
      otherCostsCents: Number(row.other_costs_cents),
    });
    if (row.status === 'issued' || row.status === 'refunded') realizedDirectCostCents += directCost;
    else if (row.status === 'pending') projectedDirectCostCents += directCost;
  }
  const realized = calculateSaleProfit(netAmountCents, realizedDirectCostCents);
  const projected = calculateSaleProfit(netAmountCents, realizedDirectCostCents + projectedDirectCostCents);
  return {
    realizedDirectCostCents,
    projectedDirectCostCents,
    realizedGrossProfitCents: realized.grossProfitCents,
    realizedMarginBps: realized.marginBps,
    projectedGrossProfitCents: projected.grossProfitCents,
    projectedMarginBps: projected.marginBps,
  };
}

function serializeReceivable(row: Record<string, unknown>) {
  return {
    id: row.id,
    installmentNumber: row.installment_number,
    dueDate: row.due_date,
    expectedAmountCents: row.expected_amount_cents,
    currency: row.currency,
    accountId: row.account_id,
    method: row.method,
    status: row.status,
    canceledAt: row.canceled_at,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeReceivablePayment(row: Record<string, unknown>) {
  return {
    id: row.id,
    receivedAmountCents: row.received_amount_cents,
    currency: row.currency,
    receivedAt: row.received_at,
    accountId: row.account_id,
    gatewayFeeCents: row.gateway_fee_cents,
    reference: row.reference,
    reversalOf: row.reversal_of,
    reversalReason: row.reversal_reason,
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
