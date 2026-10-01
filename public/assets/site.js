const navToggle = document.getElementById('navToggle');
const mainNav = document.getElementById('mainNav');
if (navToggle && mainNav) {
  navToggle.addEventListener('click', () => {
    const open = mainNav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
  });
  mainNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    mainNav.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  }));
  mainNav.querySelectorAll('.nav-parent').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const group = button.parentElement;
    const wasOpen = group.classList.contains('open');
    mainNav.querySelectorAll('.nav-group.open').forEach((item) => item.classList.remove('open'));
    if (!wasOpen) group.classList.add('open');
    button.setAttribute('aria-expanded', String(!wasOpen));
  }));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.nav-group')) mainNav.querySelectorAll('.nav-group.open').forEach((group) => group.classList.remove('open'));
  });
}

// Origem da visita (UTMs, página de entrada, site de onde veio e horário), lida pelo pedido de proposta
// em quote.js. Fica só nesta aba; uma campanha nova (com UTM) substitui a anterior.
(function captureVisitSource() {
  try {
    const params = new URLSearchParams(location.search);
    const utm = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((key) => { const value = params.get(key); if (value) utm[key] = value.trim().slice(0, 200); });
    if (sessionStorage.getItem('rc_origem_visita') && !Object.keys(utm).length) return;
    let referrer = null;
    if (document.referrer) { const from = new URL(document.referrer); if (from.host !== location.host) referrer = from.hostname; }
    sessionStorage.setItem('rc_origem_visita', JSON.stringify({ ...utm, page: location.pathname.slice(0, 300), referrer, capturedAt: new Date().toISOString() }));
  } catch { /* sem sessionStorage: o pedido só não leva a origem */ }
})();

const legacyPlannerKey = 'rotaCertaPlanner_v2';
const starterData = {
  trip: { id: null, name: 'Demonstração do Planner' },
  itinerary: [],
  places: [],
  expenses: [],
  checklist: [
    { text: 'Passaporte válido', done: false },
    { text: 'Seguro viagem', done: false },
    { text: 'Documentos de viagem', done: false },
    { text: 'Check-in online', done: false },
    { text: 'Bagagem despachada', done: false },
    { text: 'Dinheiro / cartões', done: false },
    { text: 'Adaptador de tomada', done: false },
    { text: 'Medicamentos', done: false },
  ],
  budget: 1500,
};

let session = null;
let rates = null;
let ratesDate = null;
let data = starterData;
let plannerLocked = true;
let userCurrency = 'EUR';
let selectedTripId = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}
function money(value, currency = 'EUR') {
  return new Intl.NumberFormat(currency === 'EUR' ? 'pt-PT' : 'pt-BR', { style: 'currency', currency }).format(Number(value) || 0);
}
function currentPath() {
  return (`/${location.hash.slice(1).split('?')[0] || ''}`).replace(/\/+/g, '/');
}
function hashParams() {
  return new URLSearchParams(location.hash.split('?')[1] || '');
}
function route() {
  return currentPath().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}
function csrfToken() {
  return document.cookie.split('; ').find((part) => part.startsWith('rc_csrf='))?.split('=').slice(1).join('=') || '';
}
async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) headers.set('x-csrf-token', csrfToken());
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'request_failed'), { status: response.status, body });
  return body;
}
function notify(message) {
  window.alert(message);
}

async function refreshSession() {
  try {
    session = await api('/api/auth/session');
    if (!session.authenticated) session = null;
  } catch {
    session = null;
  }
  plannerLocked = !session;
}

function setHomeMode(isHome) {
  document.querySelectorAll('body>section,body>header,body>footer,body>.strip,body>.wa-float').forEach((element) => {
    if (!element.matches('#plannerApp,#clientApp')) element.style.display = isHome ? '' : 'none';
  });
  const planner = document.getElementById('plannerApp');
  const client = document.getElementById('clientApp');
  planner.classList.toggle('active', !isHome && route()[0] === 'planner');
  client.classList.toggle('active', !isHome && route()[0] === 'cliente');
}

