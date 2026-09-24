const cookie = (name) => document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
async function api(path, options={}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('content-type','application/json');
  if ((options.method || 'GET') !== 'GET') headers.set('x-csrf-token',cookie('rc_csrf'));
  const response = await fetch(path,{...options,headers,credentials:'same-origin'});
  const body = await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(body.error||'request_failed'),{status:response.status});
  return body;
}

// Maps a specific backend error code (never the raw code itself, and never any other internal
// detail) to a clear, actionable message in Portuguese. Falls back to a generic message for any
// code not explicitly listed here — the fallback is passed in by each call site so it stays
// contextual to the action that failed.
const financialErrorMessages = {
  commission_paid_immutable: 'Esta proposta já tem uma comissão paga e não pode ser alterada por aqui. Um ajuste financeiro precisa ser feito separadamente.',
  commission_paid_requires_adjustment: 'Uma comissão já paga não pode ser anulada diretamente. Um ajuste financeiro precisa ser feito separadamente.',
  commission_void_reason_required: 'É necessário informar o motivo para anular a comissão ativa desta proposta.',
  sale_amount_required: 'Informe o valor da venda: a regra de comissão deste parceiro é percentual.',
  sale_amount_locked: 'O valor da venda já está definido para esta proposta. Anule a comissão atual para poder alterá-lo.',
  sale_currency_must_match_partner_currency: 'A moeda da venda precisa ser a mesma moeda configurada para este parceiro.',
  currency_locked_existing_commissions: 'Não é possível mudar a moeda deste parceiro: já existem comissões registradas nela.',
  email_already_used_by_partner: 'Este e-mail já está sendo usado por outro parceiro.',
  email_linked_to_other_partner: 'Este e-mail já está vinculado à conta de outro parceiro.',
  code_already_used: 'Já existe um parceiro com esse código.',
  code_or_email_already_used: 'O código ou e-mail informado já está em uso por outro parceiro.',
  invalid_currency: 'Moeda inválida. Escolha EUR, USD, BRL ou GBP.',
  invalid_partner: 'Dados inválidos. Confira os campos obrigatórios.',
  invalid_partner_program_settings: 'A regra é inválida. Confira percentuais e limites crescentes das faixas.',
  partner_inactive: 'Este parceiro está desativado. Ative-o antes de enviar um novo convite.',
  invalid_transition: 'Esta comissão não está mais no estado esperado para essa ação. Atualize a página e tente novamente.',
};
function financialErrorMessage(error, fallback) {
  return financialErrorMessages[error?.message] || fallback;
}
const fmtDate=(value)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'-';
const fmtDay=(value)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeZone:'UTC'}).format(new Date(`${String(value).slice(0,10)}T00:00:00Z`)):'-';
const fmtMoney=(cents,currency='EUR')=>cents==null?'A partir de 49,99 €':new Intl.NumberFormat('pt-PT',{style:'currency',currency}).format(cents/100);
const statusLabels={new:'Nova',reviewing:'Em análise',awaiting_customer:'Aguardando cliente',ready:'Proposta pronta',sent:'Enviada',converted:'Convertida',lost:'Não convertida',canceled:'Cancelada',closed:'Encerrada'};
const commissionLabels={pending:'Pendente',approved:'Aprovada',paid:'Paga',void:'Anulada'};
let currentLeads=[];
let currentPartners=[];
let currentPartnerApplications=[];
let selectedPartnerApplicationId=null;

