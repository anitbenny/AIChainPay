# AIChainPay — Implementation specification for VS Code Codex

Version: 1.0 

## 0. Instructions to the coding agent

You are implementing this project in the user's VS Code workspace. Read this entire document before editing. Build a working educational testnet application, not a UI mockup or an implementation plan alone. Work incrementally and verify each layer. Respect existing workspace instructions and preserve unrelated work.

The user explicitly wants a PayBox-inspired experience: initial wallet setup in a DApp, then payments requested and approved through ChatGPT or Claude without returning to the website for each payment. This is a delegated Solidity-vault design. It supersedes earlier designs requiring MetaMask approval for every payment or transferring internal credit to recipients.

Mandatory technologies: Solidity, ethers.js, Ethereum Sepolia, MetaMask for owner setup, a genuine MCP server, and a real supported AI client. Implement one real client integration first; test the second when available. Do not claim both work if only one was tested.

Do not silently replace this design with a conventional payment website, a fake chat widget, a backend holding the user's private key, mainnet transactions, or a browser approval-link workflow for every payment.

Before coding:

1. Inspect workspace files, AGENTS.md, Git status, Node/npm versions, package manifests, and existing contract/frontend code. Do not print .env contents or secrets.
2. Research the current official APIs for the selected Hardhat release, ethers v6, Solidity/OpenZeppelin compatibility, MCP SDK, MCP authorization, and the selected AI client's remote MCP and approval capabilities.
3. Select mutually compatible stable versions; record exact resolved versions and Node requirements. Commit a lockfile. Do not mix examples from incompatible SDK or Hardhat generations or use a development Solidity compiler by accident.
4. Create IMPLEMENTATION_STATUS.md with milestones, acceptance checks, external blockers, and evidence. Record important decisions in docs/architecture-decisions.md.
5. Run the client feasibility test in section 3 early. Continue authorized local implementation when external account setup is blocked, but do not label the integration complete.

Use npm workspaces and TypeScript where practical. Prefer PowerShell-compatible npm scripts and Node scripts; the user is working in VS Code on Windows. Explain necessary human actions precisely, without repeatedly asking permission for routine local development. Never request seed phrases or ask the user to paste secrets into chat. User wallet signatures, connector installation, faucet interactions, and account settings may require user action.

## 1. Product goal and assignment requirements

Name: AIChainPay

Subtitle: Natural-Language Blockchain Payments Through an AI Connector

Visible banner: SEPOLIA TESTNET — TEST FUNDS ONLY

User journey:

1. Open the DApp and connect MetaMask.
2. Sign an expiring login challenge to establish ownership of the address.
3. Deposit Sepolia ETH into AIChainPay.sol.
4. Grant a dedicated application signer a bounded, revocable spending permission through a MetaMask-signed contract transaction.
5. Connect ChatGPT or Claude to the authenticated MCP server.
6. Ask for balances or ask to pay a specified Ethereum address from the vault.
7. See payment details and use the supported in-chat execution-confirmation mechanism.
8. The backend signer calls the contract; the contract enforces permissions and sends ETH directly to the recipient.
9. Read the real result and explorer link in the chat.

The website supports setup, deposits, owner withdrawals, permission replacement/revocation, and activity inspection. Routine delegated payments must not require the website or MetaMask. The recipient requires no account or deposit in AIChainPay.

Assignment deliverables: interactive Solidity contract; frontend that connects a wallet, invokes contract functions, and displays returned data; ethers.js integration with Sepolia; GitHub repository with description, features, deployment steps, frontend startup steps, actual deployed address/network, and at least one real UI screenshot.

## 2. Explicit security and trust model

