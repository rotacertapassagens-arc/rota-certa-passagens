// Página do orçamento: formulário, prévia A4 igual ao modelo do recibo, salvar e imprimir / salvar PDF para mandar no WhatsApp.
import { api, esc, financeErrorMessage, money, toCents, centsToInput, fmtDay, today } from './fin-ui.js';

const $ = (id) => document.getElementById(id);
let quoteId = new URLSearchParams(location.search).get('id') || '';
const DEFAULT_CONDITIONS = 'Valores e disponibilidade sujeitos a alteração até a emissão do bilhete. Alterações, cancelamentos e reembolsos seguem as regras da tarifa.';

const model = {
  number: '', issuedOn: today(), validUntil: '', status: 'draft', customerName: '', customerContact: '', baggage: '', segments: [], note: '',
  lines: [], currency: 'EUR', altCurrency: '', altAmount: '', paymentTerms: '', conditions: '',
};
let dirty = false;

const emptySegment = () => ({ date: '', flight: '', airline: '', from: '', fromCity: '', depart: '', to: '', toCity: '', arrive: '', plusDay: 0, cls: '' });
const emptyLine = () => ({ title: '', subtitle: '', kind: 'pax', qty: '1', unit: '' });
const addDays = (iso, days) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

function status(message, isError = false) {
  const element = $('qtStatus');
  element.textContent = message;
  element.className = `status no-print${message ? (isError ? ' alert-error' : ' alert-success') : ''}`;
}

async function boot() {
  try {
    const session = await api('/api/auth/session');
    if (!session.user.roles.includes('master')) throw Object.assign(new Error('forbidden'), { status: 403 });
    if (quoteId) {
      const { quote } = await api(`/api/admin/finance/quotes/${quoteId}`);
      fillFromSaved(quote);
    } else {
      // Orçamento novo: validade padrão de 3 dias e uma linha de adulto pronta.
      model.validUntil = addDays(model.issuedOn, 3);
      model.segments = [emptySegment()];
      model.lines = [{ ...emptyLine(), title: 'Passageiro adulto' }];
    }
    $('accessMessage').classList.add('hidden');
    $('rcContent').classList.remove('hidden');
    init();
  } catch (error) {
    $('accessMessage').querySelector('p').textContent = error.status === 404 ? 'Orçamento não encontrado. Volte e abra pela lista de orçamentos.' : financeErrorMessage(error, 'Entre primeiro pela Área do cliente com uma conta master.');
    throw error;
  }
}

function fillFromSaved(quote) {
  const d = quote.data || {};
  Object.assign(model, {
    number: quote.number, issuedOn: quote.issuedOn, validUntil: quote.validUntil || '', status: quote.status,
    customerName: d.customerName || '', customerContact: d.customerContact || '', baggage: d.baggage || '',
    segments: (d.segments || []).map((s) => ({ ...emptySegment(), ...s })), note: d.note || '', currency: d.currency || 'EUR',
    lines: (d.lines || []).map((l) => ({ title: l.title, subtitle: l.subtitle || '', kind: l.kind === 'extra' ? 'extra' : 'pax', qty: String(l.qty), unit: centsToInput(l.unitCents) })),
    altCurrency: d.altCurrency || '', altAmount: centsToInput(d.altAmountCents), paymentTerms: d.paymentTerms || '', conditions: d.conditions || '',
  });
}

// --- formulário -------------------------------------------------------------------------------------------------
function init() {
  updateTitle();
  document.querySelectorAll('[data-f]').forEach((input) => {
    input.value = model[input.dataset.f] ?? '';
    input.addEventListener('input', () => { model[input.dataset.f] = input.value; markDirty(); if (input.dataset.f === 'currency') buildRows(); renderPreview(); });
  });
  buildRows();
  $('qtAddSegment').addEventListener('click', () => { model.segments.push(emptySegment()); buildRows(); markDirty(); renderPreview(); });
  $('qtAddLine').addEventListener('click', () => { model.lines.push(emptyLine()); buildRows(); markDirty(); renderPreview(); });
  $('qtSave').addEventListener('click', save);
  $('qtPrint').addEventListener('click', () => { renderPreview(); window.print(); });
  window.addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault(); });
  window.addEventListener('resize', fit);
  renderPreview();
}
const markDirty = () => { dirty = true; };
function updateTitle() {
  $('qtTitle').textContent = model.number ? `Orçamento ${model.number}` : 'Novo orçamento';
  $('qtSub').textContent = model.number ? '' : 'Será numerado ao salvar.';
}

