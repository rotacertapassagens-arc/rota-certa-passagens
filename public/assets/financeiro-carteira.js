// Financeiro: Carteira de milhas (saldo e custo médio por pessoa e programa) e Clubes (mensalidade, cartão, situação).
// Os dados vêm de /api/admin/finance/wallet. O custo é sempre em reais; o saldo "no programa" vem dos e-mails dos programas.
import { api, askForm, centsToInput, esc, financeErrorMessage, fmtDay, money, today } from './fin-ui.js';

const $ = (id) => document.getElementById(id);
const PROGRAMS = ['LATAM Pass', 'Smiles', 'Livelo', 'Azul Fidelidade', 'Esfera', 'All Accor', 'Ibéria', 'Rakuten', 'True Blue', 'TAP Miles&Go', 'Outro'];
const KIND_LABELS = {
  opening: 'Saldo inicial', club_credit: 'Crédito do clube', purchase: 'Compra de milhas', bonus: 'Bônus', transfer_in: 'Transferência recebida',
  transfer_out: 'Transferência enviada', usage: 'Emissão de passagem', sale: 'Venda de milhas', adjust: 'Ajuste de saldo', expire: 'Milhas vencidas',
};
const MOVEMENT_FORM_KINDS = [
  ['purchase', 'Compra de milhas (entrada)'], ['bonus', 'Bônus (entrada)'], ['transfer_in', 'Transferência recebida (entrada)'], ['club_credit', 'Crédito do clube (entrada)'],
  ['sale', 'Venda de milhas (saída)'], ['transfer_out', 'Transferência enviada (saída)'], ['expire', 'Milhas vencidas (saída)'],
  ['adjust_in', 'Ajuste para mais'], ['adjust_out', 'Ajuste para menos'],
];
const CLUB_STATUS = {
  active: { label: 'Em dia', tag: 'tag-paid' }, payment_failed: { label: 'Pagamento recusado', tag: 'tag-void' },
  canceled: { label: 'Cancelado', tag: 'tag-void' }, paused: { label: 'Pausado', tag: 'tag-muted' },
};
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');
const perThousand = (cents) => (cents === null || cents === undefined ? '-' : `${money(cents, 'BRL')} / mil`);
const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><small>${esc(label)}</small><strong>${value}</strong>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

let data = { accounts: [], alerts: [], totals: {}, unmatchedEvents: [] };
let holderFilter = '';
let detail = null; // { kind: 'program' | 'club', key }

function flash(message, isError = false) {
  const element = document.createElement('div');
  element.className = `flash${isError ? ' error' : ''}`;
  element.setAttribute('role', 'status');
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 5000);
}
const WALLET_ERRORS = {
  wallet_account_exists: 'Essa pessoa já tem uma conta nesse programa.',
  invalid_wallet_account: 'Confira pessoa, programa e os valores do saldo inicial.',
  invalid_wallet_movement: 'Confira tipo, quantidade e data do lançamento.',
  invalid_wallet_club: 'Confira nome, milhas, valor e dia do crédito do clube.',
  invalid_wallet_usage: 'Escolha a conta e a quantidade de milhas.',
  insufficient_wallet_balance: 'Essa conta não tem milhas suficientes.',
  wallet_account_not_found: 'Conta não encontrada ou inativa.',
  wallet_club_not_found: 'Clube não encontrado.',
  wallet_no_reported_balance: 'O programa ainda não informou o saldo desta conta. Digite o saldo que aparece no app.',
  wallet_movement_already_voided: 'Esse lançamento já foi estornado.',
  wallet_event_already_applied: 'Esse e-mail já foi aplicado.',
  fx_rate_required: 'A venda é em outra moeda: informe o câmbio (quantos reais vale 1 unidade dela).',
};
const message = (error, fallback) => WALLET_ERRORS[error?.message] || financeErrorMessage(error, fallback);
async function guard(action, fallback) {
  try { await action(); return true; } catch (error) { flash(message(error, fallback), true); return false; }
}

export async function fetchWallet() {
  data = await api('/api/admin/finance/wallet');
  const problems = data.alerts.filter((a) => a.kind.startsWith('club_') && a.level === 'danger').length;
  const badge = $('clubBadge');
  if (badge) badge.textContent = problems ? String(problems) : '';
  return data;
}

const holderOptions = () => [...new Set(data.accounts.map((a) => a.holder))].sort((a, b) => a.localeCompare(b));
const accountLabel = (a) => `${a.holder} · ${a.program}`;