- MetaMask owner key stays in MetaMask. The backend never imports it.
- The backend has a separate dedicated AGENT_PRIVATE_KEY. This is an execution signer, not the user's wallet key. Keep it in local ignored configuration or hosting secret storage, never in frontend bundles, prompts, tools, logs, or Git.
- The agent cannot spend ETH remaining in the user's ordinary MetaMask account. Its authority applies only to the vault balance and active contract permission.
- Agent gas is paid by the agent account from its own test ETH. Deposits, grants, revocations, and owner withdrawals are paid by the user's MetaMask account. Do not subtract agent gas from user vault credit in v1.
- A backend compromise could spend the remaining authorized allowance. Contract caps and expiry constrain this damage. This is a trusted delegated executor, not an MPC wallet or trustless proof of each human approval.
- Chat confirmation is not an Ethereum signature. The contract checks the signer and limits; it does not prove that a human clicked a chat button.
- Do not accept `approved: true`, `userConfirmed: true`, or a model-generated sentence as independent proof of human approval.
- Confirmation requests must happen through a real supported client mechanism. Document its trust boundary and test it.
- OAuth disconnection does not revoke on-chain permission. Explain both and provide separate controls.
- Revocation blocks future execution after the revocation transaction is effective on-chain. It cannot undo completed payments and is subject to ordering against already pending transactions.
- Messages, addresses, and payment events are public on-chain. Do not put personal or sensitive information in payment memos.
- This is an educational Sepolia demonstration, not audited financial infrastructure or a reproduction of PayBox's MPC/passkey system.

Production configuration accepts chain ID 11155111 only. Local automated tests may use a separate explicitly configured local chain such as 31337. Never silently fall back from Sepolia to another chain or allow arbitrary RPC URLs supplied by tools.

## 3. Early client and authentication feasibility gate

Before polishing the UI, test:

1. The selected ChatGPT or Claude account can add a custom remote MCP server.
2. A standards-compliant server can initialize, list tools, and return a real Sepolia balance.
3. The required authorization flow is supported and can bind a connection to a verified user wallet.
4. The client supports a usable in-chat confirmation for execution tools. Test a harmless simulated write first; never pretend that this proves a real transfer.

Use current official documentation and record actual client/version/account prerequisites. Tool annotations are hints; they do not enforce approval or authenticate a user.

Preferred approval adapter: supported in-band MCP elicitation inside the execution handler, showing the stored immutable payment details. Only proceed on a valid accept response for that invocation; reject cancellation, decline, unsupported capability, and timeouts. Never collect keys, passwords, card details, or other sensitive credentials through elicitation. Check protocol rules: if a client/protocol requires a financial authorization to use an external flow, do not bypass that by mislabelling the request.

Alternative adapter: the selected client's documented native per-write-tool approval mechanism, configured and tested to show execution details. State explicitly that the server trusts the client to enforce this; an OAuth-authenticated caller is not thereby proof of a human approval. Do not fabricate a server-verifiable approval receipt if the client provides none.

Default execution is disabled until a supported adapter is configured and tested. If neither in-chat method is available, report the precise blocker and retain disabled execution; do not silently fall back to website approvals or auto-execution. Any autonomous mode would be a separately agreed product change, not a workaround.

A single ChatGPT/Claude tool call may return `submitted`; use a status tool on a later turn to retrieve confirmation. Do not promise unsolicited chat updates unless actually implemented through a supported client feature. OAuth and initial wallet setup may involve browser navigation; the no-website requirement concerns routine payment approval/execution.

## 4. Architecture and repository

Use these logical components, adjusting filenames to match the selected toolchain:

| Path | Responsibility |
| --- | --- |
| contracts/AIChainPay.sol | Vault and on-chain delegated permissions |
| contracts/test/ or test/contracts/ | Contract tests and malicious/rejecting receiver fixtures |
| scripts/deploy.ts | Deploy and export actual ABI/address/deployment block |
| frontend/src/ | Setup dashboard, wallet hooks, permissions, activity |
| connector/src/auth/ | Wallet login, OAuth integration, principal resolution |
| connector/src/mcp/ | Tool definitions and confirmation adapter |
| connector/src/payments/ | Preparation, execution, queue, reconciliation |
| connector/src/blockchain/ | Provider, signer, contract adapter, event indexing |
| connector/src/db/ | Migrations and typed repository methods |
| packages/shared/ | Schemas, public ABI/types, validation constants |
| docs/ | Architecture, setup, security, client integration, demo, screenshots |
| .env.example | Public examples and blank secret fields |
| IMPLEMENTATION_STATUS.md | Honest milestone and verification record |
| README.md | Reproducible project instructions |

Choose React + Vite + TypeScript, Tailwind CSS and Lucide for frontend; Node.js + Express + TypeScript with the maintained official MCP SDK for backend; ethers v6; Hardhat with a compatible ethers integration; SQLite with migrations and persistent disk for a single-instance demo.

