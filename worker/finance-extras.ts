// Financeiro, recursos do painel novo (só master):
// - venda direta, sem proposta (POST /api/admin/finance/sales/direct), já com o recebimento quando foi pago na hora;
// - valor equivalente informativo em outra moeda (PATCH /api/admin/finance/sales/<id>), nunca somado entre moedas;
// - lista de voos com custo e lucro (GET /api/admin/finance/flights);
// - lista de contas a receber (GET /api/admin/finance/receivables);
// - recibo por venda e o PDF anexado (…/sales/<id>/receipt, …/receipts/<id>/files, …/receipt-files/<id>).
// - orçamentos de passagem (…/quotes), antes da venda: lista, criar, ler, editar e apagar.
type Row = Record<string, unknown>;
export interface FinanceExtrasAuth { userId: string; roles: string[] }
export interface FinanceExtrasDeps {
  reply(body: unknown, status?: number, headers?: HeadersInit): Response;
  getAuth(req: Request, env: Env): Promise<FinanceExtrasAuth | null>;
  mutationAuth(req: Request, env: Env): Promise<FinanceExtrasAuth | null>;
  audit(env: Env, actor: string | null, action: string, targetType: string, targetId: string | null): Promise<void>;
  profitSummary(netAmountCents: number, issuanceRows: Row[]): Record<string, number>;
}

const UUID = '[0-9a-f-]{36}';
const MAX_CENTS = 100_000_000_00;
const CURRENCIES = ['EUR', 'BRL', 'USD', 'GBP'];
const RECEIVABLE_METHODS = ['pix', 'transfer', 'card', 'cash', 'boleto', 'other'];
const RECEIPT_PAYMENT_METHODS = ['transfer', 'pix', 'card', 'cash', 'other'];
const RECEIPT_STATUSES = ['paid', 'partial', 'pending'];
const FILE_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const FILE_MAX_BYTES = 1_400_000;
const FILES_PER_RECEIPT = 5;
const FILES_GLOBAL_QUOTA = 100 * 1024 * 1024;

const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const dateOk = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null);
const timeOk = (value: unknown) => (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '');
const centsOk = (value: unknown, min = 0) => { const n = Number(value); return Number.isInteger(n) && n >= min && n <= MAX_CENTS ? n : null; };
const currencyOk = (value: unknown) => { const v = typeof value === 'string' ? value.trim().toUpperCase() : ''; return CURRENCIES.includes(v) ? v : null; };
async function readJson(req: Request): Promise<Row | null> { try { return await req.json() as Row; } catch { return null; } }

/** Rotas /api/admin/finance/ tratadas aqui; devolve null para o roteador seguir adiante. */
export async function financeExtras(req: Request, env: Env, url: URL, deps: FinanceExtrasDeps): Promise<Response | null> {
  const p = url.pathname;
  const m = req.method;
  if (m === 'POST' && p === '/api/admin/finance/sales/direct') return directSale(req, env, deps);
  if (m === 'GET' && p === '/api/admin/finance/flights') return flights(req, env, deps);
  if (m === 'GET' && p === '/api/admin/finance/receivables') return receivablesList(req, env, url, deps);
  if (m === 'GET' && p === '/api/admin/finance/accounts/balances') return accountBalances(req, env, deps);
  const sale = p.match(new RegExp(`^/api/admin/finance/sales/(${UUID})$`, 'i'));
  if (m === 'PATCH' && sale) return saleAltUpdate(req, env, sale[1]!, deps);
  const receipt = p.match(new RegExp(`^/api/admin/finance/sales/(${UUID})/receipt$`, 'i'));
  if (m === 'GET' && receipt) return receiptGet(req, env, receipt[1]!, deps);
  if (m === 'PUT' && receipt) return receiptPut(req, env, receipt[1]!, deps);
  if (m === 'GET' && p === '/api/admin/finance/quotes') return quotesList(req, env, deps);
  if (m === 'POST' && p === '/api/admin/finance/quotes') return quoteCreate(req, env, deps);
  const quote = p.match(new RegExp(`^/api/admin/finance/quotes/(${UUID})$`, 'i'));
  if (m === 'GET' && quote) return quoteGet(req, env, quote[1]!, deps);
  if (m === 'PUT' && quote) return quoteUpdate(req, env, quote[1]!, deps);
  if (m === 'DELETE' && quote) return quoteDelete(req, env, quote[1]!, deps);
  const files = p.match(new RegExp(`^/api/admin/finance/receipts/(${UUID})/files$`, 'i'));
  if (m === 'POST' && files) return fileUpload(req, env, files[1]!, deps);
  const file = p.match(new RegExp(`^/api/admin/finance/receipt-files/(${UUID})$`, 'i'));
  if (m === 'GET' && file) return fileDownload(req, env, file[1]!, deps);
  if (m === 'DELETE' && file) return fileDelete(req, env, file[1]!, deps);
  return null;
}