// --- Carteira ---------------------------------------------------------------------------------------------
export async function loadCarteira() {
  await fetchWallet();
  const { totals, accounts, alerts, unmatchedEvents } = data;
  const avg = totals.balance > 0 ? Math.round((totals.costCents * 1000) / totals.balance) : null;
  $('walletKpis').innerHTML = [
    kpi('Milhas na carteira', fmt(totals.balance), `${accounts.filter((a) => a.active).length} contas`),
    kpi('Custo das milhas', money(totals.costCents, 'BRL'), avg === null ? '' : `${perThousand(avg)} em média`),
    kpi('Clubes por mês', money(totals.clubMonthlyCostCents, 'BRL'), `${fmt(totals.clubMonthlyMiles)} milhas por mês`),
    kpi('Atenção agora', String(alerts.length), alerts.some((a) => a.level === 'danger') ? 'tem coisa urgente' : 'nada urgente', alerts.some((a) => a.level === 'danger') ? 'accent' : ''),
  ].join('');
  $('walletAlertsPanel').hidden = alerts.length === 0;
  $('walletAlertsCount').textContent = String(alerts.length);
  $('walletAlerts').innerHTML = alerts.map((a) => `<div class="alert ${a.level === 'danger' ? 'alert-error' : 'alert-warn'}"><strong>${esc(a.title)}</strong><br><span>${esc(a.detail)}</span>${a.kind === 'divergence' ? ` <button type="button" class="small" data-reconcile="${a.accountId}">Ajustar ao programa</button>` : ''}</div>`).join('');
  renderWalletCards();
  $('walletUnmatchedPanel').hidden = unmatchedEvents.length === 0;
  $('walletUnmatched').innerHTML = unmatchedEvents.map((e) => {
    const options = accounts.filter((a) => a.program === e.program && a.active);
    return `<div class="club-event"><div><strong>${esc(e.program)}${e.holderHint ? ` · ${esc(e.holderHint)}` : ''}</strong> <span class="muted">${fmtDay(e.occurredAt)}</span><br><small>${esc(e.subject)}</small></div>
      <div class="row-actions">${options.length ? `<select data-event-account="${e.id}">${options.map((a) => `<option value="${a.id}">${esc(accountLabel(a))}</option>`).join('')}</select><button type="button" class="small" data-event-link="${e.id}">Esse e-mail é dessa conta</button>` : '<span class="muted">Cadastre a conta desse programa primeiro.</span>'}</div></div>`;
  }).join('');
  renderDetail();
}

// Um cartão por programa, como a aba Saldos do Iddas: clica e abre as pessoas daquele programa.
function renderWalletCards() {
  const holders = holderOptions();
  if (holderFilter && !holders.includes(holderFilter)) holderFilter = '';
  $('walletPeople').innerHTML = holders.length > 1
    ? ['', ...holders].map((h) => `<button type="button" class="chip${h === holderFilter ? ' on' : ''}" data-holder="${esc(h)}">${h ? esc(h) : 'Todos'}</button>`).join('')
    : '';
  const byProgram = new Map();
  for (const a of data.accounts) {
    if (!a.active || (holderFilter && a.holder !== holderFilter)) continue;
    if (!byProgram.has(a.program)) byProgram.set(a.program, []);
    byProgram.get(a.program).push(a);
  }
  const cards = [...byProgram.entries()].map(([program, list]) => {
    const balance = list.reduce((s, a) => s + a.balance, 0);
    const cost = list.reduce((s, a) => s + a.costCents, 0);
    const avg = balance > 0 ? Math.round((cost * 1000) / balance) : null;
    const off = list.filter((a) => a.divergence).length;
    const people = list.length === 1 ? list[0].holder : `${list.length} pessoas`;
    return { balance, html: `<button type="button" class="mile-card${off ? ' warn' : ''}" data-program="${esc(program)}">
      <span class="mile-name">${esc(program)}</span>
      <strong class="mile-balance">${fmt(balance)}</strong>
      <span class="mile-sub">${esc(people)}${avg === null ? '' : ` · ${perThousand(avg)}`}</span>
      ${off ? `<span class="tag tag-warn">${off} saldo${off > 1 ? 's' : ''} não confere${off > 1 ? 'm' : ''}</span>` : ''}</button>` };
  }).sort((a, b) => b.balance - a.balance);
  $('walletCards').innerHTML = cards.map((c) => c.html).join('') || '<p class="muted">Nenhuma conta ainda. Use "Nova conta" para cadastrar a primeira.</p>';
}

