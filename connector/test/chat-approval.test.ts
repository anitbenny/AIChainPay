import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Wallet, parseEther } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrate } from "../src/db/index.js";
import type { Config } from "../src/config.js";
import type { Principal } from "../src/auth/oauth.js";
import type { ChainService } from "../src/blockchain/index.js";
import type { PaymentIndexer } from "../src/blockchain/indexer.js";
import { ExecutionService } from "../src/payments/execute.js";
import { preparePayment, requestForPrincipal } from "../src/payments/prepare.js";
import { issueChatApproval, decideChatApproval, chatAppConfirmation } from "../src/payments/chat-approval.js";
import { createMcpServer } from "../src/mcp/server.js";
import { PAYMENT_CARD_URI } from "../src/mcp/payment-card.js";

async function fixture() {
  const db = new Database(":memory:"); migrate(db);
  const owner = Wallet.createRandom().address;
  const config: Config = { chainId: 11155111, rpcUrl: "https://rpc.invalid", contractAddress: Wallet.createRandom().address,
    deploymentBlock: 1, agentAddress: Wallet.createRandom().address, databasePath: ":memory:", publicBaseUrl: "https://app.invalid",
    issuer: "https://app.invalid", sessionSecret: "x".repeat(48), confirmationAdapter: "disabled", requestTtlSeconds: 600, requiredConfirmations: 2, port: 0 };
  const principal: Principal = { address: owner, clientId: "https://chatgpt.com/oauth/client.json", scopes: new Set(["wallet:read", "payments:prepare", "payments:execute"]) };
  db.prepare("INSERT INTO users VALUES(?,?)").run(owner, 1);
  const chain = { check: async () => {}, balance: async () => parseEther("0.01"), allowed: async () => true,
    permission: async () => ({ active: true, expiresAt: Math.floor(Date.now()/1000)+3600, remainingAllowance: parseEther("0.005"), maxPerPayment: parseEther("0.001"), epoch: 1n }) } as unknown as ChainService;
  const preview = await preparePayment(db, config, chain, principal, { recipient: Wallet.createRandom().address, amount_eth: "0.0001", memo: "test", client_request_id: "card-test-001" });
  return { db, config, principal, chain, preview };
}

test("status expires an unsigned prepared request even with execution disabled",async()=>{
 const {db,config,principal,chain,preview:p}=await fixture();
 try{
  db.prepare("UPDATE payment_requests SET deadline=? WHERE id=?").run(Math.floor(Date.now()/1000),p.request_id);
  const service=new ExecutionService(db,config,chain,async()=>({category:"unsupported",route:"disabled"}));
  const result=await service.status(principal,p.request_id);
  assert.equal(result.state,"expired");assert.equal(result.transaction_hash,null);
 }finally{db.close();}
});

test("card decisions bind owner/client/digest and reject guessed capabilities", async () => {
  const f = await fixture(); const {db,config,principal,preview:p}=f;
  try {
    const issued=issueChatApproval(db,config,principal,p.request_id,p.intent_digest);
    const input={ request_id:p.request_id,intent_digest:p.intent_digest,token:issued.token,decision:"approve" as const };
    assert.throws(()=>decideChatApproval(db,config,{...principal,address:Wallet.createRandom().address},input),/mismatch/);
    assert.throws(()=>decideChatApproval(db,config,{...principal,clientId:"https://chatgpt.com/oauth/other/client.json"},input),/mismatch/);
    assert.throws(()=>decideChatApproval(db,config,principal,{...input,intent_digest:"0x"+"1".repeat(64)}),/mismatch/);
    assert.throws(()=>decideChatApproval(db,config,principal,{...input,token:"0".repeat(64)}),/capability/);
    assert.throws(()=>issueChatApproval(db,config,{...principal,scopes:new Set(["wallet:read"])},p.request_id,p.intent_digest),/requires/);
    const result=decideChatApproval(db,config,principal,input); assert.equal(result.mode,"verify");
    assert.throws(()=>decideChatApproval(db,config,principal,input),/used/);
    const row=requestForPrincipal(db,principal,p.request_id)!;
    assert.equal((await chatAppConfirmation(db,{...config,confirmationAdapter:"chatgpt_app"})(row,principal)).category,"unsupported");
    assert.equal(row.state,"prepared");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM transaction_attempts").get() as {n:number}).n,0);
  }finally{db.close();}
});

