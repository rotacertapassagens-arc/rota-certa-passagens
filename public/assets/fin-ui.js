// Ajudantes compartilhados do financeiro e do recibo: chamadas à API, formatação de dinheiro e datas, mensagens
// de erro e a janelinha de formulário que substitui as caixas window.prompt.
const cookie = (name) => document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('content-type', 'application/json');
  if ((options.method || 'GET') !== 'GET') headers.set('x-csrf-token', cookie('rc_csrf'));
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(responseBody.error || 'request_failed'), { status: response.status });
  return responseBody;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

const CURRENCY_SYMBOL = { EUR: '€', BRL: 'R$', USD: 'US$', GBP: '£' };
export const currencySymbol = (currency) => CURRENCY_SYMBOL[currency] || currency;
/** 156817 + EUR vira "€ 1.568,17"; BRL vira "R$ 6.726,00". Nunca soma moedas diferentes. */
export function money(cents, currency) {
  const value = (Number(cents) || 0) / 100;
  const digits = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(value));
  return `${value < 0 ? '-' : ''}${currencySymbol(currency)} ${digits}`;
}
/** Texto digitado ("1.234,56", "1234.56", "€ 12") para centavos inteiros; null quando não é número. */
export function toCents(input) {
  let text = String(input ?? '').replace(/[^\d.,-]/g, '');
  if (!text || !/\d/.test(text)) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma > -1) {
    text = text.replace(',', '.');
  } else if (lastDot > -1 && text.length - lastDot - 1 === 3) {
    text = text.replace(/\./g, '');
  }
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
export const centsToInput = (cents) => (cents === null || cents === undefined || cents === '' ? '' : (Number(cents) / 100).toFixed(2).replace('.', ','));
export const today = () => new Date().toISOString().slice(0, 10);
export function fmtDay(iso) {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : '-';
}
export const monthKey = (iso) => String(iso || '').slice(0, 7);