function programDetailHtml(program) {
  const list = data.accounts.filter((a) => a.active && a.program === program && (!holderFilter || a.holder === holderFilter));
  const balance = list.reduce((s, a) => s + a.balance, 0);
  const cost = list.reduce((s, a) => s + a.costCents, 0);
  const rows = list.map((a) => {
    const diff = a.divergence;
    const reported = a.reportedBalance === null
      ? '<span class="muted">o programa ainda não avisou o saldo</span>'
      : `No programa: ${fmt(a.reportedBalance)} <small class="muted">em ${fmtDay(a.reportedAt)}</small> ${diff ? `<span class="tag tag-warn">${diff > 0 ? '+' : ''}${fmt(diff)}</span>` : '<span class="tag tag-paid">confere</span>'}`;
    return `<div class="mile-person"><div class="mile-person-head"><div><strong>${esc(a.holder)}</strong>${a.memberNumber ? ` <small class="muted">nº ${esc(a.memberNumber)}</small>` : ''}${a.cpfLimit ? `<br><small class="muted">limite ${a.cpfLimit} CPFs/ano</small>` : ''}</div><div class="mile-person-num"><strong>${fmt(a.balance)}</strong><small class="muted">${perThousand(a.avgPerThousandCents)} · ${money(a.costCents, 'BRL')}</small></div></div>
      <p class="mile-reported">${reported}</p>
      <div class="row-actions"><button type="button" class="small" data-move="${a.id}">Lançar</button><button type="button" class="small ghost" data-reconcile="${a.id}">Conferir saldo</button><button type="button" class="small ghost" data-history="${a.id}">Histórico</button></div></div>`;
  }).join('');
  return `<div class="section-head"><div><h2>${esc(program)}</h2><p class="muted">${fmt(balance)} milhas · custo ${money(cost, 'BRL')}</p></div><button type="button" class="ghost" data-close>Fechar</button></div>
    ${rows || '<p class="muted">Nenhuma conta ativa neste programa.</p>'}
    <div class="fin-dialog-actions"><button type="button" class="small ghost" data-new-account="${esc(program)}">Nova conta em ${esc(program)}</button></div>`;
}

const lateClubIds = () => new Set(data.alerts.filter((a) => a.kind === 'club_credit_late').map((a) => a.clubId));

function clubDetailHtml(club) {
  const status = CLUB_STATUS[club.status] || CLUB_STATUS.active;
  const late = lateClubIds().has(club.id) && club.status === 'active';
  return `<div class="section-head"><div><h2>${esc(club.account.holder)} · ${esc(club.account.program)}</h2><p class="muted">${esc(club.name)}</p></div><button type="button" class="ghost" data-close>Fechar</button></div>
    <p><span class="tag ${late ? 'tag-warn' : status.tag}">${late ? 'Crédito atrasado' : status.label}</span></p>
    <dl class="club-dl"><div><dt>Mensalidade</dt><dd>${money(club.monthlyCostCents, 'BRL')}</dd></div><div><dt>Milhas por mês</dt><dd>${fmt(club.monthlyMiles)}</dd></div><div><dt>Custo por mil</dt><dd>${club.monthlyMiles ? perThousand(Math.round((club.monthlyCostCents * 1000) / club.monthlyMiles)) : '-'}</dd></div>
    <div><dt>Cartão</dt><dd>${esc(club.cardLabel || 'não informado')}</dd></div><div><dt>Credita todo dia</dt><dd>${club.creditDay || '-'}</dd></div><div><dt>Último crédito</dt><dd>${club.lastCreditOn ? fmtDay(club.lastCreditOn) : '-'}</dd></div></dl>
    ${club.lastEvent ? `<p class="muted"><small>${esc(club.lastEvent)} em ${fmtDay(club.lastEventOn)}</small></p>` : ''}
    <div class="fin-dialog-actions"><button type="button" class="small ghost" data-club-edit="${club.id}">Editar</button>${club.status !== 'active' ? `<button type="button" class="small" data-club-status="${club.id}|active">Marcar em dia</button>` : `<button type="button" class="small ghost" data-club-status="${club.id}|paused">Pausar</button>`}</div>`;
}

