// Financeiro: cadastros, contas a pagar, assinaturas e lotes de milhas. O painel (financeiro-painel.js) importa este
// módulo, chama initCadastros() uma vez e usa `state` para os seletores de conta, fornecedor e categoria.
import { api, askForm, centsToInput, esc, financeErrorMessage, fmtDay, money, today, toCents } from './fin-ui.js';

export const state = { costCenters: [], categories: [], counterparties: [], accounts: [] };
const byId = (id) => document.getElementById(id);

export async function initCadastros() {
  wireForms();
  await loadCostCenters();
  await loadCategories();
  await loadAccounts();
  await loadCounterparties();
  await loadSubscriptions();
  await loadObligations();
  await loadMileageLots();
}

async function loadCostCenters() {
  const result = await api('/api/admin/finance/cost-centers');
  state.costCenters = result.costCenters;
  byId('costCenters').innerHTML = state.costCenters.map((item) => `<tr><td>${esc(item.name)}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" class="small ghost" data-toggle-cost-center="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="3">Nenhum centro de custo cadastrado.</td></tr>';
  const parentSelect = byId('categoryCostCenter');
  const selected = parentSelect.value;
  parentSelect.innerHTML = '<option value="">Nenhum</option>' + state.costCenters.filter((item) => item.active).map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
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
  state.categories = result.categories;
  const nameOf = (id) => state.categories.find((item) => item.id === id)?.name || '-';
  const kindLabel = { revenue: 'Receita', direct_cost: 'Custo direto', operating_expense: 'Despesa operacional' };
  byId('categories').innerHTML = state.categories.map((item) => `<tr><td>${kindLabel[item.kind]}</td><td>${esc(item.name)}</td><td>${item.parentId ? esc(nameOf(item.parentId)) : '-'}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" class="small ghost" data-toggle-category="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma categoria cadastrada.</td></tr>';
  const parentSelect = byId('categoryParent');
  const selected = parentSelect.value;
  parentSelect.innerHTML = '<option value="">Nenhuma</option>' + state.categories.filter((item) => item.active).map((item) => `<option value="${item.id}" data-kind="${item.kind}">${esc(item.name)}</option>`).join('');
  parentSelect.value = selected;
  document.querySelectorAll('[data-toggle-category]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/categories/${button.dataset.toggleCategory}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadCategories();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a categoria.')); }
  }));
  fillSelect('subscriptionCategory', state.categories.filter((item) => item.active && item.kind === 'operating_expense'), 'Nenhuma categoria de despesa operacional cadastrada');
  fillSelect('mileageLotCategory', state.categories.filter((item) => item.active && item.kind === 'direct_cost'), 'Nenhuma categoria de custo direto cadastrada');
  refreshObligationCategoryOptions();
}

function fillSelect(id, items, emptyText, labelKey = 'name') {
  const select = byId(id);
  if (!select) return;
  const previous = select.value;
  select.innerHTML = items.map((item) => `<option value="${item.id}">${esc(item[labelKey])}</option>`).join('') || `<option value="">${emptyText}</option>`;
  select.value = previous;
}
function refreshObligationCategoryOptions() {
  const kind = byId('obligationKind')?.value;
  fillSelect('obligationCategory', state.categories.filter((item) => item.active && item.kind === kind), 'Nenhuma categoria cadastrada para este tipo');
}

async function loadAccounts() {
  const result = await api('/api/admin/finance/accounts');
  state.accounts = result.accounts;
  byId('accounts').innerHTML = state.accounts.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.type)}</td><td>${esc(item.currency)}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" class="small ghost" data-toggle-account="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma conta cadastrada. Crie pelo menos uma para registrar recebimentos e pagamentos.</td></tr>';
  document.querySelectorAll('[data-toggle-account]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/accounts/${button.dataset.toggleAccount}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadAccounts();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a conta.')); }
  }));
}

