import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { requireAuth } from '../auth.js';
import { sumIssuanceDirectCostCents } from '../../shared/salesProfit.js';
import { buildCsv } from '../../shared/financeCsv.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().regex(DATE_RE);

const overviewQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  regime: z.enum(['accrual', 'cash']).default('accrual'),
});

const alertsQuerySchema = z.object({
  minMarginBps: z.coerce.number().int().min(-10_000).max(10_000).default(0),
  lowBalanceThreshold: z.coerce.number().int().min(0).max(100_000_000).default(1000),
  expiringDays: z.coerce.number().int().min(1).max(365).default(30),
});

const expensesByCategoryQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  regime: z.enum(['accrual', 'cash']).default('accrual'),
});

const exportQuerySchema = z.object({
  report: z.enum(['sales', 'obligations', 'receivables']),
  from: dateSchema,
  to: dateSchema,
});

const MAX_EXPORT_ROWS = 5000;

export function registerFinanceDashboardRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  // Faturamento bruto, recebido, custo direto, lucro bruto, margem, despesas operacionais e
  // resultado operacional — sempre por moeda (nunca somadas entre si) e sempre rotulados como
  // caixa ou competência (docs/financeiro/REGRAS_CALCULO.md). Todo indicador é calculado aqui, no
  // servidor, a partir de linhas persistidas — o cliente nunca envia um total pronto.
  app.get('/api/admin/finance/dashboard/overview', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = overviewQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const { from, to, regime } = query.data;
    if (from > to) return reply.code(400).send({ error: 'invalid_date_range' });

    if (regime === 'accrual') {
      const faturamento = await sumByCurrency(db, 'SELECT currency,net_amount_cents AS amount FROM fin_sales WHERE status=\'confirmed\' AND sale_date BETWEEN $1 AND $2', [from, to]);
      const despesas = await sumByCurrency(db, "SELECT currency,amount_cents AS amount FROM fin_obligations WHERE kind='operating_expense' AND status<>'canceled' AND competency_date BETWEEN $1 AND $2", [from, to]);
      const issuanceRows = await db.query<Record<string, unknown>>(
        `SELECT fi.currency,fi.cash_amount_cents,fi.miles_cost_cents,fi.airport_fees_cents,fi.issuance_fee_cents,
                fi.consolidator_fee_cents,fi.gateway_fee_cents,fi.agent_commission_cents,fi.other_costs_cents
           FROM fin_issuances fi JOIN fin_sales fs ON fs.id=fi.sale_id
          WHERE fs.status='confirmed' AND fs.sale_date BETWEEN $1 AND $2 AND fi.status IN ('issued','refunded')`,
        [from, to],
      );
      const custoDireto = new Map<string, number>();
      for (const row of issuanceRows.rows) {
        const currency = String(row.currency);
        const cost = sumIssuanceDirectCostCents({
          cashAmountCents: Number(row.cash_amount_cents), milesCostCents: Number(row.miles_cost_cents),
          airportFeesCents: Number(row.airport_fees_cents), issuanceFeeCents: Number(row.issuance_fee_cents),
          consolidatorFeeCents: Number(row.consolidator_fee_cents), gatewayFeeCents: Number(row.gateway_fee_cents),
          agentCommissionCents: Number(row.agent_commission_cents), otherCostsCents: Number(row.other_costs_cents),
        });
        custoDireto.set(currency, (custoDireto.get(currency) ?? 0) + cost);
      }

      const currencies = new Set([...faturamento.keys(), ...custoDireto.keys(), ...despesas.keys()]);
      const indicators = [...currencies].sort().map((currency) => {
        const faturamentoBrutoCents = faturamento.get(currency) ?? 0;
        const custoDiretoCents = custoDireto.get(currency) ?? 0;
        const despesasOperacionaisCents = despesas.get(currency) ?? 0;
        const lucroBrutoCents = faturamentoBrutoCents - custoDiretoCents;
        const margemBrutaBps = faturamentoBrutoCents > 0 ? Math.round((lucroBrutoCents * 10_000) / faturamentoBrutoCents) : null;
        const resultadoOperacionalCents = lucroBrutoCents - despesasOperacionaisCents;
        return { currency, faturamentoBrutoCents, custoDiretoCents, lucroBrutoCents, margemBrutaBps, despesasOperacionaisCents, resultadoOperacionalCents };
      });
      return reply.send({ regime: 'accrual', from, to, indicators });
    }

    const recebido = await sumByCurrency(db, 'SELECT currency,received_amount_cents AS amount FROM fin_receivable_payments WHERE received_at::date BETWEEN $1 AND $2', [from, to]);
    const pago = await sumByCurrency(db, 'SELECT currency,paid_amount_cents AS amount FROM fin_obligation_payments WHERE paid_at::date BETWEEN $1 AND $2', [from, to]);
    const currencies = new Set([...recebido.keys(), ...pago.keys()]);
    const indicators = [...currencies].sort().map((currency) => {
      const recebidoCents = recebido.get(currency) ?? 0;
      const pagoCents = pago.get(currency) ?? 0;
      return { currency, recebidoCents, pagoCents, saldoCaixaCents: recebidoCents - pagoCents };
    });
    return reply.send({ regime: 'cash', from, to, indicators });
  });

  // Contas vencidas, próximos vencimentos (7/30 dias), assinaturas próximas do vencimento,
  // vendas com margem negativa/baixa, lotes de milhas com saldo baixo ou vencendo em breve.
  app.get('/api/admin/finance/dashboard/alerts', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = alertsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const { minMarginBps, lowBalanceThreshold, expiringDays } = query.data;

    const overdueObligations = await db.query(
      "SELECT id,due_date,amount_cents,currency,counterparty_id,status FROM fin_obligations WHERE status IN ('open','partial') AND due_date < CURRENT_DATE ORDER BY due_date LIMIT 200",
    );
    const overdueReceivables = await db.query(
      "SELECT id,sale_id,due_date,expected_amount_cents,currency,status FROM fin_receivables WHERE status IN ('open','partial') AND due_date < CURRENT_DATE ORDER BY due_date LIMIT 200",
    );
    const upcoming7d = await db.query(
      "SELECT id,due_date,amount_cents,currency,counterparty_id FROM fin_obligations WHERE status IN ('open','partial') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days' ORDER BY due_date LIMIT 200",
    );
    const upcoming30d = await db.query(
      "SELECT id,due_date,amount_cents,currency,counterparty_id FROM fin_obligations WHERE status IN ('open','partial') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' ORDER BY due_date LIMIT 200",
    );
    const activeSubscriptions = await db.query<{ id: string; service: string; next_charge_at: string; notice_days: number; amount_cents: number; currency: string }>(
      "SELECT id,service,next_charge_at,notice_days,amount_cents,currency FROM fin_subscriptions WHERE status='active'",
    );
    const today = todayDateOnly();
    const subscriptionsDueSoon = activeSubscriptions.rows.filter((row) => {
      const daysUntil = Math.floor((Date.parse(`${row.next_charge_at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      return daysUntil <= row.notice_days;
    });

    const confirmedSaleIssuances = await db.query<Record<string, unknown>>(
      `SELECT fs.id AS sale_id,fs.protocol,fs.net_amount_cents,fs.currency,
              fi.cash_amount_cents,fi.miles_cost_cents,fi.airport_fees_cents,fi.issuance_fee_cents,
              fi.consolidator_fee_cents,fi.gateway_fee_cents,fi.agent_commission_cents,fi.other_costs_cents,fi.status AS issuance_status
         FROM fin_sales fs JOIN fin_issuances fi ON fi.sale_id=fs.id
        WHERE fs.status='confirmed' AND fi.status IN ('issued','refunded')`,
    );
    const costBySale = new Map<string, { protocol: string; netAmountCents: number; currency: string; costCents: number }>();
    for (const row of confirmedSaleIssuances.rows) {
      const saleId = String(row.sale_id);
      const entry = costBySale.get(saleId) ?? { protocol: String(row.protocol), netAmountCents: Number(row.net_amount_cents), currency: String(row.currency), costCents: 0 };
      entry.costCents += sumIssuanceDirectCostCents({
        cashAmountCents: Number(row.cash_amount_cents), milesCostCents: Number(row.miles_cost_cents),
        airportFeesCents: Number(row.airport_fees_cents), issuanceFeeCents: Number(row.issuance_fee_cents),
        consolidatorFeeCents: Number(row.consolidator_fee_cents), gatewayFeeCents: Number(row.gateway_fee_cents),
        agentCommissionCents: Number(row.agent_commission_cents), otherCostsCents: Number(row.other_costs_cents),
      });
      costBySale.set(saleId, entry);
    }
    const salesBelowMarginThreshold = [...costBySale.entries()]
      .map(([saleId, entry]) => ({
        saleId, protocol: entry.protocol, currency: entry.currency,
        marginBps: entry.netAmountCents > 0 ? Math.round(((entry.netAmountCents - entry.costCents) * 10_000) / entry.netAmountCents) : null,
      }))
      .filter((item) => item.marginBps !== null && item.marginBps < minMarginBps);

    const mileageLots = await db.query<{ id: string; program: string; quantity_purchased: number; expires_at: string | null; status: string }>(
      "SELECT id,program,quantity_purchased,expires_at,status FROM fin_mileage_lots WHERE status IN ('active','depleted')",
    );
    const allocated = await db.query<{ lot_id: string; quantity: number }>('SELECT lot_id,quantity FROM fin_mileage_allocations WHERE voided_at IS NULL');
    const allocatedByLot = new Map<string, number>();
    for (const row of allocated.rows) allocatedByLot.set(String(row.lot_id), (allocatedByLot.get(String(row.lot_id)) ?? 0) + Number(row.quantity));
    const mileageLotsLowBalance: Array<{ id: string; program: string; balanceQuantity: number }> = [];
    const mileageLotsExpiringSoon: Array<{ id: string; program: string; expiresAt: string }> = [];
    for (const row of mileageLots.rows) {
      const balance = row.quantity_purchased - (allocatedByLot.get(row.id) ?? 0);
      if (balance <= lowBalanceThreshold) mileageLotsLowBalance.push({ id: row.id, program: row.program, balanceQuantity: balance });
      if (row.expires_at) {
        const daysUntil = Math.floor((Date.parse(`${row.expires_at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
        if (daysUntil >= 0 && daysUntil <= expiringDays) mileageLotsExpiringSoon.push({ id: row.id, program: row.program, expiresAt: row.expires_at });
      }
    }

    return reply.send({
      overdueObligations: overdueObligations.rows.map(serializeAlertObligation),
      overdueReceivables: overdueReceivables.rows.map(serializeAlertReceivable),
      upcomingObligations7d: upcoming7d.rows.map(serializeAlertObligation),
      upcomingObligations30d: upcoming30d.rows.map(serializeAlertObligation),
      subscriptionsDueSoon: subscriptionsDueSoon.map((row) => ({ id: row.id, service: row.service, nextChargeAt: row.next_charge_at, amountCents: row.amount_cents, currency: row.currency })),
      salesBelowMarginThreshold,
      mileageLotsLowBalance,
      mileageLotsExpiringSoon,
    });
  });

  app.get('/api/admin/finance/dashboard/expenses-by-category', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = expensesByCategoryQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const { from, to, regime } = query.data;
    if (from > to) return reply.code(400).send({ error: 'invalid_date_range' });

    const rows = regime === 'accrual'
      ? await db.query<{ category_id: string; currency: string; amount: number }>(
          "SELECT category_id,currency,amount_cents AS amount FROM fin_obligations WHERE status<>'canceled' AND competency_date BETWEEN $1 AND $2",
          [from, to],
        )
      : await db.query<{ category_id: string; currency: string; amount: number }>(
          `SELECT o.category_id AS category_id,p.currency AS currency,p.paid_amount_cents AS amount
             FROM fin_obligation_payments p JOIN fin_obligations o ON o.id=p.obligation_id
            WHERE p.paid_at::date BETWEEN $1 AND $2`,
          [from, to],
        );
    const categories = await db.query<{ id: string; name: string; kind: string }>('SELECT id,name,kind FROM fin_categories');
    const categoryById = new Map(categories.rows.map((row) => [row.id, row]));
    const totals = new Map<string, { categoryId: string; categoryName: string; kind: string; currency: string; amountCents: number }>();
    for (const row of rows.rows) {
      const key = `${row.category_id}|${row.currency}`;
      const category = categoryById.get(row.category_id);
      const entry = totals.get(key) ?? { categoryId: row.category_id, categoryName: category?.name ?? '(categoria removida)', kind: category?.kind ?? 'unknown', currency: row.currency, amountCents: 0 };
      entry.amountCents += Number(row.amount);
      totals.set(key, entry);
    }
    return reply.send({ regime, from, to, categories: [...totals.values()].sort((a, b) => b.amountCents - a.amountCents) });
  });

  app.get('/api/admin/finance/dashboard/export.csv', async (request, reply) => {
    if (!(await requireMaster(db, config, request, reply))) return;
    const query = exportQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_filter' });
    const { report, from, to } = query.data;
    if (from > to) return reply.code(400).send({ error: 'invalid_date_range' });

    let csv: string;
    if (report === 'sales') {
      const rows = await db.query(
        'SELECT protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,status FROM fin_sales WHERE sale_date BETWEEN $1 AND $2 ORDER BY sale_date LIMIT $3',
        [from, to, MAX_EXPORT_ROWS],
      );
      csv = buildCsv(
        ['Protocolo', 'Data', 'Moeda', 'Valor bruto (centavos)', 'Desconto (centavos)', 'Valor líquido (centavos)', 'Status'],
        rows.rows.map((row) => [row.protocol, row.sale_date, row.currency, row.gross_amount_cents, row.discount_cents, row.net_amount_cents, row.status] as Array<string | number>),
      );
    } else if (report === 'obligations') {
      const rows = await db.query(
        `SELECT o.due_date,o.currency,o.amount_cents,o.status,o.kind,cp.display_name AS counterparty_name,cat.name AS category_name
           FROM fin_obligations o LEFT JOIN fin_counterparties cp ON cp.id=o.counterparty_id LEFT JOIN fin_categories cat ON cat.id=o.category_id
          WHERE o.due_date BETWEEN $1 AND $2 ORDER BY o.due_date LIMIT $3`,
        [from, to, MAX_EXPORT_ROWS],
      );
      csv = buildCsv(
        ['Vencimento', 'Tipo', 'Categoria', 'Contraparte', 'Moeda', 'Valor (centavos)', 'Status'],
        rows.rows.map((row) => [row.due_date, row.kind, row.category_name ?? '', row.counterparty_name ?? '', row.currency, row.amount_cents, row.status] as Array<string | number>),
      );
    } else {
      const rows = await db.query(
        `SELECT r.due_date,r.currency,r.expected_amount_cents,r.status,s.protocol
           FROM fin_receivables r JOIN fin_sales s ON s.id=r.sale_id
          WHERE r.due_date BETWEEN $1 AND $2 ORDER BY r.due_date LIMIT $3`,
        [from, to, MAX_EXPORT_ROWS],
      );
      csv = buildCsv(
        ['Protocolo da venda', 'Vencimento', 'Moeda', 'Valor esperado (centavos)', 'Status'],
        rows.rows.map((row) => [row.protocol, row.due_date, row.currency, row.expected_amount_cents, row.status] as Array<string | number>),
      );
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${report}-${from}-a-${to}.csv"`)
      .send(csv);
  });
}

async function sumByCurrency(db: Database, sql: string, params: unknown[]): Promise<Map<string, number>> {
  const rows = await db.query<{ currency: string; amount: number }>(sql, params);
  const totals = new Map<string, number>();
  for (const row of rows.rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + Number(row.amount));
  return totals;
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function serializeAlertObligation(row: Record<string, unknown>) {
  return { id: row.id, dueDate: row.due_date, amountCents: row.amount_cents, currency: row.currency, counterpartyId: row.counterparty_id };
}
function serializeAlertReceivable(row: Record<string, unknown>) {
  return { id: row.id, saleId: row.sale_id, dueDate: row.due_date, expectedAmountCents: row.expected_amount_cents, currency: row.currency };
}

async function requireMaster(db: Database, config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireAuth(db, config, request, reply);
  if (!auth) return null;
  if (!auth.roles.includes('master')) {
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return auth;
}
