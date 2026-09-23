const toggle=document.getElementById('partnerApplicationToggle');
const form=document.getElementById('partnerApplicationForm');
const status=document.getElementById('partnerApplicationStatus');

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