async function loadPlanner(tripId = selectedTripId) {
  if (!rates) { try { const result = await api('/api/planner/rates'); rates = result.rates || null; ratesDate = result.date || null; } catch { rates = null; } }
  if (!session) {
    const legacy = localStorage.getItem(legacyPlannerKey);
    try { data = legacy ? { ...starterData, ...JSON.parse(legacy), trip: starterData.trip } : structuredClone(starterData); }
    catch { data = structuredClone(starterData); }
    return;
  }
  const payload = await api(`/api/planner${tripId ? `?tripId=${encodeURIComponent(tripId)}` : ''}`);
  selectedTripId = payload.trip.id;
  data = {
    trip: payload.trip,
    trips: payload.trips || [payload.trip],
    entitlement: payload.entitlement || session.access,
    itinerary: payload.itinerary.map((item) => ({ id: item.id, day: item.day, time: item.time || '', what: item.title, type: item.kind, notes: item.notes || '', bookingCode: item.booking_code || '', bookingUrl: item.booking_url || '', source: item.source || '' })),
    attachments: (payload.attachments || []).map((file) => ({ id: file.id, itemId: file.item_id, name: file.name, type: file.content_type, size: Number(file.size) || 0 })),
    places: payload.places.map((item) => ({ id: item.id, name: item.name, type: item.category, address: item.address || '', notes: item.notes || '' })),
    expenses: payload.expenses.map((item) => ({ id: item.id, value: item.amount_cents / 100, type: item.category, desc: item.description, currency: item.currency || 'EUR', paidBy: item.paid_by || '' })),
    checklist: payload.checklist.map((item) => ({ id: item.id, text: item.text, done: item.completed })),
    budget: payload.budget.amount_cents / 100,
    budgetCurrency: payload.budget.currency || 'EUR',
    companions: (() => { try { const list = JSON.parse(payload.trip.companions || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } })(),
  };
  void cacheAttachments();
}

function requireAccount() {
  if (!plannerLocked) return false;
  location.hash = `/cliente?plan=gratis&redirect=${encodeURIComponent(currentPath())}`;
  void router();
  window.scrollTo(0, 0);
  return true;
}

let currentPlannerKey = 'overview';
/** Redesenha a seção atual com o cartão da viagem (trocar, arquivar, configurar) no topo. */
function redraw() { return plannerView(currentPlannerKey); }
async function plannerView(key) {
  currentPlannerKey = key;
  const content = document.getElementById('plannerContent');
  const title = document.getElementById('plannerTitle');
  const subtitle = document.getElementById('plannerSubtitle');
  const labels = {
    overview: ['Visão geral', 'Tenha uma visão rápida da sua viagem.'],
    itinerario: ['Itinerário', 'Organize atividades, voos, restaurantes, hospedagem e transportes.'],
    lugares: ['Meus lugares', 'Guarde atrações, restaurantes e outros pontos importantes.'],
    orcamento: ['Orçamento da viagem', 'Controle o orçamento, despesas e saldo.'],
    checklist: ['Checklist da viagem', 'Não esqueça nada antes de viajar.'],
  };
  [title.textContent, subtitle.textContent] = labels[key] || labels.overview;
  document.getElementById('plannerApp').dataset.section = labels[key] ? key : 'overview';
  document.querySelectorAll('.planner-sidebar a').forEach((link) => link.classList.toggle('active', link.dataset.route === key || (key === 'overview' && link.dataset.route === 'planner')));
  if (key === 'overview') renderOverview(content);
  if (key === 'itinerario') renderItinerary(content);
  if (key === 'lugares') renderPlaces(content);
  if (key === 'orcamento') renderBudget(content);
  if (key === 'checklist') renderChecklist(content);
  if (plannerLocked) content.insertAdjacentHTML('afterbegin', `<div class="planner-lock"><div><strong>🔒 Demonstração sem gravação</strong><p>Você pode conhecer todas as áreas. Para salvar informações com segurança, crie uma conta.</p></div><a class="btn btn-gold btn-sm" href="#/cliente?plan=gratis&redirect=${encodeURIComponent(currentPath())}">Criar conta</a></div>`);
  else {
    addTripManager(content, key);
    addLegacyImportOffer(content);
  }
}

function upgradeMessage(error) {
  if (error?.body?.error === 'free_archived_trip_limit') return 'O plano Free permite até duas viagens arquivadas. Assine o Premium (9,99 € por 30 dias, pelo WhatsApp) para manter histórico ilimitado.';
  return 'O plano Free permite uma viagem ativa. Arquive a viagem atual ou assine o Premium para manter várias viagens ativas.';
}

function addTripManager(element, key) {
  const trips = data.trips || [];
  const active = trips.filter((trip) => !trip.archived_at);
  const archived = trips.filter((trip) => trip.archived_at);
  const isArchived = Boolean(data.trip.archived_at);
  if (isArchived) {
    element.querySelectorAll('button,input,select,textarea').forEach((control) => { control.disabled = true; });
    element.insertAdjacentHTML('afterbegin', '<div class="planner-lock"><div><strong>Viagem arquivada</strong><p>O histórico está preservado. Restaure esta viagem para voltar a editá-la.</p></div></div>');
  }
  const manager = document.createElement('div');
  manager.className = 'trip-manager planner-card';
  const daysLeft = data.entitlement?.tier === 'free' && data.entitlement?.endsAt ? Math.max(0, Math.ceil((new Date(data.entitlement.endsAt).getTime() - Date.now()) / 86400000)) : null;
  const planText = data.entitlement?.tier === 'free' ? `TESTE FREE · ${daysLeft} DIA${daysLeft === 1 ? '' : 'S'}` : `PLANO ${(data.entitlement?.tier || 'free').toUpperCase()}`;
  manager.innerHTML = `<div class="trip-manager-main"><div><small class="trip-plan-badge">${esc(planText)}</small><strong>${esc(data.trip.name)}</strong><span>${active.length} ativa${active.length === 1 ? '' : 's'} · ${archived.length} arquivada${archived.length === 1 ? '' : 's'}</span></div><label>Trocar viagem<select id="tripSelector">${active.length ? '<optgroup label="Ativas">' + active.map((trip) => `<option value="${esc(trip.id)}" ${trip.id === data.trip.id ? 'selected' : ''}>${esc(trip.name)}</option>`).join('') + '</optgroup>' : ''}${archived.length ? '<optgroup label="Arquivadas">' + archived.map((trip) => `<option value="${esc(trip.id)}" ${trip.id === data.trip.id ? 'selected' : ''}>${esc(trip.name)}</option>`).join('') + '</optgroup>' : ''}</select></label></div><div class="trip-manager-actions"><button class="btn btn-outline-dark btn-sm" id="newTrip">+ Nova viagem</button><button class="btn btn-gold btn-sm" id="tripSettings">Configurar e compartilhar</button><button class="btn btn-outline-dark btn-sm" id="tripArchiveAction">${isArchived ? 'Restaurar viagem' : 'Arquivar viagem'}</button></div>`
    + `<div class="trip-settings hidden" id="tripSettingsPanel"><div class="ts-grid"><label>Nome da viagem<input id="tsName" maxlength="120" value="${esc(data.trip.name)}"></label><label>Data de ida<input id="tsStart" type="date" value="${esc(data.trip.starts_on || '')}"></label><label>Data de volta<input id="tsEnd" type="date" value="${esc(data.trip.ends_on || '')}"></label><label class="ts-wide">Quem viaja com você<input id="tsCompanions" maxlength="500" placeholder="Ex.: Ana, Bruno" value="${esc((data.companions || []).join(', '))}"><small>Separe os nomes por vírgula. Eles entram na divisão dos custos.</small></label></div><div class="pl-form-actions"><button class="btn btn-gold btn-sm" id="tsSave">Salvar</button></div>`
    + `<div class="ts-share"><strong>Compartilhar com quem vai junto</strong><p>O link mostra o roteiro e os lugares. Não mostra códigos de reserva, anexos nem gastos, e você pode desligar quando quiser.</p>${data.trip.share_token ? `<div class="ts-link"><input id="tsLink" readonly value="${esc(`${location.origin}/viagem/${data.trip.share_token}`)}" aria-label="Link da viagem"><button class="btn btn-outline-dark btn-sm" id="tsCopy">Copiar</button><button class="btn btn-outline-dark btn-sm" id="tsUnshare">Desligar link</button></div>` : '<button class="btn btn-outline-dark btn-sm" id="tsShare">Criar link de leitura</button>'}</div></div>`;
  element.prepend(manager);
  const refresh = async () => { await loadPlanner(); await plannerView(key); };
  manager.querySelector('#tripSettings').onclick = () => manager.querySelector('#tripSettingsPanel').classList.toggle('hidden');
  manager.querySelector('#tsSave').onclick = async () => {
    const body = { name: manager.querySelector('#tsName').value.trim(), startsOn: manager.querySelector('#tsStart').value || null, endsOn: manager.querySelector('#tsEnd').value || null, companions: manager.querySelector('#tsCompanions').value.split(',').map((n) => n.trim()).filter(Boolean) };
    if (body.startsOn && body.endsOn && body.endsOn < body.startsOn) { notify('A data de volta precisa ser depois da data de ida.'); return; }
    try { await api(`/api/planner/trips/${data.trip.id}`, { method: 'PATCH', body: JSON.stringify(body) }); } catch (error) { notify(plannerError(error)); return; }
    await refresh();
  };
  manager.querySelector('#tsShare')?.addEventListener('click', async () => { try { await api(`/api/planner/trips/${data.trip.id}/share`, { method: 'POST' }); } catch (error) { notify(plannerError(error)); return; } await refresh(); document.getElementById('tripSettingsPanel')?.classList.remove('hidden'); });
  manager.querySelector('#tsUnshare')?.addEventListener('click', async () => { if (!window.confirm('Desligar o link? Quem tiver o link não vai mais conseguir abrir a viagem.')) return; try { await api(`/api/planner/trips/${data.trip.id}/share`, { method: 'DELETE' }); } catch (error) { notify(plannerError(error)); return; } await refresh(); });
  manager.querySelector('#tsCopy')?.addEventListener('click', async () => { const link = manager.querySelector('#tsLink').value; try { await navigator.clipboard.writeText(link); notify('Link copiado. Mande para quem vai viajar com você.'); } catch { notify(link); } });
  manager.querySelector('#tripSelector').onchange = async (event) => { selectedTripId = event.target.value; await loadPlanner(); await plannerView(key); };
  manager.querySelector('#newTrip').onclick = async () => {
    const name = window.prompt('Qual será o nome da nova viagem?');
    if (!name?.trim()) return;
    try {
      const result = await api('/api/planner/trips', { method: 'POST', body: JSON.stringify({ name: name.trim(), travelers: 1 }) });
      selectedTripId = result.id;
      await loadPlanner(); await plannerView(key);
    } catch (error) { notify(error?.body?.upgrade_required ? upgradeMessage(error) : 'Não foi possível criar a viagem agora.'); }
  };
  manager.querySelector('#tripArchiveAction').onclick = async () => {
    try {
      await api(`/api/planner/trips/${data.trip.id}/${isArchived ? 'restore' : 'archive'}`, { method: 'POST' });
      selectedTripId = null;
      await loadPlanner(); await plannerView(key);
    } catch (error) { notify(error?.body?.upgrade_required ? upgradeMessage(error) : 'Não foi possível atualizar esta viagem agora.'); }
  };
}

// Moedas: valores guardados na moeda original e convertidos pelo câmbio do dia (base EUR).
const CUR_LABEL = { EUR: 'Euro (€)', BRL: 'Real (R$)', USD: 'Dólar (US$)', GBP: 'Libra (£)' };
function convert(value, from = 'EUR', to = 'EUR') {
  if (from === to) return Number(value) || 0;
  if (!rates?.[from] || !rates?.[to]) return null;
  return (Number(value) || 0) / rates[from] * rates[to];
}
function displayCurrency() {
  try { const saved = localStorage.getItem('rcMoedaViagem'); if (saved === 'EUR' || saved === 'BRL') return saved; } catch { /* sem armazenamento */ }
  return data.budgetCurrency || 'EUR';
}
function tripTotals() {
  const cur = displayCurrency();
  let spent = 0;
  let missing = 0;
  const byType = new Map();
  for (const item of data.expenses) {
    const value = convert(item.value, item.currency || 'EUR', cur);
    if (value === null) { missing += 1; continue; }
    spent += value;
    byType.set(item.type, (byType.get(item.type) || 0) + value);
  }
  const budget = convert(data.budget, data.budgetCurrency || 'EUR', cur) ?? Number(data.budget || 0);
  return { cur, spent, budget, missing, byType: [...byType].sort((x, y) => y[1] - x[1]) };
}
/** Divide igualmente entre os viajantes e diz quem paga quanto a quem (menor número de transferências). */
function splitCosts(people, cur) {
  const paid = Object.fromEntries(people.map((person) => [person, 0]));
  let total = 0;
  for (const item of data.expenses) {
    const value = convert(item.value, item.currency || 'EUR', cur);
    if (value === null) continue;
    paid[people.includes(item.paidBy) ? item.paidBy : 'Você'] += value;
    total += value;
  }
  const share = total / people.length;
  const debtors = people.map((p) => ({ p, v: share - paid[p] })).filter((x) => x.v > 0.005).sort((x, y) => y.v - x.v);
  const creditors = people.map((p) => ({ p, v: paid[p] - share })).filter((x) => x.v > 0.005).sort((x, y) => y.v - x.v);
  const transfers = [];
  for (let i = 0, j = 0; i < debtors.length && j < creditors.length;) {
    const value = Math.min(debtors[i].v, creditors[j].v);
    transfers.push({ from: debtors[i].p, to: creditors[j].p, value });
    debtors[i].v -= value; creditors[j].v -= value;
    if (debtors[i].v < 0.005) i += 1;
    if (creditors[j].v < 0.005) j += 1;
  }
  return { share, paid, transfers };
}
function tripDayLabel(day) {
  if (!data.trip?.starts_on) return '';
  const date = new Date(Date.parse(`${data.trip.starts_on}T00:00:00Z`) + ((Number(day) || 1) - 1) * 86400000);
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(date);
}

// Ícones do Planner (traço simples, 24x24). Cores por tipo em [data-tone] no CSS.
const PL_ICONS = {
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  bed: '<path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M12 4v6M2 17h20"/>',
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
  train: '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1M9 15l-1-1M15 15l1-1M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5zM8 19l-2 3M16 19l2 3"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2zM13 5v2M13 17v2M13 11v2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5zM14 2v6h6M9 13h6M9 17h4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  clip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  wallet: '<path d="M19 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 9.5h-5a2.5 2.5 0 0 0 0 5h5z"/>',
  trend: '<path d="M3 17 9 11l4 4 8-8M14 7h7v7"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
};
function plIcon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PL_ICONS[name] || PL_ICONS.pin}</svg>`; }
const KIND_STYLE = { voo: ['plane', 'voo'], voos: ['plane', 'voo'], hospedagem: ['bed', 'hosp'], restaurante: ['food', 'food'], restaurantes: ['food', 'food'], alimentacao: ['food', 'food'], transporte: ['train', 'trans'], transportes: ['train', 'trans'], atividade: ['ticket', 'ativ'], atividades: ['ticket', 'ativ'], atracoes: ['camera', 'ativ'], compras: ['bag', 'comp'] };
function kindIcon(label) {
  const key = String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const [icon, tone] = KIND_STYLE[key] || ['pin', 'outro'];
  return { svg: plIcon(icon), tone };
}
const byDayTime = (a, b) => (Number(a.day) - Number(b.day)) || String(a.time || '99:99').localeCompare(String(b.time || '99:99'));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const tally = (list, weight) => [...list.reduce((acc, item) => acc.set(item.type, (acc.get(item.type) || 0) + weight(item)), new Map())].sort((x, y) => y[1] - x[1]);
const safeUrl = (value) => (/^https?:\/\//i.test(String(value || '')) ? String(value) : '');
function normalizeUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
}
function fileSize(bytes) {
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`;
}
function plannerError(error) {
  const code = error?.body?.error || error?.message;
  const messages = {
    attachment_too_large: 'O arquivo passa de 1,4 MB. Para PDF, salve só a página do bilhete; para foto, tire um print da tela.',
    unsupported_attachment_type: 'Envie um PDF ou uma foto (JPG, PNG ou WebP).',
    unreadable_image: 'Não conseguimos ler esta foto. Tire um print da tela e envie o print.',
    attachment_item_limit: 'Este item já tem 5 anexos. Remova um para enviar outro.',
    attachment_quota_exceeded: 'Você chegou ao limite de 20 MB de anexos. Remova arquivos antigos para enviar novos.',
    attachment_storage_full: 'Os anexos estão indisponíveis no momento. Fale com a gente pelo WhatsApp.',
    invalid_booking_url: 'O link da reserva precisa ser o endereço de um site, começando com https://',
    invalid_booking_code: 'O código da reserva pode ter até 80 caracteres.',
    trip_archived: 'Esta viagem está arquivada. Restaure a viagem para editar.',
    free_trial_expired: 'O seu teste Free terminou. Assine o Premium para continuar editando.',
    invalid_trip_date: 'Confira as datas da viagem.',
    invalid_companions: 'Informe até 12 nomes, separados por vírgula.',
    invalid_trip: 'Informe o nome da viagem.',
    invalid_expense: 'Confira o valor, a moeda e a descrição da despesa.',
    invalid_budget: 'Confira o valor do orçamento.',
  };
  if (!navigator.onLine) return 'Você está sem internet. Conecte-se para salvar mudanças; o que já está salvo continua disponível.';
  return messages[code] || 'Não foi possível salvar agora. Tente de novo em instantes.';
}
async function compressImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('unreadable_image'); }
  let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', [0.85, 0.75, 0.65][Math.min(attempt, 2)]));
    if (blob && blob.size <= 1300000) { bitmap.close?.(); return blob; }
    if (attempt >= 2) scale *= 0.8;
  }
  bitmap.close?.();
  throw new Error('attachment_too_large');
}
/** Foto é reduzida no navegador (até 1600 px, JPG); PDF vai como está, até 1,4 MB. */
async function uploadAttachment(itemId, file) {
  let blob = file;
  let name = file.name || 'Anexo';
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name);
  if (!isPdf) {
    if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(name)) throw new Error('unsupported_attachment_type');
    blob = await compressImage(file);
    name = `${name.replace(/\.[^.]+$/, '') || 'Foto'}.jpg`;
  }
  if (blob.size > 1400000) throw new Error('attachment_too_large');
  const form = new FormData();
  form.append('file', blob, name);
  form.append('name', name);
  const response = await fetch(`/api/planner/${data.trip.id}/itinerary/${itemId}/attachments`, { method: 'POST', body: form, headers: { 'x-csrf-token': csrfToken() }, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'upload_failed'), { status: response.status, body });
}