Prefer serving frontend and API under one origin for simple secure cookies and OAuth callbacks. Support Vite development proxy. A split hosted deployment is allowed only with deliberate cookie/CORS/CSRF configuration. Do not deploy writable SQLite to ephemeral storage.

No in-app LLM API is needed: ChatGPT or Claude is the model and MCP client. Do not require an OpenAI/Anthropic API key merely to serve MCP tools. Any separate API-based testing must be identified and optional.

## 5. Solidity specification

Use Solidity 0.8.x compatible with selected dependencies; OpenZeppelin ReentrancyGuard where appropriate; custom errors; bounded memo sizes; no upgradeable proxy or admin drain function in v1.

### 5.1 Storage and accounting

- `balances[owner]`: withdrawable deposited wei.
- `totalLiabilities`: sum of tracked deposited balances.
- `permissions[owner][agent]`: active flag, remaining allowance, per-payment maximum, expiry, monotonically increasing permission epoch, recipient-restriction flag.
- Optional recipient allowlist keyed by owner, agent, permission epoch, and recipient. Cap supplied recipient list length, e.g. 20.
- `usedRequestIds[owner][requestId]`: successful on-chain replay prevention.
- Payment records stored once with sequential ID; per-owner and per-recipient index arrays. Avoid duplicate participant indexing if self-payment is permitted; simpler v1 policy is reject owner-as-recipient.

Invariant: contract ETH balance >= totalLiabilities, not necessarily equality because ETH can arrive without the normal deposit path. Revert ordinary receive/fallback deposits to require explicit deposit(), but recognize forced ETH can still exist. Do not credit forced ETH or add an arbitrary sweep function.

### 5.2 Public functions

Illustrative ABI; settle exact types and export them consistently:

```solidity
deposit() external payable;
withdraw(uint256 amount) external;
getBalance(address owner) external view returns (uint256);
grantAgent(address agent, uint256 totalAllowance, uint256 maxPerPayment,
           uint64 expiresAt, address[] calldata allowedRecipients) external;
revokeAgent(address agent) external;
getAgentPermission(address owner, address agent) external view returns (...);
pay(address payable recipient, uint256 amount, string calldata memo,
    bytes32 requestId) external;
executeAgentPayment(address owner, address payable recipient, uint256 amount,
    string calldata memo, bytes32 requestId, uint256 permissionEpoch,
    uint64 requestDeadline) external;
getPaymentCount(address participant) external view returns (uint256);
getPayment(address participant, uint256 index) external view returns (...);
```

Owner `pay` is a direct MetaMask-signed optional UI operation; it spends only msg.sender's vault credit and does not consume agent allowance. Agent execution derives the agent from msg.sender, never from an unverified parameter.

Grant rules: nonzero agent, positive allowance/cap, cap <= allowance, future expiry. A grant replaces the old grant, increments epoch, and replaces the recipient policy; an empty list means unrestricted recipients within limits and must be clearly explained in UI. A new grant is not an additive top-up. Permit allowance larger than current balance but warn clearly that future deposits can be spent until the allowance/expiry is exhausted. Revocation increments epoch and disables the permission. Epochs must never reset on regrant.

Agent execution checks:

1. Active permission for owner/msg.sender; block timestamp strictly before permission expiry.
2. Supplied epoch matches current permission; request deadline not passed.
3. Nonzero unique requestId, positive amount, amount <= owner balance, remaining allowance, and per-payment maximum.
4. Nonzero recipient, recipient is not this vault, and recipient meets allowlist policy. Apply documented self-payment policy consistently.
5. Memo UTF-8 byte length <= 140 (use byte length in frontend/backend too).
6. Checks-effects-interactions: debit owner balance, totalLiabilities, remaining allowance; mark request used and record payment; then send ETH via call. Revert the whole operation on receiver failure. Protect relevant external transfer paths with nonReentrant.

Agent payment decreases total liabilities by amount; recipient receives actual ETH, not internal credit. Withdraw decreases only caller balance and liabilities; revoked agent permissions must never block owner withdrawals. Withdrawal need not change remaining allowance; future deposits are still subject to an active grant.

Events: Deposited, Withdrawn, AgentGranted, AgentRevoked, PaymentExecuted. PaymentExecuted should identify indexed owner, recipient, and requestId, plus payment ID, executor, amount, memo and timestamp. Test actual event fields and indexed topic limits. Store no transaction hash inside the contract; obtain it from receipt/logs.

