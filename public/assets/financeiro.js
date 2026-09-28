const cookie = (name) => document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('content-type', 'application/json');
  if ((options.method || 'GET') !== 'GET') headers.set('x-csrf-token', cookie('rc_csrf'));
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(responseBody.error || 'request_failed'), { status: response.status });
  return responseBody;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }
const fmtDate = (value) => (value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '-');

const financeErrorMessages = {
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
  invalid_payment: 'Dados do pagamento inválidos.',
  obligation_not_payable: 'Esta obrigação não pode mais receber pagamentos (cancelada, estornada ou já paga).',
  payment_currency_must_match_obligation: 'A moeda do pagamento precisa ser igual à moeda da obrigação.',
  obligation_terminal: 'Esta obrigação já está cancelada ou estornada.',
  obligation_has_payments_or_terminal: 'Só é possível cancelar uma obrigação em aberto, sem pagamentos.',
  payment_already_reversed: 'Este pagamento já foi estornado.',
  cannot_reverse_a_reversal: 'Não é possível estornar um estorno.',
  lead_not_found: 'Proposta não encontrada.',
  lead_not_converted: 'Esta proposta ainda não está marcada como convertida na Central de Propostas.',
  sale_amount_missing: 'Esta proposta convertida ainda não tem valor de venda registrado.',
  lead_protocol_missing: 'Esta proposta não tem protocolo — não é possível gerar a venda.',
  discount_exceeds_gross_amount: 'O desconto não pode ser maior ou igual ao valor bruto da venda.',
  sale_not_cancelable: 'Esta venda não pode mais ser cancelada.',
  sale_has_payments_use_refund: 'Esta venda já tem recebimento — use "Reembolsar" em vez de cancelar.',
  sale_not_refundable: 'Esta venda não pode ser reembolsada neste status.',
  sale_has_no_payments_use_cancel: 'Esta venda ainda não tem nenhum recebimento — use "Cancelar" em vez de reembolsar.',
  sale_not_confirmed: 'Esta venda não está mais confirmada.',
  installments_exceed_sale_amount: 'A soma das parcelas não pode ultrapassar o valor líquido da venda.',
  receivable_not_payable: 'Esta parcela não pode mais receber pagamentos (cancelada, estornada ou já paga).',
  payment_currency_must_match_receivable: 'A moeda do recebimento precisa ser igual à moeda da parcela.',
  invalid_issuance: 'Dados da emissão inválidos.',
  sale_not_found: 'Venda não encontrada.',
  issuance_currency_must_match_sale: 'A moeda da emissão precisa ser igual à moeda da venda.',
  mileage_provider_not_found: 'Fornecedor de milhas não encontrado ou inativo.',
  consolidator_not_found: 'Consolidadora não encontrada ou inativa.',
  issuance_locked_after_issued: 'Esta emissão já foi emitida — o custo histórico não pode mais ser alterado.',
  pnr_required_to_issue: 'Informe o PNR antes de marcar esta emissão como emitida.',
  invalid_mileage_lot: 'Dados do lote de milhas inválidos.',
  category_must_be_direct_cost: 'Compra de milhas só pode usar categoria do tipo custo direto.',
  mileage_lot_already_canceled: 'Este lote já está cancelado.',
  mileage_lot_has_active_allocations: 'Este lote tem milhas alocadas — estorne as alocações antes de cancelar.',
  invalid_allocation: 'Dados da alocação inválidos.',
  issuance_not_found: 'Emissão não encontrada.',
  issuance_mode_does_not_use_miles: 'Esta emissão não usa milhas (modo dinheiro/consolidadora/companhia).',
  mileage_lot_not_found: 'Lote de milhas não encontrado.',
  mileage_lot_not_active: 'Este lote não está ativo.',
  mileage_lot_expired: 'Este lote está vencido.',
  mileage_lot_currency_must_match_issuance: 'A moeda do lote precisa ser igual à moeda da emissão.',
  insufficient_mileage_balance: 'Saldo insuficiente de milhas neste lote.',
  allocation_already_voided: 'Esta alocação já foi estornada.',
};
function financeErrorMessage(error, fallback) {
  return financeErrorMessages[error?.message] || fallback;
}

let currentCostCenters = [];
let currentCategories = [];
let currentCounterparties = [];
let currentAccounts = [];

try {
  const session = await api('/api/auth/session');
  if (!session.user.roles.includes('master')) throw Object.assign(new Error('forbidden'), { status: 403 });
  document.getElementById('accessMessage').classList.add('hidden');
  document.getElementById('financeContent').classList.remove('hidden');
  await loadAll();
} catch (error) {
  document.querySelector('#accessMessage p').textContent = error.status === 403 ? 'Sua conta não tem permissão master.' : 'Entre primeiro pela Área do cliente com uma conta master.';
}

async function loadAll() {
  await loadCostCenters();
  await loadCategories();
  await loadAccounts();
  await loadCounterparties();
  await loadSubscriptions();
  await loadObligations();
  await loadSales();
  await loadMileageLots();
  await loadDashboard();
  await loadDashboardAlerts();
}

