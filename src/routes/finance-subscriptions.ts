import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { audit, requireAuth, requireMutationAuth } from '../auth.js';
import { ALLOWED_CURRENCIES } from '../security.js';
import { isValidSubscriptionTransition, nextChargeDate, subscriptionChargeIdempotencyKey, type SubscriptionPeriodicity } from '../../shared/subscriptionSchedule.js';

const CURRENCY_ENUM = z.enum(ALLOWED_CURRENCIES);
const PERIODICITY_ENUM = z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'custom']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE);

const subscriptionCreateSchema = z.object({
  counterpartyId: z.string().uuid(),
  service: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  plan: z.string().trim().max(120).optional().or(z.literal('')),
  amountCents: z.number().int().min(1).max(100_000_000_00),
  currency: CURRENCY_ENUM,
  periodicity: PERIODICITY_ENUM,
  customIntervalDays: z.number().int().min(1).max(3650).optional(),
  startedAt: dateSchema,
  billingDay: z.number().int().min(1).max(31).optional(),
  autoRenew: z.boolean().default(true),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid(),
  costCenterId: z.string().uuid().optional(),
  status: z.enum(['trial', 'active']).default('active'),
  adminUrl: z.string().url().max(500).optional().or(z.literal('')),
  responsibleUserId: z.string().uuid().optional(),
  noticeDays: z.number().int().min(0).max(365).default(7),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
}).superRefine((data, ctx) => {
  if ((data.periodicity === 'custom') !== (data.customIntervalDays !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['customIntervalDays'], message: 'custom_interval_required' });
  }
});

const subscriptionUpdateSchema = z.object({
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  plan: z.string().trim().max(120).optional().or(z.literal('')),
  billingDay: z.number().int().min(1).max(31).nullable().optional(),
  autoRenew: z.boolean().optional(),
  accountId: z.string().uuid().nullable().optional(),
  costCenterId: z.string().uuid().nullable().optional(),
  adminUrl: z.string().url().max(500).optional().or(z.literal('')),
  responsibleUserId: z.string().uuid().nullable().optional(),
  noticeDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
});

const repriceSchema = z.object({
  amountCents: z.number().int().min(1).max(100_000_000_00),
  currency: CURRENCY_ENUM,
  effectiveAt: dateSchema,
});

const statusChangeSchema = z.object({
  status: z.enum(['trial', 'active', 'suspended', 'canceled', 'ended']),
  reason: z.string().trim().max(500).optional(),
});

export function registerFinanceSubscriptionRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  app.get('/api/admin/finance/subscriptions', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = z.object({ status: z.enum(['trial', 'active', 'suspended', 'canceled', 'ended']).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const rows = await db.query(
      `SELECT id,counterparty_id,service,description,plan,amount_cents,currency,periodicity,custom_interval_days,
              next_charge_at,billing_day,auto_renew,account_id,category_id,cost_center_id,status,started_at,ended_at,
              admin_url,responsible_user_id,notice_days,notes,created_at,updated_at
         FROM fin_subscriptions
        WHERE $1::text IS NULL OR status=$1
        ORDER BY next_charge_at`,
      [query.data.status ?? null],
    );
    return reply.send({ subscriptions: rows.rows.map(serializeSubscription) });
  });

  app.post('/api/admin/finance/subscriptions', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const parsed = subscriptionCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_subscription' });
    const data = parsed.data;

    const category = await db.query<{ kind: string }>('SELECT kind FROM fin_categories WHERE id=$1 AND active=true', [data.categoryId]);
    if (!category.rows[0]) return reply.code(422).send({ error: 'category_not_found' });
    if (category.rows[0].kind !== 'operating_expense') return reply.code(422).send({ error: 'category_must_be_operating_expense' });

    const counterparty = await db.query('SELECT 1 FROM fin_counterparties WHERE id=$1 AND active=true', [data.counterpartyId]);
    if (!counterparty.rowCount) return reply.code(422).send({ error: 'counterparty_not_found' });

    if (data.accountId) {
      const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
      if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });
    }
    const costCenterId = data.costCenterId ?? null;
    if (costCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [costCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }

    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO fin_subscriptions
          (id,counterparty_id,service,description,plan,amount_cents,currency,periodicity,custom_interval_days,
           next_charge_at,billing_day,auto_renew,account_id,category_id,cost_center_id,status,started_at,
           admin_url,responsible_user_id,notice_days,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          id, data.counterpartyId, data.service, data.description || null, data.plan || null,
          data.amountCents, data.currency, data.periodicity, data.customIntervalDays ?? null,
          data.startedAt, data.billingDay ?? null, data.autoRenew, data.accountId ?? null,
          data.categoryId, costCenterId, data.status, data.startedAt,
          data.adminUrl || null, data.responsibleUserId ?? null, data.noticeDays, data.notes || null, auth.userId,
        ],
      );
      await tx.query(
        'INSERT INTO fin_subscription_price_history (id,subscription_id,amount_cents,currency,effective_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, data.amountCents, data.currency, data.startedAt, auth.userId],
      );
    });
    await audit(db, config, request, 'finance.subscription_created', auth.userId, 'fin_subscription', id, { service: data.service, amountCents: data.amountCents, currency: data.currency });
    return reply.code(201).send({ id });
  });

  app.patch('/api/admin/finance/subscriptions/:id', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = subscriptionUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const data = parsed.data;
    if (data.accountId) {
      const account = await db.query('SELECT 1 FROM fin_accounts WHERE id=$1 AND active=true', [data.accountId]);
      if (!account.rowCount) return reply.code(422).send({ error: 'account_not_found' });
    }
    if (data.costCenterId) {
      const costCenter = await db.query('SELECT 1 FROM fin_cost_centers WHERE id=$1', [data.costCenterId]);
      if (!costCenter.rowCount) return reply.code(422).send({ error: 'cost_center_not_found' });
    }
    const result = await db.query(
      `UPDATE fin_subscriptions SET
          description=CASE WHEN $1::boolean THEN $2 ELSE description END,
          plan=CASE WHEN $3::boolean THEN $4 ELSE plan END,
          billing_day=CASE WHEN $5::boolean THEN $6 ELSE billing_day END,
          auto_renew=COALESCE($7,auto_renew),
          account_id=CASE WHEN $8::boolean THEN $9 ELSE account_id END,
          cost_center_id=CASE WHEN $10::boolean THEN $11 ELSE cost_center_id END,
          admin_url=CASE WHEN $12::boolean THEN $13 ELSE admin_url END,
          responsible_user_id=CASE WHEN $14::boolean THEN $15 ELSE responsible_user_id END,
          notice_days=COALESCE($16,notice_days),
          notes=CASE WHEN $17::boolean THEN $18 ELSE notes END,
          updated_at=now()
        WHERE id=$19 RETURNING id`,
      [
        'description' in data, data.description || null,
        'plan' in data, data.plan || null,
        'billingDay' in data, data.billingDay ?? null,
        data.autoRenew ?? null,
        'accountId' in data, data.accountId ?? null,
        'costCenterId' in data, data.costCenterId ?? null,
        'adminUrl' in data, data.adminUrl || null,
        'responsibleUserId' in data, data.responsibleUserId ?? null,
        data.noticeDays ?? null,
        'notes' in data, data.notes || null,
        params.data.id,
      ],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, config, request, 'finance.subscription_updated', auth.userId, 'fin_subscription', params.data.id, {});
    return reply.send({ ok: true });
  });

  app.post('/api/admin/finance/subscriptions/:id/reprice', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = repriceSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_reprice' });
    const existing = await db.query<{ status: string }>('SELECT status FROM fin_subscriptions WHERE id=$1', [params.data.id]);
    const subscription = existing.rows[0];
    if (!subscription) return reply.code(404).send({ error: 'not_found' });
    if (subscription.status === 'canceled' || subscription.status === 'ended') return reply.code(409).send({ error: 'subscription_terminal' });
    await db.transaction(async (tx) => {
      await tx.query('UPDATE fin_subscriptions SET amount_cents=$1,currency=$2,updated_at=now() WHERE id=$3', [parsed.data.amountCents, parsed.data.currency, params.data.id]);
      await tx.query(
        'INSERT INTO fin_subscription_price_history (id,subscription_id,amount_cents,currency,effective_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), params.data.id, parsed.data.amountCents, parsed.data.currency, parsed.data.effectiveAt, auth.userId],
      );
    });
    await audit(db, config, request, 'finance.subscription_repriced', auth.userId, 'fin_subscription', params.data.id, { amountCents: parsed.data.amountCents, currency: parsed.data.currency });
    return reply.send({ ok: true });
  });

  app.get('/api/admin/finance/subscriptions/:id/price-history', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const rows = await db.query(
      'SELECT id,amount_cents,currency,effective_at,created_at FROM fin_subscription_price_history WHERE subscription_id=$1 ORDER BY effective_at DESC,created_at DESC',
      [params.data.id],
    );
    return reply.send({ priceHistory: rows.rows.map((row: Record<string, unknown>) => ({ id: row.id, amountCents: row.amount_cents, currency: row.currency, effectiveAt: row.effective_at, createdAt: row.created_at })) });
  });

  app.post('/api/admin/finance/subscriptions/:id/status', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = statusChangeSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const existing = await db.query<{ status: string }>('SELECT status FROM fin_subscriptions WHERE id=$1', [params.data.id]);
    const subscription = existing.rows[0];
    if (!subscription) return reply.code(404).send({ error: 'not_found' });
    if (!isValidSubscriptionTransition(subscription.status, parsed.data.status)) return reply.code(409).send({ error: 'invalid_transition' });
    const endedAt = parsed.data.status === 'ended' || parsed.data.status === 'canceled' ? new Date().toISOString().slice(0, 10) : null;
    await db.query(
      'UPDATE fin_subscriptions SET status=$1,ended_at=CASE WHEN $2::date IS NOT NULL THEN $2 ELSE ended_at END,updated_at=now() WHERE id=$3',
      [parsed.data.status, endedAt, params.data.id],
    );
    await audit(db, config, request, 'finance.subscription_status_changed', auth.userId, 'fin_subscription', params.data.id, { from: subscription.status, to: parsed.data.status, reason: parsed.data.reason ?? '' });
    return reply.send({ ok: true });
  });

  // Gera obrigações (fin_obligations) para toda assinatura ativa cuja próxima cobrança já
  // venceu, avançando next_charge_at período a período (nunca pula o mês perdido: se a rotina
  // não rodar por 3 meses, gera as 3 cobranças em atraso, cada uma com sua própria
  // idempotency_key). Idempotente: repetir a chamada nunca duplica uma cobrança já gerada para
  // o mesmo período.
  app.post('/api/admin/finance/subscriptions/generate-charges', async (request, reply) => {
    const auth = await requireMaster(db, config, request, reply, true);
    if (!auth) return;
    const due = await db.query<{
      id: string; counterparty_id: string; amount_cents: number; currency: string; periodicity: SubscriptionPeriodicity;
      custom_interval_days: number | null; next_charge_at: string; category_id: string; cost_center_id: string | null; account_id: string | null;
    }>(
      "SELECT id,counterparty_id,amount_cents,currency,periodicity,custom_interval_days,next_charge_at,category_id,cost_center_id,account_id FROM fin_subscriptions WHERE status='active' AND next_charge_at<=CURRENT_DATE",
    );
    let created = 0;
    let skipped = 0;
    for (const subscription of due.rows) {
      const periodDates: string[] = [];
      let cursor = toDateOnly(subscription.next_charge_at);
      let iterations = 0;
      while (cursor <= todayDateOnly() && iterations < 36) {
        periodDates.push(cursor);
        cursor = nextChargeDate(cursor, subscription.periodicity, subscription.custom_interval_days ?? undefined);
        iterations += 1;
      }
      for (const periodDate of periodDates) {
        const idempotencyKey = subscriptionChargeIdempotencyKey(subscription.id, periodDate);
        try {
          await db.query(
            `INSERT INTO fin_obligations
              (id,kind,counterparty_id,category_id,cost_center_id,competency_date,due_date,amount_cents,currency,account_id,subscription_id,source,idempotency_key,created_by)
             VALUES ($1,'operating_expense',$2,$3,$4,$5,$5,$6,$7,$8,$9,'subscription_charge',$10,$11)`,
            [randomUUID(), subscription.counterparty_id, subscription.category_id, subscription.cost_center_id, periodDate,
             subscription.amount_cents, subscription.currency, subscription.account_id, subscription.id, idempotencyKey, auth.userId],
          );
          created += 1;
        } catch (error) {
          skipped += 1; // already generated for this subscription+period (idempotency_key unique violation)
        }
      }
      await db.query('UPDATE fin_subscriptions SET next_charge_at=$1,updated_at=now() WHERE id=$2', [cursor, subscription.id]);
    }
    await audit(db, config, request, 'finance.subscription_charges_generated', auth.userId, 'fin_subscription', null, { created, skipped, subscriptionsDue: due.rows.length });
    return reply.send({ subscriptionsDue: due.rows.length, created, skipped });
  });
}

function toDateOnly(value: string | Date) {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function serializeSubscription(row: Record<string, unknown>) {
  return {
    id: row.id,
    counterpartyId: row.counterparty_id,
    service: row.service,
    description: row.description,
    plan: row.plan,
    amountCents: row.amount_cents,
    currency: row.currency,
    periodicity: row.periodicity,
    customIntervalDays: row.custom_interval_days,
    nextChargeAt: row.next_charge_at,
    billingDay: row.billing_day,
    autoRenew: row.auto_renew,
    accountId: row.account_id,
    categoryId: row.category_id,
    costCenterId: row.cost_center_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    adminUrl: row.admin_url,
    responsibleUserId: row.responsible_user_id,
    noticeDays: row.notice_days,
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