const errorMessages = {
  cost_center_name_taken: 'Já existe um centro de custo com esse nome.',
  category_has_active_children: 'Esta categoria tem subcategorias ativas. Desative-as primeiro.',
  parent_not_found: 'Categoria-pai não encontrada.',
  parent_kind_mismatch: 'A subcategoria precisa ter o mesmo tipo da categoria-pai.',
  cost_center_not_found: 'Centro de custo não encontrado.',
  invalid_currency: 'Moeda inválida. Escolha EUR, USD, BRL ou GBP.',
  invalid_account: 'Dados da conta inválidos. Confira o par valor/data do saldo inicial.',
  invalid_counterparty: 'Dados da contraparte inválidos.',
  invalid_category: 'Dados da categoria inválidos.',
  invalid_cost_center: 'Nome do centro de custo inválido.',
  category_must_be_operating_expense: 'Assinaturas só podem usar categorias do tipo despesa operacional.',
  category_kind_mismatch: 'O tipo da categoria precisa ser igual ao tipo da obrigação.',
  category_not_found: 'Categoria não encontrada ou inativa.',
  counterparty_not_found: 'Contraparte não encontrada ou inativa.',
  account_not_found: 'Conta não encontrada ou inativa.',
  invalid_subscription: 'Dados da assinatura inválidos. Confira periodicidade e intervalo personalizado.',
  invalid_reprice: 'Dados de reajuste inválidos.',
  subscription_terminal: 'Esta assinatura já está cancelada ou encerrada.',
  invalid_transition: 'Essa mudança de status não é permitida a partir do status atual.',
  invalid_obligation: 'Dados da obrigação inválidos.',
  invalid_payment: 'Dados do pagamento inválidos. Confira valor, conta e data.',
  obligation_not_payable: 'Esta obrigação não pode mais receber pagamentos (cancelada, estornada ou já paga).',
  payment_currency_must_match_obligation: 'A moeda do pagamento precisa ser igual à moeda da obrigação.',
  obligation_terminal: 'Esta obrigação já está cancelada ou estornada.',
  obligation_has_payments_or_terminal: 'Só é possível cancelar uma obrigação em aberto, sem pagamentos.',
  payment_already_reversed: 'Este pagamento já foi estornado.',
  cannot_reverse_a_reversal: 'Não é possível estornar um estorno.',
  lead_not_found: 'Proposta não encontrada.',
  lead_not_converted: 'Esta proposta ainda não está marcada como convertida na Central de Propostas.',
  sale_amount_missing: 'Esta proposta convertida ainda não tem valor de venda registrado.',
  lead_protocol_missing: 'Esta proposta não tem protocolo, não é possível gerar a venda.',
  discount_exceeds_gross_amount: 'O desconto não pode ser maior ou igual ao valor bruto da venda.',
  sale_not_cancelable: 'Esta venda não pode mais ser cancelada.',
  sale_has_payments_use_refund: 'Esta venda já tem recebimento. Use "Reembolsar" em vez de cancelar.',
  sale_not_refundable: 'Esta venda não pode ser reembolsada neste status.',
  sale_has_no_payments_use_cancel: 'Esta venda ainda não tem nenhum recebimento. Use "Cancelar" em vez de reembolsar.',
  sale_not_confirmed: 'Esta venda não está mais confirmada.',
  installments_exceed_sale_amount: 'A soma dos recebimentos não pode ultrapassar o valor líquido da venda.',
  receivable_not_payable: 'Esta parcela não pode mais receber pagamentos (cancelada, estornada ou já paga).',
  payment_currency_must_match_receivable: 'A moeda do recebimento precisa ser igual à moeda da parcela.',
  invalid_issuance: 'Dados da emissão inválidos.',
  sale_not_found: 'Venda não encontrada.',
  issuance_currency_must_match_sale: 'A moeda da emissão precisa ser igual à moeda da venda.',
  mileage_provider_not_found: 'Fornecedor de milhas não encontrado ou inativo.',
  consolidator_not_found: 'Consolidadora não encontrada ou inativa.',
  issuance_locked_after_issued: 'Esta emissão já foi emitida: o custo histórico não pode mais ser alterado.',
  pnr_required_to_issue: 'Informe o PNR antes de marcar esta emissão como emitida.',
  invalid_mileage_lot: 'Dados do lote de milhas inválidos.',
  category_must_be_direct_cost: 'Compra de milhas só pode usar categoria do tipo custo direto.',
  mileage_lot_already_canceled: 'Este lote já está cancelado.',
  mileage_lot_has_active_allocations: 'Este lote tem milhas alocadas. Estorne as alocações antes de cancelar.',
  invalid_allocation: 'Dados da alocação inválidos.',
  issuance_not_found: 'Emissão não encontrada.',
  issuance_mode_does_not_use_miles: 'Esta emissão não usa milhas (modo dinheiro/consolidadora/companhia).',
  mileage_lot_not_found: 'Lote de milhas não encontrado.',
  mileage_lot_not_active: 'Este lote não está ativo.',
  mileage_lot_expired: 'Este lote está vencido.',
  mileage_lot_currency_must_match_issuance: 'A moeda do lote precisa ser igual à moeda da emissão.',
  insufficient_mileage_balance: 'Saldo insuficiente de milhas neste lote.',
  allocation_already_voided: 'Esta alocação já foi estornada.',
  invalid_request: 'Confira os campos: algum dado está faltando ou inválido.',
  invalid_alt_amount: 'O valor equivalente precisa estar em outra moeda e ser maior que zero.',
  sale_creation_failed: 'Não foi possível criar a venda. Nada foi gravado.',
  invalid_receipt: 'Recibo inválido. Confira número, data, cliente e as linhas de valor.',
  receipt_currency_must_match_sale: 'A moeda do recibo precisa ser a mesma da venda.',
  receipt_number_taken: 'Já existe um recibo com esse número.',
  invalid_upload: 'Arquivo inválido.',
  attachment_too_large: 'O arquivo passa de 1,4 MB. Reduza o PDF e tente de novo.',
  unsupported_attachment_type: 'O arquivo não parece ser um PDF ou imagem válida.',
  attachment_item_limit: 'Este recibo já tem 5 arquivos anexados.',
  attachment_storage_full: 'O espaço de anexos do financeiro está cheio.',
  forbidden: 'Sua conta não tem permissão master.',
  unauthorized: 'Sua sessão expirou. Entre de novo pela Área do cliente.',
};
export const financeErrorMessage = (error, fallback) => errorMessages[error?.message] || fallback;