## 6. Authentication and user isolation

Use a maintained Sign-In with Ethereum implementation for EOA wallet login. Generate a cryptographically random one-use challenge with domain, URI, chain ID, issuance time and short expiry. Verify complete message fields and signature server-side, consume the nonce atomically, rotate sessions, and invalidate sensitive pending UI state when accounts change. Never treat `eth_requestAccounts` alone as proof of identity. EOA-only v1 support must be documented; do not falsely claim ERC-1271 smart-wallet login support.

Use an established OAuth/OIDC server library or provider compatible with current MCP authorization, not hand-written token/PKCE crypto. For a self-hosted implementation, evaluate a maintained provider such as oidc-provider after checking current compatibility. Implement its login/consent interaction backed by verified wallet sessions. Record the selected implementation and why it fits the client.

Required protocol behavior as applicable to current MCP/client documentation:

- Authorization code flow with PKCE, exact registered redirect URI validation, state protection, expiring one-use authorization codes, supported metadata discovery and resource/audience handling.
- Supported client registration mechanism; do not assume both clients use the same registration mechanism.
- Token issuer, audience, expiry and scope validation; secure refresh/revocation handling if enabled.
- Minimal scopes such as wallet:read, payments:prepare, payments:execute. Consent must explain the contract spending authority separately from OAuth access.
- Resolve wallet owner from validated principal and verified linkage; never from a tool's `owner` argument. For v1 one verified EOA per account is sufficient.
- User can only inspect/execute/cancel their own requests. Opaque UUIDs are not access control.
- Secure HttpOnly session cookies, production Secure flags, suitable SameSite policy, origin checks and CSRF protection for browser mutations. CORS is not authentication. Validate Host/Origin for local transport as required by SDK guidance.
- No tokens in URLs, logs, frontend storage unnecessarily, screenshots or tool output. OAuth state and code parameters are handled according to protocol; don't place access tokens in approval links.

No global currentWallet variable. No public unauthenticated execution endpoint. Developer-console controls must invoke the same authenticated service and validation code, not a bypass.

## 7. MCP tool contract

Use Streamable HTTP at `/mcp` with current SDK lifecycle/transport semantics. Isolate sessions and re-authenticate requests; an MCP session ID is not authorization. Provide health/readiness endpoints without secrets. Validate strict input/output schemas and bound pagination, memo size and request lengths. Tool outputs must distinguish application error from a mined transaction failure.

| Tool | Input | Output/behavior |
| --- | --- | --- |
| get_wallet_address | {} | Verified owner address and configured network |
| get_supported_network | {} | Sepolia chain ID/name and explorer URL |
| get_native_balance | {} | Owner's ordinary wallet ETH, read-only |
| get_contract_balance | {} | Owner's vault balance |
| get_agent_permission | {} | Agent address, active status, limits, expiry, epoch and recipient policy |
| prepare_payment | recipient, amount_eth, optional memo, client_request_id | Validated immutable request and exact preview; no broadcast |
| execute_payment | request_id, intent_digest | In-chat confirmation adapter, then execute stored request; no editable recipient/amount |
| cancel_payment_request | request_id | Cancel own request only before execution claim |
| get_request_status | request_id | Actual state, hashes, confirmations, explorer URL if available |
| get_transaction | transaction_hash | Actual Sepolia transaction and receipt, distinguish pending/not found/reverted |
| get_recent_transactions | bounded cursor/limit | App vault payments with explicitly labelled scope |

Read tools get accurate read-only annotations. Execution is a consequential write and must not be marked read-only. Preparation creates off-chain state; annotate honestly. Annotations never replace server enforcement.

Use explicit descriptions: transfers spend vault ETH, not ordinary MetaMask ETH. Do not expose generic signing, arbitrary calldata/targets, arbitrary RPC calls or arbitrary chain choice. Do not retain the old send_native_token name if it misleadingly suggests ordinary-wallet spending. User can say "send ETH" but the preview must identify the source as AIChainPay vault.

`amount_eth` is a strict decimal string, positive, <=18 decimal places, without exponent syntax, whitespace tricks, negative sign, commas, NaN or Infinity. Use ethers parseEther and bigint; store wei as decimal text. Never use floating-point math or SQLite INTEGER for uint256 amounts. Normalize valid addresses with ethers getAddress; reject invalid mixed-case checksums and ENS names in v1. Never invent a recipient.

