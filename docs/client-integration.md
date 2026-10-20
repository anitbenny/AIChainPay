# ChatGPT integration — current card workflow
Current endpoint: **https://upscale-nanometer-duvet.ngrok-free.dev/mcp**, authentication **OAuth**, Sepolia **11155111**. The same public origin is the OAuth issuer and dashboard. All MCP calls require wallet-linked bearer authentication. There is no OpenAI API key requirement.

Availability on 2026-10-20: public health/discovery/challenge checks passed after the user restored ngrok. OAuth access was subsequently renewed. The actual ChatGPT card's verification-only approval/rejection and later live approval reached authenticated callbacks. The [live Sepolia payment](https://sepolia.etherscan.io/tx/0x2bfe8bfc442c084cc012fed2b345044819bad1a11dfef682fea7a7e0cbff01cf) succeeded in block 11952073; authenticated MCP status reported `confirmed` with 17 confirmations. The card initially appeared to keep loading, so **do not click again**; use `get_request_status` for request `7c04c304-d6fa-469f-baf7-4ebd8dcaaba5`.

## What is already observed
Real owner SIWE, ChatGPT token exchange, authenticated Sepolia reads and payment preparation succeeded. Repeated native execute calls reached the disabled backend but adequate fresh execution approval was not established. The user-visible error was emitted by the backend configuration, not by ChatGPT's UI.

ChatGPT's current CIMD uses private_key_jwt: only the actual ChatGPT client can provide its signed client assertion. A synthetic callback test cannot claim to redeem as ChatGPT. Access tokens currently expire after one hour; reconnection may be needed. Never share callback code/state queries, tokens or cookies.

