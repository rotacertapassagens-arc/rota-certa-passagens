const form=document.getElementById('quoteForm');
const status=document.getElementById('quoteStatus');
const returnInput=document.getElementById('volta');
const howHeardSelect=document.getElementById('howHeard');
const referralCodeField=document.getElementById('referralCodeField');
const referralBanner=document.getElementById('referralBanner');
const successPanel=document.getElementById('quoteSuccess');

// Versão do texto de consentimento que cita o WhatsApp (igual a QUOTE_CONSENT_VERSION no servidor).
const CONSENT_VERSION='proposta-whatsapp-2026-10-01';
const SUCCESS_KEY='rc_proposta_recebida';
const SUBMISSION_KEY='rc_proposta_envio';
const SOURCE_KEY='rc_origem_visita';
const UTM_KEYS=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
// sessionStorage pode estar bloqueado (aba anônima, cookies desligados): a página funciona sem ele.
const memory={};
const store={
  get(key){try{return sessionStorage.getItem(key)??memory[key]??null;}catch{return memory[key]??null;}},
  set(key,value){memory[key]=value;try{sessionStorage.setItem(key,value);}catch{/* fica só na memória */}},
  remove(key){delete memory[key];try{sessionStorage.removeItem(key);}catch{/* nada a limpar */}},
};

// Origem da visita (UTMs, página de entrada, site de onde veio e horário). A home grava o mesmo registro
// em site.js; uma campanha nova (com UTM) substitui a anterior.
(function captureVisitSource(){
  const params=new URLSearchParams(location.search);
  const utm={};
  UTM_KEYS.forEach((key)=>{const value=params.get(key);if(value)utm[key]=value.trim().slice(0,200);});
  if(store.get(SOURCE_KEY)&&!Object.keys(utm).length)return;
  let referrer=null;
  try{if(document.referrer){const from=new URL(document.referrer);if(from.host!==location.host)referrer=from.hostname;}}catch{/* sem origem */}
  store.set(SOURCE_KEY,JSON.stringify({...utm,page:location.pathname.slice(0,300),referrer,capturedAt:new Date().toISOString()}));
})();
function visitSource(){try{return JSON.parse(store.get(SOURCE_KEY)||'null')||undefined;}catch{return undefined;}}

// Um identificador por envio: reenviar (clique duplo, rede caiu) devolve o mesmo protocolo em vez de criar outro pedido.
// UUID v4 com getRandomValues: randomUUID não existe em navegadores mais antigos (Safari antes do 15.4).
function uuid(){
  const b=crypto.getRandomValues(new Uint8Array(16));
  b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;
  const h=[...b].map((x)=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function submissionId(){
  let id=store.get(SUBMISSION_KEY);
  if(!id){id=uuid();store.set(SUBMISSION_KEY,id);}
  return id;
}
function newSubmissionId(){store.remove(SUBMISSION_KEY);return submissionId();}

// Pedido recebido: mostra protocolo, estado e o botão do WhatsApp. Nunca abre o WhatsApp sozinho.
function showSuccess(data){
  const whatsappUrl=typeof data?.whatsappUrl==='string'&&data.whatsappUrl.startsWith('https://wa.me/')?data.whatsappUrl:null;
  if(typeof data?.protocol!=='string'||!data.protocol||!whatsappUrl)return false;
  document.getElementById('successProtocol').textContent=data.protocol;
  document.getElementById('successWhatsapp').href=whatsappUrl;
  form.classList.add('hidden');
  referralBanner.classList.add('hidden');
  successPanel.classList.remove('hidden');
  successPanel.focus();
  return true;
}
function resetForm(){
  form.reset();
  returnInput.required=true;
  returnInput.disabled=false;
  referralCodeField.classList.add('hidden');
}
// Recarregar a tela de sucesso mostra o mesmo pedido, sem enviar de novo.
try{showSuccess(JSON.parse(store.get(SUCCESS_KEY)||'null'));}catch{/* sem pedido salvo nesta aba */}
document.getElementById('newQuote').addEventListener('click',()=>{
  store.remove(SUCCESS_KEY);
  newSubmissionId();
  resetForm();
  status.textContent='';
  successPanel.classList.add('hidden');
  form.classList.remove('hidden');
  document.getElementById('quoteName').focus();
});

// Pedido começado no formulário curto da página inicial (ou num cartão de destino): chega com
// origem, destino e datas já preenchidos. Tudo continua sendo validado no envio.
const startParams=new URLSearchParams(location.search);
['origem','destino','ida','volta'].forEach((id)=>{
  const value=startParams.get(id);
  const field=document.getElementById(id);
  if(value&&field&&!field.disabled)field.value=value.slice(0,160);
});

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
    if(data.active&&data.displayName&&successPanel.classList.contains('hidden')){
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
    flexibility:document.getElementById('flexibility').value,stopsPreference:document.getElementById('stopsPreference').value,
    paymentPreference:document.getElementById('paymentPreference').value,
    observacoes:document.getElementById('observacoes').value,contactConsent:document.getElementById('contactConsent').checked,
    consentVersion:CONSENT_VERSION,source:visitSource(),
    howHeard:howHeardSelect.value||undefined,
    referralCode:howHeardSelect.value==='Indicação de um parceiro/influenciador'?document.getElementById('referralCode').value:undefined,
  };
  const send=(id)=>fetch('/api/lead',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({...payload,submissionId:id})});
  button.disabled=true;
  status.textContent='Registrando sua solicitação com segurança...';
  try{
    let response=await send(submissionId());
    // O envio anterior desta aba já foi gravado com outros dados: este vira um pedido novo.
    if(response.status===409)response=await send(newSubmissionId());
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(result.error||'request_failed'),{status:response.status,code:result.error});
    const received={protocol:result.protocol,whatsappUrl:result.whatsappUrl};
    store.set(SUCCESS_KEY,JSON.stringify(received));
    resetForm();
    status.textContent='';
    if(!showSuccess(received))status.textContent=`Solicitação recebida e salva. Anote o protocolo ${result.protocol}.`;
  }catch(error){
    status.textContent=error.status===429?'Muitas tentativas seguidas. Aguarde alguns minutos e tente novamente.'
      :error.code==='invalid_phone'?'Confira o WhatsApp: comece com + e o código do país, por exemplo +55 11 91234 5678.'
      :'Não foi possível registrar o pedido agora. Revise os dados e tente novamente.';
  }finally{button.disabled=false;}
});
