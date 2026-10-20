import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { PAYMENT_CARD_HTML } from "../connector/src/mcp/payment-card.js";

// Synthetic host transport; never calls the live connector or a blockchain.
const payment = { request_id: "00000000-0000-4000-8000-000000000003", intent_digest: "0x"+"1".repeat(64),
  amount_eth:"0.0001",amount_wei:"100000000000000",recipient:"0x94421cF16aAefb1b29B2e9019f7aEF05B83d659f",
  source:"AIChainPay vault (not ordinary MetaMask wallet)",network:"Sepolia",chain_id:11155111,
  owner:"0x0432821e68A84b2F2e8dCD6e7973d14Db1A939df",contract:"0x915fCDd60d648dC9e9F558e84f805C28269E0aAC",
  agent:"0x3d111235700B9C3BEdb097467a3bf98bB7FAfA3F",memo:"SYNTHETIC UI TEST <img src=x onerror=alert(1)>",permission_epoch:"1",request_deadline:new Date(Date.now()+600000).toISOString() };
const envelope={structuredContent:{result:{payment,mode:"verify"}},_meta:{"aichainpay/approval":{token:"a".repeat(64)}}};
const host=`<!doctype html><title>Synthetic MCP Apps host — NOT ChatGPT</title><iframe title="Payment card" src="/card" style="width:100%;height:1100px;border:0"></iframe><script>
window.calls=[];const frame=document.querySelector('iframe');window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;
if(m.method==='ui/initialize')frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'synthetic',version:'1'},hostCapabilities:{}}},'*');
if(m.method==='ui/notifications/initialized')frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:${JSON.stringify(envelope)}},'*');
if(m.method==='tools/call'){window.calls.push(m.params);frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:{structuredContent:{result:{confirmation_check:'recorded',execution_enabled:false,transaction_hash:null}}}},'*');}
});</script>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/card'?PAYMENT_CARD_HTML:host);});
async function main(){
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No local test port');
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:840,height:1200}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+address.port);const frame=page.frameLocator('iframe');const button=frame.getByRole('button',{name:'Confirm test — no transfer'});
  await button.waitFor();await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('button')?.disabled===false);
  assert.equal(await page.evaluate(()=>(window as any).calls.length),0);
  assert.ok((await frame.locator('#details').innerText()).includes(payment.recipient));
  assert.equal(await frame.locator('#details img').count(),0);
  await frame.locator('#confirm').evaluate((b:HTMLButtonElement)=>b.click());
  assert.equal(await page.evaluate(()=>(window as any).calls.length),0,'Untrusted synthetic DOM click must not send approval');
  await mkdir('docs/screenshots',{recursive:true});
  await page.screenshot({path:'docs/screenshots/confirmation-card-local-test.png',fullPage:true});
  await button.click();await frame.locator('#status').filter({hasText:'recorded'}).waitFor();
  assert.equal(await page.evaluate(()=>(window as any).calls.length),1);assert.equal(await button.isDisabled(),true);
  const call=await page.evaluate(()=>(window as any).calls[0]);assert.equal(call.name,'confirm_payment_card');assert.equal(call.arguments.intent_digest,payment.intent_digest);assert.equal(call.arguments.decision,'approve');
  await page.reload();await frame.getByRole('button',{name:'Reject payment'}).click();
  await frame.locator('#status').filter({hasText:'recorded'}).waitFor();assert.equal((await page.evaluate(()=>(window as any).calls[0])).arguments.decision,'reject');
  await page.setViewportSize({width:390,height:844});assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({test:'synthetic MCP Apps host, not ChatGPT',no_auto_approval:true,untrusted_dom_click_blocked:true,confirm_and_reject:true,exact_intent_arguments:true,memo_rendered_as_text:true,mobile_overflow:false,blockchain_transactions:0}));
 }finally{await browser.close();server.close();}
}
main().catch(()=>{console.error('Payment card UI test failed (no live transactions involved)');server.close();process.exitCode=1;});