function buildRows() {
  $('qtSegments').innerHTML = model.segments.map((s, i) => `<div class="rc-row">
    <button type="button" class="ghost rc-remove" data-remove-seg="${i}">Remover</button>
    <div class="rc-row-grid">
      <label>Data<input type="date" data-seg="${i}:date" value="${esc(s.date)}"></label>
      <label>Voo<input data-seg="${i}:flight" maxlength="12" value="${esc(s.flight)}" placeholder="AF7345"></label>
      <label>Companhia<input data-seg="${i}:airline" maxlength="40" value="${esc(s.airline)}" placeholder="Air France"></label>
      <label>De (sigla)<input data-seg="${i}:from" maxlength="4" value="${esc(s.from)}" placeholder="LIS"></label>
      <label>Cidade de partida<input data-seg="${i}:fromCity" maxlength="60" value="${esc(s.fromCity)}" placeholder="Lisboa"></label>
      <label>Hora de partida<input type="time" data-seg="${i}:depart" value="${esc(s.depart)}"></label>
      <label>Para (sigla)<input data-seg="${i}:to" maxlength="4" value="${esc(s.to)}" placeholder="MCZ"></label>
      <label>Cidade de chegada<input data-seg="${i}:toCity" maxlength="60" value="${esc(s.toCity)}" placeholder="Maceió"></label>
      <label>Hora de chegada<input type="time" data-seg="${i}:arrive" value="${esc(s.arrive)}"></label>
      <label>Chega no dia seguinte<select data-seg="${i}:plusDay"><option value="0"${!s.plusDay ? ' selected' : ''}>Não</option><option value="1"${s.plusDay === 1 ? ' selected' : ''}>+1 dia</option><option value="2"${s.plusDay === 2 ? ' selected' : ''}>+2 dias</option></select></label>
      <label>Classe / cabine<input data-seg="${i}:cls" maxlength="24" value="${esc(s.cls)}" placeholder="Econômica"></label>
    </div></div>`).join('');
  $('qtLines').innerHTML = model.lines.map((l, i) => `<div class="rc-row">
    <button type="button" class="ghost rc-remove" data-remove-line="${i}">Remover</button>
    <div class="rc-two"><label>Descrição<input data-line="${i}:title" maxlength="160" value="${esc(l.title)}" placeholder="Passageiro adulto"></label>
    <label>Tipo<select data-line="${i}:kind"><option value="pax"${l.kind !== 'extra' ? ' selected' : ''}>Passageiro</option><option value="extra"${l.kind === 'extra' ? ' selected' : ''}>Extra (taxa, bagagem, seguro)</option></select></label></div>
    <label>Detalhe (opcional)<input data-line="${i}:subtitle" maxlength="200" value="${esc(l.subtitle)}" placeholder="Ex.: tarifa com bagagem de mão"></label>
    <div class="rc-row-qty"><label>Qtd<input data-line="${i}:qty" inputmode="numeric" maxlength="2" value="${esc(l.qty)}"></label>
    <label>Valor por passageiro (${esc(model.currency)})<input data-line="${i}:unit" inputmode="decimal" value="${esc(l.unit)}" placeholder="0,00"></label></div></div>`).join('');
  document.querySelectorAll('[data-seg]').forEach((input) => input.addEventListener('input', () => {
    const [index, field] = input.dataset.seg.split(':');
    model.segments[Number(index)][field] = field === 'plusDay' ? Number(input.value) : input.value;
    markDirty(); renderPreview();
  }));
  document.querySelectorAll('[data-line]').forEach((input) => input.addEventListener('input', () => {
    const [index, field] = input.dataset.line.split(':');
    model.lines[Number(index)][field] = input.value;
    markDirty(); renderPreview();
  }));
  document.querySelectorAll('[data-remove-seg]').forEach((button) => button.addEventListener('click', () => { model.segments.splice(Number(button.dataset.removeSeg), 1); buildRows(); markDirty(); renderPreview(); }));
  document.querySelectorAll('[data-remove-line]').forEach((button) => button.addEventListener('click', () => { model.lines.splice(Number(button.dataset.removeLine), 1); buildRows(); markDirty(); renderPreview(); }));
}

// --- prévia -----------------------------------------------------------------------------------------------------
const qtyOf = (line) => { const n = Number(line.qty); return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 0; };
const unitOf = (line) => { const cents = line.unit ? toCents(line.unit) : 0; return cents === null || cents < 0 ? 0 : cents; };
const subtotal = (line) => qtyOf(line) * unitOf(line);