Provide useful errors for missing permission, revoked/expired epoch, insufficient vault balance, agent gas shortage, disallowed recipient, rejected confirmation, wrong network, expired request and unavailable RPC.

## 8. Payment intent, confirmation and execution

Preparation creates a cryptographically random bytes32 requestId and a server-owned immutable intent containing owner, agent, chain ID, contract, recipient, wei amount, memo, permission epoch and request deadline. Calculate intentDigest using a canonical typed ABI encoding and keccak256, not ambiguous concatenation/JSON field order. Bind the database record to authenticated user and OAuth client. Treat the digest as an integrity identifier, not a user's signature.

Use a short configured TTL such as 10 minutes. Return full addresses, source, amount, memo, permission expiry and remaining budget, and explicitly label agent-paid gas. `client_request_id` supports idempotent preparation under a unique (user, client, idempotency key) constraint: same key/same payload returns existing request; same key/different payload fails. This does not deduplicate unrelated new user commands automatically.

Execution:

1. Authenticate and check scope, ownership, client binding, digest and intent expiry.
2. If already submitted/confirmed, return existing result without another payment or another confirmation. If cancelled/expired, refuse.
3. Atomically claim request and invoke configured confirmation adapter with the stored full intent. Rejection/timeout does not broadcast. Never hold a SQLite write transaction across human/network waits; use claim tokens, leases and compare-and-swap transitions.
4. After approval, recheck all limits, epoch, recipient policy, deadline, balance, chain ID, contract code/address and agent gas balance.
5. Simulate the exact contract call and estimate gas. Simulations are advisory, since on-chain state can change before mining.
6. Allocate an agent nonce through a serialized persistent signer queue. In v1 operate one backend writer/instance; use a transaction-safe cross-process mechanism if that changes. An in-memory ethers NonceManager alone is insufficient after crashes.
7. Construct/sign the exact transaction. Persist the nonce, transaction hash and signed bytes before broadcast, restricting access to signed payloads. Do not log signed bytes. This permits rebroadcast of the identical transaction after a crash.
8. Broadcast and persist submission status. Treat RPC timeouts as uncertain submission, not permission to create a new intent or payment.
9. Reconcile receipt and verify chain, destination vault, status and matching event fields/requestId. Follow a configured confirmation depth (e.g. 2 for the demo) and show the actual count. Confirmed is not the same as consensus finalized.
10. Return truthful status; allow later status polling. Handle reorgs/replacements and external signer-nonce use explicitly; never reuse the signer outside this application during normal operation.

Persist the confirmation route and response category for auditing without claiming cryptographic proof that the client does not supply. Delayed execution must not outlive its intent deadline. Execution retries reuse the same requestId; contract replay protection is the final duplicate barrier.

Possible states: prepared, confirming, rejected, cancelled, expired, signing, signed, submitted, confirmed, reverted, reconciliation_required. Define allowed transitions and crash recovery. Submitted requests do not become expired just because their original preparation TTL elapses; check what actually happened on-chain. No automatic new request after a failed/uncertain attempt. Recipient rejection reverts all contract accounting.

## 9. Database and event indexing

Use migrations, foreign keys, WAL where suitable, busy handling, and atomic compare-and-swap updates. Store:

- users/wallet linkage and nonce challenge consumption;
- supported OAuth provider persistence and browser sessions;
- immutable payment intents, approval/claim metadata, state and timestamps;
- transaction attempts (nonce, hash, secure signed payload, submission/receipt metadata);
- audit entries with no credentials;
- per-chain/per-contract indexing cursor and payment events keyed by transaction hash + log index.

Read balances and permissions from chain, not cached SQLite as authority. Index events from the actual deployment block in bounded ranges, respect RPC rate limits, deduplicate and rescan a recent overlap for reorg handling. Recent transactions means this vault's activity, not complete wallet history. If history indexing is incomplete, expose that fact; never substitute invented data.

## 10. Frontend behavior

Create a professional responsive dashboard with readable typography, clear testnet banner, full-address inspection, copy buttons and Sepolia explorer links.

Screens:

