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
const fmtMoney=(cents,currency='EUR')=>cents==null?'A partir de 49,99 €':new Intl.NumberFormat('pt-PT',{style:'currency',currency}).format(cents/100);
try {
  const session=await api('/api/auth/session');
  if(!session.user.roles.includes('master')) throw Object.assign(new Error('forbidden'),{status:403});
  const [overview,users,plans,payments]=await Promise.all([api('/api/admin/overview'),api('/api/admin/users'),api('/api/admin/plans'),api('/api/admin/payments')]);
  document.getElementById('accessMessage').classList.add('hidden');
  document.getElementById('adminContent').classList.remove('hidden');
  document.getElementById('metrics').innerHTML=`<div class="metric"><small>Usuários</small><strong>${overview.users}</strong></div><div class="metric"><small>Acessos ativos</small><strong>${overview.active_access}</strong></div><div class="metric"><small>Pagamentos pendentes</small><strong>${overview.pending_payments}</strong></div><div class="metric"><small>Pagamentos confirmados</small><strong>${overview.paid_payments}</strong></div>`;
  document.getElementById('users').innerHTML=users.users.map((u)=>`<tr><td>${escapeHtml(u.display_name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.status)}</td><td>${escapeHtml((u.roles||[]).join(', '))}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('');
  document.getElementById('plans').innerHTML=plans.plans.map((p)=>`<tr><td>${escapeHtml(p.name)}</td><td>${fmtMoney(p.price_cents,p.currency)}</td><td>${p.duration_days?`${p.duration_days} dias`:'Proposta'}</td><td>${p.checkout_enabled?'Sandbox':'Manual'}</td></tr>`).join('');
  document.getElementById('payments').innerHTML=payments.payments.map((p)=>`<tr><td>${fmtDate(p.created_at)}</td><td>${escapeHtml(p.email)}</td><td>${escapeHtml(p.plan_code||'-')}</td><td>${fmtMoney(p.amount_cents,p.currency)}</td><td>${escapeHtml(p.status)}</td></tr>`).join('')||'<tr><td colspan="5">Nenhum pagamento registrado.</td></tr>';
} catch(error) {
  document.querySelector('#accessMessage p').textContent=error.status===403?'Sua conta não tem permissão master.':'Entre primeiro pela Área do cliente com uma conta master.';
}
document.getElementById('inviteForm')?.addEventListener('submit',async(event)=>{
  event.preventDefault(); const status=document.getElementById('inviteStatus');
  try { await api('/api/admin/master-invites',{method:'POST',body:JSON.stringify({name:document.getElementById('inviteName').value,email:document.getElementById('inviteEmail').value})}); status.textContent='Convite criado e encaminhado pelo provedor configurado.'; event.target.reset(); }
  catch { status.textContent='Não foi possível criar o convite.'; }
});
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);}
