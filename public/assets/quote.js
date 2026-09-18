const form=document.getElementById('quoteForm');
const status=document.getElementById('quoteStatus');
const returnInput=document.getElementById('volta');

form.querySelectorAll('input[name=tipo]').forEach((radio)=>radio.addEventListener('change',()=>{
  const roundTrip=form.querySelector('input[name=tipo]:checked')?.value==='Ida e volta';
  returnInput.required=roundTrip;
  returnInput.disabled=!roundTrip;
  if(!roundTrip)returnInput.value='';
}));

form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const button=form.querySelector('button[type=submit]');
  const payload={
    type:'quote',name:document.getElementById('quoteName').value,email:document.getElementById('quoteEmail').value,
    phone:document.getElementById('quotePhone').value,origem:document.getElementById('origem').value,
    destino:document.getElementById('destino').value,ida:document.getElementById('ida').value,volta:returnInput.value,
    adults:Number(document.getElementById('adults').value),children:Number(document.getElementById('children').value),
    infants:Number(document.getElementById('infants').value),tipo:form.querySelector('input[name=tipo]:checked')?.value||'Ida e volta',
    cabinClass:document.getElementById('cabinClass').value,baggage:document.getElementById('baggage').value,
    flexibility:document.getElementById('flexibility').value,paymentPreference:document.getElementById('paymentPreference').value,
    observacoes:document.getElementById('observacoes').value,contactConsent:document.getElementById('contactConsent').checked,
  };
  button.disabled=true;
  status.textContent='Registrando sua solicitação com segurança...';
  try{
    const response=await fetch('/api/lead',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(result.error||'request_failed'),{status:response.status});
    status.textContent=result.confirmationEmailSent
      ?`Solicitação recebida. Protocolo ${result.protocol}. Enviamos a confirmação para seu e-mail e responderemos em até 48 horas.`
      :`Solicitação recebida e salva. Anote o protocolo ${result.protocol}. O e-mail de confirmação não pôde ser enviado agora, mas nossa equipe responderá em até 48 horas.`;
    form.reset();
    returnInput.required=true;
    returnInput.disabled=false;
  }catch(error){
    status.textContent=error.status===429?'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.':'Não foi possível registrar o pedido agora. Revise os dados e tente novamente.';
  }finally{button.disabled=false;}
});
