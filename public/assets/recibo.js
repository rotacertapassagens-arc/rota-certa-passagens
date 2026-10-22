// Página do recibo: formulário, prévia igual ao modelo, salvar, imprimir / salvar PDF e anexar o PDF emitido.
import { api, esc, financeErrorMessage, money, toCents, centsToInput, fmtDay, today } from './fin-ui.js';

const $ = (id) => document.getElementById(id);
const saleId = new URLSearchParams(location.search).get('sale') || '';
const METHOD_LABELS = { transfer: 'Transferência bancária', pix: 'PIX', card: 'Cartão de crédito', cash: 'Dinheiro', other: 'Outro' };
const STATUS_LABELS = { paid: 'Pago', partial: 'Pago em parte', pending: 'Pendente' };
const WORDS_FOR = {
  EUR: { one: 'euro', many: 'euros', centOne: 'cêntimo', centMany: 'cêntimos', pt: true },
  GBP: { one: 'libra', many: 'libras', centOne: 'pêni', centMany: 'pence', pt: true },
  BRL: { one: 'real', many: 'reais', centOne: 'centavo', centMany: 'centavos', pt: false },
  USD: { one: 'dólar', many: 'dólares', centOne: 'centavo', centMany: 'centavos', pt: false },
};

// --- valor por extenso (Mil quinhentos e sessenta e oito euros e dezassete cêntimos) -----------------------------
function wordsBelow1000(n, pt) {
  const units = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', pt ? 'catorze' : 'quatorze', 'quinze', pt ? 'dezasseis' : 'dezesseis', pt ? 'dezassete' : 'dezessete', 'dezoito', pt ? 'dezanove' : 'dezenove'];
  const tens = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const hundreds = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const parts = [];
  if (n >= 100) parts.push(hundreds[Math.floor(n / 100)]);
  const rest = n % 100;
  if (rest > 0) parts.push(rest < 20 ? units[rest] : tens[Math.floor(rest / 10)] + (rest % 10 ? ` e ${units[rest % 10]}` : ''));
  return parts.join(' e ');
}
function wordsInt(n, pt) {
  if (n === 0) return 'zero';
  const joiner = (rest) => (rest < 100 || rest % 100 === 0 ? ' e ' : ' ');
  if (n >= 1_000_000) {
    const millions = Math.floor(n / 1_000_000);
    const rest = n % 1_000_000;
    const head = millions === 1 ? 'um milhão' : `${wordsInt(millions, pt)} milhões`;
    return rest === 0 ? `${head} de` : `${head}${rest < 1000 || rest % 1000 === 0 ? ' e ' : ' '}${wordsInt(rest, pt)}`;
  }
  if (n >= 1000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    const head = thousands === 1 ? 'mil' : `${wordsBelow1000(thousands, pt)} mil`;
    return rest === 0 ? head : `${head}${joiner(rest)}${wordsBelow1000(rest, pt)}`;
  }
  return wordsBelow1000(n, pt);
}
function amountInWords(cents, currency) {
  const names = WORDS_FOR[currency] || WORDS_FOR.EUR;
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const parts = [];
  if (whole > 0) {
    const text = wordsInt(whole, names.pt);
    parts.push(`${text} ${whole === 1 ? names.one : names.many}`);
  }
  if (fraction > 0) parts.push(`${wordsInt(fraction, names.pt)} ${fraction === 1 ? names.centOne : names.centMany}`);
  const sentence = parts.join(' e ') || `zero ${names.many}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// --- estado do formulário -------------------------------------------------------------------------------------
const model = {
  number: '', issuedOn: today(), customerName: '', passengerKind: 'Adulto', baggage: '', reservationCodes: '', purchaseNumbers: '', ticketNumber: '', issuedBy: '',
  segments: [], note: '', lines: [], currency: 'EUR', altCurrency: '', altAmount: '', paymentMethod: 'transfer', paymentLabel: '', status: 'paid', declaration: '',
};
let sale = null;
let receiptId = null;
let dirty = false;

const emptySegment = () => ({ date: '', flight: '', airline: '', from: '', fromCity: '', depart: '', to: '', toCity: '', arrive: '', plusDay: 0, cls: '' });
const emptyLine = () => ({ title: '', subtitle: '', amount: '' });

function status(message, isError = false) {
  const element = $('rcStatus');
  element.textContent = message;
  element.className = `status no-print${message ? (isError ? ' alert-error' : ' alert-success') : ''}`;
}

// --- carregar (roda no fim do arquivo, depois de todas as funções existirem) -------------------------------------
async function boot() {
  try {
    if (!saleId) throw Object.assign(new Error('not_found'), { status: 404 });
    const session = await api('/api/auth/session');
    if (!session.user.roles.includes('master')) throw Object.assign(new Error('forbidden'), { status: 403 });
    const data = await api(`/api/admin/finance/sales/${saleId}/receipt`);
    sale = data.sale;
    receiptId = data.receipt?.id || null;
    if (data.receipt?.data) fillFromSaved(data.receipt); else fillFromSale(data);
    renderFiles(data.files);
    $('accessMessage').classList.add('hidden');
    $('rcContent').classList.remove('hidden');
    fit();
  } catch (error) {
    $('accessMessage').querySelector('p').textContent = error.status === 404 || error.message === 'not_found' ? 'Venda não encontrada. Volte e abra o recibo pela lista de vendas.' : financeErrorMessage(error, 'Entre primeiro pela Área do cliente com uma conta master.');
    throw error;
  }
}

function fillFromSaved(receipt) {
  const d = receipt.data;
  Object.assign(model, {
    number: receipt.number, issuedOn: receipt.issuedOn, customerName: d.customerName || '', passengerKind: d.passengerKind || '', baggage: d.baggage || '',
    reservationCodes: d.reservationCodes || '', purchaseNumbers: d.purchaseNumbers || '', ticketNumber: d.ticketNumber || '', issuedBy: d.issuedBy || '',
    segments: (d.segments || []).map((s) => ({ ...emptySegment(), ...s })), note: d.note || '', currency: d.currency,
    lines: (d.lines || []).map((l) => ({ title: l.title, subtitle: l.subtitle || '', amount: centsToInput(l.amountCents) })),
    altCurrency: d.altCurrency || '', altAmount: centsToInput(d.altAmountCents), paymentMethod: d.paymentMethod || 'transfer',
    paymentLabel: d.paymentLabel || '', status: d.status || 'paid', declaration: d.declaration || '',
  });
  init();
}

function fillFromSale(data) {
  const { issuances } = data;
  const pnrs = [...new Set(issuances.map((i) => i.pnr).filter(Boolean))];
  const route = [sale.origin, sale.destination].filter(Boolean).join(' → ');
  const pax = sale.passengerCount || 1;
  Object.assign(model, {
    number: `RC-${String(sale.saleDate).slice(0, 4)}-${pnrs.length ? pnrs.join('-') : String(sale.protocol).replace(/^[A-Z]+-\d{4}-/, '')}`,
    issuedOn: sale.saleDate, customerName: sale.customerName || '', reservationCodes: pnrs.join(' / '),
    ticketNumber: issuances.find((i) => i.ticketNumbers)?.ticketNumbers || '', issuedBy: issuances.find((i) => i.airline)?.airline || '',
    segments: [{ ...emptySegment(), from: sale.origin || '', to: sale.destination || '', date: sale.saleDate }],
    lines: [{ title: route ? `Passagem aérea ${route}` : 'Passagem aérea', subtitle: `${pax} passageiro${pax === 1 ? '' : 's'} adulto${pax === 1 ? '' : 's'}${pnrs.length ? ` · reserva ${pnrs.join(' / ')}` : ''}`, amount: centsToInput(sale.netAmountCents) }],
    currency: sale.currency, altCurrency: sale.altCurrency || '', altAmount: centsToInput(sale.altAmountCents),
    paymentMethod: sale.altCurrency === 'BRL' ? 'pix' : 'transfer', status: 'paid',
  });
  init();
}

// --- formulário -------------------------------------------------------------------------------------------------
function init() {
  $('rcSaleTitle').textContent = `Recibo da venda ${sale.protocol}`;
  $('rcSaleSub').textContent = `${sale.customerName || ''} · ${money(sale.netAmountCents, sale.currency)}`;
  document.querySelectorAll('[data-f]').forEach((input) => {
    input.value = model[input.dataset.f] ?? '';
    input.addEventListener('input', () => { model[input.dataset.f] = input.value; markDirty(); renderPreview(); });
  });
  buildRows();
  $('rcAddSegment').addEventListener('click', () => { model.segments.push(emptySegment()); buildRows(); markDirty(); renderPreview(); });
  $('rcAddLine').addEventListener('click', () => { model.lines.push(emptyLine()); buildRows(); markDirty(); renderPreview(); });
  $('rcSave').addEventListener('click', save);
  $('rcPrint').addEventListener('click', () => { renderPreview(); window.print(); });
  $('rcFileInput').addEventListener('change', uploadFile);
  window.addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault(); });
  window.addEventListener('resize', fit);
  $('rcFileInput').disabled = !receiptId;
  renderPreview();
}
const markDirty = () => { dirty = true; };

function buildRows() {
  $('rcSegments').innerHTML = model.segments.map((s, i) => `<div class="rc-row">
    <button type="button" class="ghost rc-remove" data-remove-seg="${i}">Remover</button>
    <div class="rc-row-grid">
      <label>Data<input type="date" data-seg="${i}:date" value="${esc(s.date)}"></label>
      <label>Voo<input data-seg="${i}:flight" maxlength="12" value="${esc(s.flight)}" placeholder="AF7345"></label>
      <label>Companhia<input data-seg="${i}:airline" maxlength="40" value="${esc(s.airline)}" placeholder="Air France"></label>
      <label>De (sigla)<input data-seg="${i}:from" maxlength="4" value="${esc(s.from)}" placeholder="MRS"></label>
      <label>Cidade de partida<input data-seg="${i}:fromCity" maxlength="60" value="${esc(s.fromCity)}" placeholder="Marselha"></label>
      <label>Hora de partida<input type="time" data-seg="${i}:depart" value="${esc(s.depart)}"></label>
      <label>Para (sigla)<input data-seg="${i}:to" maxlength="4" value="${esc(s.to)}" placeholder="CDG"></label>
      <label>Cidade de chegada<input data-seg="${i}:toCity" maxlength="60" value="${esc(s.toCity)}" placeholder="Paris"></label>
      <label>Hora de chegada<input type="time" data-seg="${i}:arrive" value="${esc(s.arrive)}"></label>
      <label>Chega no dia seguinte<select data-seg="${i}:plusDay"><option value="0"${!s.plusDay ? ' selected' : ''}>Não</option><option value="1"${s.plusDay === 1 ? ' selected' : ''}>+1 dia</option><option value="2"${s.plusDay === 2 ? ' selected' : ''}>+2 dias</option></select></label>
      <label>Classe / cabine<input data-seg="${i}:cls" maxlength="24" value="${esc(s.cls)}" placeholder="Y ou Econômica"></label>
    </div></div>`).join('');
  $('rcLines').innerHTML = model.lines.map((l, i) => `<div class="rc-row">
    <button type="button" class="ghost rc-remove" data-remove-line="${i}">Remover</button>
    <label>Descrição<input data-line="${i}:title" maxlength="160" value="${esc(l.title)}" placeholder="Passagem aérea Marselha (MRS) → Maceió (MCZ)"></label>
    <div class="rc-two"><label>Detalhe (opcional)<input data-line="${i}:subtitle" maxlength="200" value="${esc(l.subtitle)}"></label>
    <label>Valor (${esc(model.currency)})<input data-line="${i}:amount" inputmode="decimal" value="${esc(l.amount)}" placeholder="0,00"></label></div></div>`).join('');
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
const longDate = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : '');
const lineCents = (line) => { const cents = line.amount ? toCents(line.amount) : 0; return cents === null || cents < 0 ? 0 : cents; };

function renderPreview() {
  const lines = model.lines.filter((line) => line.title.trim());
  const total = lines.reduce((sum, line) => sum + lineCents(line), 0);
  const altCents = model.altCurrency && model.altAmount ? toCents(model.altAmount) : null;
  const cur = model.currency;
  const codes = model.reservationCodes.trim();
  const multiCodes = /[/,;]/.test(codes);
  const paymentText = model.paymentLabel.trim() || METHOD_LABELS[model.paymentMethod];
  const totalLabel = model.status === 'paid' ? 'Total recebido' : model.status === 'partial' ? 'Total' : 'Total a receber';
  const declaration = model.declaration.trim() || `Declaramos ter recebido de ${model.customerName || '...'} o valor acima, referente à emissão do bilhete aéreo e aos serviços de agência descritos.`;
  const baggage = model.baggage.trim().split('\n').filter(Boolean);
  const segments = model.segments.filter((s) => s.flight || s.from || s.to);

  $('recibo').innerHTML = `
    <div class="rc-head">
      <div class="rc-brand"><img src="/assets/logo-simbolo-claro.png" alt="">
        <div><h1>ROTA CERTA</h1><span class="sub">PASSAGENS</span>
          <p>Instagram <b>@rotacerta.passagens</b></p><p>WhatsApp <b>+351 925 307 391</b></p><p><b>rotacertapassagens.com</b></p></div></div>
      <div class="rc-head-right"><span class="tag-label">RECIBO</span><span class="number">Nº ${esc(model.number || '-')}</span><span class="date">Emitido em ${esc(fmtDay(model.issuedOn))}</span></div>
    </div>
    <div class="rc-body">
      <div class="rc-title"><h2>Recibo de pagamento</h2><span>Emissão de bilhete aéreo e serviço de agência</span></div>
      <div class="rc-cards">
        <section class="rc-card"><h4>Cliente / Passageiro</h4><dl class="rc-kv">
          <dt>Nome</dt><dd>${esc(model.customerName || '-')}${model.passengerKind ? `<small>(${esc(model.passengerKind)})</small>` : ''}</dd>
          ${baggage.length ? `<dt>Bagagem</dt><dd>${baggage.map((line) => `<span style="display:block">${esc(line)}</span>`).join('')}</dd>` : ''}</dl></section>
        <section class="rc-card"><h4>Reserva</h4><dl class="rc-kv">
          ${codes ? `<dt>${multiCodes ? 'Códigos' : 'Código'}</dt><dd>${esc(codes)}</dd>` : ''}
          ${model.purchaseNumbers.trim() ? `<dt>Compras</dt><dd>${esc(model.purchaseNumbers)}</dd>` : ''}
          ${model.ticketNumber.trim() ? `<dt>Nº do bilhete</dt><dd>${esc(model.ticketNumber)}</dd>` : ''}
          ${model.issuedBy.trim() ? `<dt>Emitido por</dt><dd>${esc(model.issuedBy)} · ${esc(fmtDay(model.issuedOn))}</dd>` : ''}</dl></section>
      </div>
      ${segments.length ? `<div class="rc-label">Itinerário</div><table class="rc-table"><thead><tr><th>Data</th><th>Voo</th><th>Partida</th><th></th><th>Chegada</th><th>Classe</th></tr></thead><tbody>
        ${segments.map((s) => `<tr><td>${esc(fmtDay(s.date))}</td><td><b>${esc(s.flight)}</b><small>${esc(s.airline)}</small></td>
          <td><b>${esc(s.from)}</b> ${esc(s.depart)}<small>${esc(s.fromCity)}</small></td><td class="arrow">→</td>
          <td><b>${esc(s.to)}</b> ${esc(s.arrive)}${s.plusDay ? ` <small style="display:inline">(+${s.plusDay})</small>` : ''}<small>${esc(s.toCity)}</small></td><td>${esc(s.cls)}</td></tr>`).join('')}</tbody></table>
        ${model.note.trim() ? `<p class="rc-note">${esc(model.note)}</p>` : ''}` : ''}
      <div class="rc-values"><div class="rc-label">Discriminação dos valores</div>
        ${lines.map((line) => `<div class="rc-value-row"><div>${esc(line.title)}${line.subtitle.trim() ? `<small>${esc(line.subtitle)}</small>` : ''}</div><b>${esc(money(lineCents(line), cur))}</b></div>`).join('') || '<div class="rc-value-row"><div>Adicione ao menos uma linha de valor.</div></div>'}
      </div>
      <div class="rc-total"><div><span class="label">${totalLabel}</span><span class="words">${esc(amountInWords(total, cur))}</span></div>
        <div class="amount">${esc(money(total, cur))}${altCents ? `<small>(${esc(money(altCents, model.altCurrency))})</small>` : ''}</div></div>
      <div class="rc-chips"><span class="rc-chip">Forma de pagamento: <b>${esc(paymentText)}</b></span><span class="rc-chip">Situação: <b>${esc(STATUS_LABELS[model.status])}</b></span></div>
      <p class="rc-decl">${esc(declaration)}</p>
      <p class="rc-decl">Alterações, cancelamentos e reembolsos seguem as regras da tarifa adquirida.</p>
      <div class="rc-sign"><div class="line">Rota Certa Passagens<small>Assinatura / carimbo</small></div>
        <div class="thanks">${esc(longDate(model.issuedOn))}<b>Obrigado por viajar com a Rota Certa.</b></div></div>
    </div>
    <footer class="rc-foot"><b>ROTA CERTA PASSAGENS</b><span>@rotacerta.passagens</span><span>+351 925 307 391</span><span>rotacertapassagens.com</span></footer>`;

  // Poucos trechos: modelo normal. Mais trechos: o recibo fica compacto ou denso para continuar em uma folha.
  const recibo = $('recibo');
  recibo.classList.toggle('compact', segments.length > 4 && segments.length <= 7);
  recibo.classList.toggle('dense', segments.length > 7);

  const mismatch = $('rcMismatch');
  if (total !== sale.netAmountCents) {
    mismatch.textContent = `A soma das linhas (${money(total, cur)}) é diferente do valor da venda (${money(sale.netAmountCents, cur)}). O recibo usa a soma das linhas.`;
    mismatch.classList.remove('hidden');
  } else mismatch.classList.add('hidden');
  fit();
}

// Na impressão o recibo tem de caber em UMA folha A4: se o conteúdo passar da altura, a página encolhe só o necessário.
const MM = 96 / 25.4;
function fitForPrint() {
  const el = $('recibo');
  el.style.zoom = ''; el.style.width = ''; el.style.minHeight = '0';
  const natural = el.scrollHeight;
  el.style.minHeight = '';
  const page = 286 * MM;
  const zoom = natural > page ? Math.max(0.6, page / natural) : 1;
  if (zoom < 1) { el.style.zoom = String(zoom); el.style.width = `${210 / zoom}mm`; el.style.minHeight = `${292 / zoom}mm`; }
}
function resetAfterPrint() { const el = $('recibo'); el.style.zoom = ''; el.style.width = ''; el.style.minHeight = ''; }
window.addEventListener('beforeprint', fitForPrint);
window.addEventListener('afterprint', resetAfterPrint);

// A prévia é uma folha A4 de 794 px: encolhe para caber na coluna da tela.
function fit() {
  const holder = document.querySelector('.rc-preview');
  const scaleBox = $('rcScale');
  const scale = Math.min(1, holder.clientWidth / 794);
  scaleBox.style.transform = scale < 1 ? `scale(${scale})` : '';
  scaleBox.style.height = scale < 1 ? `${$('recibo').offsetHeight * scale}px` : '';
}

// --- salvar e anexar --------------------------------------------------------------------------------------------
function payload() {
  const lines = model.lines.filter((line) => line.title.trim()).map((line) => ({ title: line.title.trim(), subtitle: line.subtitle.trim(), amountCents: lineCents(line) }));
  const altCents = model.altCurrency && model.altAmount ? toCents(model.altAmount) : null;
  return {
    number: model.number.trim(), issuedOn: model.issuedOn, customerName: model.customerName, passengerKind: model.passengerKind, baggage: model.baggage,
    reservationCodes: model.reservationCodes, purchaseNumbers: model.purchaseNumbers, ticketNumber: model.ticketNumber, issuedBy: model.issuedBy,
    segments: model.segments.filter((s) => s.flight || s.from || s.to), note: model.note, lines, currency: model.currency,
    altCurrency: altCents ? model.altCurrency : undefined, altAmountCents: altCents || undefined,
    paymentMethod: model.paymentMethod, paymentLabel: model.paymentLabel, status: model.status, declaration: model.declaration,
  };
}

async function save() {
  if (model.altCurrency && !model.altAmount) { status('Informe o valor equivalente ou escolha "Nenhum".', true); return; }
  try {
    const result = await api(`/api/admin/finance/sales/${saleId}/receipt`, { method: 'PUT', body: JSON.stringify(payload()) });
    receiptId = result.id;
    dirty = false;
    $('rcFileInput').disabled = false;
    status('Recibo salvo. Agora use "Imprimir / Salvar PDF" e anexe o arquivo abaixo.');
  } catch (error) { status(financeErrorMessage(error, 'Não foi possível salvar o recibo.'), true); }
}

function renderFiles(files) {
  $('rcFiles').innerHTML = files.length
    ? files.map((file) => `<div class="rc-file"><a href="/api/admin/finance/receipt-files/${file.id}" target="_blank" rel="noopener">${esc(file.filename)}</a><span class="muted">${Math.max(1, Math.round(file.sizeBytes / 1024))} KB</span><button type="button" class="small ghost" data-remove-file="${file.id}">Remover</button></div>`).join('')
    : '<p class="muted">Nenhum PDF anexado ainda.</p>';
  document.querySelectorAll('[data-remove-file]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Remover este arquivo do recibo?')) return;
    try { await api(`/api/admin/finance/receipt-files/${button.dataset.removeFile}`, { method: 'DELETE' }); await reloadFiles(); } catch (error) { status(financeErrorMessage(error, 'Não foi possível remover o arquivo.'), true); }
  }));
}
async function reloadFiles() { renderFiles((await api(`/api/admin/finance/sales/${saleId}/receipt`)).files); }

async function uploadFile(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!receiptId) { status('Salve o recibo antes de anexar o PDF.', true); return; }
  if (file.size > 1_400_000) { status('O arquivo passa de 1,4 MB. Reduza o PDF e tente de novo.', true); return; }
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  try {
    await api(`/api/admin/finance/receipts/${receiptId}/files`, { method: 'POST', body: JSON.stringify({ filename: file.name, mime: file.type, base64 }) });
    status('PDF anexado ao recibo.');
    await reloadFiles();
  } catch (error) { status(financeErrorMessage(error, 'Não foi possível anexar o arquivo.'), true); }
}

await boot();