async function loadCostCenters() {
  const result = await api('/api/admin/finance/cost-centers');
  currentCostCenters = result.costCenters;
  document.getElementById('costCenters').innerHTML = currentCostCenters.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" data-toggle-cost-center="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="3">Nenhum centro de custo cadastrado.</td></tr>';
  const parentSelect = document.getElementById('categoryCostCenter');
  const selected = parentSelect.value;
  parentSelect.innerHTML = '<option value="">Nenhum</option>' + currentCostCenters.filter((item) => item.active).map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  parentSelect.value = selected;
  document.querySelectorAll('[data-toggle-cost-center]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/cost-centers/${button.dataset.toggleCostCenter}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadCostCenters();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar o centro de custo.')); }
  }));
}

async function loadCategories() {
  const result = await api('/api/admin/finance/categories');
  currentCategories = result.categories;
  const nameOf = (id) => currentCategories.find((item) => item.id === id)?.name || '-';
  document.getElementById('categories').innerHTML = currentCategories.map((item) => `<tr><td>${{ revenue: 'Receita', direct_cost: 'Custo direto', operating_expense: 'Despesa operacional' }[item.kind]}</td><td>${escapeHtml(item.name)}</td><td>${item.parentId ? escapeHtml(nameOf(item.parentId)) : '-'}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" data-toggle-category="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma categoria cadastrada.</td></tr>';
  const parentSelect = document.getElementById('categoryParent');
  const selected = parentSelect.value;
  parentSelect.innerHTML = '<option value="">Nenhuma</option>' + currentCategories.filter((item) => item.active).map((item) => `<option value="${item.id}" data-kind="${item.kind}">${escapeHtml(item.name)}</option>`).join('');
  parentSelect.value = selected;
  document.querySelectorAll('[data-toggle-category]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/categories/${button.dataset.toggleCategory}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadCategories();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a categoria.')); }
  }));

  const subscriptionCategorySelect = document.getElementById('subscriptionCategory');
  if (subscriptionCategorySelect) {
    const previous = subscriptionCategorySelect.value;
    subscriptionCategorySelect.innerHTML = currentCategories.filter((item) => item.active && item.kind === 'operating_expense')
      .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('') || '<option value="">Nenhuma categoria de despesa operacional cadastrada</option>';
    subscriptionCategorySelect.value = previous;
  }
  refreshObligationCategoryOptions();

  const mileageLotCategorySelect = document.getElementById('mileageLotCategory');
  if (mileageLotCategorySelect) {
    const previous = mileageLotCategorySelect.value;
    mileageLotCategorySelect.innerHTML = currentCategories.filter((item) => item.active && item.kind === 'direct_cost')
      .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('') || '<option value="">Nenhuma categoria de custo direto cadastrada</option>';
    mileageLotCategorySelect.value = previous;
  }
}

function refreshObligationCategoryOptions() {
  const categorySelect = document.getElementById('obligationCategory');
  const kindSelect = document.getElementById('obligationKind');
  if (!categorySelect || !kindSelect) return;
  const previous = categorySelect.value;
  categorySelect.innerHTML = currentCategories.filter((item) => item.active && item.kind === kindSelect.value)
    .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('') || '<option value="">Nenhuma categoria cadastrada para este tipo</option>';
  categorySelect.value = previous;
}
document.getElementById('obligationKind')?.addEventListener('change', refreshObligationCategoryOptions);

async function loadAccounts() {
  const result = await api('/api/admin/finance/accounts');
  currentAccounts = result.accounts;
  document.getElementById('accounts').innerHTML = currentAccounts.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.currency)}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" data-toggle-account="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma conta cadastrada.</td></tr>';
  document.querySelectorAll('[data-toggle-account]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/accounts/${button.dataset.toggleAccount}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadAccounts();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a conta.')); }
  }));
}

async function loadCounterparties() {
  const result = await api('/api/admin/finance/counterparties');
  currentCounterparties = result.counterparties;
  document.getElementById('counterparties').innerHTML = currentCounterparties.map((item) => `<tr><td>${escapeHtml(item.displayName)}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.preferredCurrency || '-')}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" data-toggle-counterparty="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma contraparte cadastrada.</td></tr>';
  document.querySelectorAll('[data-toggle-counterparty]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/counterparties/${button.dataset.toggleCounterparty}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadCounterparties();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a contraparte.')); }
  }));

  const subscriptionCounterpartySelect = document.getElementById('subscriptionCounterparty');
  if (subscriptionCounterpartySelect) {
    const previous = subscriptionCounterpartySelect.value;
    subscriptionCounterpartySelect.innerHTML = currentCounterparties.filter((item) => item.active).map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join('') || '<option value="">Nenhuma contraparte cadastrada</option>';
    subscriptionCounterpartySelect.value = previous;
  }
  const obligationCounterpartySelect = document.getElementById('obligationCounterparty');
  if (obligationCounterpartySelect) {
    const previous = obligationCounterpartySelect.value;
    obligationCounterpartySelect.innerHTML = '<option value="">Nenhuma</option>' + currentCounterparties.filter((item) => item.active).map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join('');
    obligationCounterpartySelect.value = previous;
  }
  const mileageLotCounterpartySelect = document.getElementById('mileageLotCounterparty');
  if (mileageLotCounterpartySelect) {
    const previous = mileageLotCounterpartySelect.value;
    mileageLotCounterpartySelect.innerHTML = currentCounterparties.filter((item) => item.active && item.kind === 'mileage_provider')
      .map((item) => `<option value="${item.id}">${escapeHtml(item.displayName)}</option>`).join('') || '<option value="">Nenhum fornecedor de milhas cadastrado</option>';
    mileageLotCounterpartySelect.value = previous;
  }
}

