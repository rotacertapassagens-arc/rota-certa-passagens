import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { ALLOWED_CURRENCIES, isUniqueViolation } from '../security.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE);

const obligationCreateSchema = z.object({
  kind: z.enum(['direct_cost', 'operating_expense']),
  counterpartyId: z.string().uuid().optional(),
  categoryId: z.string().uuid(),
  costCenterId: z.string().uuid().optional(),
  competencyDate: dateSchema,
  dueDate: dateSchema,
  amountCents: z.number().int().min(1).max(100_000_000_00),
  currency: CURRENCY_ENUM,
  accountId: z.string().uuid().optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
});

const obligationUpdateSchema = z.object({
  categoryId: z.string().uuid().optional(),
  costCenterId: z.string().uuid().nullable().optional(),
  dueDate: dateSchema.optional(),
  accountId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
});

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const paymentCreateSchema = z.object({
  paidAmountCents: z.number().int().min(1).max(100_000_000_00),
  currency: CURRENCY_ENUM,
  paidAt: z.string().datetime().optional(),
  accountId: z.string().uuid(),
  reference: z.string().trim().max(120).optional().or(z.literal('')),
});

const reversalSchema = z.object({ reason: z.string().trim().min(3).max(500) });

class RequestError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

export function registerFinanceObligationRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/admin/finance/obligations', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = z.object({
      status: z.enum(['open', 'partial', 'paid', 'canceled', 'reversed']).optional(),
      kind: z.enum(['direct_cost', 'operating_expense']).optional(),
      dueBefore: dateSchema.optional(),
      counterpartyId: z.string().uuid().optional(),
      currency: CURRENCY_ENUM.optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const rows = await db.query(
      `SELECT id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,
              account_id,status,subscription_id,source,notes,canceled_at,cancel_reason,created_at,updated_at,
              (status IN ('open','partial') AND due_date < CURRENT_DATE) AS is_overdue
         FROM fin_obligations
        WHERE ($1::text IS NULL OR status=$1)
          AND ($2::text IS NULL OR kind=$2)
          AND ($3::date IS NULL OR due_date<=$3)
          AND ($4::uuid IS NULL OR counterparty_id=$4)
          AND ($5::text IS NULL OR currency=$5)
        ORDER BY due_date,created_at LIMIT 500`,
      [query.data.status ?? null, query.data.kind ?? null, query.data.dueBefore ?? null, query.data.counterpartyId ?? null, query.data.currency ?? null],
    );
    return reply.send({ obligations: rows.rows.map(serializeObligation) });
  });

  app.post('/api/admin/finance/obligations', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = obligationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_obligation' });
    const data = parsed.data;

    const category = await db.query<{ kind: string; default_cost_center_id: string | null }>(
      'SELECT kind,default_cost_center_id FROM fin_categories WHERE id=$1 AND active=true', [data.categoryId],
    );
    const categoryRow = category.rows[0];
    if (!categoryRow) return reply.code(422).send({ error: 'category_not_found' });
    if (categoryRow.kind !== data.kind) return reply.code(422).send({ error: 'category_kind_mismatch' });

    if (data.counterpartyId) {
      const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.counterpartyId]);
      if (!counterparty.rowCount) return reply.code(422).send({ error: 'counterparty_not_found' });
    }
    const costCenterId = data.costCenterId ?? categoryRow.default_cost_center_id ?? null;
    if (data.costCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [data.costCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }
    if (data.accountId) {
      const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
      if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });
    }

    const id = randomUUID();
    await db.query(
      `INSERT INTO fin_obligations
        (id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,account_id,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, data.kind, data.counterpartyId ?? null, data.categoryId, costCenterId, data.competencyDate, data.dueDate,
       data.amountCents, data.currency, data.accountId ?? null, data.notes || null, auth.userId],
    );
    await audit(db, config, request, 'finance.obligation_created', auth.userId, 'fin_obligation', id, { kind: data.kind, amountCents: data.amountCents, currency: data.currency });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/obligations/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = obligationUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const data = parsed.data;

    const existing = await db.query<{ status: string; kind: string }>('SELECT status,kind FROM fin_obligations WHERE id=$1', [params.data.id]);
    const obligation = existing.rows[0];
    if (!obligation) return reply.code(404).send({ error: 'not_found' });
    if (obligation.status === 'canceled' || obligation.status === 'reversed') return reply.code(409).send({ error: 'obligation_terminal' });

    if (data.categoryId) {
      const category = await db.query<{ kind: string }>('SELECT kind FROM fin_categories WHERE id=$1 AND active=true', [data.categoryId]);
      if (!category.rows[0]) return reply.code(422).send({ error: 'category_not_found' });
      if (category.rows[0].kind !== obligation.kind) return reply.code(422).send({ error: 'category_kind_mismatch' });
    }
    if (data.costCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [data.costCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }
    if (data.accountId) {
      const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
      if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });
    }

    const result = await db.query(
      `UPDATE fin_obligations SET
          category_id=COALESCE($1,category_id),
          cost_center_id=CASE WHEN $2::boolean THEN $3 ELSE cost_center_id END,
          due_date=COALESCE($4,due_date),
          account_id=CASE WHEN $5::boolean THEN $6 ELSE account_id END,
          notes=CASE WHEN $7::boolean THEN $8 ELSE notes END,
          updated_at=now()
        WHERE id=$9 RETURNING id`,
      [
        data.categoryId ?? null,
        'costCenterId' in data, data.costCenterId ?? null,
        data.dueDate ?? null,
        'accountId' in data, data.accountId ?? null,
        'notes' in data, data.notes || null,
        params.data.id,
      ],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'finance.obligation_updated', auth.userId, 'fin_obligation', params.data.id, {});
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/obligations/:id/cancel', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = cancelSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ status: string }>('SELECT status FROM fin_obligations WHERE id=$1 FOR UPDATE', [params.data.id]);
        const obligation = existing.rows[0];
        if (!obligation) throw new RequestError(404, 'not_found');
        if (obligation.status !== 'open') throw new RequestError(409, 'obligation_has_payments_or_terminal');
        await tx.query(
          "UPDATE fin_obligations SET status='canceled',canceled_at=now(),canceled_by=$1,cancel_reason=$2,updated_at=now() WHERE id=$3",
          [auth.userId, parsed.data.reason, params.data.id],
        );
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.obligation_canceled', auth.userId, 'fin_obligation', params.data.id, { reason: parsed.data.reason });
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/obligations/:id/payments', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = paymentCreateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_payment' });
    const data = parsed.data;

    const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
    if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });

    let paymentId = '';
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ status: string; currency: string; amount_cents: number }>(
          'SELECT status,currency,amount_cents FROM fin_obligations WHERE id=$1 FOR UPDATE', [params.data.id],
        );
        const obligation = existing.rows[0];
        if (!obligation) throw new RequestError(404, 'not_found');
        if (obligation.status === 'canceled' || obligation.status === 'reversed' || obligation.status === 'paid') {
          throw new RequestError(409, 'obligation_not_payable');
        }
        if (data.currency !== obligation.currency) throw new RequestError(422, 'payment_currency_must_match_obligation');
        paymentId = randomUUID();
        await tx.query(
          'INSERT INTO fin_obligation_payments (id,obligation_id,paid_amount_cents,currency,paid_at,account_id,reference,created_by) VALUES ($1,$2,$3,$4,COALESCE($5,now()),$6,$7,$8)',
          [paymentId, params.data.id, data.paidAmountCents, data.currency, data.paidAt ?? null, data.accountId, data.reference || null, auth.userId],
        );
        const total = await tx.query<{ sum: number }>('SELECT COALESCE(sum(paid_amount_cents),0)::int AS sum FROM fin_obligation_payments WHERE obligation_id=$1', [params.data.id]);
        const totalPaid = total.rows[0]?.sum ?? 0;
        const newStatus = totalPaid >= obligation.amount_cents ? 'paid' : totalPaid > 0 ? 'partial' : 'open';
        await tx.query('UPDATE fin_obligations SET status=$1,updated_at=now() WHERE id=$2', [newStatus, params.data.id]);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.obligation_payment_created', auth.userId, 'fin_obligation', params.data.id, { paidAmountCents: data.paidAmountCents, currency: data.currency });
    return reply.code(201).send({ id: paymentId });
  });

  app.get('/api/admin/finance/obligations/:id/payments', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await db.query(
      'SELECT id,paid_amount_cents,currency,paid_at,account_id,reference,reversal_of,reversal_reason,created_at FROM fin_obligation_payments WHERE obligation_id=$1 ORDER BY created_at',
      [params.data.id],
    );
    return reply.send({ payments: rows.rows.map(serializePayment) });
  });

  app.post('/api/admin/finance/obligation-payments/:id/reverse', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = reversalSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    let reversalId = '';
    try {
      await db.transaction(async (tx) => {
        const existing = await tx.query<{ obligation_id: string; paid_amount_cents: number; currency: string; account_id: string; reversal_of: string | null }>(
          'SELECT obligation_id,paid_amount_cents,currency,account_id,reversal_of FROM fin_obligation_payments WHERE id=$1 FOR UPDATE', [params.data.id],
        );
        const payment = existing.rows[0];
        if (!payment) throw new RequestError(404, 'not_found');
        if (payment.paid_amount_cents < 0) throw new RequestError(409, 'cannot_reverse_a_reversal');

        const obligation = await tx.query<{ status: string; amount_cents: number }>('SELECT status,amount_cents FROM fin_obligations WHERE id=$1 FOR UPDATE', [payment.obligation_id]);
        const obligationRow = obligation.rows[0];
        if (!obligationRow) throw new RequestError(404, 'not_found');

        reversalId = randomUUID();
        try {
          await tx.query(
            'INSERT INTO fin_obligation_payments (id,obligation_id,paid_amount_cents,currency,account_id,reversal_of,reversal_reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [reversalId, payment.obligation_id, -payment.paid_amount_cents, payment.currency, payment.account_id, params.data.id, parsed.data.reason, auth.userId],
          );
        } catch (error) {
          if (isUniqueViolation(error)) throw new RequestError(409, 'payment_already_reversed');
          throw error;
        }
        const total = await tx.query<{ sum: number }>('SELECT COALESCE(sum(paid_amount_cents),0)::int AS sum FROM fin_obligation_payments WHERE obligation_id=$1', [payment.obligation_id]);
        const totalPaid = total.rows[0]?.sum ?? 0;
        const newStatus = totalPaid >= obligationRow.amount_cents ? 'paid' : totalPaid > 0 ? 'partial' : 'open';
        await tx.query('UPDATE fin_obligations SET status=$1,updated_at=now() WHERE id=$2', [newStatus, payment.obligation_id]);
      });
    } catch (error) {
      if (error instanceof RequestError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
    await audit(db, config, request, 'finance.obligation_payment_reversed', auth.userId, 'fin_obligation_payment', params.data.id, { reason: parsed.data.reason });
    return reply.code(201).send({ id: reversalId });
  });
}

function serializeObligation(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    counterpartyId: row.counterparty_id,
    categoryId: row.category_id,
    costCenterId: row.cost_center_id,
    competencyDate: row.competency_date,
    dueDate: row.due_date,
    amountCents: row.amount_cents,
    currency: row.currency,
    accountId: row.account_id,
    status: row.status,
    subscriptionId: row.subscription_id,
    source: row.source,
    notes: row.notes,
    canceledAt: row.canceled_at,
    cancelReason: row.cancel_reason,
    isOverdue: Boolean(row.is_overdue),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializePayment(row: Record<string, unknown>) {
  return {
    id: row.id,
    paidAmountCents: row.paid_amount_cents,
    currency: row.currency,
    paidAt: row.paid_at,
    accountId: row.account_id,
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
