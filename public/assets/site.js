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
let data = starterData;
let plannerLocked = true;
let userCurrency = 'EUR';

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}
function money(value) {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);
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
  document.querySelectorAll('body>section,body>header,body>footer,body>.wa-float').forEach((element) => {
    if (!element.matches('#plannerApp,#clientApp')) element.style.display = isHome ? '' : 'none';
  });
  const planner = document.getElementById('plannerApp');
  const client = document.getElementById('clientApp');
  planner.classList.toggle('active', !isHome && route()[0] === 'planner');
  client.classList.toggle('active', !isHome && route()[0] === 'cliente');
}

async function loadPlanner() {
  if (!session) {
    const legacy = localStorage.getItem(legacyPlannerKey);
    try { data = legacy ? { ...starterData, ...JSON.parse(legacy), trip: starterData.trip } : structuredClone(starterData); }
    catch { data = structuredClone(starterData); }
    return;
  }
  const payload = await api('/api/planner');
  data = {
    trip: payload.trip,
    itinerary: payload.itinerary.map((item) => ({ id: item.id, day: item.day, time: item.time || '', what: item.title, type: item.kind, notes: item.notes || '' })),
    places: payload.places.map((item) => ({ id: item.id, name: item.name, type: item.category, address: item.address || '', notes: item.notes || '' })),
    expenses: payload.expenses.map((item) => ({ id: item.id, value: item.amount_cents / 100, type: item.category, desc: item.description })),
    checklist: payload.checklist.map((item) => ({ id: item.id, text: item.text, done: item.completed })),
    budget: payload.budget.amount_cents / 100,
  };
}

function requireAccount() {
  if (!plannerLocked) return false;
  location.hash = `/cliente?plan=gratis&redirect=${encodeURIComponent(currentPath())}`;
  void router();
  window.scrollTo(0, 0);
  return true;
}

async function plannerView(key) {
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
  document.querySelectorAll('.planner-sidebar a').forEach((link) => link.classList.toggle('active', link.dataset.route === key || (key === 'overview' && link.dataset.route === 'planner')));
  if (key === 'overview') renderOverview(content);
  if (key === 'itinerario') renderItinerary(content);
  if (key === 'lugares') renderPlaces(content);
  if (key === 'orcamento') renderBudget(content);
  if (key === 'checklist') renderChecklist(content);
  if (plannerLocked) content.insertAdjacentHTML('afterbegin', `<div class="planner-lock"><div><strong>🔒 Demonstração sem gravação</strong><p>Você pode conhecer todas as áreas. Para salvar informações com segurança, crie uma conta.</p></div><a class="btn btn-gold btn-sm" href="#/cliente?plan=gratis&redirect=${encodeURIComponent(currentPath())}">Criar conta</a></div>`);
  else addLegacyImportOffer(content);
}

function renderOverview(element) {
  element.innerHTML = `<div class="overview-grid"><a class="overview-card" href="#/planner/itinerario"><div class="icon">📅</div><h3>Itinerário</h3><p>${data.itinerary.length} atividades planejadas</p><strong>Organizar roteiro →</strong></a><a class="overview-card" href="#/planner/lugares"><div class="icon">📍</div><h3>Lugares</h3><p>${data.places.length} lugares salvos</p><strong>Ver mapa →</strong></a><a class="overview-card" href="#/planner/orcamento"><div class="icon">€</div><h3>Orçamento</h3><p>${money(data.expenses.reduce((sum, item) => sum + Number(item.value || 0), 0))} gastos</p><strong>Controlar despesas →</strong></a><a class="overview-card" href="#/planner/checklist"><div class="icon">✓</div><h3>Checklist</h3><p>${data.checklist.filter((item) => item.done).length} de ${data.checklist.length} concluídos</p><strong>Preparar viagem →</strong></a></div>`;
}

