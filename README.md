# AIChainPay

AIChainPay is a Sepolia-only DApp for sending test ETH from a Solidity vault. The owner connects MetaMask to deposit funds and grant a separate agent a limited spending allowance. Routine payment requests and exact Confirm/Reject decisions happen inside ChatGPT through an authenticated MCP connector; the agent pays gas and the recipient receives ETH from the vault. No mainnet funds are supported.

## Assignment checklist

| Requirement | Where to find it |
| --- | --- |
| Solidity contract with user-callable functions | [AIChainPay.sol](./contracts/AIChainPay.sol): `deposit`, `withdraw`, `grantAgent`, `revokeAgent` |
| Frontend with wallet connection, contract calls and returned data | [React dashboard](./frontend/src/App.tsx): connect/verify MetaMask, deposit, grant, revoke, withdraw, balances and activity |
| Testnet and ethers.js | Sepolia (chain ID 11155111); ethers.js in the frontend, connector and Hardhat deployment |
| Deployment and frontend instructions | Below |
| Contract address and screenshot | Below |
| GitHub repository | [AIChainPay on GitHub](https://github.com/anitbenny/AIChainPay) |

## Deployed Sepolia contract

- Network: **Sepolia**, chain ID **11155111**.
- Vault: [`0x915fCDd60d648dC9e9F558e84f805C28269E0aAC`](https://sepolia.etherscan.io/address/0x915fCDd60d648dC9e9F558e84f805C28269E0aAC).
- Deployment: [transaction `0xcd059159f582a2783da6f7652d4fec4c390e1696db1b596b2b291ee78005d46d`](https://sepolia.etherscan.io/tx/0xcd059159f582a2783da6f7652d4fec4c390e1696db1b596b2b291ee78005d46d), block 11947272.
- Public ABI and manifest: [ABI](./packages/shared/src/AIChainPay.abi.json) and [Sepolia deployment manifest](./packages/shared/src/deployment.11155111.json).

The contract is **not tied to one owner wallet**. Each MetaMask EOA has separate vault credit and a separate `(owner, agent)` grant. A new person can use their own wallet without deploying a new contract. The currently running connector uses one configured agent; a new connector installation generates its own agent address.

![AIChainPay dashboard configured for the deployed Sepolia vault; wallet not connected in this capture](./docs/screenshots/sepolia-dashboard-unconnected.png)

This is a real UI screenshot. It does not claim a connected-wallet session.

## Features and payment flow

1. The owner opens the dashboard, connects MetaMask on Sepolia and selects **Verify wallet**. The login message proves wallet ownership; it is not a transaction or spending permission.
2. The owner sends a small amount of Sepolia test ETH to their vault credit with `deposit`, then signs `grantAgent` in MetaMask. The grant sets a total allowance, per-payment cap, expiry, and optional recipient list. A blank list permits any valid address under the other limits. The owner can `revokeAgent` or `withdraw` later.
3. ChatGPT connects to the HTTPS `/mcp` endpoint using OAuth linked to that verified wallet. `prepare_payment` creates an immutable preview without sending ETH. `show_payment_confirmation` opens an in-chat card showing the full recipient, amount, source, network and deadline.
4. A fresh click on **Confirm** in that card permits the dedicated agent to submit `executeAgentPayment`. The contract enforces the live grant, recipient policy, amount limits, expiry, vault balance and request replay protection, then transfers ETH to the recipient. **No routine website or MetaMask approval is needed.**
5. The card checks `get_request_status` for the receipt and required confirmations. It shows success, rejection, reversion or an honest unknown/pending state. If a response is lost, check the same request; **never click Confirm twice or create a replacement payment just because a card spins**.

The owner key remains in MetaMask. The agent key stays in ignored local connector data and only authorizes spending within the owner's on-chain grant. OAuth access to read/request tools is different from that on-chain grant. This is an educational, host-trusted integration, not a security-audited payment service.

## Run the existing demonstration installation (Windows PowerShell)

Requirements: Node.js **22.13+**, npm, MetaMask on Sepolia, the existing ignored local RPC/connector configuration, and the assigned HTTPS tunnel. The contract is already deployed; **do not redeploy for an ordinary demo**.

```powershell
cd D:\AIChainPay
npm.cmd ci
npm.cmd run build
npm.cmd run verify:sepolia
npm.cmd run start:sepolia -- --live
```

Run the last command in its own terminal and leave it open; if the connector is already listening on port 3000, do not start a duplicate. Live startup is for the **already verified** local installation only: the launcher checks saved real-card evidence, the local agent identity and live-mode flags. A fresh installation must start disabled until its own real-client verification is completed.

If the assigned tunnel is not already online, use a second terminal:

```powershell
cd D:\AIChainPay
.\scripts\start-stable-ngrok.ps1 -PublicBaseUrl https://upscale-nanometer-duvet.ngrok-free.dev -AllowLiveConnector
```

The script asks for the ngrok token **locally**; never paste it into chat or commit it. Open [public health](https://upscale-nanometer-duvet.ngrok-free.dev/health), then the [dashboard](https://upscale-nanometer-duvet.ngrok-free.dev). Health should show `server`, `rpc` and `vault` as true. The public MCP URL is `https://upscale-nanometer-duvet.ngrok-free.dev/mcp` with **OAuth**. This hostname belongs to the current operator's ngrok account and works only while the laptop, connector and tunnel are running. Ngrok supplies HTTPS for ChatGPT; it is not the blockchain or a permanent deployment.

For frontend development, keep the connector on port 3000 and run the Vite frontend in another terminal:

```powershell
npm.cmd run dev:frontend
```

Open `http://localhost:5173`. Vite proxies `/api` to the connector. For the normal demo, `npm.cmd run build` lets the connector serve the built frontend itself, so a separate Vite terminal is unnecessary.

### A new wallet user

The operator must first have the connector and HTTPS endpoint running. The new user opens that public dashboard, connects their own **MetaMask EOA on Sepolia**, clicks **Verify wallet**, deposits their own small amount of test ETH, and signs their own bounded agent grant. These deposit/grant actions are MetaMask transactions and cost Sepolia gas. The user then installs the custom MCP server at the operator's `/mcp` URL with OAuth, signs in with the same wallet, and uses the in-chat card for payments. The agent also needs Sepolia ETH for gas; funding it is an operator setup step. No wallet private key or seed phrase should be entered into this project or chat.

### A fresh operator computer

1. Clone the repository; install Node.js 22.13+; run `npm.cmd ci` and `npm.cmd run build`.
2. Copy [.env.example](./.env.example) to an ignored local `.env` and enter a **Sepolia RPC URL locally**. A deployer key is not needed to reuse the existing vault. Run `npm.cmd run verify:sepolia`.
3. Obtain your **own stable HTTPS origin**. Run `npm.cmd run setup:sepolia-connector -- https://YOUR-HTTPS-ORIGIN` once. It verifies the deployed bytecode and creates ignored local connector configuration and a **new agent key**; the first connector startup creates SQLite storage. Never overwrite an existing connector installation.
4. Run `npm.cmd run start:sepolia`. This starts with execution **disabled**. Expose the matching HTTPS origin and verify OAuth, read tools, and real in-chat Confirm **and Reject** before enabling the gated live launcher. Fund the new agent with a little Sepolia test ETH for gas. Each owner must grant **this new agent**; a grant to the previous laptop's agent does not transfer.
5. For the ChatGPT connection, select **OAuth** and the full HTTPS `/mcp` URL. Refresh plugin tools after server UI changes. A new user can use their own wallet once the operator has completed this setup.

The new computer cannot simply reuse this operator's ngrok hostname, OAuth database or private agent key. Keep all credentials in ignored local files.

## Deploy a new contract (optional)

A new deployment is **not required** to use the contract above. If you intentionally deploy a different instance, use a separate deployer account funded with Sepolia test ETH. In an ignored root `.env`, set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY` locally; never use the owner's MetaMask key or commit either value.

```powershell
npm.cmd ci
npm.cmd run preflight:sepolia
npm.cmd run deploy:sepolia
npm.cmd run build
```

The preflight checks the chain, deployer and estimated cost without broadcasting. Deployment writes a new public address, ABI and manifest; review them and configure a new connector **before** claiming the frontend uses the new contract. The existing Sepolia address above remains the evidence for this repository's demonstrated instance.

## Verification and limitations

```powershell
npm.cmd test
npm.cmd run test:payment-card
npm.cmd run build
npm.cmd run verify:sepolia
npm.cmd run check:git-safety
```

On 2026-11-02, **9 contract tests and 12 backend tests passed**, the full build passed, and the browser card test passed under a **synthetic** host with no blockchain transaction. The read-only Sepolia verifier checked the deployment/ABI/runtime. The build has a nonfatal frontend chunk-size warning.

Actual Sepolia evidence includes an [owner deposit](https://sepolia.etherscan.io/tx/0x6106e7761ffba3cb274847d843b3e39fff9f58f03b9779fdda1eb458f9801ada), [grant](https://sepolia.etherscan.io/tx/0x1c5c4491b3571a0cb5464d80305ae28438a54daccfd77d77f4d596fe1838570f), [0.0001 ETH live ChatGPT-vault payment](https://sepolia.etherscan.io/tx/0x2bfe8bfc442c084cc012fed2b345044819bad1a11dfef682fea7a7e0cbff01cf), [0.00001 ETH later vault payment](https://sepolia.etherscan.io/tx/0x34a18b4ad7aee671d69ca9a654424032c49cc0511c86a33f2361f27638a30371), [revoke](https://sepolia.etherscan.io/tx/0x1e8d94f28b434eb393d8e16e830bdd52cb28b7ccc6ceeddd9fcbf7d72) and [regrant](https://sepolia.etherscan.io/tx/0x5759f2a59d21ad4e1842cb3c07eff8a1e205498d7ebd08bc8c908612e93e4526). Both listed payment receipts succeeded and emitted matching vault events. The newest automatic ChatGPT post-click message was locally tested but still needs independent real-client observation; do not treat a synthetic browser test as that proof.

![Real ChatGPT verification-only confirmation card; this screenshot did not send ETH](./docs/screenshots/chatgpt-card-verify-approved.png)

Only Sepolia test ETH and EOA wallet login are supported. This is not audited, permanently hosted, or a mainnet service. A detailed explanation is available in the [technical walkthrough PDF](./AIChainPay_Technical_Walkthrough.pdf).

## After a demo

Revoke the agent grant in the dashboard with owner MetaMask and wait for its receipt. Optionally withdraw remaining vault credit with a separate owner transaction. Then disconnect the ChatGPT MCP connection and stop the connector and HTTPS tunnel. Logging out of ChatGPT alone **does not revoke** on-chain permission.
