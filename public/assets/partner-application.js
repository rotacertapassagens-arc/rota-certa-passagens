const toggle=document.getElementById('partnerApplicationToggle');
const form=document.getElementById('partnerApplicationForm');
const status=document.getElementById('partnerApplicationStatus');
const PRIVACY_POLICY_VERSION='2026-09-24';

const formatPercent=(bps)=>`${(Number(bps||0)/100).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:2})}%`;
fetch('/api/partner-program/settings').then((response)=>response.json()).then(({settings})=>{
  const target=document.getElementById('partnerProgramRule');
  if(!target||!settings)return;
  target.innerHTML=settings.mode==='flat'
    ?`<p><strong>Percentual único vigente:</strong> ${formatPercent(settings.flatBps)} sobre o valor elegível de cada venda confirmada.</p>`
    :`<ul><li>Passageiros 1–${settings.tier1MaxPassengers}: <strong>${formatPercent(settings.tier1Bps)}</strong></li><li>Passageiros ${settings.tier1MaxPassengers+1}–${settings.tier2MaxPassengers}: <strong>${formatPercent(settings.tier2Bps)}</strong></li><li>Passageiros ${settings.tier2MaxPassengers+1}–${settings.tier3MaxPassengers}: <strong>${formatPercent(settings.tier3Bps)}</strong></li><li>A partir do passageiro ${settings.tier3MaxPassengers+1}: <strong>${formatPercent(settings.tier4Bps)}</strong></li></ul>`;
}).catch(()=>{});

toggle?.addEventListener('click',()=>{
  form.classList.toggle('hidden');
  toggle.textContent=form.classList.contains('hidden')?'Solicitar cadastro de parceiro':'Fechar formulário';
  if(!form.classList.contains('hidden'))document.getElementById('applicationDisplayName').focus();
});

form?.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const button=form.querySelector('button[type=submit]');
  button.disabled=true;
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
      status.textContent='Já recebemos uma solicitação pendente para este e-mail. Nossa equipe fará a análise.';
    }else{
      status.textContent='Solicitação recebida. Se a parceria for aprovada, você receberá o convite por e-mail.';
      form.reset();
    }
  }catch(error){
    status.textContent=error.message==='too_many_attempts'?'Muitas tentativas. Aguarde um pouco e tente novamente.':'Não foi possível enviar agora. Tente novamente mais tarde.';
  }finally{
    button.disabled=false;
  }
});