try {
  const session=await api('/api/auth/session');
  if(!session.user.roles.includes('master')) throw Object.assign(new Error('forbidden'),{status:403});
  const [overview,users,plans,payments]=await Promise.all([api('/api/admin/overview'),api('/api/admin/users'),api('/api/admin/plans'),api('/api/admin/payments')]);
  document.getElementById('accessMessage').classList.add('hidden');
  document.getElementById('adminContent').classList.remove('hidden');
  document.getElementById('metrics').innerHTML=`<div class="metric"><small>Propostas novas</small><strong>${overview.new_leads}</strong></div><div class="metric ${overview.overdue_leads?'warning':''}"><small>Prazo vencido</small><strong>${overview.overdue_leads}</strong></div><div class="metric"><small>Usuários</small><strong>${overview.users}</strong></div><div class="metric"><small>Acessos ativos</small><strong>${overview.active_access}</strong></div>`;
  document.getElementById('users').innerHTML=users.users.map((u)=>`<tr><td>${escapeHtml(u.display_name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.status)}</td><td>${escapeHtml((u.roles||[]).join(', '))}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('');
  document.getElementById('plans').innerHTML=plans.plans.map((p)=>`<tr><td>${escapeHtml(p.name)}</td><td>${fmtMoney(p.price_cents,p.currency)}</td><td>${p.duration_days?`${p.duration_days} dias`:'Proposta'}</td><td>${p.checkout_enabled?'Sandbox':'Manual'}</td></tr>`).join('');
  document.getElementById('payments').innerHTML=payments.payments.map((p)=>`<tr><td>${fmtDate(p.created_at)}</td><td>${escapeHtml(p.email)}</td><td>${escapeHtml(p.plan_code||'-')}</td><td>${fmtMoney(p.amount_cents,p.currency)}</td><td>${escapeHtml(p.status)}</td></tr>`).join('')||'<tr><td colspan="5">Nenhum pagamento registrado.</td></tr>';
  await loadPartners();
  await loadPartnerProgramSettings();
  await loadPartnerApplications();
  await loadLeads();
} catch(error) {
  document.querySelector('#accessMessage p').textContent=error.status===403?'Sua conta não tem permissão master.':'Entre primeiro pela Área do cliente com uma conta master.';
}

document.getElementById('leadFilter')?.addEventListener('change',()=>loadLeads());
document.getElementById('leadPartnerFilter')?.addEventListener('change',()=>loadLeads());

async function loadPartners(){
  const result=await api('/api/admin/partners');
  currentPartners=result.partners;
  const filterSelect=document.getElementById('leadPartnerFilter');
  const currentFilter=filterSelect.value;
  filterSelect.innerHTML='<option value="">Todos</option>'+currentPartners.map((p)=>`<option value="${p.id}">${escapeHtml(p.displayName)} (${escapeHtml(p.code)})</option>`).join('');
  filterSelect.value=currentFilter;
  document.getElementById('partners').innerHTML=currentPartners.length?currentPartners.map(renderPartnerRow).join(''):'<tr><td colspan="11">Nenhum parceiro cadastrado.</td></tr>';
}

async function loadPartnerApplications(){
  const result=await api('/api/admin/partner-applications');
  currentPartnerApplications=result.applications;
  const container=document.getElementById('partnerApplications');
  container.innerHTML=currentPartnerApplications.length?currentPartnerApplications.map(renderPartnerApplication).join(''):'<p class="muted">Nenhuma solicitação recebida.</p>';
}

function renderPartnerApplication(application){
  const statusLabel={pending:'Pendente',accepted:'Aceita',rejected:'Recusada'}[application.status]||application.status;
  const actions=application.status==='pending'?`<div class="lead-actions"><button type="button" data-use-application="${application.id}">Usar no cadastro</button><button type="button" data-reject-application="${application.id}">Recusar</button></div>`:'';
  return `<article class="lead-card"><div class="lead-title"><div><span class="protocol">${escapeHtml(statusLabel)}</span><h3>${escapeHtml(application.displayName)}</h3></div><span class="muted">${fmtDate(application.createdAt)}</span></div><div class="lead-details"><div><small>E-mail</small><strong>${escapeHtml(application.email)}</strong></div><div><small>Instagram</small><strong>${escapeHtml(application.instagram||'-')}</strong></div><div><small>WhatsApp</small><strong>${escapeHtml(application.whatsapp||'-')}</strong><small>Privacidade: ${escapeHtml(application.privacyPolicyVersion||'-')} · ${fmtDate(application.privacyConsentAt)}</small></div></div>${actions}</article>`;
}

document.getElementById('partnerApplications')?.addEventListener('click',async(event)=>{
  const use=event.target.closest('[data-use-application]');
  const reject=event.target.closest('[data-reject-application]');
  const statusEl=document.getElementById('partnerApplicationsStatus');
  if(use){
    const application=currentPartnerApplications.find((item)=>item.id===use.dataset.useApplication);
    if(!application)return;
    selectedPartnerApplicationId=application.id;
    document.getElementById('partnerDisplayName').value=application.displayName;
    document.getElementById('partnerEmail').value=application.email;
    document.getElementById('partnerInstagram').value=application.instagram||'';
    document.getElementById('partnerWhatsapp').value=application.whatsapp||'';
    const suggested=(application.instagram||application.displayName).replace(/^@/,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,32);
    if(suggested.length>=3)document.getElementById('partnerCode').value=suggested;
    document.getElementById('partnerFormStatus').textContent='Dados recuperados da solicitação. Confira o código; a regra global de comissão será aplicada automaticamente.';
    document.getElementById('partnerForm').scrollIntoView({behavior:'smooth',block:'start'});
  }else if(reject){
    try{
      await api(`/api/admin/partner-applications/${reject.dataset.rejectApplication}/reject`,{method:'POST'});
      statusEl.textContent='Solicitação marcada como recusada.';
      await loadPartnerApplications();
    }catch(error){statusEl.textContent='Não foi possível recusar esta solicitação.';}
  }
});

function commissionLabel(type,fixedCents,percentageBps,currency){
  return 'Regra global';
}

async function loadPartnerProgramSettings(){
  const {settings}=await api('/api/admin/partner-program/settings');
  document.getElementById('programMode').value=settings.mode;
  document.getElementById('programFlatRate').value=(settings.flatBps/100).toFixed(2);
  document.getElementById('programTier1Max').value=settings.tier1MaxPassengers;
  document.getElementById('programTier1Rate').value=(settings.tier1Bps/100).toFixed(2);
  document.getElementById('programTier2Max').value=settings.tier2MaxPassengers;
  document.getElementById('programTier2Rate').value=(settings.tier2Bps/100).toFixed(2);
  document.getElementById('programTier3Max').value=settings.tier3MaxPassengers;
  document.getElementById('programTier3Rate').value=(settings.tier3Bps/100).toFixed(2);
  document.getElementById('programTier4Rate').value=(settings.tier4Bps/100).toFixed(2);
}

document.getElementById('partnerProgramForm')?.addEventListener('submit',async(event)=>{
  event.preventDefault();const status=document.getElementById('partnerProgramStatus');
  const percent=(id)=>Math.round(Number(document.getElementById(id).value||0)*100);
  const payload={mode:document.getElementById('programMode').value,flatBps:percent('programFlatRate'),tier1MaxPassengers:Number(document.getElementById('programTier1Max').value),tier1Bps:percent('programTier1Rate'),tier2MaxPassengers:Number(document.getElementById('programTier2Max').value),tier2Bps:percent('programTier2Rate'),tier3MaxPassengers:Number(document.getElementById('programTier3Max').value),tier3Bps:percent('programTier3Rate'),tier4Bps:percent('programTier4Rate')};
  try{await api('/api/admin/partner-program/settings',{method:'PATCH',body:JSON.stringify(payload)});status.textContent='Regra global salva. Ela será usada nas próximas conversões; o histórico não muda.';await loadPartnerProgramSettings();}
  catch(error){status.textContent=financialErrorMessage(error,'Não foi possível salvar a regra.');}
});

function renderPartnerRow(p){
  return `<tr>
    <td>${escapeHtml(p.code)}</td>
    <td>${escapeHtml(p.displayName)}</td>
    <td>${commissionLabel(p.commissionType,p.commissionFixedCents,p.commissionPercentageBps,p.currency)}</td>
    <td>${p.clicks??0}</td><td>${p.proposals??0}</td><td>${p.conversions??0}</td>
    <td>${fmtMoney(p.commissionPendingCents,p.currency)}</td>
    <td>${fmtMoney(p.commissionApprovedCents,p.currency)}</td>
    <td>${fmtMoney(p.commissionPaidCents,p.currency)}</td>
    <td>${p.active?'Sim':'Não'}</td>
    <td class="partner-actions">
      <button type="button" data-toggle-partner="${p.id}" data-next-active="${p.active?'false':'true'}">${p.active?'Desativar':'Ativar'}</button>
      <button type="button" data-copy-link="${escapeHtml(p.code)}">Copiar link</button>
      ${p.accountActivated?'<span class="muted">Ativado</span>':`<button type="button" data-invite-partner="${p.id}">${p.hasAccount?'Reenviar convite':'Convidar'}</button>`}
    </td>
  </tr>`;
}

document.getElementById('partners')?.addEventListener('click',async(event)=>{
  const toggle=event.target.closest('[data-toggle-partner]');
  const copy=event.target.closest('[data-copy-link]');
  const invite=event.target.closest('[data-invite-partner]');
  const statusEl=document.getElementById('partnersStatus');
  try{
    if(toggle){
      await api(`/api/admin/partners/${toggle.dataset.togglePartner}`,{method:'PATCH',body:JSON.stringify({active:toggle.dataset.nextActive==='true'})});
      statusEl.textContent='Parceiro atualizado.';
      await loadPartners();
    } else if(copy){
      await navigator.clipboard.writeText(`${location.origin}/i/${copy.dataset.copyLink}`);
      statusEl.textContent='Link copiado.';
    } else if(invite){
      await api(`/api/admin/partners/${invite.dataset.invitePartner}/invite`,{method:'POST'});
      statusEl.textContent='Convite enviado por e-mail.';
      await loadPartners();
    }
  }catch(error){statusEl.textContent=financialErrorMessage(error,'Não foi possível concluir a ação.');}
});

document.getElementById('partnerForm')?.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const status=document.getElementById('partnerFormStatus');
  const payload={
    ...(selectedPartnerApplicationId?{applicationId:selectedPartnerApplicationId}:{}),
    code:document.getElementById('partnerCode').value,
    displayName:document.getElementById('partnerDisplayName').value,
    email:document.getElementById('partnerEmail').value,
    instagram:document.getElementById('partnerInstagram').value,
    whatsapp:document.getElementById('partnerWhatsapp').value,
    currency:document.getElementById('partnerCurrency').value||'EUR',
    commissionType:'percentage',
    commissionPercentageBps:200,
    attributionWindowDays:Number(document.getElementById('partnerWindow').value)||30,
  };
  try{
    const created=await api('/api/admin/partners',{method:'POST',body:JSON.stringify(payload)});
    event.target.reset();
    document.getElementById('partnerCurrency').value='EUR';
    document.getElementById('partnerWindow').value='30';
    try{
      await api(`/api/admin/partners/${created.id}/invite`,{method:'POST'});
      status.textContent='Parceiro criado e convite enviado por e-mail.';
    }catch(inviteError){
      status.textContent='Parceiro criado, mas o convite não foi enviado. Use “Reenviar convite” na lista.';
    }
    selectedPartnerApplicationId=null;
    await loadPartners();
    await loadPartnerApplications();
  }catch(error){status.textContent=financialErrorMessage(error,'Não foi possível criar o parceiro. Confira os dados.');}
});
document.getElementById('leads')?.addEventListener('click',async(event)=>{
  const commissionButton=event.target.closest('[data-commission-action]');
  if(commissionButton){
    const card=commissionButton.closest('.lead-card');
    const feedback=card.querySelector('.lead-feedback');
    commissionButton.disabled=true;
    try{
      await api(`/api/admin/commissions/${commissionButton.dataset.commissionId}/${commissionButton.dataset.commissionAction}`,{method:'POST'});
      feedback.textContent='Comissão atualizada.';
      await loadLeads();await loadPartners();
    }catch(error){feedback.textContent=financialErrorMessage(error,'Não foi possível atualizar a comissão.');commissionButton.disabled=false;}
    return;
  }
  const button=event.target.closest('[data-save-lead]');
  if(!button)return;
  const card=button.closest('.lead-card');
  button.disabled=true;
  const feedback=card.querySelector('.lead-feedback');
  const status=card.querySelector('[data-lead-status]').value;
  const payload={status,internalNotes:card.querySelector('[data-lead-notes]').value,assignToMe:card.querySelector('[data-lead-assign]').checked};
  if(status==='converted'&&card.dataset.partnerId){
    const amount=card.querySelector('[data-sale-amount]').value;
    const currency=card.querySelector('[data-sale-currency]').value;
    if(amount)payload.saleAmountCents=Math.round(Number(amount)*100);
    if(currency)payload.saleCurrency=currency;
  }
  try{
    const result=await api(`/api/admin/leads/${button.dataset.saveLead}`,{method:'PATCH',body:JSON.stringify(payload)});
    feedback.textContent=result.commissionPreview?`Proposta atualizada. Comissão: ${fmtMoney(result.commissionPreview.amountCents,result.commissionPreview.currency)}.`:'Proposta atualizada.';
    await loadLeads();
    await loadPartners();
  }catch(error){
    if(error.message==='commission_void_reason_required'){
      const reason=prompt('Esta proposta já tem uma comissão ativa. Descreva o motivo para anular a comissão e mudar o status (mínimo 3 caracteres):');
      if(reason&&reason.trim().length>=3){
        try{
          await api(`/api/admin/leads/${button.dataset.saveLead}`,{method:'PATCH',body:JSON.stringify({...payload,voidCommissionReason:reason.trim()})});
          feedback.textContent='Proposta atualizada e comissão anulada com o motivo informado.';
          await loadLeads();await loadPartners();
        }catch(retryError){feedback.textContent=financialErrorMessage(retryError,'Não foi possível salvar a alteração.');}
      } else feedback.textContent='Alteração cancelada: é necessário informar o motivo para anular a comissão.';
    } else if(error.message==='sale_amount_required'||error.status===422){
      feedback.textContent=financialErrorMessage(error,'Informe o valor da venda e a moeda: a regra deste parceiro é percentual.');
    } else {
      feedback.textContent=financialErrorMessage(error,'Não foi possível salvar a alteração.');
    }
  } finally { button.disabled=false; }
});

async function loadLeads(){
  const filter=document.getElementById('leadFilter')?.value||'';
  const partnerId=document.getElementById('leadPartnerFilter')?.value||'';
  const params=new URLSearchParams();
  if(filter)params.set('status',filter);
  if(partnerId)params.set('partnerId',partnerId);
  const query=params.toString();
  const result=await api(`/api/admin/leads${query?`?${query}`:''}`);
  currentLeads=result.leads;
  document.getElementById('leads').innerHTML=currentLeads.length?currentLeads.map(renderLead).join(''):'<p class="muted">Nenhuma proposta encontrada.</p>';
}

function renderLead(lead){
  const overdue=lead.deadline_at && new Date(lead.deadline_at)<new Date() && !['sent','converted','lost','canceled','closed'].includes(lead.status);
  const options=Object.entries(statusLabels).map(([value,label])=>`<option value="${value}" ${lead.status===value?'selected':''}>${label}</option>`).join('');
  const originLabel=lead.partner_code?`${escapeHtml(lead.partner_display_name||lead.partner_code)} (${escapeHtml(lead.partner_code)})`:'Direto';
  const commissionActions=lead.commission_status==='pending'?`<button type="button" data-commission-action="approve" data-commission-id="${lead.commission_id||''}">Aprovar comissão</button>`
    :lead.commission_status==='approved'?`<button type="button" data-commission-action="pay" data-commission-id="${lead.commission_id||''}">Marcar como paga</button>`:'';
  const commissionInfo=lead.commission_status?`<span>Comissão: ${fmtMoney(lead.commission_amount_cents,lead.commission_currency)} · ${escapeHtml(commissionLabels[lead.commission_status]||lead.commission_status)} ${commissionActions}</span>`:'';
  return `<article class="lead-card ${overdue?'overdue':''}" data-partner-id="${lead.partner_id||''}"><div class="lead-title"><div><span class="protocol">${escapeHtml(lead.protocol)}</span><h3>${escapeHtml(lead.origin)} → ${escapeHtml(lead.destination)}</h3></div><span class="deadline">${overdue?'Prazo vencido':'Responder até'}<strong>${fmtDate(lead.deadline_at)}</strong></span></div><div class="lead-details"><div><small>Cliente</small><strong>${escapeHtml(lead.customer_name)}</strong><a href="mailto:${encodeURIComponent(lead.customer_email)}">${escapeHtml(lead.customer_email)}</a><span>${escapeHtml(lead.customer_phone)}</span></div><div><small>Viagem</small><strong>${fmtDay(lead.outbound_on)}${lead.return_on?` — ${fmtDay(lead.return_on)}`:''}</strong><span>${lead.adults} adulto(s), ${lead.children} criança(s), ${lead.infants} bebê(s)</span><span>${escapeHtml(lead.trip_type)} · ${escapeHtml(lead.cabin_class)}</span></div><div><small>Origem</small><span>${originLabel}</span>${commissionInfo}</div></div>${lead.notes?`<p class="customer-notes"><strong>Observações:</strong> ${escapeHtml(lead.notes)}</p>`:''}<div class="lead-actions"><label>Status<select data-lead-status>${options}</select></label><label class="sale-amount hidden" data-sale-fields>Valor da venda<input type="number" min="0" step="0.01" data-sale-amount value="${lead.sale_amount_cents!=null?(lead.sale_amount_cents/100).toFixed(2):''}"></label><label class="sale-currency hidden" data-sale-fields>Moeda<input maxlength="3" data-sale-currency value="${escapeHtml(lead.sale_currency||lead.partner_code?'EUR':'')}"></label><label class="notes-label">Notas internas<textarea data-lead-notes maxlength="3000" placeholder="Visíveis somente para masters">${escapeHtml(lead.internal_notes||'')}</textarea></label><label class="assign"><input type="checkbox" data-lead-assign> Assumir atendimento${lead.assigned_name?` · atual: ${escapeHtml(lead.assigned_name)}`:''}</label><button data-save-lead="${escapeHtml(lead.id)}">Salvar</button><span class="lead-feedback" aria-live="polite"></span></div></article>`;
}

document.getElementById('leads')?.addEventListener('change',(event)=>{
  const select=event.target.closest('[data-lead-status]');
  if(!select)return;
  const card=select.closest('.lead-card');
  card.querySelectorAll('[data-sale-fields]').forEach((field)=>field.classList.toggle('hidden',select.value!=='converted'||!card.dataset.partnerId));
});

document.getElementById('inviteForm')?.addEventListener('submit',async(event)=>{
  event.preventDefault(); const status=document.getElementById('inviteStatus');
  try { await api('/api/admin/master-invites',{method:'POST',body:JSON.stringify({name:document.getElementById('inviteName').value,email:document.getElementById('inviteEmail').value})}); status.textContent='Convite criado e encaminhado pelo provedor configurado.'; event.target.reset(); }
  catch { status.textContent='Não foi possível criar o convite.'; }
});
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);}