async function loadCounterparties() {
  const result = await api('/api/admin/finance/counterparties');
  state.counterparties = result.counterparties;
  const kindLabel = { supplier: 'Fornecedor', airline: 'Companhia aérea', consolidator: 'Consolidadora', mileage_provider: 'Fornecedor de milhas', other: 'Outro' };
  byId('counterparties').innerHTML = state.counterparties.map((item) => `<tr><td>${esc(item.displayName)}</td><td>${kindLabel[item.kind] || esc(item.kind)}</td><td>${esc(item.preferredCurrency || '-')}</td><td>${item.active ? 'Sim' : 'Não'}</td><td><button type="button" class="small ghost" data-toggle-counterparty="${item.id}" data-active="${item.active}">${item.active ? 'Desativar' : 'Ativar'}</button></td></tr>`).join('') || '<tr><td colspan="5">Nenhuma contraparte cadastrada.</td></tr>';
  document.querySelectorAll('[data-toggle-counterparty]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/admin/finance/counterparties/${button.dataset.toggleCounterparty}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
      await loadCounterparties();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível atualizar a contraparte.')); }
  }));
  const active = state.counterparties.filter((item) => item.active);
  fillSelect('subscriptionCounterparty', active, 'Nenhuma contraparte cadastrada', 'displayName');
  fillSelect('mileageLotCounterparty', active.filter((item) => item.kind === 'mileage_provider'), 'Nenhum fornecedor de milhas cadastrado', 'displayName');
  const obligationSelect = byId('obligationCounterparty');
  const previous = obligationSelect.value;
  obligationSelect.innerHTML = '<option value="">Nenhuma</option>' + active.map((item) => `<option value="${item.id}">${esc(item.displayName)}</option>`).join('');
  obligationSelect.value = previous;
}

const subscriptionStatusLabels = { trial: 'Em teste', active: 'Ativa', suspended: 'Suspensa', canceled: 'Cancelada', ended: 'Encerrada' };
const periodicityLabels = { monthly: 'Mensal', quarterly: 'Trimestral', semiannual: 'Semestral', annual: 'Anual', custom: 'Personalizada' };
const obligationStatusLabels = { open: 'Aberta', partial: 'Parcial', paid: 'Paga', canceled: 'Cancelada', reversed: 'Estornada' };