function renderOverview(element) {
  const icon = (d) => `<span class="ov-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg></span>`;
  const totals = tripTotals();
  const cur = totals.cur;
  const spent = totals.spent;
  const budget = totals.budget;
  const budgetPct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const done = data.checklist.filter((item) => item.done).length;
  const total = data.checklist.length;
  const days = new Set(data.itinerary.map((item) => Number(item.day) || 1)).size;
  const agenda = [...data.itinerary].sort(byDayTime).slice(0, 5);
  const files = data.attachments || [];
  const placeTypes = tally(data.places, () => 1).slice(0, 3);
  const costTypes = totals.byType.slice(0, 4);
  const pending = data.checklist.filter((item) => !item.done).slice(0, 5);
  element.innerHTML = `<div class="ov-stats">`
    + `<a class="ov-stat" data-tone="voo" href="#/planner/itinerario"><span class="ov-stat-head">${icon('<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>')}Roteiro</span><span class="ov-value">${data.itinerary.length}<small>${data.itinerary.length === 1 ? 'atividade' : 'atividades'}</small></span><span class="ov-meta">${data.itinerary.length ? `em ${plural(days, 'dia', 'dias')} de viagem` : 'Nada planejado ainda'}</span><span class="ov-more">Organizar roteiro →</span></a>`
    + `<a class="ov-stat" data-tone="trans" href="#/planner/lugares"><span class="ov-stat-head">${icon('<path d="M12 21.5s-7-6.1-7-11.5a7 7 0 0 1 14 0c0 5.4-7 11.5-7 11.5z"/><circle cx="12" cy="10" r="2.5"/>')}Lugares</span><span class="ov-value">${data.places.length}<small>${data.places.length === 1 ? 'lugar salvo' : 'lugares salvos'}</small></span>${placeTypes.length ? `<span class="ov-chips">${placeTypes.map(([type, n]) => `<span>${esc(type)} ${n}</span>`).join('')}</span>` : '<span class="ov-meta">Guarde atrações e restaurantes</span>'}<span class="ov-more">Ver no mapa →</span></a>`
    + `<a class="ov-stat" data-tone="ativ" href="#/planner/orcamento"><span class="ov-stat-head">${icon('<path d="M19 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 9.5h-5a2.5 2.5 0 0 0 0 5h5z"/>')}Orçamento</span><span class="ov-value">${money(spent, cur)}<small>gastos</small></span>${budget > 0 ? `<span class="progress"><span style="width:${budgetPct.toFixed(0)}%"></span></span><span class="ov-meta">${budgetPct.toFixed(0)}% de ${money(budget, cur)} · saldo ${money(budget - spent, cur)}</span>` : '<span class="ov-meta">Defina um orçamento para a viagem</span>'}<span class="ov-more">Controlar gastos →</span></a>`
    + `<a class="ov-stat" data-tone="ok" href="#/planner/checklist"><span class="ov-stat-head">${icon('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>')}Checklist</span><span class="ov-value">${done}/${total}<small>concluídos</small></span>${total ? `<span class="progress"><span style="width:${((done / total) * 100).toFixed(0)}%"></span></span><span class="ov-meta">${done === total ? 'Tudo pronto para viajar' : `Faltam ${plural(total - done, 'item', 'itens')}`}</span>` : '<span class="ov-meta">Monte a lista do que levar e resolver</span>'}<span class="ov-more">Preparar viagem →</span></a>`
    + `</div><div class="ov-panels">`
    + `<section class="planner-card ov-panel ov-agenda-wrap"><h2>Roteiro da viagem</h2>${agenda.length ? `<ul class="ov-agenda">${agenda.map((item) => `<li><span class="ov-when">Dia ${esc(item.day)}<b>${esc(item.time || '--:--')}</b></span><div><strong>${esc(item.what)}</strong><small>${esc(item.type)}${item.notes ? ` · ${esc(item.notes)}` : ''}${item.bookingCode ? '<span class="ov-flags">Reserva</span>' : ''}${files.some((f) => f.itemId === item.id) ? `<span class="ov-flags">${plIcon('clip')}${files.filter((f) => f.itemId === item.id).length}</span>` : ''}</small></div></li>`).join('')}</ul>` : '<p class="ov-empty">Adicione a primeira atividade: o voo, o hotel ou um passeio.</p>'}<a class="ov-link" href="#/planner/itinerario">${data.itinerary.length > agenda.length ? `Ver as ${data.itinerary.length} atividades →` : 'Abrir o roteiro →'}</a></section>`
    + `<section class="planner-card ov-panel"><h2>Para onde vai o dinheiro</h2>${costTypes.length ? `<ul class="ov-bars">${costTypes.map(([type, value]) => `<li><span>${esc(type)}</span><b>${money(value, cur)}</b><span class="ov-bar"><i style="width:${spent ? ((value / spent) * 100).toFixed(0) : 0}%"></i></span></li>`).join('')}</ul>` : '<p class="ov-empty">Nenhum gasto registrado ainda.</p>'}<a class="ov-link" href="#/planner/orcamento">Ver orçamento →</a></section>`
    + `<section class="planner-card ov-panel"><h2>O que falta preparar</h2>${pending.length ? `<ul class="ov-todo">${pending.map((item) => `<li>${esc(item.text)}</li>`).join('')}</ul>` : `<p class="ov-empty">${total ? 'Tudo pronto. Boa viagem!' : 'Seu checklist ainda está vazio.'}</p>`}<a class="ov-link" href="#/planner/checklist">Abrir checklist →</a></section>`
    + `</div>`;
}