test("card rejects expiry, superseded tokens, mode changes and cancellation",async()=>{
  const {db,config,principal,preview:p}=await fixture();
  try{
    const old=issueChatApproval(db,config,principal,p.request_id,p.intent_digest);
    const latest=issueChatApproval(db,config,principal,p.request_id,p.intent_digest);
    const input={request_id:p.request_id,intent_digest:p.intent_digest,token:old.token,decision:"approve" as const};
    assert.throws(()=>decideChatApproval(db,config,principal,input),/used/);
    assert.throws(()=>decideChatApproval(db,{...config,confirmationAdapter:"chatgpt_app"},principal,{...input,token:latest.token}),/mode-changed/);
    db.prepare("UPDATE chat_approvals SET expires_at=0").run();
    assert.throws(()=>decideChatApproval(db,config,principal,{...input,token:latest.token}),/expired/);
    const reject=issueChatApproval(db,config,principal,p.request_id,p.intent_digest);
    decideChatApproval(db,config,principal,{...input,token:reject.token,decision:"reject"});
    assert.equal(requestForPrincipal(db,principal,p.request_id)!.state,"rejected");
    assert.throws(()=>issueChatApproval(db,config,principal,p.request_id,p.intent_digest),/not prepared/);
  }finally{db.close();}
});

test("live-mode card capability is consumed once, scoped to exact intent",async()=>{
  const f=await fixture();const {db,principal,preview:p}=f;const config={...f.config,confirmationAdapter:"chatgpt_app" as const};
  try{
    const row=requestForPrincipal(db,principal,p.request_id)!;
    assert.equal((await chatAppConfirmation(db,config)(row,principal)).category,"unsupported");
    const a=issueChatApproval(db,config,principal,p.request_id,p.intent_digest);
    decideChatApproval(db,config,principal,{request_id:p.request_id,intent_digest:p.intent_digest,token:a.token,decision:"approve"});
    assert.equal((await chatAppConfirmation(db,config)({...row,intent_digest:"wrong"},principal)).category,"unsupported");
    assert.equal((await chatAppConfirmation(db,config)(row,principal)).category,"accepted");
    assert.equal((await chatAppConfirmation(db,config)(row,principal)).category,"unsupported");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM transaction_attempts").get() as {n:number}).n,0);
  }finally{db.close();}
});

test("MCP card resource, private metadata and app-only action; disabled click cannot execute",async()=>{
  const {db,config,principal,chain,preview:p}=await fixture(); let executions=0;
  const server=createMcpServer(db,config,chain,{} as PaymentIndexer,principal,{execute:async()=>{executions++;throw new Error("Must not execute");}} as unknown as ExecutionService);
  const client=new Client({name:"synthetic-card-test",version:"1"});const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(a);await client.connect(b);
    const tools=await client.listTools();const action=tools.tools.find(t=>t.name==="confirm_payment_card")!;
    assert.deepEqual((action._meta?.ui as {visibility:string[]}).visibility,["app"]);
    assert.equal(action.annotations?.readOnlyHint,false);
    const resource=await client.readResource({uri:PAYMENT_CARD_URI});assert.equal(resource.contents[0].mimeType,"text/html;profile=mcp-app");
    const card=await client.callTool({name:"show_payment_confirmation",arguments:{request_id:p.request_id,intent_digest:p.intent_digest}});
    assert.equal(card.isError,undefined);
    const token=(card._meta?.["aichainpay/approval"] as {token:string}).token;
    assert.ok(token);assert.ok(!JSON.stringify(card.structuredContent).includes(token));assert.ok(!JSON.stringify(card.content).includes(token));
    const reply=await client.callTool({name:"confirm_payment_card",arguments:{request_id:p.request_id,intent_digest:p.intent_digest,token,decision:"approve"}});
    assert.equal(reply.isError,undefined);assert.equal(executions,0);
    assert.equal((reply.structuredContent as {result:{execution_enabled:boolean}}).result.execution_enabled,false);
    const replay=await client.callTool({name:"confirm_payment_card",arguments:{request_id:p.request_id,intent_digest:p.intent_digest,token,decision:"approve"}});
    assert.equal(replay.isError,true);assert.equal(executions,0);
  }finally{await client.close();await server.close();db.close();}
});