function renderPreview() {
  const lines = model.lines.filter((line) => line.title.trim());
  const total = lines.reduce((sum, line) => sum + subtotal(line), 0);
  const altCents = model.altCurrency && model.altAmount ? toCents(model.altAmount) : null;
  const cur = model.currency;
  const baggage = model.baggage.trim().split('\n').filter(Boolean);
  const segments = model.segments.filter((s) => s.flight || s.from || s.to);
  const passengers = lines.filter((line) => line.kind !== 'extra').reduce((sum, line) => sum + qtyOf(line), 0);

  $('orcamento').innerHTML = `
    <div class="rc-head">
      <div class="rc-brand"><img src="/assets/logo-simbolo-claro.png" alt="">
        <div><h1>ROTA CERTA</h1><span class="sub">PASSAGENS</span>
          <p>Instagram <b>@rotacerta.passagens</b></p><p>WhatsApp <b>+351 925 307 391</b></p><p><b>rotacertapassagens.com</b></p></div></div>
      <div class="rc-head-right"><span class="tag-label">ORÇAMENTO</span><span class="number">Nº ${esc(model.number || 'a definir')}</span><span class="date">Emitido em ${esc(fmtDay(model.issuedOn))}</span></div>
    </div>
    <div class="rc-body">
      <div class="rc-title"><h2>Orçamento de passagem aérea</h2><span>${model.validUntil ? `Válido até ${esc(fmtDay(model.validUntil))}` : 'Sujeito a disponibilidade'}</span></div>
      <div class="rc-cards">
        <section class="rc-card"><h4>Cliente</h4><dl class="rc-kv">
          <dt>Nome</dt><dd>${esc(model.customerName || '-')}</dd>
          ${model.customerContact.trim() ? `<dt>Contato</dt><dd>${esc(model.customerContact)}</dd>` : ''}</dl></section>
        <section class="rc-card"><h4>Viagem</h4><dl class="rc-kv">
          <dt>Passageiros</dt><dd>${passengers || '-'}</dd>
          ${baggage.length ? `<dt>Bagagem</dt><dd>${baggage.map((line) => `<span style="display:block">${esc(line)}</span>`).join('')}</dd>` : ''}</dl></section>
      </div>
      ${segments.length ? `<div class="rc-label">Itinerário</div><table class="rc-table"><thead><tr><th>Data</th><th>Voo</th><th>Partida</th><th></th><th>Chegada</th><th>Classe</th></tr></thead><tbody>
        ${segments.map((s) => `<tr><td>${esc(fmtDay(s.date))}</td><td><b>${esc(s.flight)}</b><small>${esc(s.airline)}</small></td>
          <td><b>${esc(s.from)}</b> ${esc(s.depart)}<small>${esc(s.fromCity)}</small></td><td class="arrow">→</td>
          <td><b>${esc(s.to)}</b> ${esc(s.arrive)}${s.plusDay ? ` <small style="display:inline">(+${s.plusDay})</small>` : ''}<small>${esc(s.toCity)}</small></td><td>${esc(s.cls)}</td></tr>`).join('')}</tbody></table>
        ${model.note.trim() ? `<p class="rc-note">${esc(model.note)}</p>` : ''}` : ''}
      <div class="rc-values"><div class="rc-label">Preço por passageiro</div>
        ${lines.length ? `<table class="qt-table"><thead><tr><th>Descrição</th><th class="num">Qtd</th><th class="num">Valor unitário</th><th class="num">Subtotal</th></tr></thead><tbody>
          ${lines.map((line) => `<tr><td>${esc(line.title)}${line.subtitle.trim() ? `<small>${esc(line.subtitle)}</small>` : ''}</td><td class="num">${qtyOf(line)}</td><td class="num">${esc(money(unitOf(line), cur))}</td><td class="num"><b>${esc(money(subtotal(line), cur))}</b></td></tr>`).join('')}</tbody></table>` : '<div class="rc-value-row"><div>Adicione ao menos uma linha de valor.</div></div>'}
      </div>
      <div class="rc-total"><div><span class="label">Total do orçamento</span><span class="words">${passengers ? `${passengers} passageiro${passengers === 1 ? '' : 's'}` : ''}</span></div>
        <div class="amount">${esc(money(total, cur))}${altCents ? `<small>(${esc(money(altCents, model.altCurrency))})</small>` : ''}</div></div>
      ${model.paymentTerms.trim() ? `<div class="rc-label">Formas de pagamento</div><p class="rc-decl" style="white-space:pre-line">${esc(model.paymentTerms)}</p>` : ''}
      <p class="rc-decl">${esc(model.conditions.trim() || DEFAULT_CONDITIONS)}</p>
      <div class="rc-sign"><div class="thanks">Para confirmar, responda pelo WhatsApp.<b>Obrigado por escolher a Rota Certa.</b></div></div>
    </div>
    <footer class="rc-foot"><b>ROTA CERTA PASSAGENS</b><span>@rotacerta.passagens</span><span>+351 925 307 391</span><span>rotacertapassagens.com</span></footer>`;

  // Poucos trechos: modelo normal. Mais trechos: o documento fica compacto ou denso para continuar em uma folha.
  const sheet = $('orcamento');
  const weight = segments.length + Math.max(0, lines.length - 2);
  sheet.classList.toggle('compact', weight > 4 && weight <= 7);
  sheet.classList.toggle('dense', weight > 7);
  fit();
}