/** Abre (ou atualiza) a janela de detalhe. Depois de cada ação a lista recarrega e a janela se refaz sozinha. */
function renderDetail() {
  let dialog = document.getElementById('walletDetail');
  if (!detail) { dialog?.close(); return; }
  let html = '';
  if (detail.kind === 'program') html = programDetailHtml(detail.key);
  else {
    const club = data.accounts.flatMap((a) => a.clubs.map((c) => ({ ...c, account: a }))).find((c) => c.id === detail.key);
    if (club) html = clubDetailHtml(club);
  }
  if (!html) { dialog?.close(); return; }
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'walletDetail';
    dialog.className = 'fin-dialog';
    dialog.addEventListener('close', () => { detail = null; dialog.remove(); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
  }
  dialog.innerHTML = `<div class="fin-dialog-body">${html}</div>`;
}
function openDetail(kind, key) { detail = { kind, key }; renderDetail(); }

async function newAccount(presetProgram) {
  const values = await askForm({
    title: 'Nova conta de milhas', submitLabel: 'Criar conta',
    intro: 'Uma conta é uma pessoa (CPF) num programa. O saldo inicial entra com o custo que você pagou por ele.',
    fields: [
      { name: 'holder', label: 'Pessoa', type: 'text', required: true, placeholder: 'ex.: Carlos', hint: holderOptions().length ? `Já cadastradas: ${holderOptions().join(', ')}` : '' },
      { name: 'program', label: 'Programa', type: 'select', required: true, value: presetProgram, options: PROGRAMS.map((p) => ({ value: p, label: p })) },
      { name: 'memberNumber', label: 'Número do programa (opcional)', type: 'text', hint: 'Ajuda a reconhecer os e-mails dele.' },
      { name: 'cpfLimit', label: 'Limite de CPFs por ano (opcional)', type: 'number', hint: 'Ex.: Smiles 25, LATAM 24, Azul 5.' },
      { name: 'openingMiles', label: 'Saldo de hoje (milhas)', type: 'number', hint: 'O que aparece no app do programa agora.' },
      { name: 'openingCostCents', label: 'Quanto custou esse saldo (R$)', type: 'money', hint: 'Custo total, não por mil. Se não souber, deixe zero.' },
    ],
  });
  if (!values) return;
  await guard(async () => { await api('/api/admin/finance/wallet/accounts', { method: 'POST', body: JSON.stringify({ ...values, cpfLimit: values.cpfLimit ?? null, openingMiles: values.openingMiles ?? 0, openingCostCents: values.openingCostCents ?? 0 }) }); await loadCarteira(); flash('Conta criada.'); }, 'Não foi possível criar a conta.');
}

async function newMovement(accountId) {
  const account = data.accounts.find((a) => a.id === accountId);
  const values = await askForm({
    title: `Lançar milhas: ${accountLabel(account)}`, submitLabel: 'Lançar',
    intro: `Saldo atual ${fmt(account.balance)}. Nas saídas, o custo sai pelo custo médio da conta.`,
    fields: [
      { name: 'kind', label: 'O que aconteceu', type: 'select', required: true, wide: true, options: MOVEMENT_FORM_KINDS.map(([value, label]) => ({ value, label })) },
      { name: 'miles', label: 'Milhas', type: 'number', required: true },
      { name: 'costCents', label: 'Custo da entrada (R$)', type: 'money', hint: 'Só nas entradas e no ajuste para mais.' },
      { name: 'occurredOn', label: 'Data', type: 'date', value: today(), required: true },
      { name: 'expiresOn', label: 'Validade das milhas (opcional)', type: 'date' },
      { name: 'note', label: 'Observação', type: 'text', wide: true },
    ],
  });
  if (!values) return;
  const adjust = values.kind.startsWith('adjust');
  const body = { kind: adjust ? 'adjust' : values.kind, direction: values.kind === 'adjust_out' ? 'out' : 'in', miles: values.miles, costCents: values.costCents ?? 0, occurredOn: values.occurredOn, expiresOn: values.expiresOn || undefined, note: values.note };
  await guard(async () => { await api(`/api/admin/finance/wallet/accounts/${accountId}/movements`, { method: 'POST', body: JSON.stringify(body) }); await loadCarteira(); flash('Lançamento salvo.'); }, 'Não foi possível salvar o lançamento.');
}

async function reconcile(accountId) {
  const account = data.accounts.find((a) => a.id === accountId);
  const values = await askForm({
    title: `Conferir saldo: ${accountLabel(account)}`, submitLabel: 'Ajustar',
    intro: `Aqui o saldo é ${fmt(account.balance)}${account.reportedBalance !== null ? ` e o programa avisou ${fmt(account.reportedBalance)} em ${fmtDay(account.reportedAt)}` : ''}. Vai entrar um ajuste para os dois ficarem iguais.`,
    fields: [{ name: 'balance', label: 'Saldo que aparece no app do programa', type: 'number', value: account.reportedBalance ?? '', hint: account.reportedBalance !== null ? 'Já veio do e-mail do programa. Mude só se o app mostrar outro valor.' : 'O programa ainda não avisou o saldo por e-mail: digite o que o app mostra.', required: true }],
  });
  if (!values) return;
  await guard(async () => {
    const typed = account.reportedBalance === null || values.balance !== account.reportedBalance;
    const result = await api(`/api/admin/finance/wallet/accounts/${accountId}/reconcile`, { method: 'POST', body: JSON.stringify(typed ? { balance: values.balance } : {}) });
    await loadCarteira();
    flash(result.adjusted ? `Ajuste de ${result.adjusted > 0 ? '+' : ''}${fmt(result.adjusted)} milhas lançado.` : 'O saldo já estava igual.');
  }, 'Não foi possível conferir o saldo.');
}

async function history(accountId) {
  const account = data.accounts.find((a) => a.id === accountId);
  const { movements } = await api(`/api/admin/finance/wallet/accounts/${accountId}/movements`);
  const dialog = document.createElement('dialog');
  dialog.className = 'fin-dialog big';
  dialog.innerHTML = `<div class="fin-dialog-body"><div class="section-head"><div><h2>Histórico: ${esc(accountLabel(account))}</h2><p class="muted">Saldo ${fmt(account.balance)} · custo ${money(account.costCents, 'BRL')}. Estornar desfaz o efeito do lançamento sem apagar o registro.</p></div><button type="button" class="ghost" data-close>Fechar</button></div>
    <div class="table-wrap"><table class="fin-table"><thead><tr><th>Data</th><th>O que foi</th><th class="num">Milhas</th><th class="num">Custo</th><th>Observação</th><th></th></tr></thead><tbody>
    ${movements.map((m) => `<tr class="${m.voidedAt ? 'muted' : ''}"><td>${fmtDay(m.occurredOn)}</td><td>${esc(KIND_LABELS[m.kind] || m.kind)}${m.source === 'email' ? ' <small class="muted">(e-mail)</small>' : ''}${m.voidedAt ? ' <span class="tag tag-void">estornado</span>' : ''}</td><td class="num">${m.miles > 0 ? '+' : ''}${fmt(m.miles)}</td><td class="num">${money(m.costCents, 'BRL')}</td><td>${esc(m.note || '')}${m.voidReason ? ` <small class="muted">(${esc(m.voidReason)})</small>` : ''}</td><td>${m.voidedAt ? '' : `<button type="button" class="small ghost" data-void="${m.id}">Estornar</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sem lançamentos.</td></tr>'}
    </tbody></table></div></div>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelectorAll('[data-void]').forEach((button) => button.addEventListener('click', async () => {
    const values = await askForm({ title: 'Estornar lançamento', submitLabel: 'Estornar', danger: true, fields: [{ name: 'reason', label: 'Motivo', type: 'text', required: true, wide: true }] });
    if (!values) return;
    if (await guard(async () => { await api(`/api/admin/finance/wallet/movements/${button.dataset.void}/void`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) }); }, 'Não foi possível estornar.')) { dialog.close(); await loadCarteira(); history(accountId); }
  }));
  dialog.showModal();
}

// --- Clubes -----------------------------------------------------------------------------------------------
export async function loadClubes() {
  await fetchWallet();
  const clubs = data.accounts.flatMap((a) => a.clubs.map((c) => ({ ...c, account: a })));
  const lateIds = lateClubIds();
  const problems = clubs.filter((c) => c.status === 'payment_failed' || c.status === 'canceled');
  const late = clubs.filter((c) => c.status === 'active' && lateIds.has(c.id));
  const fine = clubs.filter((c) => c.status === 'active' && !lateIds.has(c.id));
  const paused = clubs.filter((c) => c.status === 'paused');
  const live = clubs.filter((c) => c.status === 'active' || c.status === 'payment_failed');
  $('clubKpis').innerHTML = [
    kpi('Mensalidades por mês', money(live.reduce((s, c) => s + c.monthlyCostCents, 0), 'BRL'), `${live.length} clubes ativos`),
    kpi('Milhas por mês', fmt(live.reduce((s, c) => s + c.monthlyMiles, 0)), 'se todos creditarem'),
    kpi('Com problema', String(problems.length), problems.length ? 'pagamento recusado ou cancelado' : 'tudo certo', problems.length ? 'accent' : ''),
    kpi('Crédito atrasado', String(late.length), late.length ? 'sem e-mail de crédito do mês' : 'nenhum'),
  ].join('');
  const card = (c) => {
    const status = CLUB_STATUS[c.status] || CLUB_STATUS.active;
    const bad = c.status === 'payment_failed' || c.status === 'canceled';
    const isLate = lateIds.has(c.id) && c.status === 'active';
    return `<button type="button" class="mile-card${bad ? ' bad' : isLate ? ' warn' : ''}" data-club="${c.id}">
      <span class="mile-name">${esc(c.account.holder)} · ${esc(c.account.program)}</span>
      <strong class="mile-balance">${money(c.monthlyCostCents, 'BRL')}<small> /mês</small></strong>
      <span class="mile-sub">${fmt(c.monthlyMiles)} milhas por mês</span>
      <span class="tag ${isLate ? 'tag-warn' : status.tag}">${isLate ? 'Crédito atrasado' : status.label}</span></button>`;
  };
  const group = (title, list, hint = '') => (list.length ? `<section class="club-group"><h2>${title}</h2>${hint ? `<p class="muted">${hint}</p>` : ''}<div class="mile-grid">${list.map(card).join('')}</div></section>` : '');
  $('clubGroups').innerHTML = group('Resolver agora', problems, 'O programa avisou que o pagamento falhou ou que o clube foi cancelado. Troque ou regularize o cartão no app do programa.')
    + group('Crédito atrasado', late, 'Já passou do dia do crédito e ainda não chegou o e-mail do programa.')
    + group('Em dia', fine) + group('Pausados', paused)
    || '<section class="panel"><p class="muted">Nenhum clube cadastrado ainda. Use "Novo clube".</p></section>';
  renderDetail();
}

const clubFields = (club = {}) => [
  { name: 'name', label: 'Nome do plano', type: 'text', required: true, value: club.name || '', placeholder: 'ex.: Clube Smiles 1.000', wide: true },
  { name: 'monthlyMiles', label: 'Milhas por mês', type: 'number', required: true, value: club.monthlyMiles ?? '' },
  { name: 'monthlyCostCents', label: 'Mensalidade (R$)', type: 'money', required: true, value: centsToInput(club.monthlyCostCents) },
  { name: 'creditDay', label: 'Dia do mês em que credita', type: 'number', value: club.creditDay ?? '', hint: 'Usado para avisar crédito atrasado.' },
  { name: 'cardLabel', label: 'Cartão que paga', type: 'text', value: club.cardLabel || '', placeholder: 'ex.: Nubank 6203' },
];
async function newClub() {
  if (!data.accounts.length) { flash('Cadastre primeiro uma conta na Carteira de milhas.', true); return; }
  const values = await askForm({
    title: 'Novo clube', submitLabel: 'Cadastrar clube',
    fields: [{ name: 'accountId', label: 'Conta', type: 'select', required: true, wide: true, options: data.accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: accountLabel(a) })) }, ...clubFields()],
  });
  if (!values) return;
  await guard(async () => { await api('/api/admin/finance/wallet/clubs', { method: 'POST', body: JSON.stringify({ ...values, creditDay: values.creditDay ?? null }) }); await loadClubes(); flash('Clube cadastrado.'); }, 'Não foi possível cadastrar o clube.');
}
async function editClub(id) {
  const club = data.accounts.flatMap((a) => a.clubs).find((c) => c.id === id);
  const values = await askForm({ title: `Editar clube: ${club.name}`, submitLabel: 'Salvar', fields: clubFields(club) });
  if (!values) return;
  await guard(async () => { await api(`/api/admin/finance/wallet/clubs/${id}`, { method: 'PATCH', body: JSON.stringify({ ...values, creditDay: values.creditDay ?? null }) }); await loadClubes(); }, 'Não foi possível salvar o clube.');
}
async function setClubStatus(id, status) {
  await guard(async () => { await api(`/api/admin/finance/wallet/clubs/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await loadClubes(); }, 'Não foi possível mudar a situação.');
}