1. Dashboard: wallet, configured/on-wallet network, wallet ETH, vault balance, agent gas readiness, contract address, recent activity.
2. Setup/permissions: deposit; grant or replace allowance, maximum per payment, expiry and optional allowlist; explain grant replacement and future-deposit implications; revoke; withdraw.
3. Connector setup: real MCP URL, actual client setup instructions and verified connection activity. Server-online is not evidence that ChatGPT is connected.
4. Activity: pending app requests and actual payments, truthful state and errors.
5. Developer console: clearly labelled, authenticated, same validation path; no confirmation bypass.

Use ethers BrowserProvider for owner operations. Handle missing wallet, account changes, chain changes, rejection, replacement and pending receipts. Verify chain ID before signing and invalidate stale account-scoped UI state. Login signatures and on-chain grants must be separate and clearly explained. Disconnect UI/session does not automatically revoke contract permission; explain it.

Keep owner actions on website; do not create a routine "open website to approve payment" fallback. Support direct owner pay if useful for assignment demonstration, without making it the AI flow.

## 11. Configuration, secrets and deployment

Provide separate frontend/backend/deployment .env.example files. Example keys (adapt to chosen auth library):

```dotenv
# Public frontend configuration — not secret
VITE_CHAIN_ID=11155111
VITE_CONTRACT_ADDRESS=
VITE_API_BASE_URL=

# Backend
SEPOLIA_RPC_URL=
CHAIN_ID=11155111
CONTRACT_ADDRESS=
CONTRACT_DEPLOYMENT_BLOCK=
AGENT_PRIVATE_KEY=
DATABASE_PATH=
PUBLIC_BASE_URL=
OAUTH_ISSUER=
SESSION_SECRET=
CONFIRMATION_ADAPTER=disabled
REQUEST_TTL_SECONDS=600
REQUIRED_CONFIRMATIONS=2

# Deployment-only; never mounted into running frontend/backend
DEPLOYER_PRIVATE_KEY=
EXPLORER_API_KEY=
```

Keep deployer/agent/user identities distinct. Generate secret material locally through documented commands without printing keys into chat/logs. Never commit .env, signing keys, database files, raw signed transactions or session dumps. Public VITE variables appear in bundles. Use wallet provider for frontend reads where suitable; keep credentialed RPC access backend-only. Health endpoints expose readiness booleans, not configuration dumps.

Deploy script prints actual address, transaction hash, chain ID and deployment block; exports ABI and public deployment manifest. Startup verifies RPC chain ID, nonempty contract bytecode and expected deployment identity before enabling execution. Contract verification on explorer is desirable; do not claim verified unless it succeeded. No auto-redeploy on server startup.

Use persistent backend storage and HTTPS. Explain that laptop-hosted demo/tunnel requires the laptop/server to remain running. Host costs and availability must be checked, not assumed free. User deposits and grants must be signed in their wallet; do not impersonate those actions. Publish GitHub only using available authorized account access, and report actual URL only after success.

## 12. Required tests

### Contract

Test deposits, owner withdrawals, direct owner payment, delegated successful payment with exact recipient value increase, history and event fields, liabilities, and multiple users.

Negative cases: unauthorized signer; zero amounts; zero/vault/self recipient according to policy; oversized UTF-8 memo; insufficient balance; per-payment and aggregate allowance exceedance; exact expiry/deadline boundaries; stale epoch after revoke/regrant; recipient allowlist; duplicate requestId; rejecting recipient; malicious reentrant receiver. Verify reverted payment preserves balances, liability, allowance and request usability according to the implemented revert semantics. Test forced-ETH surplus without breaking liability invariant. Agent grant changes must not enable spending another owner's balance.

### Backend/auth/MCP

Test strict decimal/address validation, SIWE replay/expiry/domain mismatch, invalid token audience/scope/expiry, user isolation and foreign request IDs, idempotency key conflicts, prepare with no broadcast, immutable intent execution, wrong digest, decline/timeout/unsupported approval adapter, stale permission after preparation, expiry, agent gas shortage and invalid network/contract.

Test concurrent execution of same request, separate concurrent requests using shared agent nonce, restart after signed-before-broadcast and after broadcast-before-status persistence, uncertain RPC response, matching receipt/event verification, status polling without duplicate execution and reorg/replacement behavior. Use controlled RPC fixtures/local chain where appropriate; label mocks and never use them as evidence of live integration.