let editingItemId = null;
function renderItinerary(element) {
  const items = [...data.itinerary].sort(byDayTime);
  const days = [...new Set(items.map((item) => Number(item.day) || 1))];
  const files = data.attachments || [];
  const kinds = ['Atividade', 'Restaurante', 'Hospedagem', 'Transporte', 'Voo', 'Outro'];
  const fields = (p, item = {}) => `<div class="it-form-grid">`
    + `<label>Dia<input id="${p}Day" type="number" min="1" value="${esc(item.day || 1)}"></label>`
    + `<label>Horário<input id="${p}Time" type="time" value="${esc(item.time || '')}"></label>`
    + `<label class="it-type">Tipo<select id="${p}Type">${kinds.map((k) => `<option${k === item.type ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`
    + `<label class="it-what">O que você vai fazer?<input id="${p}What" maxlength="240" placeholder="Ex.: Voo de Lisboa para o Porto" value="${esc(item.what || '')}"></label>`
    + `<label class="it-code">Código da reserva<input id="${p}Code" maxlength="80" placeholder="Ex.: ABC123" value="${esc(item.bookingCode || '')}"></label>`
    + `<label class="it-url">Link da reserva<input id="${p}Url" type="url" maxlength="500" placeholder="https://" value="${esc(item.bookingUrl || '')}"></label>`
    + `<label class="it-full">Notas<textarea id="${p}Notes" maxlength="2000" placeholder="Opcional">${esc(item.notes || '')}</textarea></label></div>`;
  const read = (p) => ({
    day: Number(document.getElementById(`${p}Day`).value || 1), time: document.getElementById(`${p}Time`).value,
    title: document.getElementById(`${p}What`).value.trim(), kind: document.getElementById(`${p}Type`).value,
    notes: document.getElementById(`${p}Notes`).value.trim(), bookingCode: document.getElementById(`${p}Code`).value.trim(),
    bookingUrl: normalizeUrl(document.getElementById(`${p}Url`).value),
  });
  const itemHtml = (item) => {
    if (editingItemId && editingItemId === item.id) return `<li class="it-item is-editing"><form class="it-edit" data-edit-form="${esc(item.id)}">${fields('ed', item)}<div class="pl-form-actions"><button class="btn btn-gold btn-sm" type="submit">Salvar</button><button class="btn btn-outline-dark btn-sm" type="button" data-cancel-edit>Cancelar</button></div></form></li>`;
    const kind = kindIcon(item.type);
    const mine = files.filter((file) => file.itemId === item.id);
    const url = safeUrl(item.bookingUrl);
    return `<li class="it-item" data-tone="${kind.tone}"><span class="pl-ico">${kind.svg}</span><div class="it-body">`
      + `<div class="it-meta"><b>${esc(item.time || 'Sem horário')}</b><span>${esc(item.type)}</span>${item.source === 'rota_certa' ? '<em class="it-rc">Emitido pela Rota Certa</em>' : ''}</div><strong class="it-title">${esc(item.what)}</strong>${item.notes ? `<p class="it-notes">${esc(item.notes)}</p>` : ''}`
      + (item.bookingCode || url ? `<div class="it-booking">${item.bookingCode ? `<span class="it-code">Reserva <b>${esc(item.bookingCode)}</b><button type="button" class="it-copy" data-copy="${esc(item.bookingCode)}">${plIcon('copy')}Copiar</button></span>` : ''}${url ? `<a class="it-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${plIcon('external')}Abrir reserva</a>` : ''}</div>` : '')
      + (mine.length ? `<ul class="it-files">${mine.map((file) => `<li><a href="/api/planner/${esc(data.trip.id)}/attachments/${esc(file.id)}" target="_blank" rel="noopener" data-file="${file.type === 'application/pdf' ? 'pdf' : 'image'}">${plIcon(file.type === 'application/pdf' ? 'file' : 'image')}<span>${esc(file.name)}</span><small>${fileSize(file.size)}</small></a><button type="button" class="it-file-del" data-del-file="${esc(file.id)}" aria-label="Remover ${esc(file.name)}">×</button></li>`).join('')}</ul>` : '')
      + `</div><div class="it-actions"><button type="button" class="it-act" data-attach-it="${esc(item.id || '')}">${plIcon('clip')}Anexar</button><button type="button" class="it-act" data-edit-it="${esc(item.id || '')}">Editar</button><button type="button" class="delete-item" data-del-it="${esc(item.id || '')}">Excluir</button></div></li>`;
  };
  const dayHtml = (day) => {
    const list = items.filter((item) => (Number(item.day) || 1) === day);
    return `<section class="it-day"><div class="it-day-head"><span class="it-day-num">Dia ${day}${tripDayLabel(day) ? `<small>${esc(tripDayLabel(day))}</small>` : ''}</span><span>${plural(list.length, 'atividade', 'atividades')}</span></div><ol class="it-list">${list.map(itemHtml).join('')}</ol></section>`;
  };
  element.innerHTML = `<div class="pl-toolbar"><div><strong>${plural(items.length, 'atividade planejada', 'atividades planejadas')}</strong><small>${days.length ? `em ${plural(days.length, 'dia', 'dias')} de viagem` : 'Comece pelo voo ou pelo hotel'}</small></div><button class="btn btn-gold" id="toggleItinerary">+ Adicionar atividade</button></div>`
    + (session && data.trip?.id && !data.trip.starts_on ? '<p class="pl-hint">Informe a data de ida em <b>Configurar e compartilhar</b>, no topo, para ver a data de cada dia e receber por e-mail o lembrete de check-in dos voos.</p>' : '')
    + `<div class="planner-form pl-form hidden" id="itineraryForm"><h3>Nova atividade</h3>${fields('i')}<div class="pl-form-actions"><button class="btn btn-gold" id="addItinerary">Adicionar ao roteiro</button></div></div>`
    + (items.length ? days.map(dayHtml).join('') : `<div class="planner-card pl-empty">${plIcon('calendar')}<strong>Seu roteiro está vazio</strong><p>Adicione o voo, o hotel e os passeios de cada dia. Dá para guardar o código e o link da reserva e anexar o bilhete em PDF ou foto.</p></div>`)
    + `<p class="pl-privacy">${plIcon('lock')}Reservas e anexos ficam só na sua conta: apenas você, com a sua senha, consegue abrir. Os anexos também ficam guardados neste aparelho para abrir sem internet e são apagados quando você sai da conta.</p>`
    + '<input type="file" id="itFile" accept="application/pdf,image/*" hidden>';
  const again = async () => { await loadPlanner(); redraw(); };
  document.getElementById('toggleItinerary').onclick = () => { if (!requireAccount()) document.getElementById('itineraryForm').classList.toggle('hidden'); };
  document.getElementById('addItinerary').onclick = async () => {
    if (requireAccount()) return;
    const b = read('i');
    if (!b.title) return;
    try {
      await api(`/api/planner/${data.trip.id}/itinerary`, { method: 'POST', body: JSON.stringify({ day: b.day, time: b.time || undefined, title: b.title, kind: b.kind, notes: b.notes || undefined, bookingCode: b.bookingCode || undefined, bookingUrl: b.bookingUrl || undefined }) });
    } catch (error) { notify(plannerError(error)); return; }
    await again();
  };
  element.querySelectorAll('[data-del-it]').forEach((button) => button.onclick = async () => {
    if (requireAccount()) return;
    if (files.some((file) => file.itemId === button.dataset.delIt) && !window.confirm('Excluir esta atividade e os anexos dela?')) return;
    await api(`/api/planner/${data.trip.id}/itinerary/${button.dataset.delIt}`, { method: 'DELETE' });
    await again();
  });
  element.querySelectorAll('[data-edit-it]').forEach((button) => button.onclick = () => {
    if (requireAccount()) return;
    editingItemId = button.dataset.editIt;
    redraw().then(() => element.querySelector('.it-edit input')?.focus());
  });
  element.querySelector('[data-cancel-edit]')?.addEventListener('click', () => { editingItemId = null; redraw(); });
  element.querySelector('[data-edit-form]')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const b = read('ed');
    if (!b.title) return;
    try { await api(`/api/planner/${data.trip.id}/itinerary/${event.target.dataset.editForm}`, { method: 'PATCH', body: JSON.stringify(b) }); }
    catch (error) { notify(plannerError(error)); return; }
    editingItemId = null;
    await again();
  });
  element.querySelectorAll('[data-copy]').forEach((button) => button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      const before = button.innerHTML;
      button.textContent = 'Copiado';
      setTimeout(() => { button.innerHTML = before; }, 1500);
    } catch { notify(`Código da reserva: ${button.dataset.copy}`); }
  });
  const picker = document.getElementById('itFile');
  let attachTo = null;
  element.querySelectorAll('[data-attach-it]').forEach((button) => button.onclick = () => {
    if (requireAccount()) return;
    attachTo = button.dataset.attachIt;
    picker.value = '';
    picker.click();
  });
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file || !attachTo) return;
    const button = [...element.querySelectorAll('[data-attach-it]')].find((b) => b.dataset.attachIt === attachTo);
    if (button) { button.disabled = true; button.textContent = 'Enviando...'; }
    try { await uploadAttachment(attachTo, file); await again(); }
    catch (error) { notify(plannerError(error)); if (button) { button.disabled = false; button.innerHTML = `${plIcon('clip')}Anexar`; } }
  };
  element.querySelectorAll('[data-del-file]').forEach((button) => button.onclick = async () => {
    if (requireAccount()) return;
    if (!window.confirm('Remover este anexo?')) return;
    try { await api(`/api/planner/${data.trip.id}/attachments/${button.dataset.delFile}`, { method: 'DELETE' }); }
    catch (error) { notify(plannerError(error)); return; }
    await again();
  });
}
const placeQuery = (place) => [place.name, place.address].filter(Boolean).join(', ');
const mapEmbedUrl = (query) => `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
const directionsUrl = (place) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(placeQuery(place))}`;

function renderPlaces(element) {
  const defaultMap = data.places.length ? mapEmbedUrl(placeQuery(data.places[0])) : mapEmbedUrl('Lisboa, Portugal');
  element.innerHTML = `<div class="places-grid"><div><div class="planner-toolbar"><strong>${data.places.length} lugares salvos</strong><button class="btn btn-gold" id="togglePlace">+ Adicionar</button></div><div class="planner-form hidden" id="placeForm"><div class="place-form-grid"><input class="full" id="pName" placeholder="Nome do lugar"><select id="pType"><option>Atrações</option><option>Restaurantes</option><option>Hospedagem</option><option>Transportes</option><option>Outro</option></select><input id="pAddress" placeholder="Endereço (opcional)"><textarea class="full" id="pNotes" placeholder="Notas (opcional)"></textarea></div><button class="btn btn-gold" id="addPlace">Adicionar lugar</button></div><div class="place-list">${data.places.length ? data.places.map((place, index) => `<div class="place-row${index === 0 ? ' active' : ''}" data-tone="${kindIcon(place.type).tone}"><div class="place-main"><span class="pl-ico">${kindIcon(place.type).svg}</span><div><strong>${esc(place.name)}</strong><small>${esc(place.type)}${place.address ? ` · ${esc(place.address)}` : ''}</small><div class="place-actions"><button type="button" class="place-map" data-map-place="${index}">Ver no mapa</button><a class="place-route" href="${esc(directionsUrl(place))}" target="_blank" rel="noopener">Como chegar</a></div></div></div><button class="delete-item" data-del-place="${esc(place.id || '')}">Excluir</button></div>`).join('') : '<div class="planner-card"><p class="muted">Nenhum lugar salvo ainda.</p></div>'}</div></div><div><div class="planner-card"><h2>Mapa da viagem</h2><p class="muted">Toque em "Ver no mapa" num lugar salvo, ou pesquise um endereço.</p><div style="display:flex;gap:8px;margin:14px 0"><input class="inline-input" id="mapSearch" placeholder="Lisboa, Porto, Paris..."><button class="btn btn-outline-dark" id="mapGo">Ver no mapa</button></div><iframe id="mapFrame" class="map-frame" src="${defaultMap}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Google Maps"></iframe></div></div></div>`;
  document.getElementById('togglePlace').onclick = () => { if (!requireAccount()) document.getElementById('placeForm').classList.toggle('hidden'); };
  document.getElementById('addPlace').onclick = async () => {
    if (requireAccount()) return;
    const body = { name: document.getElementById('pName').value, category: document.getElementById('pType').value, address: document.getElementById('pAddress').value || undefined, notes: document.getElementById('pNotes').value || undefined };
    if (!body.name) return;
    await api(`/api/planner/${data.trip.id}/places`, { method: 'POST', body: JSON.stringify(body) });
    await loadPlanner(); redraw();
  };
  document.getElementById('mapGo').onclick = () => { const query = document.getElementById('mapSearch').value.trim(); if (query) document.getElementById('mapFrame').src = mapEmbedUrl(query); };
  element.querySelectorAll('[data-map-place]').forEach((button) => button.onclick = () => {
    const place = data.places[Number(button.dataset.mapPlace)];
    if (!place) return;
    const frame = document.getElementById('mapFrame');
    frame.src = mapEmbedUrl(placeQuery(place));
    element.querySelectorAll('.place-row.active').forEach((row) => row.classList.remove('active'));
    button.closest('.place-row')?.classList.add('active');
    const box = frame.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight) frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  element.querySelectorAll('[data-del-place]').forEach((button) => button.onclick = async () => {
    if (requireAccount()) return;
    await api(`/api/planner/${data.trip.id}/places/${button.dataset.delPlace}`, { method: 'DELETE' });
    await loadPlanner(); redraw();
  });
}

function renderBudget(element) {
  const totals = tripTotals();
  const cur = totals.cur;
  const people = ['Você', ...(data.companions || [])];
  const balance = totals.budget - totals.spent;
  const percentage = totals.budget > 0 ? Math.min(100, Math.max(0, totals.spent / totals.budget * 100)) : 0;
  const options = (list, selected) => list.map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${CUR_LABEL[c]}</option>`).join('');
  const split = people.length > 1 ? splitCosts(people, cur) : null;
  const splitHtml = split
    ? `<section class="planner-card pl-panel"><h2>Divisão entre ${people.length} viajantes</h2><p class="split-each">Cada um: <b>${money(split.share, cur)}</b></p><ul class="split-list">${people.map((person) => { const diff = split.paid[person] - split.share; return `<li><div><strong>${esc(person)}</strong><small>pagou ${money(split.paid[person], cur)}</small></div><b class="${diff >= 0 ? 'pos' : 'neg'}">${Math.abs(diff) < 0.005 ? 'em dia' : diff > 0 ? `recebe ${money(diff, cur)}` : `deve ${money(-diff, cur)}`}</b></li>`; }).join('')}</ul>${split.transfers.length ? `<h3 class="split-title">Para acertar</h3><ul class="split-transfers">${split.transfers.map((t) => `<li>${esc(t.from)} paga <b>${money(t.value, cur)}</b> a ${esc(t.to)}</li>`).join('')}</ul>` : '<p class="ov-empty">Tudo certo: ninguém deve nada.</p>'}</section>`
    : '<section class="planner-card pl-panel"><h2>Divisão dos custos</h2><p class="ov-empty">Viaja com mais gente? Informe os nomes em <b>Configurar e compartilhar</b>, no topo, e o Planner divide os gastos e mostra quem deve a quem.</p></section>';
  element.innerHTML = `<div class="pl-toolbar"><div><strong>Moeda de visualização</strong><small>${rates ? `Câmbio do Banco Central Europeu${ratesDate && ratesDate !== 'fixo' ? ` de ${esc(ratesDate.split('-').reverse().join('/'))}` : ''}` : 'Sem câmbio agora: gastos em outras moedas ficam fora da soma'}</small></div><div class="cur-switch" role="group" aria-label="Moeda de visualização">${['EUR', 'BRL'].map((c) => `<button type="button" data-cur="${c}" aria-pressed="${c === cur}">${c === 'EUR' ? '€ Euro' : 'R$ Real'}</button>`).join('')}</div></div>`
    + `<div class="budget-summary"><div class="budget-box" data-tone="voo"><span class="pl-ico">${plIcon('wallet')}</span><small>Orçamento</small><strong>${money(totals.budget, cur)}</strong></div><div class="budget-box expense" data-tone="food"><span class="pl-ico">${plIcon('trend')}</span><small>Gasto</small><strong>${money(totals.spent, cur)}</strong></div><div class="budget-box balance" data-tone="ok"><span class="pl-ico">${plIcon('ok')}</span><small>Saldo</small><strong>${money(balance, cur)}</strong></div></div>`
    + `<div class="budget-grid"><section class="planner-card pl-panel"><h2>Progresso do orçamento</h2><div class="pl-progress-head"><span>${totals.budget > 0 ? `${money(totals.spent, cur)} de ${money(totals.budget, cur)}` : 'Defina quanto quer gastar na viagem'}</span><b>${percentage.toFixed(0)}%</b></div><div class="progress"><span style="width:${percentage}%"></span></div><div class="pl-inline-form"><input class="inline-input" id="budgetValue" type="number" min="0" step="0.01" value="${esc(data.budget)}" aria-label="Valor do orçamento"><select class="inline-input cur-select" id="budgetCurrency" aria-label="Moeda do orçamento">${options(['EUR', 'BRL'], data.budgetCurrency || 'EUR')}</select><button class="btn btn-outline-dark" id="saveBudget">Definir orçamento</button></div></section>`
    + `<section class="planner-card pl-panel"><h2>Gastos por categoria</h2>${totals.byType.length ? `<ul class="ov-bars">${totals.byType.map(([type, value]) => `<li><span>${esc(type)}</span><b>${money(value, cur)}</b><span class="ov-bar"><i style="width:${totals.spent ? ((value / totals.spent) * 100).toFixed(0) : 0}%"></i></span></li>`).join('')}</ul>` : '<p class="ov-empty">As despesas aparecem aqui separadas por categoria.</p>'}</section></div>`
    + splitHtml
    + `<div class="pl-toolbar"><div><strong>${plural(data.expenses.length, 'despesa registrada', 'despesas registradas')}</strong><small>Registre na moeda em que pagou: o Planner converte</small></div><button class="btn btn-gold" id="toggleExpense">+ Despesa</button></div>`
    + `<div class="planner-form pl-form hidden" id="expenseForm"><div class="expense-grid"><label>Valor<input id="eValue" type="number" min="0" step="0.01" placeholder="0,00"></label><label>Moeda<select id="eCurrency">${options(['EUR', 'BRL', 'USD', 'GBP'], cur)}</select></label><label>Categoria<select id="eType"><option>Voos</option><option>Hospedagem</option><option>Alimentação</option><option>Transporte</option><option>Atividades</option><option>Compras</option><option>Outros</option></select></label><label class="ex-wide">Descrição<input id="eDesc" maxlength="500" placeholder="Ex.: Jantar no Bairro Alto"></label>${people.length > 1 ? `<label>Pago por<select id="ePaidBy">${people.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>` : ''}</div><div class="pl-form-actions"><button class="btn btn-gold" id="addExpense">Adicionar despesa</button></div></div>`
    + `<div class="item-list">${data.expenses.map((expense) => { const k = kindIcon(expense.type); const own = expense.currency || 'EUR'; const conv = own === cur ? null : convert(expense.value, own, cur); const who = people.includes(expense.paidBy) ? expense.paidBy : 'Você'; return `<div class="planner-item" data-tone="${k.tone}"><div class="planner-item-main"><span class="pl-ico">${k.svg}</span><div><strong>${money(expense.value, own)}${conv !== null ? ` <span class="conv">≈ ${money(conv, cur)}</span>` : ''}</strong><small>${esc(expense.type)} · ${esc(expense.desc)}${people.length > 1 ? ` · pago por ${esc(who)}` : ''}</small></div></div><button class="delete-item" data-del-exp="${esc(expense.id || '')}">Excluir</button></div>`; }).join('') || '<div class="planner-card"><p class="muted" style="text-align:center;padding:20px">Nenhuma despesa ainda.</p></div>'}</div>`;
  element.querySelectorAll('[data-cur]').forEach((button) => button.onclick = () => { try { localStorage.setItem('rcMoedaViagem', button.dataset.cur); } catch { /* sem armazenamento */ } redraw(); });
  document.getElementById('saveBudget').onclick = async () => {
    if (requireAccount()) return;
    try { await api(`/api/planner/${data.trip.id}/budget`, { method: 'PUT', body: JSON.stringify({ amount: Number(document.getElementById('budgetValue').value) || 0, currency: document.getElementById('budgetCurrency').value }) }); }
    catch (error) { notify(plannerError(error)); return; }
    await loadPlanner(); redraw();
  };
  document.getElementById('toggleExpense').onclick = () => { if (!requireAccount()) document.getElementById('expenseForm').classList.toggle('hidden'); };
  document.getElementById('addExpense').onclick = async () => {
    if (requireAccount()) return;
    const paidBy = document.getElementById('ePaidBy')?.value;
    const body = { amount: Number(document.getElementById('eValue').value), currency: document.getElementById('eCurrency').value, category: document.getElementById('eType').value, description: document.getElementById('eDesc').value.trim(), paidBy: paidBy && paidBy !== 'Você' ? paidBy : undefined };
    if (!body.amount || !body.description) return;
    try { await api(`/api/planner/${data.trip.id}/expenses`, { method: 'POST', body: JSON.stringify(body) }); }
    catch (error) { notify(plannerError(error)); return; }
    await loadPlanner(); redraw();
  };
  element.querySelectorAll('[data-del-exp]').forEach((button) => button.onclick = async () => { if (requireAccount()) return; await api(`/api/planner/${data.trip.id}/expenses/${button.dataset.delExp}`, { method: 'DELETE' }); await loadPlanner(); redraw(); });
}

