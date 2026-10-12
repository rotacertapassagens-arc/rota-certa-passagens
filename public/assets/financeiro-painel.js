// Painel financeiro: lateral com as áreas, visão geral, vendas e recibos, lucro por voo, contas a receber e alertas.
// Cadastros, contas a pagar, assinaturas e milhas ficam em financeiro.js. Dinheiro sempre por moeda, nunca somado entre moedas.
import { api, askConfirm, askForm, centsToInput, esc, financeErrorMessage, fmtDay, money, monthKey, today, toCents } from './fin-ui.js';
import { initCadastros, loadMileageLots, loadObligations, state } from './financeiro.js';

const $ = (id) => document.getElementById(id);
const CURRENCY_NAMES = { EUR: 'Euro', BRL: 'Real', USD: 'Dólar', GBP: 'Libra' };
const currencyOptions = ['EUR', 'BRL', 'USD', 'GBP'].map((value) => ({ value, label: `${CURRENCY_NAMES[value]} (${value})` }));
const modeLabels = { cash: 'Dinheiro', miles: 'Milhas', hybrid: 'Milhas e dinheiro', consolidator: 'Consolidadora', airline: 'Companhia aérea', other: 'Outro' };
const issuanceStatusLabels = { pending: 'Pendente', issued: 'Emitida', canceled: 'Cancelada', refunded: 'Reembolsada' };
const methodOptions = [{ value: 'pix', label: 'PIX' }, { value: 'transfer', label: 'Transferência bancária' }, { value: 'card', label: 'Cartão de crédito' }, { value: 'cash', label: 'Dinheiro' }, { value: 'other', label: 'Outro' }];
const methodLabels = Object.fromEntries(methodOptions.map((option) => [option.value, option.label]));

let flights = [];
let salesStatus = new Map();

function flash(message, isError = false) {
  const element = document.createElement('div');
  element.className = `flash${isError ? ' error' : ''}`;
  element.setAttribute('role', 'status');
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 5000);
}
function showError(containerId, error, fallback) {
  const container = $(containerId);
  if (container) container.innerHTML = `<div class="alert alert-error">${esc(financeErrorMessage(error, fallback))}</div>`;
}
const sortCurrencies = (list) => [...list].sort((a, b) => (a === 'EUR' ? -1 : b === 'EUR' ? 1 : a.localeCompare(b)));
const pct = (bps) => (bps === null || bps === undefined || Number.isNaN(bps) ? '-' : `${(bps / 100).toFixed(1).replace('.', ',')}%`);
const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><small>${esc(label)}</small><strong>${value}</strong>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
const routeOf = (flight) => [flight.origin, flight.destination].filter(Boolean).join(' → ');

// Custo e lucro de um voo: só conta como lucro confirmado quando existe emissão marcada como emitida.
function metrics(flight) {
  const list = flight.issuances || [];
  const issued = list.some((item) => item.status === 'issued' || item.status === 'refunded');
  const pending = list.some((item) => item.status === 'pending');
  const costState = issued ? 'issued' : pending ? 'pending' : 'missing';
  const cost = flight.profit?.realizedDirectCostCents || 0;
  const profit = issued ? flight.netAmountCents - cost : null;
  return {
    costState, cost, profit,
    marginBps: issued && flight.netAmountCents > 0 ? Math.round((profit / flight.netAmountCents) * 10000) : null,
    projected: flight.profit?.projectedGrossProfitCents ?? null,
    projectedCost: (flight.profit?.realizedDirectCostCents || 0) + (flight.profit?.projectedDirectCostCents || 0),
  };
}
const costTag = (state) => ({
  issued: '<span class="tag tag-paid">Custo emitido</span>',
  pending: '<span class="tag tag-warn">Custo pendente</span>',
  missing: '<span class="tag tag-muted">Sem custo</span>',
})[state];

async function fetchFlights() {
  flights = (await api('/api/admin/finance/flights')).flights;
  return flights;
}
async function fetchSales() {
  const result = await api('/api/admin/finance/sales');
  salesStatus = new Map(result.sales.map((sale) => [sale.id, sale]));
}

