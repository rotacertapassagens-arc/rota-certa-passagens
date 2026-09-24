async function api(path, options={}) {
  const response = await fetch(path,{...options,credentials:'same-origin'});
  const body = await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(body.error||'request_failed'),{status:response.status});
  return body;
}
const fmtDate=(value)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short'}).format(new Date(value)):'-';
const fmtMoney=(cents,currency='EUR')=>cents==null?'-':new Intl.NumberFormat('pt-PT',{style:'currency',currency}).format(cents/100);
const statusLabels={new:'Nova',reviewing:'Em análise',awaiting_customer:'Aguardando cliente',ready:'Proposta pronta',sent:'Enviada',converted:'Convertida',lost:'Não convertida',canceled:'Cancelada',closed:'Encerrada'};
const commissionLabels={pending:'Pendente',approved:'Aprovada',paid:'Paga',void:'Anulada'};
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);}

try {
  const session=await api('/api/auth/session');
  if(!session.user.roles.includes('partner')) throw Object.assign(new Error('forbidden'),{status:403});
  const [summary,ledger]=await Promise.all([api('/api/partner/summary'),api('/api/partner/ledger')]);
  document.getElementById('accessMessage').classList.add('hidden');
  document.getElementById('partnerContent').classList.remove('hidden');

  document.getElementById('partnerLink').value=summary.partner.link;
  document.getElementById('copyLink').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(summary.partner.link);document.getElementById('copyStatus').textContent='Link copiado.';}
    catch{document.getElementById('copyStatus').textContent='Selecione e copie manualmente.';}
  });

  const stats=summary.stats;
  const conversionRate=stats.proposals?Math.round((stats.conversions/stats.proposals)*100):0;
  document.getElementById('metrics').innerHTML=`
    <div class="metric"><small>Cliques no seu link</small><strong>${stats.clicks}</strong></div>
    <div class="metric"><small>Propostas atribuídas</small><strong>${stats.proposals}</strong></div>
    <div class="metric"><small>Convertidas</small><strong>${stats.conversions}</strong></div>
    <div class="metric"><small>Taxa de conversão</small><strong>${conversionRate}%</strong></div>`;

  const totals=summary.commissionTotalsCents;
  const currency=summary.partner.currency;
  const program=summary.programCommission;
  const rate=(bps)=>`${(Number(bps||0)/100).toLocaleString('pt-BR',{maximumFractionDigits:2})}%`;
  document.getElementById('programProgress').textContent=program.mode==='flat'
    ?`Regra vigente: ${rate(program.currentRateBps)} para todos. Passageiros fechados neste mês: ${program.currentMonthPassengers}.`
    :program.nextTierAt
      ?`Passageiros fechados neste mês: ${program.currentMonthPassengers}. Faixa atual: ${rate(program.currentRateBps)}. Faltam ${program.passengersToNextTier} passageiro(s) para a faixa de ${rate(program.nextRateBps)}.`
      :`Passageiros fechados neste mês: ${program.currentMonthPassengers}. Faixa máxima atingida: ${rate(program.currentRateBps)}.`;
  document.getElementById('commissionMetrics').innerHTML=`
    <div class="metric"><small>Pendente</small><strong>${fmtMoney(totals.pending,currency)}</strong></div>
    <div class="metric"><small>Aprovada</small><strong>${fmtMoney(totals.approved,currency)}</strong></div>
    <div class="metric"><small>Paga</small><strong>${fmtMoney(totals.paid,currency)}</strong></div>
    <div class="metric"><small>Total já gerado</small><strong>${fmtMoney((totals.pending||0)+(totals.approved||0)+(totals.paid||0),currency)}</strong></div>`;

  document.getElementById('ledger').innerHTML=ledger.entries.length?ledger.entries.map((entry)=>`<tr>
      <td>${escapeHtml(entry.protocolMasked)}</td>
      <td>${escapeHtml(entry.route||'-')}</td>
      <td>${entry.referralSource==='link'?'Link':entry.referralSource==='manual'?'Manual':'-'}</td>
      <td>${escapeHtml(statusLabels[entry.status]||entry.status)}</td>
      <td>${fmtDate(entry.requestedAt)}</td>
      <td>${entry.commission?`${fmtMoney(entry.commission.amountCents,entry.commission.currency)} · ${escapeHtml(commissionLabels[entry.commission.status]||entry.commission.status)}`:'-'}</td>
    </tr>`).join(''):'<tr><td colspan="6">Nenhuma indicação registrada ainda.</td></tr>';
} catch(error) {
  document.querySelector('#accessMessage p').textContent=error.status===403?'Sua conta não tem acesso ao painel de parceiro.':'Entre com a sua conta de parceiro para ver o painel.';
}