function renderChecklist(element) {
  const done = data.checklist.filter((item) => item.done).length;
  const percentage = data.checklist.length ? done / data.checklist.length * 100 : 0;
  element.innerHTML = `<section class="planner-card pl-panel pl-check-head"><h2>Preparação da viagem</h2><div class="pl-progress-head"><span>${done} de ${data.checklist.length} concluídos</span><b>${percentage.toFixed(0)}%</b></div><div class="progress"><span style="width:${percentage}%"></span></div></section><div class="checklist-add"><input id="checkInput" placeholder="Adicionar item..."><button class="btn btn-gold" id="addCheck">+</button></div><div>${data.checklist.map((item) => `<div class="check-item ${item.done ? 'done' : ''}"><input type="checkbox" ${item.done ? 'checked' : ''} data-check="${esc(item.id || '')}"><span>${esc(item.text)}</span><button class="delete-item" data-del-check="${esc(item.id || '')}">Excluir</button></div>`).join('')}</div>`;
  document.getElementById('addCheck').onclick = async () => { if (requireAccount()) return; const text = document.getElementById('checkInput').value.trim(); if (!text) return; await api(`/api/planner/${data.trip.id}/checklist`, { method: 'POST', body: JSON.stringify({ text }) }); await loadPlanner(); redraw(); };
  element.querySelectorAll('[data-check]').forEach((input) => input.onchange = async () => { if (requireAccount()) { input.checked = !input.checked; return; } await api(`/api/planner/${data.trip.id}/checklist/${input.dataset.check}`, { method: 'PATCH', body: JSON.stringify({ completed: input.checked }) }); await loadPlanner(); redraw(); });
  element.querySelectorAll('[data-del-check]').forEach((button) => button.onclick = async () => { if (requireAccount()) return; await api(`/api/planner/${data.trip.id}/checklist/${button.dataset.delCheck}`, { method: 'DELETE' }); await loadPlanner(); redraw(); });
}