/**
 * Janelinha de formulário. Cada campo: { name, label, type: text|money|number|date|time|select|textarea|checkbox,
 * value, options: [{ value, label }], required, placeholder, hint, wide }.
 * Devolve um objeto com os valores (money em centavos, number em número, checkbox em booleano) ou null se cancelou.
 */
export function askForm({ title, intro = '', fields = [], submitLabel = 'Salvar', cancelLabel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'fin-dialog';
    const inputFor = (field) => {
      const common = `id="ask-${field.name}" name="${field.name}"${field.required ? ' required' : ''}`;
      if (field.type === 'select') {
        return `<select ${common}>${(field.options || []).map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(field.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      }
      if (field.type === 'textarea') return `<textarea ${common} placeholder="${esc(field.placeholder || '')}">${esc(field.value || '')}</textarea>`;
      if (field.type === 'checkbox') return `<input type="checkbox" ${common}${field.value ? ' checked' : ''}>`;
      const type = field.type === 'money' ? 'text' : field.type || 'text';
      const extra = field.type === 'money' ? ' inputmode="decimal" autocomplete="off"' : field.type === 'number' ? ' step="any"' : '';
      return `<input type="${type}" ${common}${extra} value="${esc(field.value ?? '')}" placeholder="${esc(field.placeholder || '')}">`;
    };
    dialog.innerHTML = `<form method="dialog" class="fin-dialog-form" novalidate>
      <h2>${esc(title)}</h2>${intro ? `<p class="muted">${esc(intro)}</p>` : ''}
      <div class="fin-dialog-grid">${fields.map((field) => `<label class="${field.wide ? 'wide' : ''}${field.type === 'checkbox' ? ' check' : ''}">
          <span>${esc(field.label)}</span>${inputFor(field)}${field.hint ? `<small class="muted">${esc(field.hint)}</small>` : ''}</label>`).join('')}</div>
      <p class="status alert-error hidden" role="alert"></p>
      <div class="fin-dialog-actions"><button type="button" class="ghost" data-cancel>${esc(cancelLabel)}</button><button type="submit"${danger ? ' class="danger"' : ''}>${esc(submitLabel)}</button></div>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const error = dialog.querySelector('.status');
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const field of fields) {
        const element = form.elements[field.name];
        const raw = field.type === 'checkbox' ? element.checked : String(element.value ?? '').trim();
        if (field.type === 'checkbox') { values[field.name] = raw; continue; }
        if (field.required && !raw) { error.textContent = `Preencha: ${field.label}.`; error.classList.remove('hidden'); element.focus(); return; }
        if (field.type === 'money') {
          const cents = raw ? toCents(raw) : null;
          if (raw && (cents === null || cents < 0)) { error.textContent = `Valor inválido em: ${field.label}.`; error.classList.remove('hidden'); element.focus(); return; }
          values[field.name] = cents;
        } else if (field.type === 'number') {
          values[field.name] = raw === '' ? null : Number(raw);
        } else {
          values[field.name] = raw;
        }
      }
      finish(values);
    });
    dialog.showModal();
    dialog.querySelector('input:not([type=checkbox]),select,textarea')?.focus();
  });
}
export async function askConfirm(message, { title = 'Confirmar', submitLabel = 'Confirmar', danger = false } = {}) {
  return (await askForm({ title, intro: message, submitLabel, danger })) !== null;
}