function renderItinerary(element) {
  element.innerHTML = `<div class="planner-toolbar"><div><strong>${data.itinerary.length} atividades planejadas</strong></div><button class="btn btn-gold" id="toggleItinerary">+ Adicionar</button></div><div class="planner-form hidden" id="itineraryForm"><div class="planner-form-grid"><input id="iDay" type="number" min="1" placeholder="Dia" value="1"><input id="iTime" type="time"><input id="iWhat" placeholder="O que você vai fazer?"><select id="iType"><option>Atividade</option><option>Restaurante</option><option>Hospedagem</option><option>Transporte</option><option>Voo</option><option>Outro</option></select><textarea id="iNotes" placeholder="Notas (opcional)"></textarea></div><button class="btn btn-gold" id="addItinerary">Adicionar ao itinerário</button></div><div class="item-list">${data.itinerary.length ? data.itinerary.map((item) => `<div class="planner-item"><div class="planner-item-main"><span class="planner-item-badge">Dia ${esc(item.day)} · ${esc(item.time || '--:--')}</span><div><strong>${esc(item.what)}</strong><small>${esc(item.type)}${item.notes ? ` · ${esc(item.notes)}` : ''}</small></div></div><button class="delete-item" data-del-it="${esc(item.id || '')}">Excluir</button></div>`).join('') : '<div class="planner-card"><p class="muted" style="text-align:center;padding:30px">📅<br><br>Seu itinerário está vazio.</p></div>'}</div>`;
  document.getElementById('toggleItinerary').onclick = () => { if (!requireAccount()) document.getElementById('itineraryForm').classList.toggle('hidden'); };
  document.getElementById('addItinerary').onclick = async () => {
    if (requireAccount()) return;
    const body = { day: Number(document.getElementById('iDay').value || 1), time: document.getElementById('iTime').value || undefined, title: document.getElementById('iWhat').value, kind: document.getElementById('iType').value, notes: document.getElementById('iNotes').value || undefined };
    if (!body.title) return;
    await api(`/api/planner/${data.trip.id}/itinerary`, { method: 'POST', body: JSON.stringify(body) });
    await loadPlanner(); renderItinerary(element);
  };
  element.querySelectorAll('[data-del-it]').forEach((button) => button.onclick = async () => {
    if (requireAccount()) return;
    await api(`/api/planner/${data.trip.id}/itinerary/${button.dataset.delIt}`, { method: 'DELETE' });
    await loadPlanner(); renderItinerary(element);
  });
}

function renderPlaces(element) {
  const defaultMap = 'https://www.google.com/maps?q=Lisboa%2C%20Portugal&output=embed';
  element.innerHTML = `<div class="places-grid"><div><div class="planner-toolbar"><strong>${data.places.length} lugares salvos</strong><button class="btn btn-gold" id="togglePlace">+ Adicionar</button></div><div class="planner-form hidden" id="placeForm"><div class="place-form-grid"><input class="full" id="pName" placeholder="Nome do lugar"><select id="pType"><option>Atrações</option><option>Restaurantes</option><option>Hospedagem</option><option>Transportes</option><option>Outro</option></select><input id="pAddress" placeholder="Endereço (opcional)"><textarea class="full" id="pNotes" placeholder="Notas (opcional)"></textarea></div><button class="btn btn-gold" id="addPlace">Adicionar lugar</button></div><div class="place-list">${data.places.length ? data.places.map((place) => `<div class="place-row"><div><strong>${esc(place.name)}</strong><small>${esc(place.type)}${place.address ? ` · ${esc(place.address)}` : ''}</small></div><button class="delete-item" data-del-place="${esc(place.id || '')}">Excluir</button></div>`).join('') : '<div class="planner-card"><p class="muted">Nenhum lugar salvo ainda.</p></div>'}</div></div><div><div class="planner-card"><h2>Mapa da viagem</h2><p class="muted">Pesquise um endereço para abrir no mapa.</p><div style="display:flex;gap:8px;margin:14px 0"><input class="inline-input" id="mapSearch" placeholder="Lisboa, Porto, Paris..."><button class="btn btn-outline-dark" id="mapGo">Ver no mapa</button></div><iframe id="mapFrame" class="map-frame" src="${defaultMap}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Google Maps"></iframe></div></div></div>`;
  document.getElementById('togglePlace').onclick = () => { if (!requireAccount()) document.getElementById('placeForm').classList.toggle('hidden'); };
  document.getElementById('addPlace').onclick = async () => {
    if (requireAccount()) return;
    const body = { name: document.getElementById('pName').value, category: document.getElementById('pType').value, address: document.getElementById('pAddress').value || undefined, notes: document.getElementById('pNotes').value || undefined };
    if (!body.name) return;
    await api(`/api/planner/${data.trip.id}/places`, { method: 'POST', body: JSON.stringify(body) });
    await loadPlanner(); renderPlaces(element);
  };
  document.getElementById('mapGo').onclick = () => { const query = document.getElementById('mapSearch').value.trim(); if (query) document.getElementById('mapFrame').src = `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`; };
  element.querySelectorAll('[data-del-place]').forEach((button) => button.onclick = async () => {
    if (requireAccount()) return;
    await api(`/api/planner/${data.trip.id}/places/${button.dataset.delPlace}`, { method: 'DELETE' });
    await loadPlanner(); renderPlaces(element);
  });
}