async function master(req: Request, env: Env, deps: FinanceExtrasDeps) {
  const auth = await deps.getAuth(req, env);
  return auth?.roles.includes('master') ? auth : null;
}
async function masterMutation(req: Request, env: Env, deps: FinanceExtrasDeps) {
  const auth = await deps.mutationAuth(req, env);
  return auth?.roles.includes('master') ? auth : null;
}

// --- venda direta ------------------------------------------------------------------------------
async function directSale(req: Request, env: Env, deps: FinanceExtrasDeps) {
  const auth = await deps.mutationAuth(req, env);
  if (!auth) return deps.reply({ error: 'unauthorized' }, 401);
  if (!auth.roles.includes('master')) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const customerName = clean(b?.customerName, 120);
  const currency = currencyOk(b?.currency);
  const saleDate = dateOk(b?.saleDate);
  const grossAmountCents = centsOk(b?.grossAmountCents, 1);
  const discountCents = b?.discountCents === undefined ? 0 : centsOk(b.discountCents);
  const passengerCount = b?.passengerCount === undefined ? 1 : Number(b.passengerCount);
  if (customerName.length < 2 || !currency || !saleDate || !grossAmountCents || discountCents === null
    || !Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 20) return deps.reply({ error: 'invalid_request' }, 400);
  if (discountCents >= grossAmountCents) return deps.reply({ error: 'discount_exceeds_gross_amount' }, 422);
  const netAmountCents = grossAmountCents - discountCents;

  const altCurrency = b?.altCurrency ? currencyOk(b.altCurrency) : null;
  const altAmountCents = b?.altAmountCents ? centsOk(b.altAmountCents, 1) : null;
  if ((altCurrency === null) !== (altAmountCents === null) || altCurrency === currency) return deps.reply({ error: 'invalid_alt_amount' }, 400);

  const payment = (b?.payment && typeof b.payment === 'object' ? b.payment : null) as Row | null;
  const received = payment?.received === true;
  const method = typeof payment?.method === 'string' && RECEIVABLE_METHODS.includes(payment.method) ? payment.method : null;
  const accountId = typeof payment?.accountId === 'string' && new RegExp(`^${UUID}$`, 'i').test(payment.accountId) ? payment.accountId : null;
  const receivedOn = payment?.receivedOn ? dateOk(payment.receivedOn) : saleDate;
  if (received && (!method || !accountId || !receivedOn)) return deps.reply({ error: 'invalid_payment' }, 400);
  // Conta em outra moeda (ex.: cofrinho em R$ recebendo venda em €): o valor creditado na moeda da conta é obrigatório.
  let accountAmountCents: number | null = null;
  if (received) {
    const account = await env.DB.prepare('SELECT currency FROM fin_accounts WHERE id=? AND active=1').bind(accountId).first<{ currency: string }>();
    if (!account) return deps.reply({ error: 'account_not_found' }, 422);
    if (account.currency !== currency) {
      accountAmountCents = centsOk(payment?.accountAmountCents, 1);
      if (!accountAmountCents) return deps.reply({ error: 'account_amount_required' }, 422);
    }
  }

  const partnerId = typeof b?.partnerId === 'string' && new RegExp(`^${UUID}$`, 'i').test(b.partnerId) ? b.partnerId : null;
  const leadId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  const year = Number(saleDate.slice(0, 4));
  const counterSql = '(SELECT printf(\'VD-%04d-%05d\',year,last_value) FROM fin_direct_sale_counters WHERE year=?)';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO fin_direct_sale_counters(year,last_value) VALUES(?,1) ON CONFLICT(year) DO UPDATE SET last_value=last_value+1').bind(year),
    env.DB.prepare(`INSERT INTO lead_requests (id,kind,origin,destination,customer_name,customer_email,customer_phone,adults,status,sale_amount_cents,sale_currency,converted_at,internal_notes,protocol,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,${counterSql},CURRENT_TIMESTAMP)`)
      .bind(leadId, 'direct_sale', clean(b?.origin, 120) || null, clean(b?.destination, 120) || null, customerName, clean(b?.customerEmail, 254) || null,
        clean(b?.customerPhone, 40) || null, passengerCount, 'converted', netAmountCents, currency, clean(b?.notes, 1000) || null, year),
    env.DB.prepare(`INSERT INTO fin_sales (id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents,passenger_count,owner_user_id,partner_id,internal_notes,alt_currency,alt_amount_cents,created_by)
      VALUES (?,?,${counterSql},?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(saleId, leadId, year, saleDate, currency, grossAmountCents, discountCents, netAmountCents, passengerCount, auth.userId, partnerId,
        clean(b?.notes, 1000) || null, altCurrency, altAmountCents, auth.userId),
  ];
  if (received) {
    const receivableId = crypto.randomUUID();
    statements.push(
      env.DB.prepare("INSERT INTO fin_receivables (id,sale_id,installment_number,due_date,expected_amount_cents,currency,account_id,method,status) VALUES (?,?,1,?,?,?,?,?,'paid')")
        .bind(receivableId, saleId, saleDate, netAmountCents, currency, accountId, method),
      env.DB.prepare('INSERT INTO fin_receivable_payments (id,receivable_id,received_amount_cents,currency,received_at,account_id,reference,created_by,account_amount_cents) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), receivableId, netAmountCents, currency, `${receivedOn}T12:00:00Z`, accountId, clean(payment?.reference, 120) || null, auth.userId, accountAmountCents),
    );
  }
  try { await env.DB.batch(statements); } catch { return deps.reply({ error: 'sale_creation_failed' }, 500); }
  await deps.audit(env, auth.userId, 'finance.direct_sale_created', 'fin_sale', saleId);
  const created = await env.DB.prepare('SELECT protocol FROM fin_sales WHERE id=?').bind(saleId).first<{ protocol: string }>();
  return deps.reply({ id: saleId, protocol: created?.protocol ?? null, received }, 201);
}

async function saleAltUpdate(req: Request, env: Env, saleId: string, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const sale = await env.DB.prepare('SELECT currency FROM fin_sales WHERE id=?').bind(saleId).first<{ currency: string }>();
  if (!sale) return deps.reply({ error: 'not_found' }, 404);
  const clear = b?.altCurrency === null || b?.altCurrency === '';
  const altCurrency = clear ? null : currencyOk(b?.altCurrency);
  const altAmountCents = clear ? null : centsOk(b?.altAmountCents, 1);
  if (!clear && (!altCurrency || !altAmountCents || altCurrency === sale.currency)) return deps.reply({ error: 'invalid_alt_amount' }, 400);
  await env.DB.prepare('UPDATE fin_sales SET alt_currency=?,alt_amount_cents=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(altCurrency, altAmountCents, saleId).run();
  await deps.audit(env, auth.userId, 'finance.sale_alt_amount_updated', 'fin_sale', saleId);
  return deps.reply({ ok: true });
}

// --- voos, custo e lucro -----------------------------------------------------------------------
async function flights(req: Request, env: Env, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const sales = await env.DB.prepare(
    `SELECT s.id,s.protocol,s.sale_date,s.currency,s.net_amount_cents,s.alt_currency,s.alt_amount_cents,s.status,s.passenger_count,
            l.customer_name,l.origin,l.destination,l.kind,
            (SELECT id FROM fin_receipts r WHERE r.sale_id=s.id) receipt_id
       FROM fin_sales s LEFT JOIN lead_requests l ON l.id=s.lead_request_id
      ORDER BY s.sale_date DESC,s.created_at DESC LIMIT 500`,
  ).all<Row>();
  const issuances = await env.DB.prepare(
    `SELECT i.id,i.sale_id,i.mode,i.airline,i.pnr,i.status,i.currency,i.cash_amount_cents,i.miles_quantity,i.miles_cost_cents,
            i.airport_fees_cents,i.issuance_fee_cents,i.consolidator_fee_cents,i.gateway_fee_cents,i.agent_commission_cents,i.other_costs_cents
       FROM fin_issuances i JOIN fin_sales s ON s.id=i.sale_id`,
  ).all<Row>();
  const bySale = new Map<string, Row[]>();
  for (const row of issuances.results) {
    const key = String(row.sale_id);
    bySale.set(key, [...(bySale.get(key) ?? []), row]);
  }
  return deps.reply({
    flights: sales.results.map((s) => {
      const rows = bySale.get(String(s.id)) ?? [];
      return {
        id: s.id, protocol: s.protocol, saleDate: s.sale_date, currency: s.currency, netAmountCents: s.net_amount_cents,
        altCurrency: s.alt_currency, altAmountCents: s.alt_amount_cents, status: s.status, passengerCount: s.passenger_count,
        customerName: s.customer_name, origin: s.origin, destination: s.destination, direct: s.kind === 'direct_sale',
        hasReceipt: Boolean(s.receipt_id),
        issuances: rows.map((i) => ({ id: i.id, mode: i.mode, airline: i.airline, pnr: i.pnr, status: i.status, milesQuantity: i.miles_quantity })),
        profit: deps.profitSummary(Number(s.net_amount_cents), rows),
      };
    }),
  });
}

async function receivablesList(req: Request, env: Env, url: URL, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const all = url.searchParams.get('status') === 'all';
  const rows = await env.DB.prepare(
    `SELECT r.id,r.sale_id,r.installment_number,r.due_date,r.expected_amount_cents,r.currency,r.method,r.status,s.protocol,l.customer_name,
            COALESCE((SELECT sum(p.received_amount_cents) FROM fin_receivable_payments p WHERE p.receivable_id=r.id),0) received_cents
       FROM fin_receivables r JOIN fin_sales s ON s.id=r.sale_id LEFT JOIN lead_requests l ON l.id=s.lead_request_id
      WHERE (?1=1 OR r.status IN ('open','partial')) AND s.status='confirmed'
      ORDER BY r.due_date ASC LIMIT 500`,
  ).bind(all ? 1 : 0).all<Row>();
  const today = new Date().toISOString().slice(0, 10);
  return deps.reply({
    receivables: rows.results.map((r) => ({
      id: r.id, saleId: r.sale_id, protocol: r.protocol, customerName: r.customer_name, installmentNumber: r.installment_number,
      dueDate: r.due_date, expectedAmountCents: r.expected_amount_cents, receivedCents: r.received_cents, currency: r.currency,
      method: r.method, status: r.status, isOverdue: (r.status === 'open' || r.status === 'partial') && String(r.due_date) < today,
    })),
  });
}

// --- saldo das contas ----------------------------------------------------------------------------
// Saldo na moeda da própria conta: saldo inicial + entradas - saídas. Pagamento na mesma moeda da conta entra pelo valor
// dele; pagamento em outra moeda entra pelo valor creditado/debitado informado (account_amount_cents). Quando esse valor
// falta (pagamentos antigos), o total vai em `estimatedIn`/`estimatedOut` por moeda, para a tela estimar pelo câmbio.
async function accountBalances(req: Request, env: Env, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const accounts = await env.DB.prepare('SELECT id,name,type,institution,last4,currency,opening_balance_cents,opening_balance_at,active FROM fin_accounts ORDER BY active DESC,name').all<Row>();
  const flow = (table: string, amountColumn: string) => env.DB.prepare(
    `SELECT account_id,currency,COALESCE(SUM(${amountColumn}),0) amount,
            COALESCE(SUM(CASE WHEN account_amount_cents IS NOT NULL THEN account_amount_cents ELSE 0 END),0) credited,
            COALESCE(SUM(CASE WHEN account_amount_cents IS NULL THEN ${amountColumn} ELSE 0 END),0) uncredited
       FROM ${table} GROUP BY account_id,currency`,
  ).all<Row>();
  const [inflows, outflows] = await Promise.all([flow('fin_receivable_payments', 'received_amount_cents'), flow('fin_obligation_payments', 'paid_amount_cents')]);
  const sum = (rows: Row[], account: Row) => {
    let total = 0;
    const estimated: Record<string, number> = {};
    for (const row of rows) {
      if (row.account_id !== account.id) continue;
      if (row.currency === account.currency) total += Number(row.amount);
      else {
        total += Number(row.credited);
        if (Number(row.uncredited)) estimated[String(row.currency)] = (estimated[String(row.currency)] ?? 0) + Number(row.uncredited);
      }
    }
    return { total, estimated };
  };
  return deps.reply({
    accounts: accounts.results.map((account) => {
      const entradas = sum(inflows.results, account);
      const saidas = sum(outflows.results, account);
      const opening = Number(account.opening_balance_cents ?? 0);
      return {
        id: account.id, name: account.name, type: account.type, institution: account.institution, last4: account.last4, currency: account.currency,
        active: Boolean(account.active), openingBalanceCents: opening, openingBalanceAt: account.opening_balance_at,
        inCents: entradas.total, outCents: saidas.total, balanceCents: opening + entradas.total - saidas.total,
        estimatedIn: entradas.estimated, estimatedOut: saidas.estimated,
      };
    }),
  });
}

// --- recibo ------------------------------------------------------------------------------------
/** Trechos do itinerário, iguais no recibo e no orçamento. */
function cleanSegments(raw: unknown) {
  return (Array.isArray(raw) ? raw : []).slice(0, 12).map((item) => {
    const s = (item && typeof item === 'object' ? item : {}) as Row;
    const plusDay = Number(s.plusDay);
    return {
      date: dateOk(s.date) ?? '', flight: clean(s.flight, 12), airline: clean(s.airline, 40),
      from: clean(s.from, 4).toUpperCase(), fromCity: clean(s.fromCity, 60), depart: timeOk(s.depart),
      to: clean(s.to, 4).toUpperCase(), toCity: clean(s.toCity, 60), arrive: timeOk(s.arrive),
      plusDay: Number.isInteger(plusDay) && plusDay > 0 && plusDay < 4 ? plusDay : 0, cls: clean(s.cls, 24),
    };
  }).filter((s) => s.flight || s.from || s.to);
}

function cleanReceipt(b: Row) {
  const segments = cleanSegments(b.segments);
  const lines: { title: string; subtitle: string; amountCents: number }[] = [];
  for (const raw of (Array.isArray(b.lines) ? b.lines : []).slice(0, 10)) {
    const l = (raw && typeof raw === 'object' ? raw : {}) as Row;
    const title = clean(l.title, 160);
    const amountCents = centsOk(l.amountCents, 0);
    if (!title) continue;
    if (amountCents === null) return null;
    lines.push({ title, subtitle: clean(l.subtitle, 200), amountCents });
  }
  const currency = currencyOk(b.currency);
  const customerName = clean(b.customerName, 120);
  const totalCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (!currency || customerName.length < 2 || !lines.length || totalCents < 1) return null;
  const altCurrency = b.altCurrency ? currencyOk(b.altCurrency) : null;
  const altAmountCents = b.altAmountCents ? centsOk(b.altAmountCents, 1) : null;
  if ((altCurrency === null) !== (altAmountCents === null) || altCurrency === currency) return null;
  const paymentMethod = typeof b.paymentMethod === 'string' && RECEIPT_PAYMENT_METHODS.includes(b.paymentMethod) ? b.paymentMethod : 'other';
  const status = typeof b.status === 'string' && RECEIPT_STATUSES.includes(b.status) ? b.status : 'paid';
  return {
    customerName, passengerKind: clean(b.passengerKind, 40), baggage: clean(b.baggage, 300),
    reservationCodes: clean(b.reservationCodes, 120), purchaseNumbers: clean(b.purchaseNumbers, 160), ticketNumber: clean(b.ticketNumber, 60),
    issuedBy: clean(b.issuedBy, 120), segments, note: clean(b.note, 300), lines, currency, totalCents, altCurrency, altAmountCents,
    paymentMethod, paymentLabel: clean(b.paymentLabel, 120), status, declaration: clean(b.declaration, 500),
  };
}

async function receiptGet(req: Request, env: Env, saleId: string, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const sale = await env.DB.prepare(
    `SELECT s.id,s.protocol,s.sale_date,s.currency,s.net_amount_cents,s.alt_currency,s.alt_amount_cents,s.passenger_count,l.customer_name,l.origin,l.destination
       FROM fin_sales s LEFT JOIN lead_requests l ON l.id=s.lead_request_id WHERE s.id=?`,
  ).bind(saleId).first<Row>();
  if (!sale) return deps.reply({ error: 'not_found' }, 404);
  const receipt = await env.DB.prepare('SELECT id,number,issued_on,data,updated_at FROM fin_receipts WHERE sale_id=?').bind(saleId).first<Row>();
  const files = receipt
    ? await env.DB.prepare('SELECT id,filename,mime,size_bytes,created_at FROM fin_receipt_files WHERE receipt_id=? ORDER BY created_at').bind(receipt.id).all<Row>()
    : { results: [] as Row[] };
  const issuances = await env.DB.prepare('SELECT airline,pnr,ticket_numbers FROM fin_issuances WHERE sale_id=? ORDER BY created_at').bind(saleId).all<Row>();
  let data: unknown = null;
  if (receipt) { try { data = JSON.parse(String(receipt.data)); } catch { data = null; } }
  return deps.reply({
    sale: {
      id: sale.id, protocol: sale.protocol, saleDate: sale.sale_date, currency: sale.currency, netAmountCents: sale.net_amount_cents,
      altCurrency: sale.alt_currency, altAmountCents: sale.alt_amount_cents, passengerCount: sale.passenger_count,
      customerName: sale.customer_name, origin: sale.origin, destination: sale.destination,
    },
    receipt: receipt ? { id: receipt.id, number: receipt.number, issuedOn: receipt.issued_on, updatedAt: receipt.updated_at, data } : null,
    files: files.results.map((f) => ({ id: f.id, filename: f.filename, mime: f.mime, sizeBytes: f.size_bytes, createdAt: f.created_at })),
    issuances: issuances.results.map((i) => ({ airline: i.airline, pnr: i.pnr, ticketNumbers: i.ticket_numbers })),
  });
}

async function receiptPut(req: Request, env: Env, saleId: string, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const data = b ? cleanReceipt(b) : null;
  const number = clean(b?.number, 40);
  const issuedOn = dateOk(b?.issuedOn);
  if (!data || !issuedOn || !/^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(number)) return deps.reply({ error: 'invalid_receipt' }, 400);
  const sale = await env.DB.prepare('SELECT currency FROM fin_sales WHERE id=?').bind(saleId).first<{ currency: string }>();
  if (!sale) return deps.reply({ error: 'not_found' }, 404);
  if (sale.currency !== data.currency) return deps.reply({ error: 'receipt_currency_must_match_sale' }, 422);
  const existing = await env.DB.prepare('SELECT id FROM fin_receipts WHERE sale_id=?').bind(saleId).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  try {
    if (existing) {
      await env.DB.prepare('UPDATE fin_receipts SET number=?,issued_on=?,data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(number, issuedOn, JSON.stringify(data), id).run();
    } else {
      await env.DB.prepare('INSERT INTO fin_receipts (id,sale_id,number,issued_on,data,created_by) VALUES (?,?,?,?,?,?)').bind(id, saleId, number, issuedOn, JSON.stringify(data), auth.userId).run();
    }
  } catch { return deps.reply({ error: 'receipt_number_taken' }, 409); }
  if (data.altCurrency && data.altAmountCents) {
    await env.DB.prepare('UPDATE fin_sales SET alt_currency=?,alt_amount_cents=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(data.altCurrency, data.altAmountCents, saleId).run();
  }
  await deps.audit(env, auth.userId, existing ? 'finance.receipt_updated' : 'finance.receipt_created', 'fin_receipt', id);
  return deps.reply({ id, number }, existing ? 200 : 201);
}

function decodedSize(b64: string) {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
function fileMimeMatches(mime: string, b64: string) {
  const head = atob(b64.slice(0, 16));
  if (mime === 'application/pdf') return head.startsWith('%PDF');
  if (mime === 'image/png') return head.startsWith('\x89PNG');
  if (mime === 'image/jpeg') return head.startsWith('\xff\xd8\xff');
  return head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
}
const safeName = (value: unknown) => clean(value, 120).replace(/[^\w.\- ()]/g, '_') || 'recibo';

async function fileUpload(req: Request, env: Env, receiptId: string, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const b = await readJson(req);
  const mime = typeof b?.mime === 'string' ? b.mime : '';
  const b64 = typeof b?.base64 === 'string' ? b.base64 : '';
  if (!FILE_MIMES.includes(mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0 || b64.length < 8) return deps.reply({ error: 'invalid_upload' }, 400);
  const size = decodedSize(b64);
  if (size < 1 || size > FILE_MAX_BYTES) return deps.reply({ error: 'attachment_too_large' }, 413);
  if (!fileMimeMatches(mime, b64)) return deps.reply({ error: 'unsupported_attachment_type' }, 415);
  const receipt = await env.DB.prepare('SELECT 1 FROM fin_receipts WHERE id=?').bind(receiptId).first();
  if (!receipt) return deps.reply({ error: 'not_found' }, 404);
  const [perReceipt, total] = await Promise.all([
    env.DB.prepare('SELECT count(*) n FROM fin_receipt_files WHERE receipt_id=?').bind(receiptId).first<{ n: number }>(),
    env.DB.prepare('SELECT COALESCE(SUM(size_bytes),0) n FROM fin_receipt_files').first<{ n: number }>(),
  ]);
  if (Number(perReceipt?.n ?? 0) >= FILES_PER_RECEIPT) return deps.reply({ error: 'attachment_item_limit' }, 409);
  if (Number(total?.n ?? 0) + size > FILES_GLOBAL_QUOTA) return deps.reply({ error: 'attachment_storage_full' }, 507);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO fin_receipt_files (id,receipt_id,filename,mime,size_bytes,content_b64,created_by) VALUES (?,?,?,?,?,?,?)')
    .bind(id, receiptId, safeName(b?.filename), mime, size, b64, auth.userId).run();
  await deps.audit(env, auth.userId, 'finance.receipt_file_added', 'fin_receipt_file', id);
  return deps.reply({ id }, 201);
}

async function fileDownload(req: Request, env: Env, fileId: string, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const row = await env.DB.prepare('SELECT filename,mime,content_b64 FROM fin_receipt_files WHERE id=?').bind(fileId).first<{ filename: string; mime: string; content_b64: string }>();
  if (!row) return deps.reply({ error: 'not_found' }, 404);
  const bytes = Uint8Array.from(atob(row.content_b64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': row.mime, 'content-disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    },
  });
}

async function fileDelete(req: Request, env: Env, fileId: string, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const result = await env.DB.prepare('DELETE FROM fin_receipt_files WHERE id=?').bind(fileId).run();
  if (!result.meta.changes) return deps.reply({ error: 'not_found' }, 404);
  await deps.audit(env, auth.userId, 'finance.receipt_file_removed', 'fin_receipt_file', fileId);
  return deps.reply({ ok: true });
}

// --- orçamentos ----------------------------------------------------------------------------------
// Orçamento de passagem montado antes da venda: cliente, itinerário e preço por passageiro. Não mexe em vendas nem em
// caixa; o PDF sai da página /orcamento.html (imprimir / salvar PDF), como no recibo.
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined'];
// A numeração começa em 500 (ORC-2026-500) para a agência não parecer nova; o contador é por ano.
const QUOTE_FIRST_NUMBER = 500;

function cleanQuote(b: Row) {
  // kind: 'pax' é linha de passageiro (conta na quantidade de passageiros); 'extra' é taxa, bagagem, seguro etc.
  const lines: { title: string; subtitle: string; kind: 'pax' | 'extra'; qty: number; unitCents: number }[] = [];
  for (const raw of (Array.isArray(b.lines) ? b.lines : []).slice(0, 10)) {
    const l = (raw && typeof raw === 'object' ? raw : {}) as Row;
    const title = clean(l.title, 160);
    if (!title) continue;
    const qty = Number(l.qty);
    const unitCents = centsOk(l.unitCents, 0);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99 || unitCents === null) return null;
    lines.push({ title, subtitle: clean(l.subtitle, 200), kind: l.kind === 'extra' ? 'extra' : 'pax', qty, unitCents });
  }
  const currency = currencyOk(b.currency);
  const customerName = clean(b.customerName, 120);
  const totalCents = lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
  if (!currency || customerName.length < 2 || !lines.length || totalCents < 1 || totalCents > MAX_CENTS) return null;
  const altCurrency = b.altCurrency ? currencyOk(b.altCurrency) : null;
  const altAmountCents = b.altAmountCents ? centsOk(b.altAmountCents, 1) : null;
  if ((altCurrency === null) !== (altAmountCents === null) || altCurrency === currency) return null;
  return {
    customerName, customerContact: clean(b.customerContact, 120), baggage: clean(b.baggage, 300),
    segments: cleanSegments(b.segments), note: clean(b.note, 300), lines, currency, totalCents, altCurrency, altAmountCents,
    paymentTerms: clean(b.paymentTerms, 500), conditions: clean(b.conditions, 600),
  };
}

/** Dados do corpo comuns à criação e à edição; null quando algo está inválido. */
function quoteInput(b: Row | null) {
  const data = b ? cleanQuote(b) : null;
  const issuedOn = dateOk(b?.issuedOn);
  const validUntil = b?.validUntil ? dateOk(b.validUntil) : '';
  const status = b?.status === undefined ? 'draft' : typeof b.status === 'string' && QUOTE_STATUSES.includes(b.status) ? b.status : null;
  if (!data || !issuedOn || validUntil === null || !status || (validUntil && validUntil < issuedOn)) return null;
  return { data, issuedOn, validUntil: validUntil || null, status };
}

function quoteRoute(json: unknown) {
  try {
    const segments = (JSON.parse(String(json)) as { segments?: { from?: string; to?: string }[] }).segments ?? [];
    const stops = [segments[0]?.from, ...segments.map((s) => s.to)].filter((code): code is string => Boolean(code));
    return stops.length > 1 ? stops.join(' → ') : '';
  } catch { return ''; }
}

async function quotesList(req: Request, env: Env, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT id,number,issued_on,valid_until,customer_name,currency,total_cents,status,data,updated_at FROM fin_quotes ORDER BY issued_on DESC,created_at DESC LIMIT 500').all<Row>();
  return deps.reply({
    quotes: rows.results.map((r) => ({
      id: r.id, number: r.number, issuedOn: r.issued_on, validUntil: r.valid_until, customerName: r.customer_name, currency: r.currency,
      totalCents: r.total_cents, status: r.status, route: quoteRoute(r.data), updatedAt: r.updated_at,
    })),
  });
}

async function quoteGet(req: Request, env: Env, id: string, deps: FinanceExtrasDeps) {
  if (!(await master(req, env, deps))) return deps.reply({ error: 'forbidden' }, 403);
  const r = await env.DB.prepare('SELECT id,number,issued_on,valid_until,status,data,updated_at FROM fin_quotes WHERE id=?').bind(id).first<Row>();
  if (!r) return deps.reply({ error: 'not_found' }, 404);
  let data: unknown = null;
  try { data = JSON.parse(String(r.data)); } catch { data = null; }
  return deps.reply({ quote: { id: r.id, number: r.number, issuedOn: r.issued_on, validUntil: r.valid_until, status: r.status, updatedAt: r.updated_at, data } });
}

async function quoteCreate(req: Request, env: Env, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const input = quoteInput(await readJson(req));
  if (!input) return deps.reply({ error: 'invalid_quote' }, 400);
  const id = crypto.randomUUID();
  const year = Number(input.issuedOn.slice(0, 4));
  const counterSql = '(SELECT printf(\'ORC-%04d-%03d\',year,last_value) FROM fin_quote_counters WHERE year=?)';
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO fin_quote_counters(year,last_value) VALUES(?,?) ON CONFLICT(year) DO UPDATE SET last_value=last_value+1').bind(year, QUOTE_FIRST_NUMBER),
      env.DB.prepare(`INSERT INTO fin_quotes (id,number,issued_on,valid_until,customer_name,currency,total_cents,status,data,created_by) VALUES (?,${counterSql},?,?,?,?,?,?,?,?)`)
        .bind(id, year, input.issuedOn, input.validUntil, input.data.customerName, input.data.currency, input.data.totalCents, input.status, JSON.stringify(input.data), auth.userId),
    ]);
  } catch { return deps.reply({ error: 'quote_creation_failed' }, 500); }
  const created = await env.DB.prepare('SELECT number FROM fin_quotes WHERE id=?').bind(id).first<{ number: string }>();
  await deps.audit(env, auth.userId, 'finance.quote_created', 'fin_quote', id);
  return deps.reply({ id, number: created?.number ?? null }, 201);
}

async function quoteUpdate(req: Request, env: Env, id: string, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const input = quoteInput(await readJson(req));
  if (!input) return deps.reply({ error: 'invalid_quote' }, 400);
  const result = await env.DB.prepare('UPDATE fin_quotes SET issued_on=?,valid_until=?,customer_name=?,currency=?,total_cents=?,status=?,data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(input.issuedOn, input.validUntil, input.data.customerName, input.data.currency, input.data.totalCents, input.status, JSON.stringify(input.data), id).run();
  if (!result.meta.changes) return deps.reply({ error: 'not_found' }, 404);
  await deps.audit(env, auth.userId, 'finance.quote_updated', 'fin_quote', id);
  return deps.reply({ ok: true });
}

async function quoteDelete(req: Request, env: Env, id: string, deps: FinanceExtrasDeps) {
  const auth = await masterMutation(req, env, deps);
  if (!auth) return deps.reply({ error: 'forbidden' }, 403);
  const result = await env.DB.prepare('DELETE FROM fin_quotes WHERE id=?').bind(id).run();
  if (!result.meta.changes) return deps.reply({ error: 'not_found' }, 404);
  await deps.audit(env, auth.userId, 'finance.quote_deleted', 'fin_quote', id);
  return deps.reply({ ok: true });
}