// --- acesso e rotas -----------------------------------------------------------------------------------
const VIEWS = {
  geral: loadGeral, vendas: loadSales, voos: loadFlights, contas: loadAccountBalances, receber: loadReceivables, alertas: loadAlerts,
  pagar: () => loadObligations(), milhas: () => loadMileageLots(), assinaturas: async () => {}, cadastros: async () => {},
};
function route() {
  const requested = location.hash.replace(/^#\//, '').split('?')[0];
  const key = VIEWS[requested] ? requested : 'geral';
  document.querySelectorAll('.fin-view').forEach((view) => { view.hidden = view.dataset.view !== key; });
  document.querySelectorAll('[data-nav]').forEach((link) => { if (link.dataset.nav === key) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  window.scrollTo({ top: 0 });
  VIEWS[key]().catch((error) => flash(financeErrorMessage(error, 'Não foi possível carregar esta área.'), true));
}

try {
  const session = await api('/api/auth/session');
  if (!session.user.roles.includes('master')) throw Object.assign(new Error('forbidden'), { status: 403 });
  $('accessMessage').classList.add('hidden');
  $('financeContent').classList.remove('hidden');
} catch (error) {
  $('accessMessage').querySelector('p').textContent = error.status === 403 ? 'Sua conta não tem permissão master.' : 'Entre primeiro pela Área do cliente com uma conta master.';
  throw error;
}
try { await initCadastros(); } catch (error) { flash(financeErrorMessage(error, 'Não foi possível carregar os cadastros.'), true); }
wireGeral();
wireSales();
wireFlights();
$('receivablesAll').addEventListener('change', () => loadReceivables().catch(() => {}));
window.addEventListener('hashchange', route);
route();
refreshBadge();

// --- visão geral --------------------------------------------------------------------------------------
function presetRange(preset) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (date) => date.toISOString().slice(0, 10);
  if (preset === 'prev') return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
  if (preset === 'year') return [iso(new Date(Date.UTC(y, 0, 1))), today()];
  if (preset === 'all') return ['2000-01-01', today()];
  return [iso(new Date(Date.UTC(y, m, 1))), today()];
}
function wireGeral() {
  const apply = () => {
    const preset = $('dashboardPreset').value;
    if (preset === 'custom') return;
    const [from, to] = presetRange(preset);
    $('dashboardFrom').value = from;
    $('dashboardTo').value = to;
  };
  apply();
  $('dashboardPreset').addEventListener('change', () => { apply(); if ($('dashboardPreset').value !== 'custom') loadGeral().catch(() => {}); });
  $('dashboardFrom').addEventListener('change', () => { $('dashboardPreset').value = 'custom'; });
  $('dashboardTo').addEventListener('change', () => { $('dashboardPreset').value = 'custom'; });
  $('dashboardForm').addEventListener('submit', (event) => { event.preventDefault(); loadGeral().catch(() => {}); });
}

async function refreshBadge() {
  try {
    const [alerts, receivables] = await Promise.all([api('/api/admin/finance/dashboard/alerts'), api('/api/admin/finance/receivables')]);
    const total = alerts.overdueObligations.length + receivables.receivables.filter((item) => item.isOverdue).length;
    $('alertBadge').textContent = total ? String(total) : '';
  } catch { /* o selo é só um aviso */ }
}

async function loadGeral() {
  const from = $('dashboardFrom').value;
  const to = $('dashboardTo').value;
  if (!from || !to) return;
  $('dashboardStatus').textContent = 'Carregando...';
  $('exportSalesCsv').href = `/api/admin/finance/dashboard/export.csv?report=sales&from=${from}&to=${to}`;
  $('exportObligationsCsv').href = `/api/admin/finance/dashboard/export.csv?report=obligations&from=${from}&to=${to}`;
  $('exportReceivablesCsv').href = `/api/admin/finance/dashboard/export.csv?report=receivables&from=${from}&to=${to}`;
  try {
    const [accrual, cash, receivables, alerts] = await Promise.all([
      api(`/api/admin/finance/dashboard/overview?from=${from}&to=${to}&regime=accrual`),
      api(`/api/admin/finance/dashboard/overview?from=${from}&to=${to}&regime=cash`),
      api('/api/admin/finance/receivables'),
      api('/api/admin/finance/dashboard/alerts'),
      fetchFlights(),
    ]).then((results) => results.slice(0, 4));
    const buckets = new Map();
    const bucket = (currency) => {
      if (!buckets.has(currency)) buckets.set(currency, { recebido: 0, vendido: 0, vendas: 0, aReceber: 0, parcelas: 0, custo: 0, lucro: 0, receitaComCusto: 0, semCusto: 0, despesas: 0, pago: 0, saldo: 0, alt: {} });
      return buckets.get(currency);
    };
    accrual.indicators.forEach((item) => { const b = bucket(item.currency); b.vendido = item.faturamentoBrutoCents; b.despesas = item.despesasOperacionaisCents; });
    cash.indicators.forEach((item) => { const b = bucket(item.currency); b.recebido = item.recebidoCents; b.pago = item.pagoCents; b.saldo = item.saldoCaixaCents; });
    receivables.receivables.forEach((item) => { const b = bucket(item.currency); b.aReceber += item.expectedAmountCents - item.receivedCents; b.parcelas += 1; });
    const inRange = flights.filter((item) => item.status === 'confirmed' && item.saleDate >= from && item.saleDate <= to);
    inRange.forEach((item) => {
      const b = bucket(item.currency);
      const m = metrics(item);
      b.vendas += 1;
      if (item.altCurrency) b.alt[item.altCurrency] = (b.alt[item.altCurrency] || 0) + item.altAmountCents;
      if (m.costState === 'issued') { b.custo += m.cost; b.lucro += m.profit; b.receitaComCusto += item.netAmountCents; } else b.semCusto += 1;
    });

    const blocks = sortCurrencies([...buckets.keys()]).map((currency) => {
      const b = buckets.get(currency);
      const altText = Object.entries(b.alt).map(([code, cents]) => `≈ ${money(cents, code)} informado nas vendas`).join(' · ');
      const resultado = b.lucro - b.despesas;
      return `<h2 class="cur-head"><span class="pill">${currency}</span>${CURRENCY_NAMES[currency] || currency}</h2>
        <div class="kpi-row">
          ${kpi('Faturamento recebido', money(b.recebido, currency), altText, 'accent')}
          ${kpi('Vendido no período', money(b.vendido, currency), `${b.vendas} venda${b.vendas === 1 ? '' : 's'}`)}
          ${kpi('A receber', money(b.aReceber, currency), b.parcelas ? `${b.parcelas} parcela${b.parcelas === 1 ? '' : 's'} em aberto` : 'nada em aberto')}
          ${kpi('Custo dos voos', money(b.custo, currency), 'só emissões já emitidas')}
          ${kpi('Lucro confirmado', money(b.lucro, currency), `margem ${pct(b.receitaComCusto ? Math.round((b.lucro / b.receitaComCusto) * 10000) : null)}`, 'accent')}
          ${kpi('Despesas operacionais', money(b.despesas, currency))}
          ${kpi('Resultado do período', money(resultado, currency), 'lucro confirmado menos despesas', resultado < 0 ? 'warn' : '')}
          ${kpi('Saldo de caixa', money(b.saldo, currency), `pago no período: ${money(b.pago, currency)}`)}
        </div>
        ${b.semCusto ? `<p class="fin-note">${b.semCusto} venda${b.semCusto === 1 ? '' : 's'} deste período em ${currency} ainda sem custo emitido. O lucro acima só considera os voos com custo. <a href="#/voos">Ver voos</a></p>` : ''}`;
    });
    $('geralKpis').innerHTML = blocks.join('') || `<section class="panel"><div class="empty-state"><strong>Sem movimento neste período</strong>Lance uma venda para começar a ver os números aqui.<p><a class="button" href="#/vendas">Ir para Vendas e recibos</a></p></div></section>`;
    $('dashboardStatus').textContent = '';
    renderChart(to);
    renderRank(inRange);
    renderAttention(alerts, receivables.receivables);
  } catch (error) {
    $('dashboardStatus').textContent = financeErrorMessage(error, 'Não foi possível carregar a visão geral.');
  }
}

function renderChart(to) {
  const months = [];
  const [yearText, monthText] = to.split('-');
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1 - i, 1));
    months.push(date.toISOString().slice(0, 7));
  }
  const currencies = sortCurrencies([...new Set(flights.filter((item) => item.status === 'confirmed').map((item) => item.currency))]);
  const label = (key) => { const [y, m] = key.split('-'); return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(m) - 1]}/${y.slice(2)}`; };
  const html = currencies.map((currency) => {
    const rows = months.map((key) => {
      const group = flights.filter((item) => item.status === 'confirmed' && item.currency === currency && monthKey(item.saleDate) === key);
      return { key, sold: group.reduce((sum, item) => sum + item.netAmountCents, 0), profit: group.reduce((sum, item) => sum + (metrics(item).profit || 0), 0) };
    });
    const W = 720; const H = 230; const padB = 30; const padT = 22;
    const max = Math.max(1, ...rows.flatMap((row) => [row.sold, row.profit]));
    const slot = W / rows.length; const bw = Math.min(32, slot / 2 - 8);
    const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
    const bar = (value, x, color) => {
      const h = Math.max(value > 0 ? 2 : 0, (value / max) * (H - padB - padT));
      return `<rect x="${x}" y="${H - padB - h}" width="${bw}" height="${h}" rx="3" fill="${color}"/>${value > 0 ? `<text x="${x + bw / 2}" y="${H - padB - h - 5}" text-anchor="middle" font-size="11" fill="#37424f">${compact.format(value / 100)}</text>` : ''}`;
    };
    const svg = rows.map((row, index) => {
      const cx = slot * index + slot / 2;
      return `${bar(row.sold, cx - bw - 2, '#0d1b2a')}${bar(row.profit, cx + 2, '#d4af37')}<text x="${cx}" y="${H - 9}" text-anchor="middle" font-size="12" fill="#647181">${label(row.key)}</text>`;
    }).join('');
    return `<div><div class="legend"><strong>${CURRENCY_NAMES[currency] || currency} (${currency})</strong><span><i style="background:#0d1b2a"></i>Vendido</span><span><i style="background:#d4af37"></i>Lucro confirmado</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vendido e lucro confirmado por mês em ${currency}">${svg}<line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="rgba(13,27,42,.15)"/></svg></div>`;
  }).join('');
  $('geralChart').innerHTML = html || '<p class="muted">Ainda não há vendas para mostrar no gráfico.</p>';
}

