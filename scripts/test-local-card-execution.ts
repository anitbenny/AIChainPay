import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Contract, JsonRpcProvider, Wallet, parseEther, keccak256 } from "ethers";
import { VAULT_ABI } from "@aichainpay/shared";
import { migrate } from "../connector/src/db/index.js";
import { ChainService } from "../connector/src/blockchain/index.js";
import { preparePayment } from "../connector/src/payments/prepare.js";
import { issueChatApproval, decideChatApproval, chatAppConfirmation } from "../connector/src/payments/chat-approval.js";
import { ExecutionService } from "../connector/src/payments/execute.js";
import type { Config } from "../connector/src/config.js";
import type { Principal } from "../connector/src/auth/oauth.js";

async function main(){
 const rpc=new JsonRpcProvider("http://127.0.0.1:8545",undefined,{cacheTimeout:0});let chain:ChainService|undefined;
 const db=new Database(":memory:");migrate(db);
 try{
  assert.equal((await rpc.getNetwork()).chainId,31337n,"Refusing a non-local chain");
  const manifest=JSON.parse(readFileSync('packages/shared/src/deployment.31337.json','utf8'));
  assert.equal(keccak256(await rpc.getCode(manifest.address)),manifest.codeHash);
  const owner=await rpc.getSigner(0),recipient=await rpc.getSigner(1),agent=Wallet.createRandom().connect(rpc);
  const ownerAddress=await owner.getAddress(),recipientAddress=await recipient.getAddress();
  const vault=new Contract(manifest.address,VAULT_ABI,owner);
  await(await owner.sendTransaction({to:agent.address,value:parseEther('0.01')})).wait();
  await(await vault.deposit({value:parseEther('0.001')})).wait();
  await(await vault.grantAgent(agent.address,parseEther('0.0005'),parseEther('0.0001'),Math.floor(Date.now()/1000)+3600,[])).wait();
  const config:Config={chainId:31337,rpcUrl:'http://127.0.0.1:8545',contractAddress:manifest.address,contractCodeHash:manifest.codeHash,deploymentBlock:manifest.deploymentBlock,
    agentKey:agent.privateKey,agentAddress:agent.address,databasePath:':memory:',publicBaseUrl:'http://localhost:3000',issuer:'http://localhost:3000',sessionSecret:'synthetic-local-card-test-only-'.repeat(2),confirmationAdapter:'chatgpt_app',requestTtlSeconds:600,requiredConfirmations:1,port:0};
  // Constructor fixture only: production loadConfig explicitly rejects this adapter on local chains.
  const principal:Principal={address:ownerAddress,clientId:'https://chatgpt.com/oauth/client.json',scopes:new Set(['wallet:read','payments:prepare','payments:execute'])};
  db.prepare('INSERT INTO users VALUES(?,?)').run(ownerAddress,1);chain=new ChainService(config);
  const service=new ExecutionService(db,config,chain,chatAppConfirmation(db,config));
  const prepare=()=>preparePayment(db,config,chain!,principal,{recipient:recipientAddress,amount_eth:'0.0001',memo:'synthetic card integration',client_request_id:randomUUID()});
  const missing=await prepare();await assert.rejects(service.execute(principal,missing.request_id,missing.intent_digest),/unsupported/);
  const p=await prepare();const card=issueChatApproval(db,config,principal,p.request_id,p.intent_digest);
  decideChatApproval(db,config,principal,{request_id:p.request_id,intent_digest:p.intent_digest,token:card.token,decision:'approve'});
  const before=await rpc.getBalance(recipientAddress);const sent=await service.execute(principal,p.request_id,p.intent_digest);assert.ok(sent.transaction_hash);
  await rpc.waitForTransaction(sent.transaction_hash,1,15000);await rpc.send('evm_mine',[]);
  const confirmed=await service.status(principal,p.request_id);assert.equal(confirmed.state,'confirmed');assert.equal(await rpc.getBalance(recipientAddress)-before,parseEther('0.0001'));
  assert.equal((await service.execute(principal,p.request_id,p.intent_digest)).transaction_hash,sent.transaction_hash);
  const reject=await prepare();const rejectCard=issueChatApproval(db,config,principal,reject.request_id,reject.intent_digest);
  decideChatApproval(db,config,principal,{request_id:reject.request_id,intent_digest:reject.intent_digest,token:rejectCard.token,decision:'reject'});
  await assert.rejects(service.execute(principal,reject.request_id,reject.intent_digest),/rejected/);
  await assert.rejects(preparePayment(db,config,chain,principal,{recipient:recipientAddress,amount_eth:'0.001',client_request_id:randomUUID()}),/cap/);
  const stale=await prepare();const staleCard=issueChatApproval(db,config,principal,stale.request_id,stale.intent_digest);
  decideChatApproval(db,config,principal,{request_id:stale.request_id,intent_digest:stale.intent_digest,token:staleCard.token,decision:'approve'});
  await(await vault.revokeAgent(agent.address)).wait();await assert.rejects(service.execute(principal,stale.request_id,stale.intent_digest),/revoked/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM transaction_attempts').get() as {n:number}).n,1);
  console.log(JSON.stringify({test:'synthetic card decisions and real LOCAL chain transactions, NOT ChatGPT or Sepolia',chain_id:31337,exact_recipient_increase_eth:'0.0001',receipt_and_event_verified:true,missing_approval_blocked:true,retry_same_hash:true,rejection_no_broadcast:true,over_limit_blocked:true,revocation_blocked:true,payment_attempts:1}));
 }finally{db.close();rpc.destroy();chain?.provider.destroy();}
}
main().catch(()=>{console.error('Local card execution test failed; no Sepolia transaction is involved.');process.exitCode=1;});
