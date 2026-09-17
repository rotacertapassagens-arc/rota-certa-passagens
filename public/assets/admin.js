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
const fmtDate=(value)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'-';
const fmtDay=(value)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeZone:'UTC'}).format(new Date(`${String(value).slice(0,10)}T00:00:00Z`)):'-';
const fmtMoney=(cents,currency='EUR')=>cents==null?'A partir de 49,99 €':new Intl.NumberFormat('pt-PT',{style:'currency',currency}).format(cents/100);
const statusLabels={new:'Nova',reviewing:'Em análise',awaiting_customer:'Aguardando cliente',ready:'Proposta pronta',sent:'Enviada',converted:'Convertida',lost:'Não convertida',canceled:'Cancelada',closed:'Encerrada'};
let currentLeads=[];

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
  await loadLeads();
} catch(error) {
  document.querySelector('#accessMessage p').textContent=error.status===403?'Sua conta não tem permissão master.':'Entre primeiro pela Área do cliente com uma conta master.';
}

document.getElementById('leadFilter')?.addEventListener('change',()=>loadLeads());
document.getElementById('leads')?.addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-save-lead]');
  if(!button)return;
  const card=button.closest('.lead-card');
  button.disabled=true;
  const feedback=card.querySelector('.lead-feedback');
  try{
    await api(`/api/admin/leads/${button.dataset.saveLead}`,{method:'PATCH',body:JSON.stringify({status:card.querySelector('[data-lead-status]').value,internalNotes:card.querySelector('[data-lead-notes]').value,assignToMe:card.querySelector('[data-lead-assign]').checked})});
    feedback.textContent='Proposta atualizada.';
    await loadLeads();
  }catch{feedback.textContent='Não foi possível salvar a alteração.';button.disabled=false;}
});

async function loadLeads(){
  const filter=document.getElementById('leadFilter')?.value||'';
  const result=await api(`/api/admin/leads${filter?`?status=${encodeURIComponent(filter)}`:''}`);
  currentLeads=result.leads;
  document.getElementById('leads').innerHTML=currentLeads.length?currentLeads.map(renderLead).join(''):'<p class="muted">Nenhuma proposta encontrada.</p>';
}

function renderLead(lead){
  const overdue=lead.deadline_at && new Date(lead.deadline_at)<new Date() && !['sent','converted','lost','canceled','closed'].includes(lead.status);
  const options=Object.entries(statusLabels).map(([value,label])=>`<option value="${value}" ${lead.status===value?'selected':''}>${label}</option>`).join('');
  return `<article class="lead-card ${overdue?'overdue':''}"><div class="lead-title"><div><span class="protocol">${escapeHtml(lead.protocol)}</span><h3>${escapeHtml(lead.origin)} → ${escapeHtml(lead.destination)}</h3></div><span class="deadline">${overdue?'Prazo vencido':'Responder até'}<strong>${fmtDate(lead.deadline_at)}</strong></span></div><div class="lead-details"><div><small>Cliente</small><strong>${escapeHtml(lead.customer_name)}</strong><a href="mailto:${encodeURIComponent(lead.customer_email)}">${escapeHtml(lead.customer_email)}</a><span>${escapeHtml(lead.customer_phone)}</span></div><div><small>Viagem</small><strong>${fmtDay(lead.outbound_on)}${lead.return_on?` — ${fmtDay(lead.return_on)}`:''}</strong><span>${lead.adults} adulto(s), ${lead.children} criança(s), ${lead.infants} bebê(s)</span><span>${escapeHtml(lead.trip_type)} · ${escapeHtml(lead.cabin_class)}</span></div><div><small>Preferências</small><span>${escapeHtml(lead.baggage)}</span><span>${escapeHtml(lead.date_flexibility)}</span><span>${escapeHtml(lead.payment_preference)}</span></div></div>${lead.notes?`<p class="customer-notes"><strong>Observações:</strong> ${escapeHtml(lead.notes)}</p>`:''}<div class="lead-actions"><label>Status<select data-lead-status>${options}</select></label><label class="notes-label">Notas internas<textarea data-lead-notes maxlength="3000" placeholder="Visíveis somente para masters">${escapeHtml(lead.internal_notes||'')}</textarea></label><label class="assign"><input type="checkbox" data-lead-assign> Assumir atendimento${lead.assigned_name?` · atual: ${escapeHtml(lead.assigned_name)}`:''}</label><button data-save-lead="${escapeHtml(lead.id)}">Salvar</button><span class="lead-feedback" aria-live="polite"></span></div></article>`;
}

document.getElementById('inviteForm')?.addEventListener('submit',async(event)=>{
  event.preventDefault(); const status=document.getElementById('inviteStatus');
  try { await api('/api/admin/master-invites',{method:'POST',body:JSON.stringify({name:document.getElementById('inviteName').value,email:document.getElementById('inviteEmail').value})}); status.textContent='Convite criado e encaminhado pelo provedor configurado.'; event.target.reset(); }
  catch { status.textContent='Não foi possível criar o convite.'; }
});
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);}