const subscriptionStatusLabels = { trial: 'Trial', active: 'Ativa', suspended: 'Suspensa', canceled: 'Cancelada', ended: 'Encerrada' };
const periodicityLabels = { monthly: 'Mensal', quarterly: 'Trimestral', semiannual: 'Semestral', annual: 'Anual', custom: 'Personalizada' };
const obligationStatusLabels = { open: 'Aberta', partial: 'Parcial', paid: 'Paga', canceled: 'Cancelada', reversed: 'Estornada' };

async function loadSubscriptions() {
  const result = await api('/api/admin/finance/subscriptions');
  document.getElementById('subscriptions').innerHTML = result.subscriptions.map((item) => `<tr>
      <td>${escapeHtml(item.service)}</td>
      <td>${(item.amountCents / 100).toFixed(2)} ${escapeHtml(item.currency)}</td>
      <td>${periodicityLabels[item.periodicity] || escapeHtml(item.periodicity)}</td>
      <td>${escapeHtml(item.nextChargeAt)}</td>
      <td>${subscriptionStatusLabels[item.status] || escapeHtml(item.status)}</td>
      <td>
        <button type="button" data-reprice="${item.id}">Reajustar</button>
        ${item.status === 'trial' ? `<button type="button" data-sub-status="${item.id}" data-target="active">Ativar</button>` : ''}
        ${item.status === 'active' ? `<button type="button" data-sub-status="${item.id}" data-target="suspended">Suspender</button>` : ''}
        ${item.status === 'suspended' ? `<button type="button" data-sub-status="${item.id}" data-target="active">Reativar</button>` : ''}
        ${item.status !== 'canceled' && item.status !== 'ended' ? `<button type="button" data-sub-status="${item.id}" data-target="canceled">Cancelar</button>` : ''}
      </td>
    </tr>`).join('') || '<tr><td colspan="6">Nenhuma assinatura cadastrada.</td></tr>';

  document.querySelectorAll('[data-reprice]').forEach((button) => button.addEventListener('click', async () => {
    const amount = window.prompt('Novo valor em centavos:');
    if (!amount) return;
    const effectiveAt = window.prompt('Data efetiva (AAAA-MM-DD):', new Date().toISOString().slice(0, 10));
    if (!effectiveAt) return;
    try {
      await api(`/api/admin/finance/subscriptions/${button.dataset.reprice}/reprice`, { method: 'POST', body: JSON.stringify({ amountCents: Number(amount), currency: 'EUR', effectiveAt }) });
      await loadSubscriptions();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível reajustar a assinatura.')); }
  }));
  document.querySelectorAll('[data-sub-status]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/subscriptions/${button.dataset.subStatus}/status`, { method: 'POST', body: JSON.stringify({ status: button.dataset.target }) });
      await loadSubscriptions();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível mudar o status da assinatura.')); }
  }));
}