## New adapter and its trust boundary
The new card uses the documented [MCP Apps UI bridge](https://developers.openai.com/plugins/build/chatgpt-ui) and [resource/tool metadata](https://developers.openai.com/plugins/reference). It renders inside ChatGPT, not at a website approval link. No new dependencies were needed; the existing pinned MCP SDK registers the resource and tools.

Flow:
1. prepare_payment creates an immutable, owner/client-bound intent and short deadline.
2. show_payment_confirmation returns the full intent and UI resource. A random capability is included ONLY in widget-private result metadata, with only its hash stored in SQLite.
3. The card displays exact details. Confirm/Reject triggers an app-only authenticated callback containing that capability and the exact request/digest.
4. The backend validates user, client, capability, mode, expiry and unused state. Verification mode records only; live mode uses the existing signer pipeline. Reject never broadcasts.
5. get_request_status reports actual persisted/chain state. A submitted transaction needs later status polling; there are no unsolicited updates.

The host must isolate private metadata from the model and honor app-only tool visibility. Trusted DOM event handling prevents the component itself from silently calling its action on render, but it is not cryptographic attestation and cannot defend against a malicious host/backend. The callback is not merely an approved:true model field: a fresh secret, bound to one immutable intent, is required. The on-chain contract still enforces limits independently.

ChatGPT's ordinary tool permission dialogs remain in effect. The card does NOT bypass host safety policy, collect signing credentials, or disguise a transfer as read-only. If the host blocks financial tool actions, do not rename/mislabel them to evade that block.

## One next account action
**Current result:** verification-only approval (`sepolia-card-check-002`) and rejection (`sepolia-card-reject-001`) are recorded; the rejected request has no transaction. A separate live approval for `sepolia-send-20261020-001` caused a confirmed 0.0001 ETH transfer. A later owner revoke and regrant also succeeded; a read-only call during the revoked interval returned `PermissionInactive`. No additional card or payment is needed for the successful-transfer demonstration. The earlier authenticated over-cap preparation was refused without a transaction. GitHub publication, permanent hosting and a live-card screenshot remain unverified.

The user-provided [ChatGPT screenshot](./screenshots/chatgpt-card-verify-approved.png) and matching audit establish rendering and a successful verification callback, not cryptographic proof of a human or full host isolation. The screenshot's “CSP off” badge is recorded; CSP enforcement has not been demonstrated.

### Connection recovery only
If the connector is in its verified live mode and the tunnel stops, run this in PowerShell from the repository:
```powershell
.\scripts\start-stable-ngrok.ps1 -PublicBaseUrl https://upscale-nanometer-duvet.ngrok-free.dev -AllowLiveConnector
```
Enter the authtoken in the hidden local prompt, never chat, and leave the terminal open. Verify public `/health`, OAuth issuer/resource discovery and `/mcp` bearer challenge before proceeding. No deposit, grant or wallet transaction is required. When public connectivity is restored, expired access may require wallet ownership sign-in again; that signature authenticates the wallet and does not spend ETH.

### After public connectivity is verified
Refresh tools/metadata for the existing AIChainPay plugin in ChatGPT's plugin details. Keep **Always ask**. Do not recreate the connection unless its actual URL differs; the ngrok URL did not change.

Then request:
> Use AIChainPay prepare_payment for recipient 0x94421cF16aAefb1b29B2e9019f7aEF05B83d659f, amount_eth "0.0001", memo "Sepolia card check", client_request_id "sepolia-card-check-001". Then call show_payment_confirmation with the returned request_id and intent_digest. Do not call execute_payment. Wait for my click on the card.

The genuine interactive card must show **CONFIRMATION CHECK ONLY**, full payment details, Confirm test and Reject buttons. Confirm once, then verify a chat_card_decision audit entry with mode verify and zero transactions. Repeat with a distinct new client_request_id and Reject to verify rejection. A screenshot or response generated by the assistant is not the card.

No card, missing private metadata, missing buttons, unsupported app-only callback, or automatic action means this gate is still blocked. Never enable live mode merely because a tool returned HTTP 200. Existing local synthetic card tests are not live-client evidence.

## Live setup performed for this session
Actual card verification and separate agent gas funding have been recorded. The chain, matching agent identity, owner grant, expiry, amount and destination were rechecked before live startup. The direct gas-funding receipt is [0x4e14c2530a67a557f5160b2d12bcc0397433b0d94af6a2ca212378595836700b](https://sepolia.etherscan.io/tx/0x4e14c2530a67a557f5160b2d12bcc0397433b0d94af6a2ca212378595836700b). The separate live payment is verified above.

Set these locally, never in chat:
```dotenv
CONFIRMATION_ADAPTER=chatgpt_app
CHATGPT_APP_APPROVAL_TESTED=1
```
The disabled backend was stopped and `npm.cmd run start:sepolia -- --live` was started. The launcher checks verification approval/rejection evidence and reads the ignored local agent key only in this explicit mode. Root deployer credentials are not mounted into the child. The read-only launcher `npm.cmd run start:sepolia` always disables execution.

The live payment used its own new card/intent; verification-mode capabilities did not authorize it. Receipt/event/recipient/allowance evidence was obtained. Do not repeat the payment; finish over-limit and revocation checks. Do not use the legacy chatgpt_native adapter without its own adequate verification.

## Post-demo shutdown
1. Owner MetaMask: Revoke agent on Sepolia; wait for mining and verify inactive permission. This blocks future spending, not earlier/pending payments.
2. Optional owner MetaMask: Withdraw remaining vault balance, paying owner gas. Verify the receipt/balance.
3. Disconnect the ChatGPT plugin and dashboard session. OAuth disconnection alone does not revoke the contract grant.
4. Stop backend and tunnel. Retain protected database/key until signed transactions are reconciled.

## Other clients and historical notes
Claude is untested; the current OAuth allowlist targets ChatGPT. Do not claim switching clients solves approval without implementing and testing their supported authentication/UI.

Older tunnel/OAuth/native-probe experiments are superseded by this card workflow. Official [custom MCP connection guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server) documents plugin refresh and remembered approval behavior. New conversations are not a substitute for the explicit payment card.