function renderRank(inRange) {
  const confirmed = inRange.map((item) => ({ item, m: metrics(item) })).filter(({ m }) => m.costState === 'issued');
  const currencies = sortCurrencies([...new Set(confirmed.map(({ item }) => item.currency))]);
  $('geralRank').innerHTML = currencies.map((currency) => {
    const top = confirmed.filter(({ item }) => item.currency === currency).sort((a, b) => b.m.profit - a.m.profit).slice(0, 5);
    return `<h3 class="cur-head" style="margin:14px 0 8px;font-size:1rem"><span class="pill">${currency}</span></h3><ol class="rank">${top.map(({ item, m }) => `<li><span class="who">${esc(item.customerName || item.protocol)}<small>${esc(routeOf(item) || item.protocol)} · ${fmtDay(item.saleDate)}</small></span><strong class="${m.profit < 0 ? 'neg' : 'pos'}">${money(m.profit, currency)}</strong></li>`).join('')}</ol>`;
  }).join('') || '<p class="muted">Quando um voo tiver custo emitido, ele aparece aqui.</p>';
}

function renderAttention(alerts, receivables) {
  const overdueReceivables = receivables.filter((item) => item.isOverdue).length;
  const withoutCost = flights.filter((item) => item.status === 'confirmed' && metrics(item).costState === 'missing').length;
  const withoutReceipt = flights.filter((item) => item.status === 'confirmed' && !item.hasReceipt).length;
  const items = [
    [alerts.overdueObligations.length, 'conta(s) a pagar vencida(s)', '#/pagar'],
    [overdueReceivables, 'parcela(s) a receber vencida(s)', '#/receber'],
    [alerts.upcomingObligations7d.length, 'conta(s) a pagar vencendo em 7 dias', '#/pagar'],
    [withoutCost, 'venda(s) sem custo lançado', '#/voos'],
    [withoutReceipt, 'venda(s) sem recibo', '#/vendas'],
    [alerts.salesBelowMarginThreshold.length, 'venda(s) com margem baixa ou negativa', '#/voos'],
    [alerts.mileageLotsExpiringSoon.length, 'lote(s) de milhas vencendo em breve', '#/milhas'],
  ].filter(([count]) => count > 0);
  $('geralAttention').innerHTML = items.length
    ? `<ul class="rank">${items.map(([count, text, href]) => `<li><span class="who"><a href="${href}"><strong>${count}</strong> ${text}</a></span></li>`).join('')}</ul>`
    : '<p class="muted">Tudo em dia. Nada vencido nem pendente.</p>';
}

// --- vendas e recibos -----------------------------------------------------------------------------------
function wireSales() {
  ['salesSearch', 'salesFilter', 'salesCurrency'].forEach((id) => $(id).addEventListener('input', renderSales));
  $('newSaleBtn').addEventListener('click', newSale);
  $('saleFromLeadForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('saleFromLeadStatus');
    const discountCents = $('saleDiscount').value ? toCents($('saleDiscount').value) : 0;
    if (discountCents === null) { status.textContent = 'Desconto inválido. Use por exemplo 50,00.'; return; }
    try {
      const result = await api(`/api/admin/finance/sales/from-lead/${$('saleLeadId').value.trim()}`, { method: 'POST', body: JSON.stringify({ discountCents }) });
      event.target.reset();
      status.textContent = result.alreadyExisted ? 'Esta proposta já tinha uma venda registrada. Nada foi duplicado.' : 'Venda criada a partir da proposta.';
      await loadSales();
    } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível gerar a venda a partir da proposta.'); }
  });
}

async function loadSales() {
  try { await Promise.all([fetchFlights(), fetchSales()]); renderSales(); } catch (error) { showError('sales', error, 'Não foi possível carregar as vendas.'); }
}

function renderSales() {
  const text = $('salesSearch').value.trim().toLowerCase();
  const filter = $('salesFilter').value;
  const currency = $('salesCurrency').value;
  const rows = flights.filter((item) => {
    const status = salesStatus.get(item.id);
    const financial = status?.financialStatus;
    if (currency && item.currency !== currency) return false;
    if (text && !`${item.customerName || ''} ${item.protocol} ${routeOf(item)}`.toLowerCase().includes(text)) return false;
    if (filter === 'open') return item.status === 'confirmed' && financial !== 'paid';
    if (filter === 'paid') return item.status === 'confirmed' && financial === 'paid';
    if (filter === 'no_receipt') return item.status === 'confirmed' && !item.hasReceipt;
    if (filter === 'canceled') return item.status !== 'confirmed';
    return true;
  });
  $('sales').innerHTML = rows.map((item) => {
    const financial = salesStatus.get(item.id)?.financialStatus;
    const situation = item.status === 'canceled' ? '<span class="tag tag-void">Cancelada</span>'
      : item.status === 'refunded' ? '<span class="tag tag-void">Reembolsada</span>'
        : financial === 'paid' ? '<span class="tag tag-paid">Recebida</span>'
          : financial === 'partial' ? '<span class="tag tag-pending">Recebida em parte</span>'
            : '<span class="tag tag-pending">A receber</span>';
    const confirmed = item.status === 'confirmed';
    return `<tr>
      <td><span class="main">${esc(item.protocol)}</span><span class="alt">${fmtDay(item.saleDate)}${item.direct ? ' · venda direta' : ''}</span></td>
      <td><span class="main">${esc(item.customerName || '-')}</span><span class="alt">${esc(routeOf(item) || 'rota não informada')} · ${item.passengerCount || 1} pax</span></td>
      <td class="num"><span class="main">${money(item.netAmountCents, item.currency)}</span>${item.altCurrency ? `<span class="alt">${money(item.altAmountCents, item.altCurrency)}</span>` : ''}</td>
      <td>${situation}</td>
      <td>${item.hasReceipt ? `<a class="button small ghost" href="/recibo.html?sale=${item.id}">Ver recibo</a>` : confirmed ? `<a class="button small" href="/recibo.html?sale=${item.id}">Criar recibo</a>` : '-'}</td>
      <td><div class="row-actions">
        ${confirmed && financial !== 'paid' ? `<button type="button" class="small" data-receive-sale="${item.id}">Registrar recebimento</button>` : ''}
        ${confirmed ? `<button type="button" class="small ghost" data-flight-cost="${item.id}">Custo e lucro</button>` : ''}
        <button type="button" class="small ghost" data-alt-sale="${item.id}">${item.altCurrency ? 'Editar' : 'Informar'} valor em outra moeda</button>
        ${confirmed ? `<button type="button" class="small ghost" data-cancel-sale="${item.id}">Cancelar</button><button type="button" class="small ghost" data-refund-sale="${item.id}">Reembolsar</button>` : ''}
      </div></td></tr>`;
  }).join('') || '<tr><td colspan="6">Nenhuma venda encontrada. Use "Nova venda" para lançar a primeira.</td></tr>';
  bindSaleActions();
}

function bindSaleActions() {
  document.querySelectorAll('[data-receive-sale]').forEach((button) => button.addEventListener('click', () => receiveForSale(button.dataset.receiveSale)));
  document.querySelectorAll('[data-flight-cost]').forEach((button) => button.addEventListener('click', () => openFlightDialog(button.dataset.flightCost)));
  document.querySelectorAll('[data-alt-sale]').forEach((button) => button.addEventListener('click', () => editAlt(button.dataset.altSale)));
  document.querySelectorAll('[data-cancel-sale]').forEach((button) => button.addEventListener('click', () => terminateSale(button.dataset.cancelSale, 'cancel')));
  document.querySelectorAll('[data-refund-sale]').forEach((button) => button.addEventListener('click', () => terminateSale(button.dataset.refundSale, 'refund')));
}