### Frontend and live acceptance

Test wallet rejection, wrong chain, account switching, deposit/grant/revoke/withdraw, responsive layout and actual data. Use browser tests with injected test providers where practical, then separately test real MetaMask manually.

Live end-to-end acceptance: owner deposits small Sepolia amount; grants bounded permission; real chat client reads balance; prepares payment; user confirms in chat; recipient receives ETH without website/MetaMask payment approval; tool reports matching receipt; remaining allowance decreases; over-limit payment fails; revocation prevents subsequent execution. Also demonstrate rejection with no broadcast. Record client/version, date, contract, tx hashes and test results without personal secrets.

## 13. Work milestones and stop conditions

1. Inspect and record decisions. Implement minimal MCP/client/auth feasibility check.
2. Implement contract, comprehensive behavioral tests and local deployment.
3. Implement owner wallet setup and basic frontend on local chain; deploy to Sepolia when test ETH and user-controlled deployment credentials are configured.
4. Implement wallet-linked authentication, OAuth, database/migrations and read tools.
5. Implement prepared intents, supported chat confirmation adapter, signer queue, contract execution and reconciliation.
6. Complete dashboard, history, failure states, integration tests and actual chat demo.
7. Package documentation, screenshots, GitHub contents and clean-install verification.

Security and validation belong in each milestone. Do not defer them to a final patch. Continue until all locally achievable work is complete. If credentials, user signatures, network restrictions or account capability block live work, give exact next steps and clearly mark live acceptance pending; do not invent success or silently substitute a fake demonstration. Do not switch to autonomous spending, custody, another network or another project without discussing the substantive change.

## 14. README, documentation and final handoff

Document problem, features, architecture, why a vault/delegated signer is necessary, owner vs agent gas, chain ID, real contract address/deployment block, ABI export, contract functions, setup and migrations, Windows/PowerShell commands, deploy/run/test/build scripts, faucet/RPC prerequisites, wallet connection, grants/revocation, OAuth setup, MCP URL, actual client connection/confirmation settings, prompt examples, transaction states, tests and known trust limitations.

Provide npm scripts for compile, contract tests, backend tests, frontend checks, build, local chain, local deployment, Sepolia deployment and development startup. Ensure they actually work for the chosen workspace layout. Include at least one actual dashboard screenshot with test data; do not present a mockup as evidence. Provide docs/demo-script.md, docs/security.md and docs/client-integration.md.

When finished report: implemented features; files changed; exact commands/tests run and outcomes; actual deployment/client evidence; remaining manual steps and blockers. State honestly if only local tests passed. Do not claim production-ready, audited, fully decentralized infrastructure, private payment memos, cryptographic human approval, or PayBox-equivalent custody protections.

## 15. Official references to consult at implementation time

These are reference entry points, not permission to assume current package versions or account access. Follow current redirects and document the exact pages/version used. Prefer official documentation over generated tutorials.

- ethers v6: https://docs.ethers.org/v6/
- Solidity security: https://docs.soliditylang.org/en/latest/security-considerations.html
- Hardhat: https://hardhat.org/docs
- OpenZeppelin contracts: https://docs.openzeppelin.com/contracts/5.x/
- Ethereum networks: https://ethereum.org/developers/docs/networks/
- SIWE standard: https://eips.ethereum.org/EIPS/eip-4361
- MCP specification and authorization: https://modelcontextprotocol.io/specification/latest/basic/authorization
- MCP SDKs: https://modelcontextprotocol.io/docs/sdk
- OpenAI MCP build guidance: https://developers.openai.com/plugins/build/mcp-server
- OpenAI connection testing: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Claude: use current official Anthropic/Claude documentation for custom remote MCP connections and supported approval/elicitation behavior; find the current canonical page before implementation.
- PayBox concept reference only: https://docs.paybox.sh/ — we implement our own Solidity vault, not its MPC infrastructure, and do not use its branding as our own.

## 16. Begin now

Read the workspace and this specification. Give a short implementation plan identifying the chosen dependency versions and first external feasibility check. Then implement and test incrementally. Keep IMPLEMENTATION_STATUS.md current so work can resume between Codex sessions. Preserve the defining outcome: after initial owner authorization, a real chat client can initiate an authorized vault payment and retrieve the blockchain result without sending the user back to the website for routine approval.