// --- ligação com a tela de custo do voo ---------------------------------------------------------------------
export async function walletUsages(issuanceId) {
  return (await api(`/api/admin/finance/issuances/${issuanceId}/wallet-usage`)).usages;
}
/** Janela "Usar milhas da minha carteira". Devolve true quando lançou. */
export async function useWalletMiles(issuance, sale) {
  await fetchWallet();
  const usable = data.accounts.filter((a) => a.active && a.balance > 0);
  if (!usable.length) { flash('Nenhuma conta com saldo na carteira. Cadastre uma em Carteira de milhas.', true); return false; }
  const foreign = sale.currency !== 'BRL';
  const preferred = usable.find((a) => a.program === issuance.loyaltyProgram) || usable[0];
  const values = await askForm({
    title: 'Usar milhas da minha carteira', submitLabel: 'Usar milhas',
    intro: 'O custo sai pelo custo médio da conta escolhida, e o lucro do voo já se atualiza.',
    fields: [
      { name: 'accountId', label: 'Conta', type: 'select', wide: true, value: preferred.id, options: usable.map((a) => ({ value: a.id, label: `${accountLabel(a)} · saldo ${fmt(a.balance)} · ${perThousand(a.avgPerThousandCents)}` })) },
      { name: 'miles', label: 'Quantidade de milhas', type: 'number', required: true },
      ...(foreign ? [{ name: 'fxRate', label: `Câmbio: quantos reais vale 1 ${sale.currency}`, type: 'number', required: true, hint: 'O custo das milhas é em reais; precisa converter para a moeda da venda.' }] : []),
    ],
  });
  if (!values) return false;
  return guard(async () => {
    const result = await api(`/api/admin/finance/issuances/${issuance.id}/wallet-usage`, { method: 'POST', body: JSON.stringify({ accountId: values.accountId, miles: values.miles, fxRate: values.fxRate ?? undefined }) });
    flash(`Milhas lançadas. Custo ${money(result.costCents, 'BRL')}${foreign ? ` (${money(result.issuanceCostCents, sale.currency)})` : ''}.`);
  }, 'Não foi possível usar as milhas.');
}
export async function voidWalletUsage(movementId) {
  const values = await askForm({ title: 'Estornar milhas da carteira', submitLabel: 'Estornar', danger: true, intro: 'As milhas voltam para a conta e o custo da emissão é recalculado.', fields: [{ name: 'reason', label: 'Motivo', type: 'text', required: true, wide: true }] });
  if (!values) return false;
  return guard(async () => { await api(`/api/admin/finance/wallet/movements/${movementId}/void`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) }); }, 'Não foi possível estornar as milhas.');
}