function addLegacyImportOffer(element) {
  const raw = localStorage.getItem(legacyPlannerKey);
  if (!raw || sessionStorage.getItem('legacyImportDismissed')) return;
  const banner = document.createElement('div');
  banner.className = 'planner-lock';
  banner.innerHTML = '<div><strong>Encontramos dados antigos neste navegador</strong><p>A importação cria uma viagem separada e não substitui nada que já esteja salvo na sua conta.</p></div><button class="btn btn-gold btn-sm">Importar com segurança</button>';
  banner.querySelector('button').onclick = async () => {
    try {
      const legacy = JSON.parse(raw);
      await api('/api/planner/import-local', { method: 'POST', body: JSON.stringify(legacy) });
      sessionStorage.setItem('legacyImportDismissed', '1');
      notify('Importação concluída em uma viagem separada. Os dados antigos continuam neste navegador até você decidir removê-los.');
      await loadPlanner(); await plannerView('overview');
    } catch { notify('Não foi possível importar estes dados. Nada foi apagado.'); }
  };
  element.prepend(banner);
}

function planLabel(plan) {
  const eur = { gratis: 'Teste Free por 10 dias', plus: 'Premium com viagens ilimitadas', personalizado: 'Planejamento personalizado a partir de 49,99 €' };
  return eur[plan] || plan;
}
async function detectCurrency() {
  try { const result = await api('/api/geo'); userCurrency = result.country === 'BR' ? 'BRL' : 'EUR'; }
  catch { userCurrency = 'EUR'; }
  document.querySelectorAll('.plan-price[data-eur]').forEach((element) => {
    const value = userCurrency === 'BRL' ? (element.dataset.brl || element.dataset.eur) : element.dataset.eur;
    const span = element.querySelector('span');
    if (span) { element.childNodes[0].textContent = `${value} `; span.textContent = userCurrency === 'BRL' ? (element.dataset.brlSuffix || '') : (element.dataset.eurSuffix || ''); }
    else element.textContent = value;
  });
}