function renderBudget(element) {
  const spent = data.expenses.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const balance = Number(data.budget || 0) - spent;
  const percentage = Math.min(100, Math.max(0, spent / (Number(data.budget) || 1) * 100));
  element.innerHTML = `<div class="budget-summary"><div class="budget-box"><small>Orçamento</small><strong>${money(data.budget)}</strong></div><div class="budget-box expense"><small>Gasto</small><strong>${money(spent)}</strong></div><div class="budget-box balance"><small>Saldo</small><strong>${money(balance)}</strong></div></div><div class="planner-card"><div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:8px"><span>Progresso do orçamento</span><span>${percentage.toFixed(0)}%</span></div><div class="progress"><span style="width:${percentage}%"></span></div><div style="display:flex;gap:10px;margin-top:20px"><input class="inline-input" id="budgetValue" type="number" min="0" step="0.01" value="${esc(data.budget)}"><button class="btn btn-outline-dark" id="saveBudget">Definir orçamento</button></div></div><div class="planner-toolbar"><strong>${data.expenses.length} despesas registradas</strong><button class="btn btn-gold" id="toggleExpense">+ Despesa</button></div><div class="planner-form hidden" id="expenseForm"><div class="planner-form-grid"><input id="eValue" type="number" min="0" step="0.01" placeholder="Valor (€)"><select id="eType"><option>Voos</option><option>Hospedagem</option><option>Alimentação</option><option>Transporte</option><option>Atividades</option><option>Compras</option><option>Outros</option></select><input id="eDesc" placeholder="Descrição"><button class="btn btn-gold" id="addExpense">Adicionar despesa</button></div></div><div class="item-list">${data.expenses.map((expense) => `<div class="planner-item"><div><strong>${money(expense.value)}</strong><small>${esc(expense.type)} · ${esc(expense.desc)}</small></div><button class="delete-item" data-del-exp="${esc(expense.id || '')}">Excluir</button></div>`).join('') || '<div class="planner-card"><p class="muted" style="text-align:center;padding:20px">Nenhuma despesa ainda.</p></div>'}</div>`;
  document.getElementById('saveBudget').onclick = async () => { if (requireAccount()) return; await api(`/api/planner/${data.trip.id}/budget`, { method: 'PUT', body: JSON.stringify({ amount: Number(document.getElementById('budgetValue').value) || 0 }) }); await loadPlanner(); renderBudget(element); };
  document.getElementById('toggleExpense').onclick = () => { if (!requireAccount()) document.getElementById('expenseForm').classList.toggle('hidden'); };
  document.getElementById('addExpense').onclick = async () => {
    if (requireAccount()) return;
    const body = { amount: Number(document.getElementById('eValue').value), category: document.getElementById('eType').value, description: document.getElementById('eDesc').value };
    if (!body.amount || !body.description) return;
    await api(`/api/planner/${data.trip.id}/expenses`, { method: 'POST', body: JSON.stringify(body) });
    await loadPlanner(); renderBudget(element);
  };
  element.querySelectorAll('[data-del-exp]').forEach((button) => button.onclick = async () => { if (requireAccount()) return; await api(`/api/planner/${data.trip.id}/expenses/${button.dataset.delExp}`, { method: 'DELETE' }); await loadPlanner(); renderBudget(element); });
}

