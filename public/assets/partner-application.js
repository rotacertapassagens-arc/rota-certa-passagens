const toggle=document.getElementById('partnerApplicationToggle');
const form=document.getElementById('partnerApplicationForm');
const status=document.getElementById('partnerApplicationStatus');
const PRIVACY_POLICY_VERSION='2026-09-24';

const formatPercent=(bps)=>`${(Number(bps||0)/100).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:2})}%`;
// Exemplos ilustrativos de comissão no mês, calculados com a regra vigente (não são resultados reais).
const EXAMPLES=[
  {tag:'Uma indicação',title:'Casal para Lisboa',detail:'2 passagens de ida e volta a R$ 4.800',passengers:2,ticket:4800},
  {tag:'Férias em família',title:'4 pessoas para Orlando',detail:'4 passagens de ida e volta a R$ 5.500',passengers:4,ticket:5500},
  {tag:'Um mês bom',title:'12 passageiros no mês',detail:'Viagens variadas, média de R$ 4.500 por passageiro',passengers:12,ticket:4500},
  {tag:'Comunidade engajada',title:'25 passageiros no mês',detail:'Média de R$ 4.500. Passou de 20, a faixa sobe',passengers:25,ticket:4500},
];
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
  const cards=EXAMPLES.map((ex)=>{
    let total=0;
    const parts=[];
    bands.forEach((band)=>{
      const count=Math.max(0,Math.min(ex.passengers,band.to)-band.from+1);
      if(!count)return;
      total+=count*ex.ticket*Number(band.bps||0)/10000;
      parts.push(`${count} × ${formatBRL(ex.ticket)} × ${formatPercent(band.bps)}`);
    });
    return `<div class="pm-ex"><small class="pm-ex-tag">${ex.tag}</small><h4>${ex.title}</h4><p class="pm-ex-sales">${ex.detail}<br>${formatBRL(ex.passengers*ex.ticket)} em vendas</p><strong>${formatBRL(total)}</strong><small>no seu Pix</small><p class="pm-ex-calc">${parts.join(' + ')}</p></div>`;
  }).join('');
  box.innerHTML=`<h3>Quanto dá na prática?</h3><p>Simulações com preços comuns de passagem, calculadas com a regra vigente acima. Valores ilustrativos, não são resultados reais nem garantia de ganho.</p><div class="pm-ex-grid">${cards}</div>`;
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