// Na impressão o orçamento tem de caber em UMA folha A4: se o conteúdo passar da altura, a página encolhe só o necessário.
const MM = 96 / 25.4;
function fitForPrint() {
  const el = $('orcamento');
  el.style.zoom = ''; el.style.width = ''; el.style.minHeight = '0';
  const natural = el.scrollHeight;
  el.style.minHeight = '';
  const page = 286 * MM;
  const zoom = natural > page ? Math.max(0.6, page / natural) : 1;
  if (zoom < 1) { el.style.zoom = String(zoom); el.style.width = `${210 / zoom}mm`; el.style.minHeight = `${292 / zoom}mm`; }
}
function resetAfterPrint() { const el = $('orcamento'); el.style.zoom = ''; el.style.width = ''; el.style.minHeight = ''; }
window.addEventListener('beforeprint', fitForPrint);
window.addEventListener('afterprint', resetAfterPrint);

// A prévia é uma folha A4 de 794 px: encolhe para caber na coluna da tela.
function fit() {
  const holder = document.querySelector('.rc-preview');
  const scaleBox = $('rcScale');
  const scale = Math.min(1, holder.clientWidth / 794);
  scaleBox.style.transform = scale < 1 ? `scale(${scale})` : '';
  scaleBox.style.height = scale < 1 ? `${$('orcamento').offsetHeight * scale}px` : '';
}

// --- salvar -----------------------------------------------------------------------------------------------------
function payload() {
  const lines = model.lines.filter((line) => line.title.trim()).map((line) => ({ title: line.title.trim(), subtitle: line.subtitle.trim(), kind: line.kind === 'extra' ? 'extra' : 'pax', qty: qtyOf(line), unitCents: unitOf(line) }));
  const altCents = model.altCurrency && model.altAmount ? toCents(model.altAmount) : null;
  return {
    issuedOn: model.issuedOn, validUntil: model.validUntil || undefined, status: model.status,
    customerName: model.customerName, customerContact: model.customerContact, baggage: model.baggage,
    segments: model.segments.filter((s) => s.flight || s.from || s.to), note: model.note, lines, currency: model.currency,
    altCurrency: altCents ? model.altCurrency : undefined, altAmountCents: altCents || undefined,
    paymentTerms: model.paymentTerms, conditions: model.conditions,
  };
}

async function save() {
  if (model.altCurrency && !model.altAmount) { status('Informe o valor equivalente ou escolha "Nenhum".', true); return; }
  if (model.lines.some((line) => line.title.trim() && !qtyOf(line))) { status('A quantidade de passageiros vai de 1 a 99.', true); return; }
  try {
    if (quoteId) {
      await api(`/api/admin/finance/quotes/${quoteId}`, { method: 'PUT', body: JSON.stringify(payload()) });
    } else {
      const result = await api('/api/admin/finance/quotes', { method: 'POST', body: JSON.stringify(payload()) });
      quoteId = result.id;
      model.number = result.number;
      history.replaceState(null, '', `/orcamento.html?id=${quoteId}`);
      updateTitle();
      renderPreview();
    }
    dirty = false;
    status('Orçamento salvo. Use "Imprimir / Salvar PDF" e escolha "Salvar como PDF" para enviar ao cliente.');
  } catch (error) { status(financeErrorMessage(error, 'Não foi possível salvar o orçamento.'), true); }
}

await boot();
