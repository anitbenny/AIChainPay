# AIChainPay implementation status

Updated: 2026-10-19. Evidence below separates local simulated-chain tests from external live acceptance. The connector defaults to execution disabled.

| Milestone | Acceptance check | Status / evidence |
| --- | --- | --- |
| 1. Inspect and feasibility | Workspace/tools/spec read; official versions; real client account, auth and write-confirmation probe | **Local research complete; real-client gate blocked.** Workspace initially contained only the spec, no Git repository or `AGENTS.md`. Windows Node 22.22.2, npm 10.9.7 (`npm.cmd`), Git 2.53.0. Official references/versions in [architecture decisions](./docs/architecture-decisions.md). Real ChatGPT account/HTTPS endpoint unavailable; no custom-server install or human approval observed. |
| 2. Solidity vault | Compile, grant/withdraw/delegated transfer/security tests and local deployment | **Local complete.** Solidity 0.8.28 compiles; 9 contract tests pass. Local chain 31337 deployment: `0x5FbDB2315678afecb367f032d93F642f64180aa3`, block 1, tx `0xa986666f970d10d016063eda74844d57e974581bdea7ffddb1c4f7f3bfeefd10`, code hash in [local manifest](./packages/shared/src/deployment.31337.json). This address is ephemeral and not Sepolia. |
| 3. Frontend/owner setup | Browser connects, SIWE login, actual deposit/grant, responsive dashboard; real MetaMask/Sepolia | **Local browser complete, real MetaMask pending.** Headless Edge with injected local test provider signed in, mined a local deposit and grant, displayed real local-chain data, and found no 390px horizontal overflow. Actual screenshot: [local-chain-dashboard.png](./docs/screenshots/local-chain-dashboard.png). Withdraw/revoke/direct-pay paths exist; real MetaMask actions not yet manually tested. |
| 4. Auth/MCP | One-use wallet login, OAuth/PKCE, authenticated MCP read, isolation | **Local protocol complete.** Local synthetic client completed SIWE, OAuth authorization code + PKCE, MCP initialize/list tools, read actual vault balance and indexed vault history. Unauthenticated MCP returned 401. Five backend tests pass including replay/expiry, audience/scope and preparation isolation. Real ChatGPT connection remains unverified. |
| 5. Payment pipeline | Immutable intent, chat confirmation, durable signer, receipt and recovery | **Local execution pipeline tested; live confirmation blocked.** Controlled local approval stub produced exact 0.004 ETH recipient increase across four real local-chain transfers, decline caused zero broadcast, same-request concurrency one attempt, distinct concurrent nonces, idempotent retry same hash, signed-before-broadcast and broadcast-before-status recovery, and matching receipt/event checks. Stub is **not** ChatGPT approval. Production `execute_payment` remains disabled until a real in-chat per-write confirmation displaying full immutable details is observed. |
| 6. Live Sepolia/chat demo | Actual deployment, deposit/grant, read, approve/decline, recipient receipt, revoke | **Blocked on external human setup.** No Sepolia RPC/keys/test ETH, owner MetaMask signatures, public HTTPS endpoint or compatible ChatGPT account were supplied. No Sepolia transaction hash, contract address, explorer verification or real chat approval can be claimed. Exact human steps in [README](./README.md) and [client integration](./docs/client-integration.md). |
| 7. Packaging | Accurate README/security/client/demo docs, screenshot, clean install, GitHub remote | **Local packaging complete; GitHub remote pending.** Root [README](./README.md), [security](./docs/security.md), [client integration](./docs/client-integration.md), [demo script](./docs/demo-script.md), lockfile and ignored secret patterns exist. Clean `npm.cmd ci`, build and all automated tests passed on this Windows host with `better-sqlite3` 12.4.1. A local Git repository was initialized; no commit or remote exists. GitHub publication requires authorized account access. |

## External blockers and required human actions

1. **Sepolia deployment:** supply an RPC URL and a dedicated deployment-only key locally (not in chat), funded with a little Sepolia test ETH; run the deployment command. This broadcasts a contract creation transaction paid by that deployer. The owner address/key must remain in MetaMask and separate.
2. **Backend/agent:** generate a different dedicated agent key locally, fund its address with Sepolia test ETH for gas, configure it in a private connector environment, and keep the SQLite database and HTTPS endpoint persistent. Do not share keys/seed phrases in chat or commit them.
3. **Owner signatures:** in MetaMask, sign the expiring SIWE login message (authentication only); separately sign deposit (moves owner test ETH into vault), grant (authorizes agent spending up to displayed caps/expiry/allowlist), and eventual revoke/withdraw (on-chain control). Do not sign a grant unless the exact agent address and limits are intended.
4. **Client capability and approval:** add the actual HTTPS MCP endpoint in a supported ChatGPT account, complete OAuth, compare real Sepolia reads, and inspect the harmless write probe and full-detail execution confirmation. If the native approval UI cannot bind exact recipient/amount/source to the write, execution must remain disabled. Claude remains untested.
5. **GitHub:** connect an authorized account/repository and publish only after reviewing ignored local secrets; no remote URL is available to report.

## Tests performed and results

- `npm.cmd run compile` — passed, Solidity 0.8.28.
- `npm.cmd ci` — clean install passed on Node 22.22.2/Windows; SQLite native module loaded. An initial attempt using SQLite 13.0.3 failed due to missing local C++ toolset, prompting the pinned 12.4.1 version.
- `npm.cmd test` — 9 Solidity tests and 5 backend tests passed.
- `npm.cmd run build -w connector` — passed TypeScript compilation.
- `npm.cmd run build -w frontend` — passed TypeScript and Vite production build; Vite reports a non-fatal >500 kB chunk warning.
- `npm.cmd run check:frontend` — passed TypeScript no-emit check.
- `npm.cmd run test:local-mcp` — passed local SIWE/OAuth/PKCE/MCP read and indexing; execution refused as configured.
- `npm.cmd run test:local-ui` — passed local wallet-provider login, mined deposit/grant, screenshot and mobile overflow check.
- `npm.cmd run test:local-execution` — passed local-chain execution/recovery/concurrency with **controlled approval stub only**.

The three local integration checks were rerun successfully after the clean install against a fresh local deployment. These checks do not establish real MetaMask, ChatGPT, Sepolia deployment, explorer contract verification or secure public hosting. Browser wallet rejection/account switching, live client approval, reorg/replacement and distributed multi-instance behavior remain unverified. Local tests use a running Hardhat node and deployment; they are not self-contained without that setup.