async function loadObligations() {
  const result = await api('/api/admin/finance/obligations');
  document.getElementById('obligations').innerHTML = result.obligations.map((item) => `<tr>
      <td>${escapeHtml(currentCategories.find((category) => category.id === item.categoryId)?.name || '-')}</td>
      <td>${escapeHtml(item.dueDate)}${item.isOverdue ? ' (vencida)' : ''}</td>
      <td>${(item.amountCents / 100).toFixed(2)} ${escapeHtml(item.currency)}</td>
      <td>${obligationStatusLabels[item.status] || escapeHtml(item.status)}</td>
      <td>
        ${item.status === 'open' || item.status === 'partial' ? `<button type="button" data-pay="${item.id}">Registrar pagamento</button>` : ''}
        ${item.status === 'open' ? `<button type="button" data-cancel-obligation="${item.id}">Cancelar</button>` : ''}
        <button type="button" data-view-payments="${item.id}">Ver pagamentos</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5">Nenhuma obrigação cadastrada.</td></tr>';

  document.querySelectorAll('[data-pay]').forEach((button) => button.addEventListener('click', async () => {
    if (!currentAccounts.length) { alert('Cadastre uma conta financeira antes de registrar um pagamento.'); return; }
    const amount = window.prompt('Valor pago em centavos:');
    if (!amount) return;
    const accountId = currentAccounts[0].id;
    try {
      await api(`/api/admin/finance/obligations/${button.dataset.pay}/payments`, { method: 'POST', body: JSON.stringify({ paidAmountCents: Number(amount), currency: 'EUR', accountId }) });
      await loadObligations();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível registrar o pagamento.')); }
  }));
  document.querySelectorAll('[data-cancel-obligation]').forEach((button) => button.addEventListener('click', async () => {
    const reason = window.prompt('Motivo do cancelamento:');
    if (!reason) return;
    try {
      await api(`/api/admin/finance/obligations/${button.dataset.cancelObligation}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      await loadObligations();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível cancelar a obrigação.')); }
  }));
  document.querySelectorAll('[data-view-payments]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/admin/finance/obligations/${button.dataset.viewPayments}/payments`);
      const lines = result.payments.map((payment) => `${payment.createdAt}: ${(payment.paidAmountCents / 100).toFixed(2)} ${payment.currency}${payment.reversalOf ? ' (estorno)' : ''}`);
      alert(lines.join('\n') || 'Nenhum pagamento registrado ainda.');
    } catch (error) { alert('Não foi possível carregar os pagamentos.'); }
  }));
}

const saleStatusLabels = { confirmed: 'Confirmada', canceled: 'Cancelada', refunded: 'Reembolsada' };
const financialStatusLabels = { no_receivables: 'Sem parcelas', open: 'Aberta', partial: 'Parcial', paid: 'Paga', canceled: 'Cancelada', refunded: 'Reembolsada' };

