const toggle=document.getElementById('partnerApplicationToggle');
const form=document.getElementById('partnerApplicationForm');
const status=document.getElementById('partnerApplicationStatus');
const PRIVACY_POLICY_VERSION='2026-09-24';

const formatPercent=(bps)=>`${(Number(bps||0)/100).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:2})}%`;
// Exemplos ilustrativos de comissão no mês, calculados com a regra vigente (não são resultados reais).
const EXAMPLE_TICKET=4000;
const EXAMPLE_PASSENGERS=[5,30,60];
const formatBRL=(value)=>value.toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
function commissionBands(settings){
  if(settings.mode==='flat')return[{from:1,to:Infinity,bps:settings.flatBps}];
  return[
    {from:1,to:settings.tier1MaxPassengers,bps:settings.tier1Bps},
    {from:settings.tier1MaxPassengers+1,to:settings.tier2MaxPassengers,bps:settings.tier2Bps},
    {from:settings.tier2MaxPassengers+1,to:settings.tier3MaxPassengers,bps:settings.tier3Bps},
    {from:settings.tier3MaxPassengers+1,to:Infinity,bps:settings.tier4Bps},
  ];
}
function renderCommissionExamples(settings){
  const box=document.getElementById('partnerProgramExamples');
  if(!box)return;
  const bands=commissionBands(settings);
  const cards=EXAMPLE_PASSENGERS.map((passengers)=>{
    let total=0;
    const parts=[];
    bands.forEach((band)=>{
      const count=Math.max(0,Math.min(passengers,band.to)-band.from+1);
      if(!count)return;
      const value=count*EXAMPLE_TICKET*Number(band.bps||0)/10000;
      total+=value;
      parts.push(`${count} × ${formatBRL(EXAMPLE_TICKET)} × ${formatPercent(band.bps)}`);
    });
    return `<div class="pm-ex"><small>${passengers} passageiros no mês</small><p class="pm-ex-sales">${formatBRL(passengers*EXAMPLE_TICKET)} em vendas</p><strong>${formatBRL(total)}</strong><small>de comissão</small><p class="pm-ex-calc">${parts.join(' + ')}</p></div>`;
  }).join('');
  box.innerHTML=`<h3>Exemplos com números</h3><p>Simulação com passagem média de ${formatBRL(EXAMPLE_TICKET)} por passageiro, usando a regra vigente acima. Valores ilustrativos, não são resultados reais.</p><div class="pm-ex-grid">${cards}</div>`;
  box.hidden=false;
}

fetch('/api/partner-program/settings').then((response)=>{
  if(!response.ok)throw new Error('request_failed');
  return response.json();
}).then(({settings})=>{
  const target=document.getElementById('partnerProgramRule');
  if(!target||!settings)return;
  target.innerHTML=settings.mode==='flat'
    ?`<p><strong>Percentual único vigente:</strong> ${formatPercent(settings.flatBps)} sobre o valor elegível de cada venda confirmada.</p>`
    :`<ul><li>Passageiros 1–${settings.tier1MaxPassengers}: <strong>${formatPercent(settings.tier1Bps)}</strong></li><li>Passageiros ${settings.tier1MaxPassengers+1}–${settings.tier2MaxPassengers}: <strong>${formatPercent(settings.tier2Bps)}</strong></li><li>Passageiros ${settings.tier2MaxPassengers+1}–${settings.tier3MaxPassengers}: <strong>${formatPercent(settings.tier3Bps)}</strong></li><li>A partir do passageiro ${settings.tier3MaxPassengers+1}: <strong>${formatPercent(settings.tier4Bps)}</strong></li></ul>`;
  renderCommissionExamples(settings);
}).catch(()=>{
  const target=document.getElementById('partnerProgramRule');
  if(target)target.innerHTML='<p class="alert alert-error">Não foi possível carregar a regra vigente agora. Atualize a página ou fale com a nossa equipe para confirmar o percentual atual.</p>';
});

toggle?.addEventListener('click',()=>{
  form.classList.toggle('hidden');
  const open=!form.classList.contains('hidden');
  toggle.setAttribute('aria-expanded',String(open));
  toggle.textContent=open?'Fechar formulário':'Solicitar cadastro de parceiro';
  if(open)document.getElementById('applicationDisplayName').focus();
});

form?.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const button=form.querySelector('button[type=submit]');
  button.disabled=true;
  status.classList.remove('alert-error','alert-success','alert-info');
  status.textContent='Enviando...';
  try{
    const response=await fetch('/api/partner-applications',{
      method:'POST',
      headers:{'content-type':'application/json'},
      credentials:'same-origin',
      body:JSON.stringify({
        displayName:document.getElementById('applicationDisplayName').value,
        email:document.getElementById('applicationEmail').value,
        instagram:document.getElementById('applicationInstagram').value,
        whatsapp:document.getElementById('applicationWhatsapp').value,
        website:document.getElementById('applicationWebsite').value,
        privacyConsent:document.getElementById('applicationConsent').checked,
        privacyPolicyVersion:PRIVACY_POLICY_VERSION,
      }),
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok&&response.status!==409)throw new Error(result.error||'request_failed');
    if(response.status===409&&result.error==='partner_application_already_pending'){
      status.classList.add('alert-info');
      status.textContent='Já recebemos uma solicitação pendente para este e-mail. Nossa equipe fará a análise.';
    }else{
      status.classList.add('alert-success');
      status.textContent='Solicitação recebida. Se a parceria for aprovada, você receberá o convite por e-mail.';
      form.reset();
    }
  }catch(error){
    status.classList.add('alert-error');
    status.textContent=error.message==='too_many_attempts'?'Muitas tentativas. Aguarde um pouco e tente novamente.':'Não foi possível enviar agora. Tente novamente mais tarde.';
  }finally{
    button.disabled=false;
  }
});