export function initCarteira() {
  $('walletNewAccount').addEventListener('click', () => newAccount());
  $('walletNewClub').addEventListener('click', newClub);
  document.addEventListener('click', (event) => {
    const t = event.target.closest('button');
    if (!t) return;
    if (t.dataset.close !== undefined && t.closest('#walletDetail')) document.getElementById('walletDetail').close();
    else if (t.dataset.program) openDetail('program', t.dataset.program);
    else if (t.dataset.club) openDetail('club', t.dataset.club);
    else if (t.dataset.holder !== undefined && t.closest('#walletPeople')) { holderFilter = t.dataset.holder; renderWalletCards(); }
    else if (t.dataset.newAccount) newAccount(t.dataset.newAccount);
    else if (t.dataset.move) newMovement(t.dataset.move);
    else if (t.dataset.reconcile) reconcile(t.dataset.reconcile);
    else if (t.dataset.history) history(t.dataset.history);
    else if (t.dataset.clubEdit) editClub(t.dataset.clubEdit);
    else if (t.dataset.clubStatus) { const [id, status] = t.dataset.clubStatus.split('|'); setClubStatus(id, status); }
    else if (t.dataset.eventLink) {
      const select = document.querySelector(`[data-event-account="${t.dataset.eventLink}"]`);
      guard(async () => { await api(`/api/admin/finance/wallet/events/${t.dataset.eventLink}/link`, { method: 'POST', body: JSON.stringify({ accountId: select.value }) }); await loadCarteira(); flash('E-mail aplicado à conta.'); }, 'Não foi possível ligar o e-mail.');
    }
  });
}