function bindClientForms() {
  if (document.getElementById('clientApp').dataset.bound) return;
  document.getElementById('clientApp').dataset.bound = '1';
  const tabs = document.querySelectorAll('.client-tab');
  tabs.forEach((tab) => tab.onclick = () => {
    tabs.forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    const register = tab.dataset.clientTab === 'register';
    document.getElementById('clientRegisterForm').classList.toggle('hidden', !register);
    document.getElementById('clientLoginForm').classList.toggle('hidden', register);
    document.getElementById('verifyCodeForm').classList.add('hidden');
  });
  let pendingEmail = '';
  document.getElementById('clientRegisterForm').onsubmit = async (event) => {
    event.preventDefault();
    const password = document.getElementById('registerPassword').value;
    if (password !== document.getElementById('registerPasswordConfirm').value) return notify('As senhas não coincidem.');
    const body = { name: document.getElementById('registerName').value, email: document.getElementById('registerEmail').value, password, termsAccepted: document.getElementById('registerTerms').checked };
    try {
      await api('/api/auth/signup', { method: 'POST', body: JSON.stringify(body) });
      pendingEmail = body.email.trim().toLowerCase();
      document.getElementById('verifyEmailLabel').textContent = pendingEmail;
      document.getElementById('clientRegisterForm').classList.add('hidden');
      document.getElementById('verifyCodeForm').classList.remove('hidden');
    } catch (error) { notify(error.status === 429 ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Confira os dados. A senha precisa ter 12 caracteres, letra maiúscula, minúscula e número.'); }
  };
  document.getElementById('resendCode').onclick = async () => {
    if (!pendingEmail) return;
    notify('Para sua segurança, volte à aba Criar conta e envie o cadastro novamente para solicitar outro código.');
  };
  document.getElementById('verifyCodeForm').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ email: pendingEmail, code: document.getElementById('verifyCodeInput').value.trim() }) });
      await refreshSession();
      await afterAuthentication();
    } catch { notify('Código incorreto ou expirado.'); }
  };
  document.getElementById('clientLoginForm').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('loginEmail').value, password: document.getElementById('loginPassword').value }) });
      await refreshSession();
      await afterAuthentication();
    } catch (error) { notify(error.status === 429 ? 'Muitas tentativas. Aguarde alguns minutos.' : 'E-mail ou senha inválidos.'); }
  };
  document.getElementById('forgotPassword').onclick = async () => {
    const email = window.prompt('Digite o e-mail da sua conta:');
    if (!email) return;
    try { await api('/api/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) }); } catch {}
    notify('Se a conta existir, você receberá as instruções de recuperação.');
  };
  document.getElementById('logoutBtn').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    await clearDeviceData();
    session = null; plannerLocked = true; location.hash = '/cliente'; await router();
  };
}

