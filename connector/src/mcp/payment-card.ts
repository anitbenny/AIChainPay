export const PAYMENT_CARD_URI = "ui://aichainpay/payment-confirmation-v2.html";
export const PAYMENT_CARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIChainPay payment confirmation</title><style>
*{box-sizing:border-box}body{margin:0;padding:16px;font:15px system-ui,sans-serif;background:#0c1424;color:#e8eef8}
main{max-width:660px;margin:auto;border:1px solid #344259;border-radius:16px;padding:22px;background:#142036}
h1{font-size:22px;margin:8px 0}p{line-height:1.5}.tag{font-size:12px;color:#76e4c0;letter-spacing:1px}
dl{display:grid;grid-template-columns:125px minmax(0,1fr);gap:12px;font-size:13px}dt{color:#a6b5cd}dd{margin:0;overflow-wrap:anywhere}
.notice{padding:12px;border:1px solid #e7b65a;border-radius:8px;color:#ffdc94}button{padding:12px 16px;border:0;border-radius:8px;font:inherit;cursor:pointer;margin:8px 8px 0 0}
#confirm{background:#72e3bb;color:#102217}#reject{background:#663a42;color:white}#check{background:#344e72;color:white}button:disabled{opacity:.5;cursor:not-allowed}
#status{overflow-wrap:anywhere}a{color:#91c4ff}@media(max-width:430px){body{padding:8px}main{padding:14px}dl{grid-template-columns:1fr;gap:5px}dd{margin-bottom:9px}}
</style></head><body><main>
<div class="tag">SEPOLIA TESTNET — TEST FUNDS ONLY</div><h1>Confirm this vault payment</h1>
<p id="mode" class="notice">Waiting for authenticated payment details. No payment authorized.</p>
<dl id="details"></dl><p>The agent pays gas. Your ordinary MetaMask balance is not spent. This decision applies only to the payment shown here.</p>
<button id="confirm" disabled>Confirm</button><button id="reject" disabled>Reject payment</button><button id="check" hidden>Check payment status</button>
<p id="status" role="status">Connecting to the in-chat host…</p><a id="explorer" hidden target="_blank" rel="noopener noreferrer">View Sepolia transaction</a>
</main><script type="module">
let serial=0, card=null, ready=false, busy=false, finished=false, checking=false, notified=false;
const pending=new Map();
const status=document.querySelector('#status'),confirm=document.querySelector('#confirm'),reject=document.querySelector('#reject'),check=document.querySelector('#check');
function request(method,params,timeoutMs=30000){return new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Host response timed out. Do not retry a payment; check its status.'));},timeoutMs);pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
function buttons(){const valid=ready&&card&&!busy&&!finished&&Date.parse(card.payment.request_deadline)>Date.now();confirm.disabled=!valid;reject.disabled=!valid;}
function receive(result){
 const data=result?.structuredContent?.result, secret=result?._meta?.['aichainpay/approval'];
 if(!data?.payment||!secret?.token||!['verify','execute'].includes(data.mode))return;
 if(busy)return;
 card={payment:data.payment,mode:data.mode,token:secret.token};finished=false;notified=false;check.hidden=true;document.querySelector('#explorer').hidden=true;
 document.querySelector('#mode').textContent=data.mode==='verify'?'CONFIRMATION CHECK ONLY — execution is disabled. Confirm records your choice but sends no ETH.':'LIVE SEPOLIA TEST TRANSFER — Confirm sends the exact vault payment below.';
 const p=data.payment,fields=[['Amount',p.amount_eth+' ETH ('+p.amount_wei+' wei)'],['Recipient',p.recipient],['Source',p.source],['Network',p.network+' / '+p.chain_id],['Owner',p.owner],['Vault',p.contract],['Agent',p.agent],['Memo',p.memo||'(empty)'],['Deadline UTC',p.request_deadline],['Permission epoch',p.permission_epoch],['Request',p.request_id],['Intent digest',p.intent_digest]];
 const dl=document.querySelector('#details');dl.replaceChildren();for(const [key,value] of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=String(value);dl.append(dt,dd);}
 confirm.textContent=data.mode==='verify'?'Confirm test — no transfer':'Confirm and send '+p.amount_eth+' ETH';
 status.textContent='Review the full recipient and amount, then choose Confirm or Reject.';buttons();
}
window.addEventListener('message',event=>{
 if(event.source!==window.parent||event.data?.jsonrpc!=='2.0')return;
 const message=event.data;if(typeof message.id==='number'){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(new Error('Host rejected the request. No automatic retry.'));else item.resolve(message.result);}
 else if(message.method==='ui/notifications/tool-result')receive(message.params);
});
function valueFrom(reply){
 if(reply?.isError)throw new Error(reply.content?.find(x=>x.type==='text')?.text||'The payment tool failed');
 if(!reply?.structuredContent?.result)throw new Error('No validated tool result received');
 return reply.structuredContent.result;
}
function matchesPayment(value,p){return value?.request_id===p.request_id&&value.intent_digest===p.intent_digest&&value.recipient===p.recipient&&value.amount_wei===p.amount_wei&&value.owner===p.owner&&value.chain_id===p.chain_id&&value.contract===p.contract;}
function linkTransaction(tx){
 if(typeof tx!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(tx))return;
 const a=document.querySelector('#explorer');a.href='https://sepolia.etherscan.io/tx/'+tx;a.hidden=false;
}
async function followUp(message){
 if(notified||typeof window.openai?.sendFollowUpMessage!=='function')return;
 notified=true;
 try{await window.openai.sendFollowUpMessage({prompt:message+' Report this result only. Do not prepare, confirm, or execute another payment.'});}catch{/* The card remains the authoritative visible result. */}
}
function showStatus(value,p){
 if(!matchesPayment(value,p)){status.textContent='Status details did not match this payment. No success can be claimed; do not retry.';return true;}
 linkTransaction(value.transaction_hash);
 const conf=Number(value.confirmations),required=Number(value.required_confirmations);
 if(value.state==='confirmed'&&/^0x[0-9a-fA-F]{64}$/.test(value.transaction_hash||'')&&Number.isFinite(conf)&&Number.isFinite(required)&&conf>=required){
  status.textContent='Payment successful: '+p.amount_eth+' ETH sent to '+p.recipient+'. Transaction '+value.transaction_hash+'; '+conf+' confirmations.';
  void followUp('AIChainPay verified payment successful for request '+p.request_id+': '+p.amount_eth+' ETH to '+p.recipient+'. Transaction '+value.transaction_hash+'; '+conf+' confirmations.');return true;
 }
 if(value.state==='reverted'){status.textContent='Payment failed on-chain. No transfer completed. Transaction '+(value.transaction_hash||'(unavailable)')+'.';void followUp('AIChainPay verified payment reverted for request '+p.request_id+'. Transaction '+(value.transaction_hash||'(unavailable)')+'. No transfer completed.');return true;}
 if(['rejected','expired','cancelled'].includes(value.state)){status.textContent='Payment '+value.state+'. No transfer was submitted for this request.';void followUp('AIChainPay payment '+value.state+' for request '+p.request_id+'. No transfer was submitted.');return true;}
 if(value.state==='reconciliation_required'){status.textContent='Transaction result could not be verified automatically. Do not retry; use Check payment status again or inspect the transaction link.';return true;}
 status.textContent=value.transaction_hash?'Transaction submitted; waiting for Sepolia confirmation. '+conf+' / '+required+' confirmations. Do not confirm again.':'Payment status: '+value.state+'. Checking whether a transaction was submitted. Do not confirm again.';
 return false;
}
async function checkStatus(p,attempts=8){
 if(checking)return;checking=true;check.disabled=true;
 try{
  for(let i=0;i<attempts;i++){
   try{const value=valueFrom(await request('tools/call',{name:'get_request_status',arguments:{request_id:p.request_id}},12000));if(showStatus(value,p))return;}
   catch(error){status.textContent='Could not read payment status: '+error.message+'. Do not confirm again.';}
   if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,4000));
  }
  status.textContent+=' Use Check payment status later; a pending or unknown result is not proof of failure.';
 }finally{checking=false;check.disabled=false;}
}
async function decide(event,decision){
 if(!event.isTrusted||!ready||!card||busy||finished)return;
 const selected=card;if(Date.parse(selected.payment.request_deadline)<=Date.now()){status.textContent='Payment expired. Prepare a new intent.';buttons();return;}
 busy=true;buttons();status.textContent='Submitting this decision through the authenticated chat host…';
 try{
  const result=await request('tools/call',{name:'confirm_payment_card',arguments:{request_id:selected.payment.request_id,intent_digest:selected.payment.intent_digest,token:selected.token,decision}},60000);
  const value=valueFrom(result);
  if(decision==='reject'){status.textContent=value.state==='rejected'?'Payment rejected. No ETH sent.':'Rejection result unclear. Check payment status; do not retry.';if(value.state==='rejected')void followUp('AIChainPay payment rejected for request '+selected.payment.request_id+'. No ETH sent.');return;}
  if(selected.mode==='verify'){status.textContent='Confirmation check recorded. Execution was disabled; no ETH sent.';void followUp('AIChainPay confirmation check recorded for request '+selected.payment.request_id+'. Execution was disabled; no ETH sent.');return;}
  if(matchesPayment(value,selected.payment)&&showStatus(value,selected.payment))return;
 }catch(error){status.textContent='Confirmation result unclear: '+error.message+'. Checking the saved request; do not confirm again.';}
 finally{finished=true;card.token='';busy=false;buttons();check.hidden=false;}
 if(selected.mode==='execute')void checkStatus(selected.payment);
}
confirm.addEventListener('click',event=>decide(event,'approve'));reject.addEventListener('click',event=>decide(event,'reject'));
check.addEventListener('click',event=>{if(event.isTrusted&&card&&finished)void checkStatus(card.payment,1);});
setInterval(buttons,1000);
try{await request('ui/initialize',{appInfo:{name:'AIChainPay confirmation',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'});ready=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');buttons();if(!card)status.textContent='Waiting for payment details from the host.';}
catch{status.textContent='This host did not initialize the confirmation card. Execution remains unavailable; do not substitute an AI message.';}
</script></body></html>`;