function accountOptions(currency) {
  const active = state.accounts.filter((account) => account.active);
  const sorted = [...active.filter((account) => account.currency === currency), ...active.filter((account) => account.currency !== currency)];
  return sorted.map((account) => ({ value: account.id, label: `${account.name} (${account.currency})` }));
}

async function newSale() {
  if (!state.accounts.some((account) => account.active)) {
    flash('Antes de lançar uma venda recebida, crie uma conta em Cadastros (por exemplo "Conta Rota Certa").', true);
    location.hash = '#/cadastros';
    return;
  }
  const values = await askForm({
    title: 'Nova venda', submitLabel: 'Criar venda',
    intro: 'Euro ou real: informe o valor na moeda que você cobra. O equivalente na outra moeda é só informativo e nunca é somado.',
    fields: [
      { name: 'customerName', label: 'Cliente / passageiro principal', type: 'text', required: true, wide: true },
      { name: 'customerEmail', label: 'E-mail (opcional)', type: 'text' },
      { name: 'customerPhone', label: 'Telefone (opcional)', type: 'text' },
      { name: 'origin', label: 'Origem (ex.: MRS)', type: 'text' },
      { name: 'destination', label: 'Destino (ex.: MCZ)', type: 'text' },
      { name: 'passengerCount', label: 'Passageiros', type: 'number', value: 1 },
      { name: 'saleDate', label: 'Data da venda', type: 'date', value: today(), required: true },
      { name: 'currency', label: 'Moeda cobrada', type: 'select', options: currencyOptions, value: 'EUR' },
      { name: 'gross', label: 'Valor cobrado do cliente', type: 'money', required: true },
      { name: 'discount', label: 'Desconto (opcional)', type: 'money' },
      { name: 'altCurrency', label: 'Equivalente em outra moeda (opcional)', type: 'select', options: [{ value: '', label: 'Nenhum' }, ...currencyOptions], value: '' },
      { name: 'altAmount', label: 'Valor equivalente (ex.: em R$)', type: 'money' },
      { name: 'received', label: 'Já foi recebido', type: 'checkbox', value: true },
      { name: 'method', label: 'Forma de pagamento', type: 'select', options: methodOptions, value: 'pix' },
      { name: 'accountId', label: 'Recebido na conta', type: 'select', options: accountOptions('EUR'), wide: true },
      { name: 'notes', label: 'Observações internas (opcional)', type: 'textarea', wide: true },
      { name: 'createReceipt', label: 'Abrir o recibo logo depois de criar', type: 'checkbox', value: true },
    ],
  });
  if (!values) return;
  if (!values.gross || values.gross < 1) { flash('Informe o valor cobrado do cliente.', true); return; }
  if (Boolean(values.altCurrency) !== Boolean(values.altAmount)) { flash('Para o equivalente, informe a moeda e o valor juntos.', true); return; }
  // Conta em outra moeda (ex.: cofrinho em R$ recebendo venda em €): o equivalente digitado é o que entrou na conta.
  const account = state.accounts.find((item) => item.id === values.accountId);
  let accountAmountCents;
  if (values.received && account && account.currency !== values.currency) {
    if (values.altCurrency !== account.currency || !values.altAmount) {
      flash(`A conta "${account.name}" é em ${account.currency}. Preencha o equivalente em ${account.currency}: é o valor que entrou na conta.`, true);
      return;
    }
    accountAmountCents = values.altAmount;
  }
  try {
    const result = await api('/api/admin/finance/sales/direct', {
      method: 'POST',
      body: JSON.stringify({
        customerName: values.customerName, customerEmail: values.customerEmail, customerPhone: values.customerPhone,
        origin: values.origin.toUpperCase(), destination: values.destination.toUpperCase(), passengerCount: values.passengerCount || 1,
        saleDate: values.saleDate, currency: values.currency, grossAmountCents: values.gross, discountCents: values.discount || 0,
        altCurrency: values.altCurrency || undefined, altAmountCents: values.altAmount || undefined, notes: values.notes,
        payment: { received: values.received, method: values.method, accountId: values.accountId, accountAmountCents },
      }),
    });
    flash(`Venda ${result.protocol} criada.`);
    if (values.createReceipt) { location.href = `/recibo.html?sale=${result.id}`; return; }
    await loadSales();
  } catch (error) { flash(financeErrorMessage(error, 'Não foi possível criar a venda.'), true); }
}

async function editAlt(saleId) {
  const item = flights.find((flight) => flight.id === saleId);
  const others = currencyOptions.filter((option) => option.value !== item.currency);
  const values = await askForm({
    title: 'Valor em outra moeda', submitLabel: 'Salvar',
    intro: `Venda ${item.protocol}, cobrada em ${money(item.netAmountCents, item.currency)}. Este valor é só informativo e aparece no recibo e nas vendas.`,
    fields: [
      { name: 'altCurrency', label: 'Moeda', type: 'select', options: [{ value: '', label: 'Remover valor equivalente' }, ...others], value: item.altCurrency || others.find((option) => option.value === 'BRL')?.value || others[0].value },
      { name: 'altAmount', label: 'Valor equivalente', type: 'money', value: centsToInput(item.altAmountCents) },
    ],
  });
  if (!values) return;
  try {
    if (!values.altCurrency) await api(`/api/admin/finance/sales/${saleId}`, { method: 'PATCH', body: JSON.stringify({ altCurrency: null }) });
    else {
      if (!values.altAmount) { flash('Informe o valor equivalente.', true); return; }
      await api(`/api/admin/finance/sales/${saleId}`, { method: 'PATCH', body: JSON.stringify({ altCurrency: values.altCurrency, altAmountCents: values.altAmount }) });
    }
    flash('Valor equivalente salvo.');
    await loadSales();
  } catch (error) { flash(financeErrorMessage(error, 'Não foi possível salvar o valor equivalente.'), true); }
}

async function terminateSale(saleId, kind) {
  const item = flights.find((flight) => flight.id === saleId);
  const word = kind === 'cancel' ? 'Cancelar' : 'Reembolsar';
  const values = await askForm({
    title: `${word} venda ${item.protocol}`, submitLabel: word, danger: true,
    intro: kind === 'cancel' ? 'Só é possível cancelar vendas sem nenhum recebimento.' : 'Reembolsar estorna os recebimentos da venda. O histórico é mantido.',
    fields: [{ name: 'reason', label: 'Motivo', type: 'text', required: true, wide: true }],
  });
  if (!values) return;
  try {
    await api(`/api/admin/finance/sales/${saleId}/${kind === 'cancel' ? 'cancel' : 'refund'}`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) });
    flash(kind === 'cancel' ? 'Venda cancelada.' : 'Venda reembolsada.');
    await loadSales();
  } catch (error) { flash(financeErrorMessage(error, `Não foi possível ${word.toLowerCase()} a venda.`), true); }
}

// Registrar recebimento: usa a parcela em aberto da venda, ou cria uma parcela no valor recebido.
async function receiveForSale(saleId) {
  const item = flights.find((flight) => flight.id === saleId);
  try {
    const all = (await api('/api/admin/finance/receivables?status=all')).receivables.filter((receivable) => receivable.saleId === saleId);
    const open = all.find((receivable) => receivable.status === 'open' || receivable.status === 'partial');
    const received = all.filter((receivable) => receivable.status !== 'canceled').reduce((sum, receivable) => sum + receivable.receivedCents, 0);
    const remaining = open ? open.expectedAmountCents - open.receivedCents : item.netAmountCents - received;
    if (remaining <= 0) { flash('Esta venda já está totalmente recebida.'); return; }
    await collectPayment({ title: `Registrar recebimento da venda ${item.protocol}`, currency: item.currency, remaining, receivable: open, saleId });
  } catch (error) { flash(financeErrorMessage(error, 'Não foi possível registrar o recebimento.'), true); }
}

