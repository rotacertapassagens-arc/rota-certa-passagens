const form=document.getElementById('quoteForm');
const status=document.getElementById('quoteStatus');
const returnInput=document.getElementById('volta');
const howHeardSelect=document.getElementById('howHeard');
const referralCodeField=document.getElementById('referralCodeField');
const referralBanner=document.getElementById('referralBanner');

form.querySelectorAll('input[name=tipo]').forEach((radio)=>radio.addEventListener('change',()=>{
  const roundTrip=form.querySelector('input[name=tipo]:checked')?.value==='Ida e volta';
  returnInput.required=roundTrip;
  returnInput.disabled=!roundTrip;
  if(!roundTrip)returnInput.value='';
}));

// The code/@ field only appears when the client explicitly says a partner referred them, and it
// is always re-validated server-side — this page never decides attribution on its own.
howHeardSelect.addEventListener('change',()=>{
  referralCodeField.classList.toggle('hidden',howHeardSelect.value!=='Indicação de um parceiro/influenciador');
});

(async function loadReferralBanner(){
  try{
    const ref=new URLSearchParams(location.search).get('ref')||'';
    const response=await fetch(`/api/partners/attribution${ref?`?ref=${encodeURIComponent(ref)}`:''}`,{credentials:'same-origin'});
    const data=await response.json().catch(()=>({active:false}));
    if(data.active&&data.displayName){
      referralBanner.textContent=`Você está pedindo uma proposta indicado(a) por ${data.displayName} 🎉`;
      referralBanner.classList.remove('hidden');
    }
  }catch{/* banner is a courtesy; a failure here must never block the form */}
})();

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
    howHeard:howHeardSelect.value||undefined,
    referralCode:howHeardSelect.value==='Indicação de um parceiro/influenciador'?document.getElementById('referralCode').value:undefined,
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
    referralCodeField.classList.add('hidden');
  }catch(error){
    status.textContent=error.status===429?'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.':'Não foi possível registrar o pedido agora. Revise os dados e tente novamente.';
  }finally{button.disabled=false;}
});