async function afterAuthentication() {
  const redirect = hashParams().get('redirect');
  const plan = hashParams().get('plan');
  if (plan === 'plus') return startCheckout();
  if (redirect) { location.hash = redirect; await router(); window.scrollTo(0, 0); }
  else showClient();
}
/** Premium pelo WhatsApp (Pix ou cartão): a equipe libera no painel depois do pagamento. */
function premiumWhatsAppUrl() {
  const email = session?.user?.email || '';
  const text = `Olá! Quero assinar o Premium do Planner (9,99 € por 30 dias).${email ? ` Meu e-mail de cadastro é ${email}.` : ''}`;
  return `https://wa.me/351925307391?text=${encodeURIComponent(text)}`;
}
function startCheckout() {
  const url = premiumWhatsAppUrl();
  history.replaceState(null, '', '#/cliente');
  location.href = url;
}
function showClient() {
  if (!session) return;
  const firstName = String(session.user.name || '').trim().split(/\s+/)[0];
  document.getElementById('clientApp').dataset.state = 'logado';
  document.getElementById('clientTitle').textContent = firstName ? `Olá, ${firstName}` : 'O seu espaço Rota Certa';
  document.getElementById('planContext').textContent = 'O seu planejamento, reservas e anexos em um só lugar.';
  document.querySelector('.client-grid').classList.add('hidden');
  document.getElementById('clientDashboard').classList.remove('hidden');
  document.getElementById('masterPanelLink')?.classList.toggle('hidden', !session.user.roles?.includes('master'));
}
async function clientInit() {
  bindClientForms();
  const plan = hashParams().get('plan');
  document.getElementById('planContext').textContent = plan ? `Acesse sua conta para continuar: ${planLabel(plan)}.` : 'Acesse o seu planejamento e mantenha os dados da viagem em um só lugar.';
  document.querySelector('.client-grid').classList.toggle('hidden', Boolean(session));
  document.getElementById('clientDashboard').classList.toggle('hidden', !session);
  document.getElementById('clientApp').dataset.state = 'entrar';
  document.getElementById('clientTitle').textContent = 'O seu espaço Rota Certa';
  if (session && plan === 'plus') { startCheckout(); return; }
  if (session) showClient();
  if (localStorage.getItem('rotaCertaClient')) document.getElementById('clientNote').textContent += ' Uma conta antiga deste navegador foi detectada; a senha local não será enviada nem migrada.';
}

function quoteInit() {
  const form = document.getElementById('quoteForm');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  const status = document.getElementById('quoteStatus');
  const returnInput = document.getElementById('volta');
  form.querySelectorAll('input[name=tipo]').forEach((radio) => radio.addEventListener('change', () => {
    const roundTrip = form.querySelector('input[name=tipo]:checked')?.value === 'Ida e volta';
    returnInput.required = roundTrip;
    returnInput.disabled = !roundTrip;
    if (!roundTrip) returnInput.value = '';
  }));
  returnInput.required = true;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    const payload = {
      name: document.getElementById('quoteName').value,
      email: document.getElementById('quoteEmail').value,
      phone: document.getElementById('quotePhone').value,
      type: 'quote', origem: document.getElementById('origem').value, destino: document.getElementById('destino').value,
      ida: document.getElementById('ida').value, volta: document.getElementById('volta').value,
      adults: Number(document.getElementById('adults').value),
      children: Number(document.getElementById('children').value),
      infants: Number(document.getElementById('infants').value),
      tipo: form.querySelector('input[name=tipo]:checked')?.value || 'Ida e volta',
      cabinClass: document.getElementById('cabinClass').value,
      baggage: document.getElementById('baggage').value,
      flexibility: document.getElementById('flexibility').value,
      paymentPreference: document.getElementById('paymentPreference').value,
      observacoes: document.getElementById('observacoes').value,
      contactConsent: document.getElementById('contactConsent').checked,
    };
    button.disabled = true;
    status.textContent = 'Registrando sua solicitação com segurança...';
    try {
      const result = await api('/api/lead', { method: 'POST', body: JSON.stringify(payload) });
      status.textContent = result.confirmationEmailSent
        ? `Solicitação recebida. Protocolo ${result.protocol}. Enviamos a confirmação para seu e-mail e responderemos em até 48 horas.`
        : `Solicitação recebida e salva. Anote o protocolo ${result.protocol}. O e-mail de confirmação não pôde ser enviado agora, mas nossa equipe responderá em até 48 horas.`;
      form.reset();
      returnInput.required = true;
      returnInput.disabled = false;
    } catch (error) {
      status.textContent = error.status === 429 ? 'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.' : 'Não foi possível registrar o pedido agora. Revise os dados e tente novamente.';
    } finally {
      button.disabled = false;
    }
  });
}

async function router() {
  const parts = route();
  const isPlanner = parts[0] === 'planner';
  const isClient = parts[0] === 'cliente';
  setHomeMode(!isPlanner && !isClient);
  if (isPlanner) {
    try { await loadPlanner(); await plannerView(parts[1] === 'visao-geral' ? 'overview' : (parts[1] || 'overview')); }
    catch (error) {
      if (error.status === 402 && error.body?.error === 'free_trial_expired') document.getElementById('plannerContent').innerHTML = '<div class="planner-lock"><div><strong>Seu teste gratuito terminou, mas nada se perdeu</strong><p>Suas viagens continuam guardadas. Assine o Premium por 9,99 € (30 dias) e leve roteiro, reservas e bilhetes no celular, até sem internet. Pagamento por Pix ou cartão, pelo WhatsApp.</p></div><a class="btn btn-gold" target="_blank" rel="noopener" href="' + premiumWhatsAppUrl() + '">Assinar pelo WhatsApp</a></div>';
      else notify('Não foi possível carregar o Planner agora.');
    }
  }
  if (isClient) await clientInit();
  if (!isPlanner && !isClient) quoteInit();
}

window.addEventListener('hashchange', () => void router());
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#/planner"],a[href^="#/cliente"]');
  if (link && !link.target) { event.preventDefault(); location.hash = link.getAttribute('href').slice(1); void router(); window.scrollTo(0, 0); }
});

await refreshSession();
await detectCurrency();
await router();

// --- App Rota Certa (PWA): instalar na tela do celular e funcionar sem internet ---------------------
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
let installPrompt = null;
function showInstallButtons(show) { document.querySelectorAll('[data-install-app]').forEach((element) => { element.hidden = !show; }); }
if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; showInstallButtons(true); });
window.addEventListener('appinstalled', () => { installPrompt = null; showInstallButtons(false); });
if (isIos && !isStandalone()) showInstallButtons(true);
document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-install-app]');
  if (!trigger) return;
  event.preventDefault();
  if (installPrompt) {
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    if (choice?.outcome === 'accepted') showInstallButtons(false);
    return;
  }
  notify(isIos
    ? 'Para instalar no iPhone: no Safari, toque em Compartilhar (o quadrado com a seta para cima) e depois em "Adicionar à Tela de Início".'
    : 'Para instalar: abra o menu do navegador e escolha "Instalar app" ou "Adicionar à tela inicial".');
});
function updateOnlineBanner() {
  let banner = document.getElementById('offlineBanner');
  if (navigator.onLine) { banner?.remove(); return; }
  if (banner) return;
  banner = document.createElement('div');
  banner.id = 'offlineBanner';
  banner.className = 'rc-offline';
  banner.setAttribute('role', 'status');
  banner.textContent = 'Você está sem internet. Mostrando a última versão salva da sua viagem; para editar, conecte-se de novo.';
  document.body.append(banner);
}
window.addEventListener('online', updateOnlineBanner);
window.addEventListener('offline', updateOnlineBanner);
updateOnlineBanner();
/** Guarda no aparelho os bilhetes e vouchers da viagem aberta, para abrir sem internet. */
async function cacheAttachments() {
  if (!('caches' in window) || !session || !data?.trip?.id || !navigator.onLine) return;
  try {
    const cache = await caches.open('rc-anexos');
    for (const file of data.attachments || []) {
      const url = `/api/planner/${data.trip.id}/attachments/${file.id}`;
      if (!(await cache.match(url))) await cache.add(url).catch(() => {});
    }
  } catch { /* sem espaço ou navegador sem suporte: segue normal */ }
}
async function clearDeviceData() {
  if (!('caches' in window)) return;
  await Promise.all(['rc-dados', 'rc-anexos'].map((name) => caches.delete(name).catch(() => false)));
}
