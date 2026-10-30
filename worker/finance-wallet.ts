// Financeiro, carteira de milhas própria (só master):
// - contas por pessoa/CPF e programa, com saldo e custo médio calculados dos lançamentos (GET /api/admin/finance/wallet);
// - lançamentos manuais, estorno e "conferir com o saldo informado pelo programa";
// - clubes de milhas (valor, dia do crédito, cartão, situação) atualizados pelos e-mails dos programas;
// - uso das milhas numa emissão (POST …/issuances/<id>/wallet-usage), que já recalcula o custo e o lucro do voo;
// - ingestWalletEvents: recebe os eventos lidos do Gmail por tools/miles-mail-sync.mjs (rota interna com token).
// Milhas com sinal (entrada +, saída -). Na saída o custo é o custo médio da conta naquele momento.
type Row = Record<string, unknown>;
export interface WalletAuth { userId: string; roles: string[] }
export interface WalletDeps {
  reply(body: unknown, status?: number, headers?: HeadersInit): Response;
  getAuth(req: Request, env: Env): Promise<WalletAuth | null>;
  mutationAuth(req: Request, env: Env): Promise<WalletAuth | null>;
  audit(env: Env, actor: string | null, action: string, targetType: string, targetId: string | null): Promise<void>;
  recomputeIssuanceMiles(env: Env, issuanceId: string): Promise<void>;
}
export interface WalletEventInput {
  sourceId: string;
  kind: 'club_credited' | 'club_payment_ok' | 'club_payment_failed' | 'club_canceled' | 'balance';
  program: string;
  holderHint: string | null;
  memberNumber: string | null;
  miles: number | null;
  balance: number | null;
  /** Instante a que o saldo se refere, quando o e-mail cita o saldo de outro dia. */
  balanceAt?: string | null;
  planName: string | null;
  monthlyCostCents: number | null;
  occurredAt: string;
  subject: string;
}