async function collectPayment({ title, currency, remaining, receivable, saleId }) {
  if (!state.accounts.some((account) => account.active)) { flash('Crie uma conta em Cadastros antes de registrar um recebimento.', true); location.hash = '#/cadastros'; return; }
  const values = await askForm({
    title, submitLabel: 'Registrar recebimento',
    fields: [
      { name: 'amount', label: `Valor recebido (${currency})`, type: 'money', value: centsToInput(remaining), required: true },
      { name: 'receivedOn', label: 'Data do recebimento', type: 'date', value: today(), required: true },
      { name: 'method', label: 'Forma de pagamento', type: 'select', options: methodOptions, value: receivable?.method || 'pix' },
      { name: 'accountId', label: 'Recebido na conta', type: 'select', options: accountOptions(currency) },
      { name: 'accountAmount', label: 'Valor que entrou na conta (só se a conta for em outra moeda)', type: 'money', hint: 'Ex.: o valor em R$ que apareceu no Mercado Pago.', wide: true },
    ],
  });
  if (!values) return;
  if (!values.amount || values.amount < 1 || values.amount > remaining) { flash(`Informe um valor de até ${money(remaining, currency)}.`, true); return; }
  const account = state.accounts.find((item) => item.id === values.accountId);
  const accountAmountCents = account && account.currency !== currency ? values.accountAmount : undefined;
  if (account && account.currency !== currency && !accountAmountCents) { flash(`A conta "${account.name}" é em ${account.currency}. Informe o valor que entrou na conta.`, true); return; }
  try {
    let receivableId = receivable?.id;
    if (!receivableId) {
      const created = await api(`/api/admin/finance/sales/${saleId}/receivables`, { method: 'POST', body: JSON.stringify({ installments: [{ dueDate: values.receivedOn, expectedAmountCents: values.amount, method: values.method, accountId: values.accountId }] }) });
      receivableId = created.ids[0];
    }
    await api(`/api/admin/finance/receivables/${receivableId}/payments`, { method: 'POST', body: JSON.stringify({ receivedAmountCents: values.amount, currency, accountId: values.accountId, receivedAt: `${values.receivedOn}T12:00:00Z`, accountAmountCents }) });
    flash('Recebimento registrado.');
    const view = document.querySelector('.fin-view:not([hidden])')?.dataset.view;
    if (view === 'receber') await loadReceivables(); else await loadSales();
    refreshBadge();
  } catch (error) { flash(financeErrorMessage(error, 'Não foi possível registrar o recebimento.'), true); }
}