async function loadSubscriptions() {
  const result = await api('/api/admin/finance/subscriptions');
  byId('subscriptions').innerHTML = result.subscriptions.map((item) => `<tr>
      <td>${esc(item.service)}</td>
      <td class="num">${money(item.amountCents, item.currency)}</td>
      <td>${periodicityLabels[item.periodicity] || esc(item.periodicity)}</td>
      <td>${fmtDay(item.nextChargeAt)}</td>
      <td>${subscriptionStatusLabels[item.status] || esc(item.status)}</td>
      <td><div class="row-actions">
        <button type="button" class="small ghost" data-reprice="${item.id}" data-currency="${item.currency}" data-amount="${item.amountCents}">Reajustar</button>
        ${item.status === 'trial' ? `<button type="button" class="small ghost" data-sub-status="${item.id}" data-target="active">Ativar</button>` : ''}
        ${item.status === 'active' ? `<button type="button" class="small ghost" data-sub-status="${item.id}" data-target="suspended">Suspender</button>` : ''}
        ${item.status === 'suspended' ? `<button type="button" class="small ghost" data-sub-status="${item.id}" data-target="active">Reativar</button>` : ''}
        ${item.status !== 'canceled' && item.status !== 'ended' ? `<button type="button" class="small ghost" data-sub-status="${item.id}" data-target="canceled">Cancelar</button>` : ''}
      </div></td>
    </tr>`).join('') || '<tr><td colspan="6">Nenhuma assinatura cadastrada.</td></tr>';

  document.querySelectorAll('[data-reprice]').forEach((button) => button.addEventListener('click', async () => {
    const values = await askForm({
      title: 'Reajustar assinatura', submitLabel: 'Reajustar',
      fields: [
        { name: 'amount', label: `Novo valor (${button.dataset.currency})`, type: 'money', value: centsToInput(button.dataset.amount), required: true },
        { name: 'effectiveAt', label: 'Vale a partir de', type: 'date', value: today(), required: true },
      ],
    });
    if (!values) return;
    try {
      await api(`/api/admin/finance/subscriptions/${button.dataset.reprice}/reprice`, { method: 'POST', body: JSON.stringify({ amountCents: values.amount, currency: button.dataset.currency, effectiveAt: values.effectiveAt }) });
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

export async function loadObligations() {
  const result = await api('/api/admin/finance/obligations');
  byId('obligations').innerHTML = result.obligations.map((item) => `<tr>
      <td>${esc(state.categories.find((category) => category.id === item.categoryId)?.name || '-')}</td>
      <td>${fmtDay(item.dueDate)}${item.isOverdue ? ' <span class="tag tag-void">vencida</span>' : ''}</td>
      <td class="num">${money(item.amountCents, item.currency)}</td>
      <td>${obligationStatusLabels[item.status] || esc(item.status)}</td>
      <td><div class="row-actions">
        ${item.status === 'open' || item.status === 'partial' ? `<button type="button" class="small" data-pay="${item.id}" data-currency="${item.currency}" data-amount="${item.amountCents}">Registrar pagamento</button>` : ''}
        ${item.status === 'open' ? `<button type="button" class="small ghost" data-cancel-obligation="${item.id}">Cancelar</button>` : ''}
        <button type="button" class="small ghost" data-view-payments="${item.id}">Ver pagamentos</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="5">Nenhuma conta a pagar cadastrada.</td></tr>';

  document.querySelectorAll('[data-pay]').forEach((button) => button.addEventListener('click', async () => {
    const active = state.accounts.filter((account) => account.active);
    const accounts = [...active.filter((account) => account.currency === button.dataset.currency), ...active.filter((account) => account.currency !== button.dataset.currency)];
    if (!accounts.length) { alert('Cadastre uma conta (aba Cadastros) antes de registrar um pagamento.'); return; }
    const values = await askForm({
      title: 'Registrar pagamento', submitLabel: 'Registrar',
      fields: [
        { name: 'amount', label: `Valor pago (${button.dataset.currency})`, type: 'money', value: centsToInput(button.dataset.amount), required: true },
        { name: 'accountId', label: 'Pago pela conta', type: 'select', options: accounts.map((account) => ({ value: account.id, label: `${account.name} (${account.currency})` })), value: accounts[0].id },
        { name: 'accountAmount', label: 'Valor que saiu da conta (só se a conta for em outra moeda)', type: 'money', hint: 'Ex.: o valor em R$ debitado no Mercado Pago.', wide: true },
        { name: 'paidAt', label: 'Data do pagamento', type: 'date', value: today(), required: true },
      ],
    });
    if (!values) return;
    const account = accounts.find((item) => item.id === values.accountId);
    const differentCurrency = account && account.currency !== button.dataset.currency;
    if (differentCurrency && !values.accountAmount) { alert(`A conta "${account.name}" é em ${account.currency}. Informe o valor que saiu da conta.`); return; }
    try {
      await api(`/api/admin/finance/obligations/${button.dataset.pay}/payments`, { method: 'POST', body: JSON.stringify({ paidAmountCents: values.amount, currency: button.dataset.currency, accountId: values.accountId, paidAt: `${values.paidAt}T12:00:00Z`, accountAmountCents: differentCurrency ? values.accountAmount : undefined }) });
      await loadObligations();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível registrar o pagamento.')); }
  }));
  document.querySelectorAll('[data-cancel-obligation]').forEach((button) => button.addEventListener('click', async () => {
    const values = await askForm({ title: 'Cancelar conta a pagar', submitLabel: 'Cancelar conta', danger: true, fields: [{ name: 'reason', label: 'Motivo', type: 'text', required: true, wide: true }] });
    if (!values) return;
    try {
      await api(`/api/admin/finance/obligations/${button.dataset.cancelObligation}/cancel`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) });
      await loadObligations();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível cancelar a conta.')); }
  }));
  document.querySelectorAll('[data-view-payments]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const payments = await api(`/api/admin/finance/obligations/${button.dataset.viewPayments}/payments`);
      const lines = payments.payments.map((payment) => `${fmtDay(payment.createdAt)}: ${money(payment.paidAmountCents, payment.currency)}${payment.reversalOf ? ' (estorno)' : ''}`);
      alert(lines.join('\n') || 'Nenhum pagamento registrado ainda.');
    } catch { alert('Não foi possível carregar os pagamentos.'); }
  }));
}

const mileageLotStatusLabels = { active: 'Ativo', depleted: 'Esgotado', expired: 'Vencido', canceled: 'Cancelado' };

export async function loadMileageLots() {
  const result = await api('/api/admin/finance/mileage-lots');
  byId('mileageLots').innerHTML = result.mileageLots.map((item) => `<tr>
      <td>${esc(state.counterparties.find((counterparty) => counterparty.id === item.counterpartyId)?.displayName || '-')}</td>
      <td>${esc(item.program)}</td>
      <td class="num">${item.balanceQuantity.toLocaleString('pt-BR')} / ${item.quantityPurchased.toLocaleString('pt-BR')}</td>
      <td class="num">${money(Number(item.unitCostMicros) / 1000, item.currency)}</td>
      <td>${mileageLotStatusLabels[item.status] || esc(item.status)}${item.isExpired ? ' (vencido)' : ''}</td>
      <td>${item.status !== 'canceled' && item.balanceQuantity === item.quantityPurchased ? `<button type="button" class="small ghost" data-cancel-lot="${item.id}">Cancelar</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6">Nenhum lote cadastrado.</td></tr>';

  document.querySelectorAll('[data-cancel-lot]').forEach((button) => button.addEventListener('click', async () => {
    const values = await askForm({ title: 'Cancelar lote de milhas', submitLabel: 'Cancelar lote', danger: true, fields: [{ name: 'reason', label: 'Motivo', type: 'text', required: true, wide: true }] });
    if (!values) return;
    try {
      await api(`/api/admin/finance/mileage-lots/${button.dataset.cancelLot}/cancel`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) });
      await loadMileageLots();
    } catch (error) { alert(financeErrorMessage(error, 'Não foi possível cancelar o lote.')); }
  }));
}

function wireForms() {
  byId('obligationKind')?.addEventListener('change', refreshObligationCategoryOptions);

  const submit = (id, statusId, run) => byId(id)?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = byId(statusId);
    try { await run(event.target, status); } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível salvar.'); }
  });

  submit('costCenterForm', 'costCenterStatus', async (form, status) => {
    await api('/api/admin/finance/cost-centers', { method: 'POST', body: JSON.stringify({ name: byId('costCenterName').value }) });
    form.reset(); status.textContent = 'Centro de custo criado.'; await loadCostCenters();
  });
  submit('categoryForm', 'categoryStatus', async (form, status) => {
    await api('/api/admin/finance/categories', { method: 'POST', body: JSON.stringify({ kind: byId('categoryKind').value, name: byId('categoryName').value, parentId: byId('categoryParent').value || undefined, defaultCostCenterId: byId('categoryCostCenter').value || undefined }) });
    form.reset(); status.textContent = 'Categoria criada.'; await loadCategories();
  });
  submit('accountForm', 'accountStatus', async (form, status) => {
    const openingText = byId('accountOpening').value.trim();
    const openingCents = openingText ? toCents(openingText) : null;
    const openingAt = byId('accountOpeningAt').value;
    if (openingText && openingCents === null) { status.textContent = 'Saldo inicial inválido. Use por exemplo 3250,00.'; return; }
    if (Boolean(openingText) !== Boolean(openingAt)) { status.textContent = 'Para o saldo inicial, informe o valor e a data juntos.'; return; }
    await api('/api/admin/finance/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: byId('accountName').value, type: byId('accountType').value, currency: byId('accountCurrency').value,
        institution: byId('accountInstitution').value || undefined, last4: byId('accountLast4').value || undefined,
        openingBalanceCents: openingCents ?? undefined, openingBalanceAt: openingAt || undefined,
      }),
    });
    form.reset(); status.textContent = 'Conta criada.'; await loadAccounts();
  });
  submit('counterpartyForm', 'counterpartyStatus', async (form, status) => {
    await api('/api/admin/finance/counterparties', { method: 'POST', body: JSON.stringify({ displayName: byId('counterpartyName').value, kind: byId('counterpartyKind').value, preferredCurrency: byId('counterpartyCurrency').value || undefined }) });
    form.reset(); status.textContent = 'Contraparte criada.'; await loadCounterparties();
  });
  submit('subscriptionForm', 'subscriptionStatus', async (form, status) => {
    const amountCents = toCents(byId('subscriptionAmount').value);
    if (!amountCents || amountCents < 1) { status.textContent = 'Informe um valor válido, por exemplo 29,90.'; return; }
    const periodicity = byId('subscriptionPeriodicity').value;
    await api('/api/admin/finance/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        counterpartyId: byId('subscriptionCounterparty').value, categoryId: byId('subscriptionCategory').value, service: byId('subscriptionService').value,
        amountCents, currency: byId('subscriptionCurrency').value, periodicity,
        customIntervalDays: periodicity === 'custom' ? Number(byId('subscriptionCustomDays').value) : undefined, startedAt: byId('subscriptionStartedAt').value,
      }),
    });
    form.reset(); status.textContent = 'Assinatura criada.'; await loadSubscriptions();
  });
  submit('obligationForm', 'obligationStatus', async (form, status) => {
    const amountCents = toCents(byId('obligationAmount').value);
    if (!amountCents || amountCents < 1) { status.textContent = 'Informe um valor válido, por exemplo 120,50.'; return; }
    await api('/api/admin/finance/obligations', {
      method: 'POST',
      body: JSON.stringify({
        kind: byId('obligationKind').value, categoryId: byId('obligationCategory').value, counterpartyId: byId('obligationCounterparty').value || undefined,
        competencyDate: byId('obligationCompetencyDate').value, dueDate: byId('obligationDueDate').value, amountCents, currency: byId('obligationCurrency').value,
      }),
    });
    form.reset(); status.textContent = 'Conta a pagar criada.'; refreshObligationCategoryOptions(); await loadObligations();
  });
  submit('mileageLotForm', 'mileageLotStatus', async (form, status) => {
    const totalCostCents = toCents(byId('mileageLotCost').value);
    if (!totalCostCents || totalCostCents < 1) { status.textContent = 'Informe o custo total do lote, por exemplo 850,00.'; return; }
    await api('/api/admin/finance/mileage-lots', {
      method: 'POST',
      body: JSON.stringify({
        counterpartyId: byId('mileageLotCounterparty').value, program: byId('mileageLotProgram').value, categoryId: byId('mileageLotCategory').value,
        quantityPurchased: Number(byId('mileageLotQuantity').value), totalCostCents, currency: byId('mileageLotCurrency').value,
        purchasedAt: byId('mileageLotPurchasedAt').value, dueDate: byId('mileageLotDueDate').value, expiresAt: byId('mileageLotExpiresAt').value || undefined,
      }),
    });
    form.reset(); status.textContent = 'Lote comprado. A conta a pagar ao fornecedor foi criada sozinha.'; await loadMileageLots(); await loadObligations();
  });
  // Atalhos na própria tela de Milhas: quem ainda não cadastrou fornecedor ou categoria não precisa procurar em Cadastros.
  byId('newMileageProviderBtn')?.addEventListener('click', async () => {
    const status = byId('mileageLotStatus');
    const values = await askForm({
      title: 'Novo fornecedor de milhas', submitLabel: 'Cadastrar',
      intro: 'De quem você comprou as milhas ou os pontos. Ex.: Livelo, se você comprou pontos Livelo e transferiu para a LATAM.',
      fields: [{ name: 'name', label: 'Nome do fornecedor', type: 'text', required: true, placeholder: 'Livelo', wide: true }],
    });
    if (!values) return;
    try {
      const created = await api('/api/admin/finance/counterparties', { method: 'POST', body: JSON.stringify({ displayName: values.name, kind: 'mileage_provider' }) });
      await loadCounterparties();
      byId('mileageLotCounterparty').value = created.id;
      status.textContent = `Fornecedor "${values.name}" cadastrado e escolhido.`;
    } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível cadastrar o fornecedor.'); }
  });
  byId('newMileageCategoryBtn')?.addEventListener('click', async () => {
    const status = byId('mileageLotStatus');
    try {
      const existing = state.categories.find((item) => item.active && item.kind === 'direct_cost' && item.name === 'Compra de milhas');
      const created = existing || await api('/api/admin/finance/categories', { method: 'POST', body: JSON.stringify({ kind: 'direct_cost', name: 'Compra de milhas' }) });
      await loadCategories();
      byId('mileageLotCategory').value = created.id;
      status.textContent = 'Categoria "Compra de milhas" pronta e escolhida.';
    } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível criar a categoria.'); }
  });
  byId('generateChargesButton')?.addEventListener('click', async () => {
    const status = byId('generateChargesStatus');
    try {
      const result = await api('/api/admin/finance/subscriptions/generate-charges', { method: 'POST' });
      status.textContent = `Assinaturas vencidas: ${result.subscriptionsDue}. Cobranças criadas: ${result.created}. Já existentes: ${result.skipped}.`;
      await loadObligations(); await loadSubscriptions();
    } catch (error) { status.textContent = financeErrorMessage(error, 'Não foi possível gerar as cobranças.'); }
  });
}