const UUID = '[0-9a-f-]{36}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const MAX_MILES = 100_000_000;
const MAX_CENTS = 100_000_000_00;
const ENTRY_KINDS = ['opening', 'club_credit', 'purchase', 'bonus', 'transfer_in'];
const EXIT_KINDS = ['transfer_out', 'sale', 'expire'];
const MANUAL_KINDS = [...ENTRY_KINDS, ...EXIT_KINDS, 'adjust'];
const CLUB_STATUSES = ['active', 'payment_failed', 'canceled', 'paused'];
const EVENT_KINDS = ['club_credited', 'club_payment_ok', 'club_payment_failed', 'club_canceled', 'balance'];
/** Programas em que a promoção de transferência com bônus é controlada por mês (aviso quando a conta fica sem). */
const PROMO_PROGRAMS = ['LATAM Pass'];
const PROMO_LATE_DAY = 20;
const GRACE_DAYS = 3;
const STALE_REPORT_DAYS = 35;
const EXPIRY_WARN_DAYS = 45;

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const intIn = (value: unknown, min: number, max: number) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const dateOk = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null);
const todayIso = () => new Date().toISOString().slice(0, 10);
const norm = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const firstWord = (value: string) => norm(value).split(/\s+/)[0] ?? '';
async function readJson(req: Request): Promise<Row | null> { try { return await req.json() as Row; } catch { return null; } }
function daysBetween(fromIso: string, toIso: string) { return Math.floor((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86_400_000); }

export interface WalletPosition { miles: number; costCents: number; avgPerThousandCents: number | null }
/** Saldo e custo de uma lista de lançamentos que ainda valem (sem estorno). */
export function walletPosition(movements: Array<{ miles: number; cost_cents: number }>): WalletPosition {
  let miles = 0; let costCents = 0;
  for (const m of movements) { miles += Number(m.miles); costCents += Number(m.cost_cents); }
  return { miles, costCents, avgPerThousandCents: miles > 0 ? Math.round((costCents * 1000) / miles) : null };
}
/** Custo médio de uma saída de `milesOut` milhas dado o saldo atual (nunca passa do custo que existe na conta). */
export function exitCostCents(position: WalletPosition, milesOut: number): number {
  if (position.miles <= 0 || position.costCents <= 0) return 0;
  if (milesOut >= position.miles) return position.costCents;
  return Math.round((position.costCents * milesOut) / position.miles);
}

/** Rotas da carteira; devolve null para o roteador seguir adiante. */
export async function financeWallet(req: Request, env: Env, url: URL, deps: WalletDeps): Promise<Response | null> {
  const p = url.pathname;
  const m = req.method;
  if (m === 'GET' && p === '/api/admin/finance/wallet') return overview(req, env, deps);
  if (m === 'POST' && p === '/api/admin/finance/wallet/accounts') return accountCreate(req, env, deps);
  const account = p.match(new RegExp(`^/api/admin/finance/wallet/accounts/(${UUID})$`, 'i'));
  if (m === 'PATCH' && account) return accountUpdate(req, env, account[1]!, deps);
  const accountMovements = p.match(new RegExp(`^/api/admin/finance/wallet/accounts/(${UUID})/movements$`, 'i'));
  if (m === 'GET' && accountMovements) return movementsList(req, env, accountMovements[1]!, deps);
  if (m === 'POST' && accountMovements) return movementCreate(req, env, accountMovements[1]!, deps);
  const reconcile = p.match(new RegExp(`^/api/admin/finance/wallet/accounts/(${UUID})/reconcile$`, 'i'));
  if (m === 'POST' && reconcile) return reconcileAccount(req, env, reconcile[1]!, deps);
  const accountPromos = p.match(new RegExp(`^/api/admin/finance/wallet/accounts/(${UUID})/promos$`, 'i'));
  if (m === 'POST' && accountPromos) return promoCreate(req, env, accountPromos[1]!, deps);
  const voidPromo = p.match(new RegExp(`^/api/admin/finance/wallet/promos/(${UUID})/void$`, 'i'));
  if (m === 'POST' && voidPromo) return promoVoid(req, env, voidPromo[1]!, deps);
  const voidMovement = p.match(new RegExp(`^/api/admin/finance/wallet/movements/(${UUID})/void$`, 'i'));
  if (m === 'POST' && voidMovement) return movementVoid(req, env, voidMovement[1]!, deps);
  if (m === 'POST' && p === '/api/admin/finance/wallet/clubs') return clubCreate(req, env, deps);
  const club = p.match(new RegExp(`^/api/admin/finance/wallet/clubs/(${UUID})$`, 'i'));
  if (m === 'PATCH' && club) return clubUpdate(req, env, club[1]!, deps);
  const eventLink = p.match(new RegExp(`^/api/admin/finance/wallet/events/(${UUID})/link$`, 'i'));
  if (m === 'POST' && eventLink) return eventLinkAccount(req, env, eventLink[1]!, deps);
  const usage = p.match(new RegExp(`^/api/admin/finance/issuances/(${UUID})/wallet-usage$`, 'i'));
  if (m === 'GET' && usage) return usageList(req, env, usage[1]!, deps);
  if (m === 'POST' && usage) return usageCreate(req, env, usage[1]!, deps);
  return null;
}

async function master(req: Request, env: Env, deps: WalletDeps) {
  const auth = await deps.getAuth(req, env);
  return auth?.roles.includes('master') ? auth : null;
}
async function masterMutation(req: Request, env: Env, deps: WalletDeps) {
  const auth = await deps.mutationAuth(req, env);
  return auth?.roles.includes('master') ? auth : null;
}

const accountColumns = 'id,holder,program,member_number,cpf_limit,reported_balance,reported_at,reported_source,active,notes,created_at,updated_at';
const clubColumns = 'id,account_id,name,monthly_miles,monthly_cost_cents,credit_day,card_label,status,last_credit_on,last_event_on,last_event,created_at,updated_at';
const movementColumns = 'id,account_id,kind,miles,cost_cents,occurred_on,expires_on,issuance_id,issuance_cost_cents,fx_rate,event_id,note,source,voided_at,void_reason,created_at';

async function positionOf(env: Env, accountId: string): Promise<WalletPosition> {
  const rows = await env.DB.prepare('SELECT miles,cost_cents FROM fin_wallet_movements WHERE account_id=? AND voided_at IS NULL').bind(accountId).all<{ miles: number; cost_cents: number }>();
  return walletPosition(rows.results);
}

function serializeClub(row: Row) {
  return {
    id: row.id, accountId: row.account_id, name: row.name, monthlyMiles: row.monthly_miles, monthlyCostCents: row.monthly_cost_cents,
    creditDay: row.credit_day, cardLabel: row.card_label, status: row.status, lastCreditOn: row.last_credit_on,
    lastEventOn: row.last_event_on, lastEvent: row.last_event,
  };
}
function serializeMovement(row: Row) {
  return {
    id: row.id, accountId: row.account_id, kind: row.kind, miles: row.miles, costCents: row.cost_cents, occurredOn: row.occurred_on,
    expiresOn: row.expires_on, issuanceId: row.issuance_id, issuanceCostCents: row.issuance_cost_cents, fxRate: row.fx_rate,
    note: row.note, source: row.source, voidedAt: row.voided_at, voidReason: row.void_reason, createdAt: row.created_at,
  };
}

const promoColumns = 'id,account_id,promo_name,month,done_on,points_sent,bonus_percent,miles_received,note';
function serializePromo(row: Row) {
  return { id: row.id, accountId: row.account_id, name: row.promo_name, month: row.month, doneOn: row.done_on, pointsSent: row.points_sent, bonusPercent: row.bonus_percent, milesReceived: row.miles_received, note: row.note };
}
/** Primeiro mês (YYYY-MM) devolvido na visão geral: os 12 meses até hoje, para ver o que já foi feito sem carregar o histórico todo. */
function promoSince(today: string) {
  const [y, mo] = today.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 12, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Data em que o clube deveria ter creditado neste mês (dia do crédito, limitado ao último dia do mês). */
function expectedCreditDate(creditDay: number, today: string) {
  const [y, mo] = today.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(Math.min(creditDay, last)).padStart(2, '0')}`;
}

type Alert = { level: 'danger' | 'warn' | 'info'; kind: string; accountId: string | null; clubId?: string; title: string; detail: string };

async function overview(req: Request, env: Env, deps: WalletDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const today = todayIso();
  const [accountsRes, movementsRes, clubsRes, eventsRes, promosRes] = await Promise.all([
    env.DB.prepare(`SELECT ${accountColumns} FROM fin_wallet_accounts ORDER BY holder COLLATE NOCASE, program`).all<Row>(),
    env.DB.prepare('SELECT account_id,kind,miles,cost_cents,expires_on FROM fin_wallet_movements WHERE voided_at IS NULL').all<Row>(),
    env.DB.prepare(`SELECT ${clubColumns} FROM fin_wallet_clubs ORDER BY created_at`).all<Row>(),
    env.DB.prepare("SELECT id,source_id,kind,program,holder_hint,member_number,miles,balance,plan_name,occurred_at,subject FROM fin_wallet_events WHERE applied=0 AND account_id IS NULL ORDER BY occurred_at DESC LIMIT 50").all<Row>(),
    env.DB.prepare(`SELECT ${promoColumns} FROM fin_wallet_promos WHERE voided_at IS NULL AND month >= ? ORDER BY done_on DESC, created_at DESC`).bind(promoSince(today)).all<Row>(),
  ]);
  const promosByAccount = new Map<string, ReturnType<typeof serializePromo>[]>();
  for (const promo of promosRes.results) { const key = String(promo.account_id); (promosByAccount.get(key) ?? promosByAccount.set(key, []).get(key)!).push(serializePromo(promo)); }
  const movementsByAccount = new Map<string, Row[]>();
  for (const mv of movementsRes.results) { const key = String(mv.account_id); (movementsByAccount.get(key) ?? movementsByAccount.set(key, []).get(key)!).push(mv); }
  const clubsByAccount = new Map<string, Row[]>();
  for (const club of clubsRes.results) { const key = String(club.account_id); (clubsByAccount.get(key) ?? clubsByAccount.set(key, []).get(key)!).push(club); }

  const alerts: Alert[] = [];
  const accounts = accountsRes.results.map((acc) => {
    const id = String(acc.id);
    const mvs = movementsByAccount.get(id) ?? [];
    const pos = walletPosition(mvs as Array<{ miles: number; cost_cents: number }>);
    const reported = acc.reported_balance === null || acc.reported_balance === undefined ? null : Number(acc.reported_balance);
    const divergence = reported === null ? null : reported - pos.miles;
    const label = `${acc.holder} · ${acc.program}`;
    if (Number(acc.active) === 1 && divergence !== null && divergence !== 0) {
      alerts.push({ level: 'warn', kind: 'divergence', accountId: id, title: `Saldo diferente do programa: ${label}`, detail: `Aqui ${pos.miles.toLocaleString('pt-BR')}, no programa ${reported!.toLocaleString('pt-BR')} (${divergence > 0 ? '+' : ''}${divergence.toLocaleString('pt-BR')}).` });
    }
    if (Number(acc.active) === 1 && PROMO_PROGRAMS.includes(String(acc.program))) {
      const mine = promosByAccount.get(id) ?? [];
      if (!mine.some((promo) => promo.month === today.slice(0, 7))) {
        const last = mine[0];
        alerts.push({
          level: Number(today.slice(8, 10)) >= PROMO_LATE_DAY ? 'warn' : 'info', kind: 'promo_missing', accountId: id,
          title: `Sem promoção neste mês: ${label}`,
          detail: last ? `Última registrada: ${last.name} em ${String(last.doneOn).split('-').reverse().join('/')}. Registre em "Registrar promoção" quando fizer.` : 'Nenhuma promoção registrada nesta conta ainda. Registre em "Registrar promoção" quando fizer.',
        });
      }
    }
    if (Number(acc.active) === 1 && acc.reported_at && daysBetween(String(acc.reported_at), today) > STALE_REPORT_DAYS) {
      alerts.push({ level: 'info', kind: 'stale_report', accountId: id, title: `Sem confirmação do programa há mais de ${STALE_REPORT_DAYS} dias: ${label}`, detail: 'Nenhum e-mail do programa trouxe o saldo desde então. Confira no app.' });
    }
    for (const mv of mvs) {
      if (mv.expires_on && Number(mv.miles) > 0 && ENTRY_KINDS.includes(String(mv.kind))) {
        const left = daysBetween(today, String(mv.expires_on));
        if (left <= EXPIRY_WARN_DAYS) alerts.push({ level: left < 0 ? 'danger' : 'warn', kind: 'expiry', accountId: id, title: `${left < 0 ? 'Milhas vencidas' : 'Milhas vencendo'}: ${label}`, detail: `${Number(mv.miles).toLocaleString('pt-BR')} ${left < 0 ? 'venceram' : 'vencem'} em ${String(mv.expires_on).split('-').reverse().join('/')}. Confira se já foram usadas.` });
      }
    }
    const clubs = (clubsByAccount.get(id) ?? []).map((club) => {
      const view = serializeClub(club);
      const status = String(club.status);
      if (status === 'payment_failed') alerts.push({ level: 'danger', kind: 'club_payment_failed', accountId: id, clubId: String(club.id), title: `Pagamento do clube recusado: ${label}`, detail: `${club.name}${club.card_label ? ` · cartão ${club.card_label}` : ''}. Troque ou regularize o cartão no programa antes de perder o clube.` });
      else if (status === 'canceled') alerts.push({ level: 'danger', kind: 'club_canceled', accountId: id, clubId: String(club.id), title: `Clube cancelado: ${label}`, detail: `${club.name}. Se foi sem querer, assine de novo no programa.` });
      // Só cobra atraso de quem já teve crédito avisado por e-mail antes: programa sem e-mail de crédito lido não gera alarme falso.
      else if (status === 'active' && club.credit_day && club.last_credit_on) {
        const due = expectedCreditDate(Number(club.credit_day), today);
        if (today > due && daysBetween(due, today) > GRACE_DAYS && String(club.last_credit_on) < due) {
          alerts.push({ level: 'warn', kind: 'club_credit_late', accountId: id, clubId: String(club.id), title: `Crédito do clube atrasado: ${label}`, detail: `${club.name}: esperado em ${due.split('-').reverse().join('/')}, ainda sem e-mail de crédito.` });
        }
      }
      return view;
    });
    return {
      id, holder: acc.holder, program: acc.program, memberNumber: acc.member_number, cpfLimit: acc.cpf_limit, active: Number(acc.active) === 1, notes: acc.notes,
      balance: pos.miles, costCents: pos.costCents, avgPerThousandCents: pos.avgPerThousandCents,
      reportedBalance: reported, reportedAt: acc.reported_at, reportedSource: acc.reported_source, divergence, clubs,
      promos: promosByAccount.get(id) ?? [],
    };
  });
  const activeClubs = clubsRes.results.filter((c) => c.status === 'active' || c.status === 'payment_failed');
  const level = { danger: 0, warn: 1, info: 2 } as const;
  alerts.sort((a, b) => level[a.level] - level[b.level]);
  return deps.reply({
    accounts,
    totals: {
      balance: accounts.reduce((sum, a) => sum + (a.active ? a.balance : 0), 0),
      costCents: accounts.reduce((sum, a) => sum + (a.active ? a.costCents : 0), 0),
      clubMonthlyCostCents: activeClubs.reduce((sum, c) => sum + Number(c.monthly_cost_cents), 0),
      clubMonthlyMiles: activeClubs.reduce((sum, c) => sum + Number(c.monthly_miles), 0),
    },
    alerts,
    unmatchedEvents: eventsRes.results.map((e) => ({ id: e.id, kind: e.kind, program: e.program, holderHint: e.holder_hint, memberNumber: e.member_number, miles: e.miles, balance: e.balance, planName: e.plan_name, occurredAt: e.occurred_at, subject: e.subject })),
  });
}

async function accountCreate(req: Request, env: Env, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const holder = clean(b?.holder, 80);
  const program = clean(b?.program, 80);
  const memberNumber = clean(b?.memberNumber, 40) || null;
  const noLimit = b?.cpfLimit === null || b?.cpfLimit === undefined || b?.cpfLimit === '';
  const cpfLimit = noLimit ? null : intIn(b?.cpfLimit, 0, 1000);
  const openingMiles = b?.openingMiles === undefined || b?.openingMiles === null || b?.openingMiles === '' ? 0 : intIn(b.openingMiles, 0, MAX_MILES);
  const openingCostCents = b?.openingCostCents === undefined || b?.openingCostCents === null || b?.openingCostCents === '' ? 0 : intIn(b.openingCostCents, 0, MAX_CENTS);
  const openingDate = b?.openingDate ? dateOk(b.openingDate) : todayIso();
  if (!holder || !program || (!noLimit && cpfLimit === null) || openingMiles === null || openingCostCents === null || !openingDate) return deps.reply({ error: 'invalid_wallet_account' }, 400);
  const id = crypto.randomUUID();
  const statements = [env.DB.prepare('INSERT INTO fin_wallet_accounts (id,holder,program,member_number,cpf_limit,notes) VALUES (?,?,?,?,?,?)').bind(id, holder, program, memberNumber, cpfLimit, clean(b?.notes, 500) || null)];
  if (openingMiles > 0) {
    statements.push(env.DB.prepare("INSERT INTO fin_wallet_movements (id,account_id,kind,miles,cost_cents,occurred_on,note,source,created_by) VALUES (?,?,'opening',?,?,?,?,'manual',?)")
      .bind(crypto.randomUUID(), id, openingMiles, openingCostCents, openingDate, clean(b?.openingNote, 300) || 'Saldo inicial', auth.userId));
  }
  try { await env.DB.batch(statements); } catch (error) {
    if (String((error as Error)?.message).includes('UNIQUE')) return deps.reply({ error: 'wallet_account_exists' }, 409);
    throw error;
  }
  await deps.audit(env, auth.userId, 'finance.wallet_account_created', 'fin_wallet_account', id);
  return deps.reply({ id }, 201);
}

async function accountUpdate(req: Request, env: Env, id: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  if (!b) return deps.reply({ error: 'invalid_request' }, 400);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(b, key);
  const noLimit = b.cpfLimit === null || b.cpfLimit === '';
  const cpfLimit = has('cpfLimit') && !noLimit ? intIn(b.cpfLimit, 0, 1000) : null;
  if (has('cpfLimit') && !noLimit && cpfLimit === null) return deps.reply({ error: 'invalid_request' }, 400);
  const result = await env.DB.prepare(
    `UPDATE fin_wallet_accounts SET
       member_number=CASE WHEN ?=1 THEN ? ELSE member_number END,
       cpf_limit=CASE WHEN ?=1 THEN ? ELSE cpf_limit END,
       active=CASE WHEN ?=1 THEN ? ELSE active END,
       notes=CASE WHEN ?=1 THEN ? ELSE notes END,
       updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(
    has('memberNumber') ? 1 : 0, clean(b.memberNumber, 40) || null,
    has('cpfLimit') ? 1 : 0, cpfLimit,
    has('active') ? 1 : 0, b.active ? 1 : 0,
    has('notes') ? 1 : 0, clean(b.notes, 500) || null, id,
  ).run();
  if (!result.meta.changes) return deps.reply({ error: 'wallet_account_not_found' }, 404);
  await deps.audit(env, auth.userId, 'finance.wallet_account_updated', 'fin_wallet_account', id);
  return deps.reply({ ok: true });
}

async function movementsList(req: Request, env: Env, accountId: string, deps: WalletDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare(`SELECT ${movementColumns} FROM fin_wallet_movements WHERE account_id=? ORDER BY occurred_on DESC, created_at DESC LIMIT 200`).bind(accountId).all<Row>();
  return deps.reply({ movements: rows.results.map(serializeMovement) });
}

async function insertMovement(env: Env, args: { accountId: string; kind: string; miles: number; costCents: number; occurredOn: string; expiresOn?: string | null; note?: string | null; source?: string; eventId?: string | null; actor: string | null }) {
  // Saída só passa se o saldo cobrir: a conferência roda dentro do próprio INSERT, que o D1 executa como uma instrução só.
  const exit = args.miles < 0;
  const result = await env.DB.prepare(
    `INSERT INTO fin_wallet_movements (id,account_id,kind,miles,cost_cents,occurred_on,expires_on,event_id,note,source,created_by)
     SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE ? = 0 OR (SELECT COALESCE(sum(miles),0) FROM fin_wallet_movements WHERE account_id=? AND voided_at IS NULL) + ? >= 0`,
  ).bind(crypto.randomUUID(), args.accountId, args.kind, args.miles, args.costCents, args.occurredOn, args.expiresOn ?? null, args.eventId ?? null, args.note ?? null, args.source ?? 'manual', args.actor,
    exit ? 1 : 0, args.accountId, args.miles).run();
  return result.meta.changes > 0;
}

async function movementCreate(req: Request, env: Env, accountId: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const account = await env.DB.prepare('SELECT id FROM fin_wallet_accounts WHERE id=?').bind(accountId).first();
  if (!account) return deps.reply({ error: 'wallet_account_not_found' }, 404);
  const b = await readJson(req);
  const kind = clean(b?.kind, 20);
  const miles = intIn(b?.miles, 1, MAX_MILES);
  const occurredOn = b?.occurredOn ? dateOk(b.occurredOn) : todayIso();
  const expiresOn = b?.expiresOn ? dateOk(b.expiresOn) : null;
  const costInput = b?.costCents === undefined || b?.costCents === null || b?.costCents === '' ? 0 : intIn(b.costCents, 0, MAX_CENTS);
  const sign = kind === 'adjust' ? (b?.direction === 'out' ? -1 : 1) : EXIT_KINDS.includes(kind) ? -1 : 1;
  if (!MANUAL_KINDS.includes(kind) || !miles || !occurredOn || costInput === null || (b?.expiresOn && !expiresOn)) return deps.reply({ error: 'invalid_wallet_movement' }, 400);
  const signed = sign * miles;
  const costCents = signed < 0 ? -exitCostCents(await positionOf(env, accountId), miles) : costInput;
  if (!(await insertMovement(env, { accountId, kind, miles: signed, costCents, occurredOn, expiresOn, note: clean(b?.note, 300) || null, actor: auth.userId }))) return deps.reply({ error: 'insufficient_wallet_balance' }, 409);
  await deps.audit(env, auth.userId, 'finance.wallet_movement_created', 'fin_wallet_account', accountId);
  return deps.reply({ ok: true }, 201);
}

async function reconcileAccount(req: Request, env: Env, accountId: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const account = await env.DB.prepare('SELECT reported_balance FROM fin_wallet_accounts WHERE id=?').bind(accountId).first<{ reported_balance: number | null }>();
  if (!account) return deps.reply({ error: 'wallet_account_not_found' }, 404);
  const b = await readJson(req);
  // O saldo pode vir do programa (e-mail) ou ser digitado por quem conferiu no app.
  const typed = b?.balance !== undefined && b?.balance !== null && b?.balance !== '';
  const target = typed ? intIn(b!.balance, 0, MAX_MILES) : account.reported_balance;
  if (target === null || target === undefined) return deps.reply({ error: typed ? 'invalid_request' : 'wallet_no_reported_balance' }, typed ? 400 : 422);
  const position = await positionOf(env, accountId);
  const diff = target - position.miles;
  if (typed) {
    await env.DB.prepare("UPDATE fin_wallet_accounts SET reported_balance=?,reported_at=?,reported_source='manual',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(target, new Date().toISOString(), accountId).run();
  }
  if (diff === 0) return deps.reply({ ok: true, adjusted: 0 });
  const costCents = diff < 0 ? -exitCostCents(position, -diff) : 0;
  const note = clean(b?.note, 300) || `Ajuste ao saldo ${typed ? 'conferido no app' : 'informado pelo programa'}`;
  if (!(await insertMovement(env, { accountId, kind: 'adjust', miles: diff, costCents, occurredOn: todayIso(), note, actor: auth.userId }))) return deps.reply({ error: 'insufficient_wallet_balance' }, 409);
  await deps.audit(env, auth.userId, 'finance.wallet_account_reconciled', 'fin_wallet_account', accountId);
  return deps.reply({ ok: true, adjusted: diff });
}

/** Promoção feita numa conta (ex.: Livelo para LATAM Turbo). É só controle: o saldo muda pelos lançamentos ou pelo "Conferir saldo". */
async function promoCreate(req: Request, env: Env, accountId: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const account = await env.DB.prepare('SELECT id FROM fin_wallet_accounts WHERE id=?').bind(accountId).first();
  if (!account) return deps.reply({ error: 'wallet_account_not_found' }, 404);
  const b = await readJson(req);
  const name = clean(b?.name, 80);
  const doneOn = b?.doneOn ? dateOk(b.doneOn) : todayIso();
  const optional = (value: unknown, max: number) => (value === undefined || value === null || value === '' ? null : intIn(value, 1, max));
  const pointsSent = optional(b?.pointsSent, MAX_MILES);
  const milesReceived = optional(b?.milesReceived, MAX_MILES);
  const bonusPercent = b?.bonusPercent === undefined || b?.bonusPercent === null || b?.bonusPercent === '' ? null : intIn(b.bonusPercent, 0, 1000);
  const hasBad = (b?.pointsSent ?? '') !== '' && pointsSent === null || (b?.milesReceived ?? '') !== '' && milesReceived === null || (b?.bonusPercent ?? '') !== '' && bonusPercent === null;
  if (!name || !doneOn || hasBad) return deps.reply({ error: 'invalid_wallet_promo' }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_wallet_promos (id,account_id,promo_name,month,done_on,points_sent,bonus_percent,miles_received,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, accountId, name, doneOn.slice(0, 7), doneOn, pointsSent, bonusPercent, milesReceived, clean(b?.note, 300) || null, auth.userId).run();
  await deps.audit(env, auth.userId, 'finance.wallet_promo_created', 'fin_wallet_account', accountId);
  return deps.reply({ id }, 201);
}

async function promoVoid(req: Request, env: Env, id: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const reason = clean(b?.reason, 300);
  if (reason.length < 3) return deps.reply({ error: 'invalid_request' }, 400);
  const promo = await env.DB.prepare('SELECT account_id,voided_at FROM fin_wallet_promos WHERE id=?').bind(id).first<{ account_id: string; voided_at: string | null }>();
  if (!promo) return deps.reply({ error: 'not_found' }, 404);
  if (promo.voided_at) return deps.reply({ error: 'wallet_promo_already_voided' }, 409);
  await env.DB.prepare('UPDATE fin_wallet_promos SET voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE id=? AND voided_at IS NULL').bind(reason, id).run();
  await deps.audit(env, auth.userId, 'finance.wallet_promo_voided', 'fin_wallet_account', promo.account_id);
  return deps.reply({ ok: true });
}

async function movementVoid(req: Request, env: Env, id: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const reason = clean(b?.reason, 300);
  if (reason.length < 3) return deps.reply({ error: 'invalid_request' }, 400);
  const mv = await env.DB.prepare('SELECT account_id,miles,issuance_id,voided_at FROM fin_wallet_movements WHERE id=?').bind(id).first<{ account_id: string; miles: number; issuance_id: string | null; voided_at: string | null }>();
  if (!mv) return deps.reply({ error: 'not_found' }, 404);
  if (mv.voided_at) return deps.reply({ error: 'wallet_movement_already_voided' }, 409);
  if (mv.issuance_id) {
    const issuance = await env.DB.prepare('SELECT status FROM fin_issuances WHERE id=?').bind(mv.issuance_id).first<{ status: string }>();
    if (issuance?.status !== 'pending' && issuance?.status !== 'issued') return deps.reply({ error: 'issuance_locked_after_issued' }, 409);
  }
  // Estornar uma entrada não pode deixar o saldo negativo.
  const result = await env.DB.prepare(
    `UPDATE fin_wallet_movements SET voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE id=? AND voided_at IS NULL
       AND (? <= 0 OR (SELECT COALESCE(sum(miles),0) FROM fin_wallet_movements WHERE account_id=? AND voided_at IS NULL) - ? >= 0)`,
  ).bind(reason, id, mv.miles, mv.account_id, mv.miles).run();
  if (!result.meta.changes) return deps.reply({ error: 'insufficient_wallet_balance' }, 409);
  if (mv.issuance_id) await deps.recomputeIssuanceMiles(env, mv.issuance_id);
  await deps.audit(env, auth.userId, 'finance.wallet_movement_voided', 'fin_wallet_movement', id);
  return deps.reply({ ok: true });
}

// --- clubes ---------------------------------------------------------------------------------------
async function clubCreate(req: Request, env: Env, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const name = clean(b?.name, 80);
  const monthlyMiles = intIn(b?.monthlyMiles, 0, MAX_MILES);
  const monthlyCostCents = b?.monthlyCostCents === undefined || b?.monthlyCostCents === '' ? 0 : intIn(b.monthlyCostCents, 0, MAX_CENTS);
  const noDay = b?.creditDay === undefined || b?.creditDay === null || b?.creditDay === '';
  const creditDay = noDay ? null : intIn(b?.creditDay, 1, 31);
  if (!accountId || !name || monthlyMiles === null || monthlyCostCents === null || (!noDay && creditDay === null)) return deps.reply({ error: 'invalid_wallet_club' }, 400);
  if (!(await env.DB.prepare('SELECT 1 FROM fin_wallet_accounts WHERE id=?').bind(accountId).first())) return deps.reply({ error: 'wallet_account_not_found' }, 404);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_wallet_clubs (id,account_id,name,monthly_miles,monthly_cost_cents,credit_day,card_label) VALUES (?,?,?,?,?,?,?)')
    .bind(id, accountId, name, monthlyMiles, monthlyCostCents, creditDay, clean(b?.cardLabel, 80) || null).run();
  await deps.audit(env, auth.userId, 'finance.wallet_club_created', 'fin_wallet_club', id);
  return deps.reply({ id }, 201);
}

async function clubUpdate(req: Request, env: Env, id: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  if (!b) return deps.reply({ error: 'invalid_request' }, 400);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(b, key);
  const status = has('status') ? clean(b.status, 20) : null;
  if (has('status') && !CLUB_STATUSES.includes(status!)) return deps.reply({ error: 'invalid_wallet_club' }, 400);
  const monthlyMiles = has('monthlyMiles') ? intIn(b.monthlyMiles, 0, MAX_MILES) : null;
  const monthlyCostCents = has('monthlyCostCents') ? intIn(b.monthlyCostCents, 0, MAX_CENTS) : null;
  const noDay = b.creditDay === null || b.creditDay === '';
  const creditDay = has('creditDay') && !noDay ? intIn(b.creditDay, 1, 31) : null;
  if ((has('monthlyMiles') && monthlyMiles === null) || (has('monthlyCostCents') && monthlyCostCents === null) || (has('creditDay') && !noDay && creditDay === null)) return deps.reply({ error: 'invalid_wallet_club' }, 400);
  const result = await env.DB.prepare(
    `UPDATE fin_wallet_clubs SET
       name=CASE WHEN ?=1 THEN ? ELSE name END,
       monthly_miles=CASE WHEN ?=1 THEN ? ELSE monthly_miles END,
       monthly_cost_cents=CASE WHEN ?=1 THEN ? ELSE monthly_cost_cents END,
       credit_day=CASE WHEN ?=1 THEN ? ELSE credit_day END,
       card_label=CASE WHEN ?=1 THEN ? ELSE card_label END,
       status=CASE WHEN ?=1 THEN ? ELSE status END,
       updated_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).bind(
    has('name') && clean(b.name, 80) ? 1 : 0, clean(b.name, 80),
    has('monthlyMiles') ? 1 : 0, monthlyMiles, has('monthlyCostCents') ? 1 : 0, monthlyCostCents,
    has('creditDay') ? 1 : 0, creditDay, has('cardLabel') ? 1 : 0, clean(b.cardLabel, 80) || null,
    has('status') ? 1 : 0, status, id,
  ).run();
  if (!result.meta.changes) return deps.reply({ error: 'wallet_club_not_found' }, 404);
  await deps.audit(env, auth.userId, 'finance.wallet_club_updated', 'fin_wallet_club', id);
  return deps.reply({ ok: true });
}

// --- eventos lidos dos e-mails dos programas -----------------------------------------------------------
async function findAccountForEvent(env: Env, ev: WalletEventInput): Promise<string | null> {
  if (ev.memberNumber) {
    const byNumber = await env.DB.prepare('SELECT id FROM fin_wallet_accounts WHERE program=? AND member_number=? AND active=1').bind(ev.program, ev.memberNumber).all<{ id: string }>();
    if (byNumber.results.length === 1) return byNumber.results[0]!.id;
  }
  if (!ev.holderHint) return null;
  const rows = await env.DB.prepare('SELECT id,holder FROM fin_wallet_accounts WHERE program=? AND active=1').bind(ev.program).all<{ id: string; holder: string }>();
  const hint = firstWord(ev.holderHint);
  const matches = rows.results.filter((row) => firstWord(row.holder) === hint);
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Aplica um evento (já ligado a uma conta): crédito do clube, situação do clube e saldo informado pelo programa. */
async function applyEvent(env: Env, eventId: string, accountId: string, ev: WalletEventInput) {
  const day = ev.occurredAt.slice(0, 10);
  const clubs = (await env.DB.prepare(`SELECT ${clubColumns} FROM fin_wallet_clubs WHERE account_id=? ORDER BY created_at`).bind(accountId).all<Row>()).results;
  const live = clubs.filter((c) => c.status !== 'canceled');
  // Qual clube da conta o e-mail descreve: mesma mensalidade ou mesmas milhas; se só existe um, é ele.
  const exact = live.filter((c) => (ev.monthlyCostCents !== null && Number(c.monthly_cost_cents) === ev.monthlyCostCents) || (ev.miles !== null && Number(c.monthly_miles) === ev.miles));
  const targets = exact.length ? [exact[0]!] : live.length === 1 ? live : [];
  const setStatus = async (status: string, text: string) => {
    for (const club of targets.length ? targets : live) {
      await env.DB.prepare('UPDATE fin_wallet_clubs SET status=?,last_event_on=?,last_event=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (last_event_on IS NULL OR last_event_on<=?)').bind(status, day, text, club.id, day).run();
    }
  };

  if (ev.kind === 'club_credited' && ev.miles && ev.miles > 0) {
    const club = targets[0];
    const cost = club ? Number(club.monthly_cost_cents) : ev.monthlyCostCents ?? 0;
    // Crédito de antes do saldo inicial (ou de um ajuste ao saldo do programa) já está dentro desse saldo: não soma de novo.
    const baseline = await env.DB.prepare("SELECT max(occurred_on) d FROM fin_wallet_movements WHERE account_id=? AND kind IN ('opening','adjust') AND voided_at IS NULL").bind(accountId).first<{ d: string | null }>();
    if (!baseline?.d || day > baseline.d) await insertMovement(env, { accountId, kind: 'club_credit', miles: ev.miles, costCents: cost, occurredOn: day, note: `Clube ${ev.program}: crédito do mês`, source: 'email', eventId, actor: null });
    if (club) await env.DB.prepare("UPDATE fin_wallet_clubs SET status='active',last_credit_on=?,last_event_on=?,last_event=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(day, day, 'Crédito do mês chegou', club.id).run();
  } else if (ev.kind === 'club_payment_failed') await setStatus('payment_failed', 'Pagamento recusado');
  else if (ev.kind === 'club_payment_ok') await setStatus('active', 'Pagamento aprovado');
  else if (ev.kind === 'club_canceled') await setStatus('canceled', 'Clube cancelado');

  if (ev.balance !== null) {
    const at = ev.balanceAt ?? ev.occurredAt;
    await env.DB.prepare("UPDATE fin_wallet_accounts SET reported_balance=?,reported_at=?,reported_source='email',updated_at=CURRENT_TIMESTAMP WHERE id=? AND (reported_at IS NULL OR reported_at<?)").bind(ev.balance, at, accountId, at).run();
  }
  if (ev.memberNumber) await env.DB.prepare('UPDATE fin_wallet_accounts SET member_number=? WHERE id=? AND member_number IS NULL').bind(ev.memberNumber, accountId).run();
  await env.DB.prepare('UPDATE fin_wallet_events SET applied=1,account_id=? WHERE id=?').bind(accountId, eventId).run();
}

function validEvent(raw: unknown): WalletEventInput | null {
  const e = raw as Row | null;
  if (!e || typeof e !== 'object') return null;
  const sourceId = clean(e.sourceId, 200);
  const kind = clean(e.kind, 30);
  const program = clean(e.program, 80);
  const occurredAt = typeof e.occurredAt === 'string' && !Number.isNaN(Date.parse(e.occurredAt)) ? new Date(e.occurredAt).toISOString() : null;
  if (!sourceId || !EVENT_KINDS.includes(kind) || !program || !occurredAt) return null;
  const optInt = (v: unknown, max: number) => (v === null || v === undefined ? null : intIn(v, 0, max));
  return {
    sourceId, kind: kind as WalletEventInput['kind'], program, holderHint: clean(e.holderHint, 80) || null, memberNumber: clean(e.memberNumber, 40) || null,
    miles: optInt(e.miles, MAX_MILES), balance: optInt(e.balance, MAX_MILES),
    balanceAt: typeof e.balanceAt === 'string' && !Number.isNaN(Date.parse(e.balanceAt)) ? new Date(e.balanceAt).toISOString() : null, planName: clean(e.planName, 80) || null,
    monthlyCostCents: optInt(e.monthlyCostCents, MAX_CENTS), occurredAt, subject: clean(e.subject, 200),
  };
}

/** Rota interna: grava os eventos novos (cada e-mail só uma vez) e aplica os que já têm dono. */
export async function ingestWalletEvents(env: Env, rawEvents: unknown[]): Promise<{ received: number; created: number; applied: number; unmatched: number; invalid: number }> {
  const out = { received: rawEvents.length, created: 0, applied: 0, unmatched: 0, invalid: 0 };
  const events = rawEvents.map(validEvent);
  // Do mais antigo para o mais novo, para o "último evento" do clube refletir o e-mail mais recente.
  const ordered = events.filter((e): e is WalletEventInput => e !== null).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  out.invalid = events.length - ordered.length;
  for (const ev of ordered) {
    const accountId = await findAccountForEvent(env, ev);
    const id = crypto.randomUUID();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO fin_wallet_events (id,source_id,kind,program,holder_hint,member_number,account_id,miles,balance,balance_at,plan_name,monthly_cost_cents,occurred_at,subject)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, ev.sourceId, ev.kind, ev.program, ev.holderHint, ev.memberNumber, accountId, ev.miles, ev.balance, ev.balanceAt ?? null, ev.planName, ev.monthlyCostCents, ev.occurredAt, ev.subject).run();
    if (!inserted.meta.changes) continue;
    out.created += 1;
    if (accountId) { await applyEvent(env, id, accountId, ev); out.applied += 1; } else out.unmatched += 1;
  }
  return out;
}

async function eventLinkAccount(req: Request, env: Env, eventId: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  if (!accountId) return deps.reply({ error: 'invalid_request' }, 400);
  const row = await env.DB.prepare('SELECT source_id,kind,program,holder_hint,member_number,miles,balance,balance_at,plan_name,monthly_cost_cents,occurred_at,subject,applied FROM fin_wallet_events WHERE id=?').bind(eventId).first<Row>();
  if (!row) return deps.reply({ error: 'not_found' }, 404);
  if (Number(row.applied) === 1) return deps.reply({ error: 'wallet_event_already_applied' }, 409);
  if (!(await env.DB.prepare('SELECT 1 FROM fin_wallet_accounts WHERE id=? AND program=?').bind(accountId, row.program).first())) return deps.reply({ error: 'wallet_account_not_found' }, 404);
  await applyEvent(env, eventId, accountId, {
    sourceId: String(row.source_id), kind: row.kind as WalletEventInput['kind'], program: String(row.program), holderHint: row.holder_hint as string | null,
    memberNumber: row.member_number as string | null, miles: row.miles as number | null, balance: row.balance as number | null, balanceAt: row.balance_at as string | null, planName: row.plan_name as string | null,
    monthlyCostCents: row.monthly_cost_cents as number | null, occurredAt: String(row.occurred_at), subject: String(row.subject ?? ''),
  });
  await deps.audit(env, auth.userId, 'finance.wallet_event_linked', 'fin_wallet_event', eventId);
  return deps.reply({ ok: true });
}

// --- uso das milhas numa emissão -----------------------------------------------------------------------
async function usageList(req: Request, env: Env, issuanceId: string, deps: WalletDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare(
    `SELECT mv.id,mv.account_id,mv.miles,mv.cost_cents,mv.issuance_cost_cents,mv.fx_rate,mv.occurred_on,acc.holder,acc.program
       FROM fin_wallet_movements mv JOIN fin_wallet_accounts acc ON acc.id=mv.account_id
      WHERE mv.issuance_id=? AND mv.voided_at IS NULL ORDER BY mv.created_at`,
  ).bind(issuanceId).all<Row>();
  return deps.reply({ usages: rows.results.map((r) => ({ id: r.id, accountId: r.account_id, holder: r.holder, program: r.program, miles: -Number(r.miles), costCents: -Number(r.cost_cents), issuanceCostCents: r.issuance_cost_cents, fxRate: r.fx_rate, occurredOn: r.occurred_on })) });
}

async function usageCreate(req: Request, env: Env, issuanceId: string, deps: WalletDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const accountId = typeof b?.accountId === 'string' && UUID_RE.test(b.accountId) ? b.accountId : null;
  const miles = intIn(b?.miles, 1, MAX_MILES);
  if (!accountId || !miles) return deps.reply({ error: 'invalid_wallet_usage' }, 400);
  const issuance = await env.DB.prepare('SELECT status,mode,currency,loyalty_program FROM fin_issuances WHERE id=?').bind(issuanceId).first<{ status: string; mode: string; currency: string; loyalty_program: string | null }>();
  if (!issuance) return deps.reply({ error: 'issuance_not_found' }, 404);
  if (issuance.status !== 'pending' && issuance.status !== 'issued') return deps.reply({ error: 'issuance_locked_after_issued' }, 409);
  if (issuance.mode !== 'miles' && issuance.mode !== 'hybrid') return deps.reply({ error: 'issuance_mode_does_not_use_miles' }, 422);
  const account = await env.DB.prepare('SELECT program,active FROM fin_wallet_accounts WHERE id=?').bind(accountId).first<{ program: string; active: number }>();
  if (!account || !account.active) return deps.reply({ error: 'wallet_account_not_found' }, 404);

  const position = await positionOf(env, accountId);
  if (miles > position.miles) return deps.reply({ error: 'insufficient_wallet_balance' }, 409);
  const costBrl = exitCostCents(position, miles);
  let issuanceCost = costBrl;
  let fx: string | null = null;
  if (issuance.currency !== 'BRL') {
    const rate = Number(b?.fxRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) return deps.reply({ error: 'fx_rate_required', currency: issuance.currency, costBrlCents: costBrl }, 422);
    issuanceCost = Math.round(costBrl / rate);
    fx = String(rate);
  }
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO fin_wallet_movements (id,account_id,kind,miles,cost_cents,occurred_on,issuance_id,issuance_cost_cents,fx_rate,note,source,created_by)
     SELECT ?,?,'usage',?,?,?,?,?,?,?,'manual',?
      WHERE (SELECT COALESCE(sum(miles),0) FROM fin_wallet_movements WHERE account_id=? AND voided_at IS NULL) >= ?`,
  ).bind(id, accountId, -miles, -costBrl, todayIso(), issuanceId, issuanceCost, fx, clean(b?.note, 300) || 'Emissão de passagem', auth.userId, accountId, miles).run();
  if (!result.meta.changes) return deps.reply({ error: 'insufficient_wallet_balance' }, 409);
  if (!issuance.loyalty_program) await env.DB.prepare('UPDATE fin_issuances SET loyalty_program=? WHERE id=?').bind(account.program, issuanceId).run();
  await deps.recomputeIssuanceMiles(env, issuanceId);
  await deps.audit(env, auth.userId, 'finance.wallet_usage_created', 'fin_wallet_movement', id);
  return deps.reply({ id, costCents: costBrl, issuanceCostCents: issuanceCost }, 201);
}