// --- contas a receber -------------------------------------------------------------------------------------
async function loadReceivables() {
  try {
    const all = $('receivablesAll').checked;
    const result = await api(`/api/admin/finance/receivables${all ? '?status=all' : ''}`);
    const open = result.receivables.filter((item) => item.status === 'open' || item.status === 'partial');
    const currencies = sortCurrencies([...new Set(open.map((item) => item.currency))]);
    $('receberKpis').innerHTML = currencies.length
      ? `<div class="kpi-row">${currencies.map((currency) => {
        const list = open.filter((item) => item.currency === currency);
        const total = list.reduce((sum, item) => sum + item.expectedAmountCents - item.receivedCents, 0);
        const overdue = list.filter((item) => item.isOverdue);
        return `${kpi(`A receber em ${currency}`, money(total, currency), `${list.length} parcela${list.length === 1 ? '' : 's'}`, 'accent')}${kpi(`Vencidas em ${currency}`, money(overdue.reduce((sum, item) => sum + item.expectedAmountCents - item.receivedCents, 0), currency), `${overdue.length} parcela${overdue.length === 1 ? '' : 's'}`, overdue.length ? 'warn' : '')}`;
      }).join('')}</div>`
      : '<p class="fin-note info">Nada a receber agora. Quando uma venda for feita para pagar depois, as parcelas aparecem aqui.</p>';
    const statusLabel = { open: '<span class="tag tag-pending">Em aberto</span>', partial: '<span class="tag tag-pending">Parcial</span>', paid: '<span class="tag tag-paid">Recebida</span>', canceled: '<span class="tag tag-void">Cancelada</span>', refunded: '<span class="tag tag-void">Reembolsada</span>' };
    $('receivables').innerHTML = result.receivables.map((item) => `<tr>
      <td>${fmtDay(item.dueDate)}${item.isOverdue ? ' <span class="tag tag-void">vencida</span>' : ''}</td>
      <td>${esc(item.customerName || '-')}</td>
      <td>${esc(item.protocol)}<span class="alt">parcela ${item.installmentNumber} · ${esc(methodLabels[item.method] || item.method)}</span></td>
      <td class="num">${money(item.expectedAmountCents, item.currency)}</td>
      <td class="num">${money(item.receivedCents, item.currency)}</td>
      <td>${statusLabel[item.status] || esc(item.status)}</td>
      <td>${item.status === 'open' || item.status === 'partial' ? `<button type="button" class="small" data-receive-installment="${item.id}">Registrar recebimento</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7">Nenhuma parcela a receber.</td></tr>';
    document.querySelectorAll('[data-receive-installment]').forEach((button) => button.addEventListener('click', () => {
      const item = result.receivables.find((receivable) => receivable.id === button.dataset.receiveInstallment);
      collectPayment({ title: `Recebimento da venda ${item.protocol}`, currency: item.currency, remaining: item.expectedAmountCents - item.receivedCents, receivable: item, saleId: item.saleId });
    }));
  } catch (error) { showError('receivables', error, 'Não foi possível carregar as contas a receber.'); }
}

// --- alertas ------------------------------------------------------------------------------------------------
// --- contas e saldos ----------------------------------------------------------------------------------------
// Saldo de cada conta na moeda dela (para conferir com o app do banco) e a conversão automática para euros.
const accountTypeLabels = { bank: 'Banco', cash: 'Dinheiro', card: 'Cartão', digital_wallet: 'Carteira digital', other: 'Outro' };
async function loadAccountBalances() {
  try {
    const [result, rates] = await Promise.all([api('/api/admin/finance/accounts/balances'), api('/api/planner/rates').catch(() => null)]);
    const rate = (code) => (code === 'EUR' ? 1 : rates?.rates?.[code] || null);
    const convert = (cents, from, to) => { const a = rate(from); const b = rate(to); return a && b ? Math.round((cents / a) * b) : null; };
    const rows = result.accounts.filter((account) => account.active).map((account) => {
      let estimated = 0; let hasEstimate = false;
      for (const [code, cents] of Object.entries(account.estimatedIn)) { const v = convert(cents, code, account.currency); if (v !== null) { estimated += v; hasEstimate = true; } }
      for (const [code, cents] of Object.entries(account.estimatedOut)) { const v = convert(cents, code, account.currency); if (v !== null) { estimated -= v; hasEstimate = true; } }
      const balance = account.balanceCents + estimated;
      return { account, balance, hasEstimate, eur: convert(balance, account.currency, 'EUR') };
    });
    const perCurrency = new Map();
    rows.forEach((row) => perCurrency.set(row.account.currency, (perCurrency.get(row.account.currency) || 0) + row.balance));
    const totalEur = rows.length && rows.every((row) => row.eur !== null) ? rows.reduce((sum, row) => sum + row.eur, 0) : null;
    $('contasKpis').innerHTML = rows.length
      ? `<div class="kpi-row">${sortCurrencies([...perCurrency.keys()]).map((code) => kpi(`Saldo em ${CURRENCY_NAMES[code] || code}`, money(perCurrency.get(code), code), 'confira com o app do banco', code === 'EUR' ? '' : 'accent')).join('')}${totalEur === null ? '' : kpi('Total em euros', money(totalEur, 'EUR'), 'tudo convertido pelo câmbio de hoje', 'accent')}</div>`
      : '<p class="fin-note info">Nenhuma conta cadastrada ainda. Crie a conta (por exemplo, o cofrinho do Mercado Pago em reais) em Cadastros.</p>';
    $('accountBalances').innerHTML = rows.map(({ account, balance, hasEstimate, eur }) => `<tr>
      <td><span class="main">${esc(account.name)}</span><span class="alt">${esc(accountTypeLabels[account.type] || account.type)}${account.institution ? ` · ${esc(account.institution)}` : ''} · ${esc(account.currency)}</span></td>
      <td class="num"><span class="main ${balance < 0 ? 'neg' : ''}">${money(balance, account.currency)}</span>${hasEstimate ? '<span class="alt">inclui valores estimados pelo câmbio</span>' : ''}</td>
      <td class="num">${eur === null ? '<span class="alt">câmbio indisponível</span>' : `${account.currency === 'EUR' ? '' : '≈ '}${money(eur, 'EUR')}`}</td>
      <td class="num">${money(account.inCents, account.currency)}</td>
      <td class="num">${money(account.outCents, account.currency)}</td>
      <td>${account.openingBalanceAt ? `${money(account.openingBalanceCents, account.currency)}<span class="alt">em ${fmtDay(account.openingBalanceAt)}</span>` : '<span class="alt">não informado</span>'}</td></tr>`).join('') || '<tr><td colspan="6">Nenhuma conta ativa.</td></tr>';
    const used = sortCurrencies([...perCurrency.keys()]).filter((code) => code !== 'EUR');
    $('contasRate').textContent = !rates ? 'Câmbio indisponível agora: a conversão para euros não pôde ser calculada.'
      : used.length ? `Câmbio usado: ${used.map((code) => `1 € = ${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(rates.rates[code])} ${code}`).join(' · ')} (Banco Central Europeu, ${rates.date}).` : '';
  } catch (error) { showError('accountBalances', error, 'Não foi possível carregar os saldos.'); }
}

async function loadAlerts() {
  const container = $('dashboardAlerts');
  try {
    const alerts = await api('/api/admin/finance/dashboard/alerts');
    const sections = [
      ['Contas a pagar vencidas', alerts.overdueObligations.map((item) => `${fmtDay(item.dueDate)}: ${money(item.amountCents, item.currency)}`), '#/pagar'],
      ['Contas a receber vencidas', alerts.overdueReceivables.map((item) => `${fmtDay(item.dueDate)}: ${money(item.expectedAmountCents, item.currency)}`), '#/receber'],
      ['Contas a pagar vencendo em 7 dias', alerts.upcomingObligations7d.map((item) => `${fmtDay(item.dueDate)}: ${money(item.amountCents, item.currency)}`), '#/pagar'],
      ['Contas a pagar vencendo em 30 dias', alerts.upcomingObligations30d.map((item) => `${fmtDay(item.dueDate)}: ${money(item.amountCents, item.currency)}`), '#/pagar'],
      ['Assinaturas perto da cobrança', alerts.subscriptionsDueSoon.map((item) => `${esc(item.service)}: ${fmtDay(item.nextChargeAt)}`), '#/assinaturas'],
      ['Vendas com margem baixa ou negativa', alerts.salesBelowMarginThreshold.map((item) => `${esc(item.protocol)}: margem ${pct(item.marginBps)}`), '#/voos'],
      ['Lotes de milhas com saldo baixo', alerts.mileageLotsLowBalance.map((item) => `${esc(item.program)}: ${item.balanceQuantity.toLocaleString('pt-BR')} milhas`), '#/milhas'],
      ['Lotes de milhas vencendo em breve', alerts.mileageLotsExpiringSoon.map((item) => `${esc(item.program)}: vence em ${fmtDay(item.expiresAt)}`), '#/milhas'],
    ];
    container.innerHTML = sections.map(([title, lines, href]) => `<section class="panel"><div class="section-head"><strong>${title}</strong>${lines.length ? `<a class="button small ghost" href="${href}">Abrir</a>` : ''}</div>${lines.length ? `<ul>${lines.map((line) => `<li>${line}</li>`).join('')}</ul>` : '<p class="muted">Nada por aqui.</p>'}</section>`).join('');
  } catch (error) { showError('dashboardAlerts', error, 'Não foi possível carregar os alertas.'); }
}

// --- lucro por voo ------------------------------------------------------------------------------------------
function wireFlights() {
  ['flightsSearch', 'flightsFilter', 'flightsCurrency'].forEach((id) => $(id).addEventListener('input', renderFlights));
}

async function loadFlights() {
  try { await fetchFlights(); renderFlights(); } catch (error) { showError('flights', error, 'Não foi possível carregar os voos.'); }
}

function renderFlights() {
  const text = $('flightsSearch').value.trim().toLowerCase();
  const filter = $('flightsFilter').value;
  const currency = $('flightsCurrency').value;
  const rows = flights.filter((item) => {
    if (item.status !== 'confirmed') return false;
    if (currency && item.currency !== currency) return false;
    if (text && !`${item.customerName || ''} ${item.protocol} ${routeOf(item)} ${(item.issuances || []).map((i) => i.pnr || '').join(' ')}`.toLowerCase().includes(text)) return false;
    return !filter || metrics(item).costState === filter;
  });
  const confirmed = flights.filter((item) => item.status === 'confirmed');
  const currencies = sortCurrencies([...new Set(confirmed.map((item) => item.currency))]);
  $('voosKpis').innerHTML = currencies.map((code) => {
    const list = confirmed.filter((item) => item.currency === code);
    const issued = list.filter((item) => metrics(item).costState === 'issued');
    const profit = issued.reduce((sum, item) => sum + metrics(item).profit, 0);
    const revenue = issued.reduce((sum, item) => sum + item.netAmountCents, 0);
    const missing = list.length - issued.length;
    return `<h2 class="cur-head"><span class="pill">${code}</span>${CURRENCY_NAMES[code] || code}</h2><div class="kpi-row">
      ${kpi('Lucro confirmado', money(profit, code), `${issued.length} voo${issued.length === 1 ? '' : 's'} com custo emitido`, 'accent')}
      ${kpi('Margem média', pct(revenue ? Math.round((profit / revenue) * 10000) : null), `sobre ${money(revenue, code)}`)}
      ${kpi('Voos sem custo emitido', String(missing), missing ? 'o lucro deles ainda não é conhecido' : 'tudo lançado', missing ? 'warn' : '')}</div>`;
  }).join('') || '<p class="fin-note info">Ainda não há vendas. Lance uma venda em "Vendas e recibos".</p>';
  $('flights').innerHTML = rows.map((item) => {
    const m = metrics(item);
    const pnrs = (item.issuances || []).map((issuance) => issuance.pnr).filter(Boolean).join(' / ');
    const profitCell = m.costState === 'issued'
      ? `<span class="main ${m.profit < 0 ? 'neg' : 'pos'}">${money(m.profit, item.currency)}</span><span class="alt">margem ${pct(m.marginBps)}</span>`
      : m.costState === 'pending' ? `<span class="alt">previsto ${money(m.projected, item.currency)}</span>` : '<span class="alt">sem custo</span>';
    return `<tr>
      <td><span class="main">${esc(pnrs || 'Sem PNR')}</span><span class="alt">${esc(item.protocol)} · ${fmtDay(item.saleDate)}</span></td>
      <td><span class="main">${esc(item.customerName || '-')}</span><span class="alt">${esc(routeOf(item) || 'rota não informada')}</span></td>
      <td class="num"><span class="main">${money(item.netAmountCents, item.currency)}</span>${item.altCurrency ? `<span class="alt">${money(item.altAmountCents, item.altCurrency)}</span>` : ''}</td>
      <td class="num">${m.costState === 'missing' ? '-' : money(m.costState === 'issued' ? m.cost : m.projectedCost, item.currency)}</td>
      <td class="num">${profitCell}</td>
      <td>${costTag(m.costState)}</td>
      <td><button type="button" class="small" data-flight-cost="${item.id}">Custo e lucro</button></td></tr>`;
  }).join('') || '<tr><td colspan="7">Nenhum voo encontrado.</td></tr>';
  document.querySelectorAll('[data-flight-cost]').forEach((button) => button.addEventListener('click', () => openFlightDialog(button.dataset.flightCost)));
}

// Janela do custo de um voo: emissões, milhas do lote, taxas e o lucro resultante.
async function openFlightDialog(saleId) {
  const dialog = document.createElement('dialog');
  dialog.className = 'fin-dialog big';
  document.body.append(dialog);
  dialog.addEventListener('close', () => { dialog.remove(); const view = document.querySelector('.fin-view:not([hidden])')?.dataset.view; if (view === 'voos') loadFlights(); else if (view === 'vendas') loadSales(); else if (view === 'geral') loadGeral(); });
  dialog.addEventListener('cancel', () => dialog.close());
  let detail;
  const reload = async () => {
    detail = await api(`/api/admin/finance/sales/${saleId}`);
    await fetchFlights();
    render();
  };

  function render() {
    const { sale, issuances, profit } = detail;
    const flight = flights.find((item) => item.id === saleId) || {};
    const cur = sale.currency;
    const m = metrics({ ...flight, netAmountCents: sale.netAmountCents, issuances, profit });
    const total = (i) => i.cashAmountCents + i.milesCostCents + i.airportFeesCents + i.issuanceFeeCents + i.consolidatorFeeCents + i.gatewayFeeCents + i.agentCommissionCents + i.otherCostsCents;
    dialog.innerHTML = `<div class="fin-dialog-body">
      <div class="section-head"><div><h2>Custo e lucro do voo</h2><p class="muted">${esc(flight.customerName || sale.protocol)} · ${esc(routeOf(flight) || sale.protocol)} · venda ${esc(sale.protocol)}</p></div><button type="button" class="ghost" data-close>Fechar</button></div>
      <div class="kpi-row">
        ${kpi('Recebido do cliente', money(sale.netAmountCents, cur), flight.altCurrency ? money(flight.altAmountCents, flight.altCurrency) : '')}
        ${kpi('Custo confirmado', money(m.cost, cur), m.costState === 'issued' ? 'emissões já emitidas' : 'nenhuma emissão emitida ainda')}
        ${kpi('Lucro confirmado', m.costState === 'issued' ? money(m.profit, cur) : 'ainda não confirmado', m.costState === 'issued' ? `margem ${pct(m.marginBps)}` : `previsto: ${money(profit.projectedGrossProfitCents, cur)}`, 'accent')}
      </div>
      <h3>Emissões</h3>
      ${issuances.map((i) => `<article class="issuance">
        <header><strong>${esc(modeLabels[i.mode] || i.mode)}${i.airline ? ` · ${esc(i.airline)}` : ''}${i.loyaltyProgram ? ` · ${esc(i.loyaltyProgram)}` : ''}</strong><span class="tag ${i.status === 'issued' ? 'tag-paid' : i.status === 'pending' ? 'tag-warn' : 'tag-void'}">${issuanceStatusLabels[i.status]}</span></header>
        <p class="muted">${i.pnr ? `PNR ${esc(i.pnr)}` : 'Sem PNR'}${i.ticketNumbers ? ` · bilhete ${esc(i.ticketNumbers)}` : ''}</p>
        <dl>
          ${i.milesQuantity ? `<div><dt>Milhas usadas</dt><dd>${i.milesQuantity.toLocaleString('pt-BR')} (${money(i.milesCostCents, cur)})</dd></div>` : ''}
          <div><dt>Passagem em dinheiro</dt><dd>${money(i.cashAmountCents, cur)}</dd></div>
          <div><dt>Taxas de aeroporto</dt><dd>${money(i.airportFeesCents, cur)}</dd></div>
          <div><dt>Taxa de emissão</dt><dd>${money(i.issuanceFeeCents, cur)}</dd></div>
          <div><dt>Outros custos</dt><dd>${money(i.otherCostsCents + i.consolidatorFeeCents + i.gatewayFeeCents + i.agentCommissionCents, cur)}</dd></div>
          <div><dt>Custo desta emissão</dt><dd>${money(total(i), cur)}</dd></div>
        </dl>
        <div class="row-actions">
          ${i.status === 'pending' && (i.mode === 'miles' || i.mode === 'hybrid') ? `<button type="button" class="small" data-allocate="${i.id}">Usar milhas de um lote</button>` : ''}
          ${i.status === 'pending' ? `<button type="button" class="small" data-issue="${i.id}">Marcar como emitida</button><button type="button" class="small ghost" data-edit="${i.id}">Editar custos</button><button type="button" class="small ghost" data-cancel="${i.id}">Cancelar</button>` : ''}
          ${i.status === 'issued' ? `<button type="button" class="small ghost" data-refund="${i.id}">Reembolsar</button><button type="button" class="small ghost" data-cancel="${i.id}">Cancelar</button>` : ''}
        </div></article>`).join('') || '<p class="muted">Nenhuma emissão lançada ainda. Adicione a primeira para calcular o lucro.</p>'}
      <div class="fin-dialog-actions" style="justify-content:flex-start"><button type="button" id="addIssuance">Adicionar emissão</button></div>
    </div>`;
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('#addIssuance').addEventListener('click', () => addIssuance(sale));
    dialog.querySelectorAll('[data-allocate]').forEach((button) => button.addEventListener('click', () => allocate(issuances.find((i) => i.id === button.dataset.allocate), sale)));
    dialog.querySelectorAll('[data-issue]').forEach((button) => button.addEventListener('click', () => issue(issuances.find((i) => i.id === button.dataset.issue))));
    dialog.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => editIssuance(issuances.find((i) => i.id === button.dataset.edit))));
    dialog.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => terminate(button.dataset.cancel, 'cancel')));
    dialog.querySelectorAll('[data-refund]').forEach((button) => button.addEventListener('click', () => terminate(button.dataset.refund, 'refund')));
  }

  const guard = async (action, fallback) => { try { await action(); } catch (error) { flash(financeErrorMessage(error, fallback), true); } };
  const costFields = (i = {}) => [
    { name: 'airline', label: 'Companhia aérea', type: 'text', value: i.airline || '' },
    { name: 'loyaltyProgram', label: 'Programa de milhas', type: 'text', value: i.loyaltyProgram || '' },
    { name: 'pnr', label: 'PNR (código da reserva)', type: 'text', value: i.pnr || '' },
    { name: 'ticketNumbers', label: 'Número do bilhete', type: 'text', value: i.ticketNumbers || '' },
    { name: 'cash', label: 'Passagem paga em dinheiro', type: 'money', value: centsToInput(i.cashAmountCents || 0) },
    { name: 'airportFees', label: 'Taxas de aeroporto', type: 'money', value: centsToInput(i.airportFeesCents || 0) },
    { name: 'issuanceFee', label: 'Taxa de emissão', type: 'money', value: centsToInput(i.issuanceFeeCents || 0) },
    { name: 'otherCosts', label: 'Outros custos', type: 'money', value: centsToInput(i.otherCostsCents || 0) },
  ];
  const costBody = (v) => ({ airline: v.airline, loyaltyProgram: v.loyaltyProgram, pnr: v.pnr, ticketNumbers: v.ticketNumbers, cashAmountCents: v.cash || 0, airportFeesCents: v.airportFees || 0, issuanceFeeCents: v.issuanceFee || 0, otherCostsCents: v.otherCosts || 0 });

  async function addIssuance(sale) {
    const lots = (await api('/api/admin/finance/mileage-lots?status=active')).mileageLots.filter((lot) => lot.currency === sale.currency && lot.balanceQuantity > 0);
    const values = await askForm({
      title: 'Adicionar emissão', submitLabel: 'Adicionar',
      intro: 'O custo das milhas vem do custo médio do lote escolhido. O lucro só é confirmado quando a emissão for marcada como emitida.',
      fields: [
        { name: 'mode', label: 'Como foi emitido', type: 'select', options: Object.entries(modeLabels).map(([value, label]) => ({ value, label })), value: 'miles' },
        ...costFields(),
        { name: 'lotId', label: 'Lote de milhas usado', type: 'select', options: [{ value: '', label: lots.length ? 'Escolher depois' : 'Nenhum lote ativo com saldo nesta moeda' }, ...lots.map((lot) => ({ value: lot.id, label: `${lot.program} · saldo ${lot.balanceQuantity.toLocaleString('pt-BR')} · ${state.counterparties.find((c) => c.id === lot.counterpartyId)?.displayName || 'fornecedor'}` }))], wide: true },
        { name: 'quantity', label: 'Milhas usadas deste lote', type: 'number' },
        { name: 'markIssued', label: 'Já foi emitida (confirmar o custo agora)', type: 'checkbox', value: false },
      ],
    });
    if (!values) return;
    if (values.lotId && !values.quantity) { flash('Informe quantas milhas foram usadas do lote.', true); return; }
    if (values.markIssued && !values.pnr) { flash('Informe o PNR para marcar como emitida.', true); return; }
    if (values.markIssued && (values.mode === 'miles' || values.mode === 'hybrid') && !values.lotId) { flash('Escolha o lote das milhas antes de confirmar o custo.', true); return; }
    await guard(async () => {
      const created = await api(`/api/admin/finance/sales/${sale.id}/issuances`, { method: 'POST', body: JSON.stringify({ mode: values.mode, currency: sale.currency, ...costBody(values) }) });
      if (values.lotId) await api(`/api/admin/finance/issuances/${created.id}/mileage-allocations`, { method: 'POST', body: JSON.stringify({ lotId: values.lotId, quantity: values.quantity }) });
      if (values.markIssued) await api(`/api/admin/finance/issuances/${created.id}/issue`, { method: 'POST', body: JSON.stringify({}) });
      flash('Emissão adicionada.');
      await reload();
      loadMileageLots();
    }, 'Não foi possível adicionar a emissão.');
  }

  async function editIssuance(i) {
    const values = await askForm({ title: 'Editar custos da emissão', submitLabel: 'Salvar', fields: costFields(i) });
    if (!values) return;
    await guard(async () => { await api(`/api/admin/finance/issuances/${i.id}`, { method: 'PATCH', body: JSON.stringify(costBody(values)) }); await reload(); }, 'Não foi possível salvar os custos.');
  }

  async function allocate(i, sale) {
    const lots = (await api('/api/admin/finance/mileage-lots?status=active')).mileageLots.filter((lot) => lot.currency === sale.currency && lot.balanceQuantity > 0);
    if (!lots.length) { flash('Nenhum lote ativo com saldo nesta moeda. Compre um lote em Milhas.', true); return; }
    const values = await askForm({
      title: 'Usar milhas de um lote', submitLabel: 'Usar milhas',
      fields: [
        { name: 'lotId', label: 'Lote', type: 'select', wide: true, options: lots.map((lot) => ({ value: lot.id, label: `${lot.program} · saldo ${lot.balanceQuantity.toLocaleString('pt-BR')} · ${money(Number(lot.unitCostMicros) / 1000, lot.currency)} por mil milhas` })) },
        { name: 'quantity', label: 'Quantidade de milhas', type: 'number', required: true },
      ],
    });
    if (!values) return;
    await guard(async () => { await api(`/api/admin/finance/issuances/${i.id}/mileage-allocations`, { method: 'POST', body: JSON.stringify({ lotId: values.lotId, quantity: values.quantity }) }); await reload(); loadMileageLots(); }, 'Não foi possível usar as milhas.');
  }

  async function issue(i) {
    let pnr = i.pnr;
    if (!pnr) {
      const values = await askForm({ title: 'PNR da emissão', submitLabel: 'Continuar', intro: 'Informe o PNR para poder marcar como emitida.', fields: [{ name: 'pnr', label: 'PNR (código da reserva)', type: 'text', required: true }] });
      if (!values) return;
      pnr = values.pnr;
    }
    if ((i.mode === 'miles' || i.mode === 'hybrid') && !i.milesQuantity && !(await askConfirm('Esta emissão ainda não tem milhas de um lote. O custo das milhas ficaria zerado e o lucro apareceria maior que o real. Marcar como emitida mesmo assim?', { title: 'Sem milhas lançadas', submitLabel: 'Marcar mesmo assim' }))) return;
    if (!(await askConfirm('Depois de emitida, o custo desta emissão não pode mais ser alterado. Confirmar?', { title: 'Marcar como emitida', submitLabel: 'Marcar como emitida' }))) return;
    await guard(async () => {
      if (pnr !== i.pnr) await api(`/api/admin/finance/issuances/${i.id}`, { method: 'PATCH', body: JSON.stringify({ pnr }) });
      await api(`/api/admin/finance/issuances/${i.id}/issue`, { method: 'POST', body: JSON.stringify({}) });
      flash('Emissão marcada como emitida. Lucro confirmado.');
      await reload();
    }, 'Não foi possível marcar como emitida.');
  }

  async function terminate(id, kind) {
    const word = kind === 'cancel' ? 'Cancelar' : 'Reembolsar';
    const values = await askForm({ title: `${word} emissão`, submitLabel: word, danger: true, fields: [{ name: 'reason', label: 'Motivo', type: 'text', required: true, wide: true }] });
    if (!values) return;
    await guard(async () => { await api(`/api/admin/finance/issuances/${id}/${kind}`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) }); await reload(); loadMileageLots(); }, `Não foi possível ${word.toLowerCase()} a emissão.`);
  }

  dialog.showModal();
  dialog.innerHTML = '<div class="fin-dialog-body"><p class="muted">Carregando...</p></div>';
  await guard(reload, 'Não foi possível abrir o custo do voo.');
}