function renderChecklist(element) {
  const done = data.checklist.filter((item) => item.done).length;
  const percentage = data.checklist.length ? done / data.checklist.length * 100 : 0;
  element.innerHTML = `<div class="planner-card"><div style="display:flex;justify-content:space-between;margin-bottom:8px"><strong>${done} de ${data.checklist.length} concluídos</strong><span>${percentage.toFixed(0)}%</span></div><div class="progress"><span style="width:${percentage}%"></span></div></div><div class="checklist-add"><input id="checkInput" placeholder="Adicionar item..."><button class="btn btn-gold" id="addCheck">+</button></div><div>${data.checklist.map((item) => `<div class="check-item ${item.done ? 'done' : ''}"><input type="checkbox" ${item.done ? 'checked' : ''} data-check="${esc(item.id || '')}"><span>${esc(item.text)}</span><button class="delete-item" data-del-check="${esc(item.id || '')}">Excluir</button></div>`).join('')}</div>`;
  document.getElementById('addCheck').onclick = async () => { if (requireAccount()) return; const text = document.getElementById('checkInput').value.trim(); if (!text) return; await api(`/api/planner/${data.trip.id}/checklist`, { method: 'POST', body: JSON.stringify({ text }) }); await loadPlanner(); renderChecklist(element); };
  element.querySelectorAll('[data-check]').forEach((input) => input.onchange = async () => { if (requireAccount()) { input.checked = !input.checked; return; } await api(`/api/planner/${data.trip.id}/checklist/${input.dataset.check}`, { method: 'PATCH', body: JSON.stringify({ completed: input.checked }) }); await loadPlanner(); renderChecklist(element); });
  element.querySelectorAll('[data-del-check]').forEach((button) => button.onclick = async () => { if (requireAccount()) return; await api(`/api/planner/${data.trip.id}/checklist/${button.dataset.delCheck}`, { method: 'DELETE' }); await loadPlanner(); renderChecklist(element); });
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
  const eur = { gratis: 'Planner grátis por 10 dias', plus: 'Planner 9,99 € por 30 dias', personalizado: 'Planejamento personalizado a partir de 49,99 €' };
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
async function startCheckout() {
  try {
    const result = await api('/api/payments/checkout', { method: 'POST', body: JSON.stringify({ planCode: 'planner-30d' }) });
    location.assign(result.url);
  } catch { notify('O checkout sandbox ainda não está configurado. Nenhuma cobrança foi feita.'); showClient(); }
}
function showClient() {
  if (!session) return;
  document.getElementById('clientName').textContent = session.user.name || 'Cliente Rota Certa';
  document.querySelector('.client-grid').classList.add('hidden');
  document.getElementById('clientDashboard').classList.remove('hidden');
}
async function clientInit() {
  bindClientForms();
  const plan = hashParams().get('plan');
  document.getElementById('planContext').textContent = plan ? `Acesse sua conta para continuar: ${planLabel(plan)}.` : 'Acesse o seu planejamento e mantenha os dados da viagem em um só lugar.';
  document.querySelector('.client-grid').classList.toggle('hidden', Boolean(session));
  document.getElementById('clientDashboard').classList.toggle('hidden', !session);
  if (session) showClient();
  if (localStorage.getItem('rotaCertaClient')) document.getElementById('clientNote').textContent += ' Uma conta antiga deste navegador foi detectada; a senha local não será enviada nem migrada.';
}

function quoteInit() {
  const form = document.getElementById('quoteForm');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      type: 'quote', origem: document.getElementById('origem').value, destino: document.getElementById('destino').value,
      ida: document.getElementById('ida').value, volta: document.getElementById('volta').value,
      passageiros: document.getElementById('passageiros').value,
      tipo: form.querySelector('input[name=tipo]:checked')?.value || 'Individual',
      observacoes: document.getElementById('observacoes').value,
      observacoesCurtas: document.getElementById('observacoesShort')?.value || '',
    };
    try { await api('/api/lead', { method: 'POST', body: JSON.stringify(payload) }); }
    catch { return notify('Não foi possível registrar o pedido agora. Tente novamente mais tarde.'); }
    const message = `Olá! Gostaria de uma proposta de voo:%0A${encodeURIComponent(payload.origem)} → ${encodeURIComponent(payload.destino)}%0AIda: ${payload.ida || '-'} | Volta: ${payload.volta || '-'}%0APassageiros: ${encodeURIComponent(payload.passageiros)}%0ATipo de viagem: ${encodeURIComponent(payload.tipo)}${payload.observacoes ? `%0AObservações: ${encodeURIComponent(payload.observacoes)}` : ''}`;
    window.open(`https://wa.me/351925307391?text=${message}`, '_blank', 'noopener');
    form.reset();
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
      if (error.status === 402) document.getElementById('plannerContent').innerHTML = '<div class="planner-lock"><div><strong>Seu acesso terminou</strong><p>Suas viagens continuam salvas. Ative mais 30 dias para continuar.</p></div><a class="btn btn-gold" href="#/cliente?plan=plus">Continuar por 9,99 €</a></div>';
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
