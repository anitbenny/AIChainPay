export const PAYMENT_CARD_URI = "ui://aichainpay/payment-confirmation-v1.html";
export const PAYMENT_CARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIChainPay payment confirmation</title><style>
*{box-sizing:border-box}body{margin:0;padding:16px;font:15px system-ui,sans-serif;background:#0c1424;color:#e8eef8}
main{max-width:660px;margin:auto;border:1px solid #344259;border-radius:16px;padding:22px;background:#142036}
h1{font-size:22px;margin:8px 0}p{line-height:1.5}.tag{font-size:12px;color:#76e4c0;letter-spacing:1px}
dl{display:grid;grid-template-columns:125px minmax(0,1fr);gap:12px;font-size:13px}dt{color:#a6b5cd}dd{margin:0;overflow-wrap:anywhere}
.notice{padding:12px;border:1px solid #e7b65a;border-radius:8px;color:#ffdc94}button{padding:12px 16px;border:0;border-radius:8px;font:inherit;cursor:pointer;margin:8px 8px 0 0}
#confirm{background:#72e3bb;color:#102217}#reject{background:#663a42;color:white}button:disabled{opacity:.5;cursor:not-allowed}
#status{overflow-wrap:anywhere}a{color:#91c4ff}@media(max-width:430px){body{padding:8px}main{padding:14px}dl{grid-template-columns:1fr;gap:5px}dd{margin-bottom:9px}}
</style></head><body><main>
<div class="tag">SEPOLIA TESTNET — TEST FUNDS ONLY</div><h1>Confirm this vault payment</h1>
<p id="mode" class="notice">Waiting for authenticated payment details. No payment authorized.</p>
<dl id="details"></dl><p>The agent pays gas. Your ordinary MetaMask balance is not spent. This decision applies only to the payment shown here.</p>
<button id="confirm" disabled>Confirm</button><button id="reject" disabled>Reject payment</button>
<p id="status" role="status">Connecting to the in-chat host…</p><a id="explorer" hidden target="_blank" rel="noopener noreferrer">View Sepolia transaction</a>
</main><script type="module">
let serial=0, card=null, ready=false, busy=false, finished=false;
const pending=new Map();
const status=document.querySelector('#status'),confirm=document.querySelector('#confirm'),reject=document.querySelector('#reject');
function request(method,params){return new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Host response timed out. Do not retry a payment; check its status.'));},30000);pending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
function buttons(){const valid=ready&&card&&!busy&&!finished&&Date.parse(card.payment.request_deadline)>Date.now();confirm.disabled=!valid;reject.disabled=!valid;}
function receive(result){
 const data=result?.structuredContent?.result, secret=result?._meta?.['aichainpay/approval'];
 if(!data?.payment||!secret?.token||!['verify','execute'].includes(data.mode))return;
 if(busy)return;
 card={payment:data.payment,mode:data.mode,token:secret.token};finished=false;
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
async function decide(event,decision){
 if(!event.isTrusted||!ready||!card||busy||finished)return;
 const selected=card;if(Date.parse(selected.payment.request_deadline)<=Date.now()){status.textContent='Payment expired. Prepare a new intent.';buttons();return;}
 busy=true;buttons();status.textContent='Submitting this decision through the authenticated chat host…';
 try{
  const result=await request('tools/call',{name:'confirm_payment_card',arguments:{request_id:selected.payment.request_id,intent_digest:selected.payment.intent_digest,token:selected.token,decision}});
  finished=true;card.token='';
  if(result?.isError){status.textContent=result.content?.find(x=>x.type==='text')?.text||'Request failed. Check payment status before trying again.';return;}
  const value=result?.structuredContent?.result;
  if(!value){status.textContent='No validated result received. Check payment status; do not retry.';return;}
  status.textContent=JSON.stringify(value,null,2);
  const tx=value.transaction_hash;if(typeof tx==='string'&&/^0x[0-9a-fA-F]{64}$/.test(tx)){const a=document.querySelector('#explorer');a.href='https://sepolia.etherscan.io/tx/'+tx;a.hidden=false;}
 }catch(error){finished=true;card.token='';status.textContent=error.message;}finally{busy=false;buttons();}
}
confirm.addEventListener('click',event=>decide(event,'approve'));reject.addEventListener('click',event=>decide(event,'reject'));
setInterval(buttons,1000);
try{await request('ui/initialize',{appInfo:{name:'AIChainPay confirmation',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'});ready=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');buttons();if(!card)status.textContent='Waiting for payment details from the host.';}
catch{status.textContent='This host did not initialize the confirmation card. Execution remains unavailable; do not substitute an AI message.';}
</script></body></html>`;