async function loadSales() {
  const result = await api('/api/admin/finance/sales');
  document.getElementById('sales').innerHTML = result.sales.map((item) => `<tr>
      <td>${escapeHtml(item.protocol)}</td>
      <td>${escapeHtml(item.saleDate)}</td>
      <td>${(item.netAmountCents / 100).toFixed(2)} ${escapeHtml(item.currency)}</td>
      <td>${saleStatusLabels[item.status] || escapeHtml(item.status)}</td>
      <td>${financialStatusLabels[item.financialStatus] || escapeHtml(item.financialStatus)}</td>
      <td>
        ${item.status === 'confirmed' ? `<button type="button" data-add-installment="${item.id}">Adicionar parcela</button>` : ''}
        ${item.status === 'confirmed' ? `<button type="button" data-cancel-sale="${item.id}">Cancelar</button>` : ''}
        ${item.status === 'confirmed' ? `<button type="button" data-refund-sale="${item.id}">Reembolsar</button>` : ''}
        <button type="button" data-view-sale="${item.id}">Ver parcelas</button>
        <button type="button" data-view-issuances="${item.id}">Emissões e lucro</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6">Nenhuma venda registrada.</td></tr>';

  document.querySelectorAll('[data-add-installment]').forEach((button) => button.addEventListener('click', async () => {
    const dueDate = window.prompt('Vencimento da parcela (AAAA-MM-DD):');
    if (!dueDate) return;
    const amount = window.prompt('Valor esperado em centavos:');
    if (!amount) return;
    try {
      await api(`/api/admin/finance/sales/${button.dataset.addInstallment}/receivables`, {
        method: 'POST', body: JSON.stringify({ installments: [{ dueDate, expectedAmountCents: Number(amount), method: 'pix' }] }),
      });
      await loadSales();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível adicionar a parcela.')); }
  }));
  document.querySelectorAll('[data-cancel-sale]').forEach((button) => button.addEventListener('click', async () => {
    const reason = window.prompt('Motivo do cancelamento:');
    if (!reason) return;
    try {
      await api(`/api/admin/finance/sales/${button.dataset.cancelSale}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      await loadSales();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível cancelar a venda.')); }
  }));
  document.querySelectorAll('[data-refund-sale]').forEach((button) => button.addEventListener('click', async () => {
    const reason = window.prompt('Motivo do reembolso:');
    if (!reason) return;
    try {
      await api(`/api/admin/finance/sales/${button.dataset.refundSale}/refund`, { method: 'POST', body: JSON.stringify({ reason }) });
      await loadSales();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível reembolsar a venda.')); }
  }));
  document.querySelectorAll('[data-view-sale]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/admin/finance/sales/${button.dataset.viewSale}`);
      if (!result.receivables.length) { alert('Nenhuma parcela cadastrada ainda.'); return; }
      const lines = await Promise.all(result.receivables.map(async (installment) => {
        const payments = await api(`/api/admin/finance/receivables/${installment.id}/payments`);
        const receivedLines = payments.payments.map((payment) => `    recebido ${(payment.receivedAmountCents / 100).toFixed(2)} ${payment.currency}${payment.reversalOf ? ' (estorno)' : ''} em ${payment.receivedAt}`);
        return [`Parcela ${installment.installmentNumber}: ${(installment.expectedAmountCents / 100).toFixed(2)} ${installment.currency} — ${installment.status} (venc. ${installment.dueDate})`, ...receivedLines].join('\n');
      }));
      const registerPayment = window.confirm(`${lines.join('\n\n')}\n\nRegistrar um novo pagamento agora?`);
      if (!registerPayment) return;
      const installmentNumber = window.prompt('Número da parcela a pagar:');
      const installment = result.receivables.find((item) => String(item.installmentNumber) === installmentNumber);
      if (!installment) { alert('Parcela não encontrada.'); return; }
      if (!currentAccounts.length) { alert('Cadastre uma conta financeira antes de registrar um recebimento.'); return; }
      const amount = window.prompt('Valor recebido em centavos:');
      if (!amount) return;
      await api(`/api/admin/finance/receivables/${installment.id}/payments`, {
        method: 'POST', body: JSON.stringify({ receivedAmountCents: Number(amount), currency: installment.currency, accountId: currentAccounts[0].id }),
      });
      await loadSales();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível carregar as parcelas.')); }
  }));

  const issuanceModeLabels = { cash: 'Dinheiro', miles: 'Milhas', hybrid: 'Híbrido', consolidator: 'Consolidadora', airline: 'Companhia aérea', other: 'Outro' };
  const issuanceStatusLabels = { pending: 'Pendente', issued: 'Emitida', canceled: 'Cancelada', refunded: 'Reembolsada' };
  document.querySelectorAll('[data-view-issuances]').forEach((button) => button.addEventListener('click', async () => {
    const saleId = button.dataset.viewIssuances;
    try {
      const detail = await api(`/api/admin/finance/sales/${saleId}`);
      const profit = detail.profit;
      const profitLines = [
        `Lucro realizado: ${(profit.realizedGrossProfitCents / 100).toFixed(2)} (margem ${(profit.realizedMarginBps / 100).toFixed(2)}%)`,
        `Lucro projetado (com emissões pendentes): ${(profit.projectedGrossProfitCents / 100).toFixed(2)} (margem ${(profit.projectedMarginBps / 100).toFixed(2)}%)`,
      ];
      const issuanceLines = detail.issuances.map((item, index) => `  ${index + 1}. ${item.mode ? issuanceModeLabels[item.mode] : '-'} — ${issuanceStatusLabels[item.status]}${item.pnr ? ` (PNR ${item.pnr})` : ''}`);
      const choice = window.prompt(`${profitLines.join('\n')}\n\nEmissões:\n${issuanceLines.join('\n') || '  Nenhuma emissão ainda.'}\n\nDigite o número de uma emissão para emitir/cancelar/reembolsar, "nova" para criar outra, ou deixe em branco para fechar:`);
      if (!choice) return;
      if (choice.trim().toLowerCase() === 'nova') {
        const mode = window.prompt('Modo (cash, miles, hybrid, consolidator, airline, other):', 'cash');
        if (!mode) return;
        const cashAmountCents = Number(window.prompt('Valor em dinheiro (centavos):', '0') || 0);
        const airportFeesCents = Number(window.prompt('Taxas de aeroporto (centavos):', '0') || 0);
        const pnr = window.prompt('PNR (opcional, necessário só para marcar como emitida):') || undefined;
        await api(`/api/admin/finance/sales/${saleId}/issuances`, {
          method: 'POST', body: JSON.stringify({ mode, currency: detail.sale.currency, cashAmountCents, airportFeesCents, pnr }),
        });
        await loadSales();
        return;
      }
      const issuance = detail.issuances[Number(choice) - 1];
      if (!issuance) { alert('Emissão não encontrada.'); return; }
      const actionOptions = issuance.mode === 'miles' || issuance.mode === 'hybrid' ? 'alocar, emitir, cancelar ou reembolsar' : 'emitir, cancelar ou reembolsar';
      const action = window.prompt(`Emissão "${issuanceStatusLabels[issuance.status]}". Digite: ${actionOptions}.`);
      if (!action) return;
      if (action.trim().toLowerCase() === 'alocar') {
        const mileageLots = await api('/api/admin/finance/mileage-lots?status=active');
        const usable = mileageLots.mileageLots.filter((lot) => lot.currency === issuance.currency && lot.balanceQuantity > 0);
        if (!usable.length) { alert('Nenhum lote ativo com saldo nessa moeda.'); return; }
        const lotLines = usable.map((lot, index) => `  ${index + 1}. ${lot.program} — saldo ${lot.balanceQuantity} (${currentCounterparties.find((c) => c.id === lot.counterpartyId)?.displayName || '-'})`);
        const lotChoice = window.prompt(`Lotes disponíveis:\n${lotLines.join('\n')}\n\nDigite o número do lote:`);
        const lot = usable[Number(lotChoice) - 1];
        if (!lot) { alert('Lote não encontrado.'); return; }
        const quantity = window.prompt(`Quantas milhas alocar (saldo disponível: ${lot.balanceQuantity}):`);
        if (!quantity) return;
        await api(`/api/admin/finance/issuances/${issuance.id}/mileage-allocations`, { method: 'POST', body: JSON.stringify({ lotId: lot.id, quantity: Number(quantity) }) });
      } else if (action.trim().toLowerCase() === 'emitir') {
        if (!issuance.pnr) {
          const pnr = window.prompt('Esta emissão ainda não tem PNR. Informe o PNR para poder emitir:');
          if (!pnr) return;
          await api(`/api/admin/finance/issuances/${issuance.id}`, { method: 'PATCH', body: JSON.stringify({ pnr }) });
        }
        await api(`/api/admin/finance/issuances/${issuance.id}/issue`, { method: 'POST', body: JSON.stringify({}) });
      } else if (action.trim().toLowerCase() === 'cancelar') {
        const reason = window.prompt('Motivo do cancelamento:');
        if (!reason) return;
        await api(`/api/admin/finance/issuances/${issuance.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      } else if (action.trim().toLowerCase() === 'reembolsar') {
        const reason = window.prompt('Motivo do reembolso:');
        if (!reason) return;
        await api(`/api/admin/finance/issuances/${issuance.id}/refund`, { method: 'POST', body: JSON.stringify({ reason }) });
      } else {
        return;
      }
      await loadSales();
      await loadMileageLots();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a emissão.')); }
  }));
}

document.getElementById('saleFromLeadForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('saleFromLeadStatus');
  const leadId = document.getElementById('saleLeadId').value.trim();
  const discountCents = Number(document.getElementById('saleDiscount').value || 0);
  try {
    const result = await api(`/api/admin/finance/sales/from-lead/${leadId}`, { method: 'POST', body: JSON.stringify({ discountCents }) });
    event.target.reset();
    status.textContent = result.alreadyExisted ? 'Esta proposta já tinha uma venda registrada — nada duplicado.' : 'Venda criada a partir da proposta.';
    await loadSales();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível gerar a venda a partir da proposta.'); }
});

document.getElementById('generateChargesButton')?.addEventListener('click', async () => {
  const status = document.getElementById('generateChargesStatus');
  try {
    const result = await api('/api/admin/finance/subscriptions/generate-charges', { method: 'POST' });
    status.textContent = `Assinaturas vencidas: ${result.subscriptionsDue}. Cobranças criadas: ${result.created}. Já existentes: ${result.skipped}.`;
    await loadObligations();
    await loadSubscriptions();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível gerar as cobranças.'); }
});

document.getElementById('costCenterForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('costCenterStatus');
  try {
    await api('/api/admin/finance/cost-centers', { method: 'POST', body: JSON.stringify({ name: document.getElementById('costCenterName').value }) });
    event.target.reset();
    status.textContent = 'Centro de custo criado.';
    await loadCostCenters();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar o centro de custo.'); }
});

document.getElementById('categoryForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('categoryStatus');
  const parentId = document.getElementById('categoryParent').value || undefined;
  const defaultCostCenterId = document.getElementById('categoryCostCenter').value || undefined;
  try {
    await api('/api/admin/finance/categories', {
      method: 'POST',
      body: JSON.stringify({ kind: document.getElementById('categoryKind').value, name: document.getElementById('categoryName').value, parentId, defaultCostCenterId }),
    });
    event.target.reset();
    status.textContent = 'Categoria criada.';
    await loadCategories();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar a categoria.'); }
});

document.getElementById('accountForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('accountStatus');
  const last4 = document.getElementById('accountLast4').value || undefined;
  const institution = document.getElementById('accountInstitution').value || undefined;
  try {
    await api('/api/admin/finance/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('accountName').value, type: document.getElementById('accountType').value, currency: document.getElementById('accountCurrency').value.toUpperCase(), institution, last4 }),
    });
    event.target.reset();
    document.getElementById('accountCurrency').value = 'EUR';
    status.textContent = 'Conta criada.';
    await loadAccounts();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar a conta.'); }
});

document.getElementById('counterpartyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('counterpartyStatus');
  const preferredCurrency = document.getElementById('counterpartyCurrency').value || undefined;
  try {
    await api('/api/admin/finance/counterparties', {
      method: 'POST',
      body: JSON.stringify({ displayName: document.getElementById('counterpartyName').value, kind: document.getElementById('counterpartyKind').value, preferredCurrency: preferredCurrency ? preferredCurrency.toUpperCase() : undefined }),
    });
    event.target.reset();
    status.textContent = 'Contraparte criada.';
    await loadCounterparties();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar a contraparte.'); }
});

document.getElementById('subscriptionForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('subscriptionStatus');
  const periodicity = document.getElementById('subscriptionPeriodicity').value;
  const customIntervalDays = periodicity === 'custom' ? Number(document.getElementById('subscriptionCustomDays').value) : undefined;
  try {
    await api('/api/admin/finance/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        counterpartyId: document.getElementById('subscriptionCounterparty').value,
        categoryId: document.getElementById('subscriptionCategory').value,
        service: document.getElementById('subscriptionService').value,
        amountCents: Number(document.getElementById('subscriptionAmount').value),
        currency: document.getElementById('subscriptionCurrency').value.toUpperCase(),
        periodicity,
        customIntervalDays,
        startedAt: document.getElementById('subscriptionStartedAt').value,
      }),
    });
    event.target.reset();
    document.getElementById('subscriptionCurrency').value = 'EUR';
    status.textContent = 'Assinatura criada.';
    await loadSubscriptions();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar a assinatura.'); }
});

document.getElementById('obligationForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('obligationStatus');
  const counterpartyId = document.getElementById('obligationCounterparty').value || undefined;
  try {
    await api('/api/admin/finance/obligations', {
      method: 'POST',
      body: JSON.stringify({
        kind: document.getElementById('obligationKind').value,
        categoryId: document.getElementById('obligationCategory').value,
        counterpartyId,
        competencyDate: document.getElementById('obligationCompetencyDate').value,
        dueDate: document.getElementById('obligationDueDate').value,
        amountCents: Number(document.getElementById('obligationAmount').value),
        currency: document.getElementById('obligationCurrency').value.toUpperCase(),
      }),
    });
    event.target.reset();
    document.getElementById('obligationCurrency').value = 'EUR';
    status.textContent = 'Obrigação criada.';
    await loadObligations();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar a obrigação.'); }
});

const mileageLotStatusLabels = { active: 'Ativo', depleted: 'Esgotado', expired: 'Vencido', canceled: 'Cancelado' };

async function loadMileageLots() {
  const result = await api('/api/admin/finance/mileage-lots');
  document.getElementById('mileageLots').innerHTML = result.mileageLots.map((item) => `<tr>
      <td>${escapeHtml(currentCounterparties.find((counterparty) => counterparty.id === item.counterpartyId)?.displayName || '-')}</td>
      <td>${escapeHtml(item.program)}</td>
      <td>${item.balanceQuantity} / ${item.quantityPurchased}</td>
      <td>${mileageLotStatusLabels[item.status] || escapeHtml(item.status)}${item.isExpired ? ' (vencido)' : ''}</td>
      <td>${item.status !== 'canceled' && item.balanceQuantity === item.quantityPurchased ? `<button type="button" data-cancel-lot="${item.id}">Cancelar</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="5">Nenhum lote cadastrado.</td></tr>';

  document.querySelectorAll('[data-cancel-lot]').forEach((button) => button.addEventListener('click', async () => {
    const reason = window.prompt('Motivo do cancelamento:');
    if (!reason) return;
    try {
      await api(`/api/admin/finance/mileage-lots/${button.dataset.cancelLot}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      await loadMileageLots();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível cancelar o lote.')); }
  }));
}

document.getElementById('mileageLotForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('mileageLotStatus');
  const expiresAt = document.getElementById('mileageLotExpiresAt').value || undefined;
  try {
    await api('/api/admin/finance/mileage-lots', {
      method: 'POST',
      body: JSON.stringify({
        counterpartyId: document.getElementById('mileageLotCounterparty').value,
        program: document.getElementById('mileageLotProgram').value,
        categoryId: document.getElementById('mileageLotCategory').value,
        quantityPurchased: Number(document.getElementById('mileageLotQuantity').value),
        totalCostCents: Number(document.getElementById('mileageLotCost').value),
        currency: document.getElementById('mileageLotCurrency').value.toUpperCase(),
        purchasedAt: document.getElementById('mileageLotPurchasedAt').value,
        dueDate: document.getElementById('mileageLotDueDate').value,
        expiresAt,
      }),
    });
    event.target.reset();
    document.getElementById('mileageLotCurrency').value = 'EUR';
    status.textContent = 'Lote comprado. Obrigação de pagamento criada automaticamente.';
    await loadMileageLots();
    await loadObligations();
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível comprar o lote.'); }
});

const regimeLabels = { accrual: 'Competência', cash: 'Caixa' };
function currentDashboardRange() {
  const from = document.getElementById('dashboardFrom')?.value;
  const to = document.getElementById('dashboardTo')?.value;
  const regime = document.getElementById('dashboardRegime')?.value || 'accrual';
  return { from, to, regime };
}
function updateExportLinks() {
  const { from, to } = currentDashboardRange();
  if (!from || !to) return;
  document.getElementById('exportSalesCsv').href = `/api/admin/finance/dashboard/export.csv?report=sales&from=${from}&to=${to}`;
  document.getElementById('exportObligationsCsv').href = `/api/admin/finance/dashboard/export.csv?report=obligations&from=${from}&to=${to}`;
  document.getElementById('exportReceivablesCsv').href = `/api/admin/finance/dashboard/export.csv?report=receivables&from=${from}&to=${to}`;
}

async function loadDashboard() {
  const { from, to, regime } = currentDashboardRange();
  if (!from || !to) return;
  const status = document.getElementById('dashboardStatus');
  try {
    const overview = await api(`/api/admin/finance/dashboard/overview?from=${from}&to=${to}&regime=${regime}`);
    updateExportLinks();
    const container = document.getElementById('dashboardIndicators');
    if (!overview.indicators.length) { container.innerHTML = '<p class="muted">Sem movimento neste período.</p>'; status.textContent = ''; return; }
    container.innerHTML = overview.indicators.map((item) => {
      const fmt = (cents) => `${(cents / 100).toFixed(2)} ${item.currency}`;
      if (regime === 'accrual') {
        return `<div class="metric"><small>Faturamento bruto (${item.currency})</small><strong>${fmt(item.faturamentoBrutoCents)}</strong></div>
          <div class="metric"><small>Custo direto (${item.currency})</small><strong>${fmt(item.custoDiretoCents)}</strong></div>
          <div class="metric ${item.lucroBrutoCents < 0 ? 'warning' : ''}"><small>Lucro bruto (${item.currency})</small><strong>${fmt(item.lucroBrutoCents)}</strong></div>
          <div class="metric"><small>Margem bruta</small><strong>${item.margemBrutaBps === null ? '-' : (item.margemBrutaBps / 100).toFixed(2) + '%'}</strong></div>
          <div class="metric"><small>Despesas operacionais (${item.currency})</small><strong>${fmt(item.despesasOperacionaisCents)}</strong></div>
          <div class="metric ${item.resultadoOperacionalCents < 0 ? 'warning' : ''}"><small>Resultado operacional (${item.currency})</small><strong>${fmt(item.resultadoOperacionalCents)}</strong></div>`;
      }
      return `<div class="metric"><small>Recebido (${item.currency})</small><strong>${fmt(item.recebidoCents)}</strong></div>
        <div class="metric"><small>Pago (${item.currency})</small><strong>${fmt(item.pagoCents)}</strong></div>
        <div class="metric ${item.saldoCaixaCents < 0 ? 'warning' : ''}"><small>Saldo de caixa (${item.currency})</small><strong>${fmt(item.saldoCaixaCents)}</strong></div>`;
    }).join('');
    status.textContent = `Regime: ${regimeLabels[regime]}.`;
  } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível carregar os indicadores.'); }
}

async function loadDashboardAlerts() {
  const container = document.getElementById('dashboardAlerts');
  try {
    const alerts = await api('/api/admin/finance/dashboard/alerts');
    const sections = [
      ['Contas a pagar vencidas', alerts.overdueObligations.map((item) => `${item.dueDate}: ${(item.amountCents / 100).toFixed(2)} ${item.currency}`)],
      ['Contas a receber vencidas', alerts.overdueReceivables.map((item) => `${item.dueDate}: ${(item.expectedAmountCents / 100).toFixed(2)} ${item.currency}`)],
      ['Vencendo em 7 dias', alerts.upcomingObligations7d.map((item) => `${item.dueDate}: ${(item.amountCents / 100).toFixed(2)} ${item.currency}`)],
      ['Vencendo em 30 dias', alerts.upcomingObligations30d.map((item) => `${item.dueDate}: ${(item.amountCents / 100).toFixed(2)} ${item.currency}`)],
      ['Assinaturas próximas da cobrança', alerts.subscriptionsDueSoon.map((item) => `${escapeHtml(item.service)} — ${item.nextChargeAt}`)],
      ['Vendas com margem baixa/negativa', alerts.salesBelowMarginThreshold.map((item) => `${escapeHtml(item.protocol)}: ${(item.marginBps / 100).toFixed(2)}%`)],
      ['Lotes de milhas com saldo baixo', alerts.mileageLotsLowBalance.map((item) => `${escapeHtml(item.program)}: ${item.balanceQuantity} milhas`)],
      ['Lotes de milhas vencendo em breve', alerts.mileageLotsExpiringSoon.map((item) => `${escapeHtml(item.program)}: ${item.expiresAt}`)],
    ];
    container.innerHTML = sections.map(([title, lines]) => `<div class="panel" style="margin-bottom:10px"><strong>${title}</strong>${lines.length ? `<ul>${lines.map((line) => `<li>${line}</li>`).join('')}</ul>` : '<p class="muted">Nada por aqui.</p>'}</div>`).join('');
  } catch (error) { container.innerHTML = `<p class="muted">${financeErrorMessage(error, 'Não foi possível carregar os alertas.')}</p>`; }
}

document.getElementById('dashboardForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  await loadDashboard();
});

(function initDashboardDefaults() {
  const fromInput = document.getElementById('dashboardFrom');
  const toInput = document.getElementById('dashboardTo');
  if (!fromInput || !toInput) return;
  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  fromInput.value = firstOfMonth;
  toInput.value = today;
})();
