# Client integration: actual evidence boundary

ChatGPT is the first target client. The connector offers authenticated Streamable HTTP MCP at `https://<your-host>/mcp`; it is **not** an LLM API and needs no OpenAI API key. Initial OAuth/wallet login may open a browser. Routine payment confirmation must occur in the chat client, without returning to the AIChainPay website or MetaMask for each payment.

Official references consulted: [OpenAI custom MCP server](https://developers.openai.com/plugins/build/mcp-server), [authorization](https://developers.openai.com/plugins/build/auth), [connecting to ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt), [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), and [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation). Client features and account access can change; recheck the official pages during live setup.

## Implemented locally

The connector publishes OAuth authorization-server and protected-resource metadata, uses authorization code + PKCE with persistent `oidc-provider`, restricts the resource audience to `/mcp`, and binds tokens to a wallet address verified through a one-use SIWE challenge. It accepts ChatGPT's Client ID Metadata Document registration pattern by policy. A local synthetic client completed OAuth, initialized MCP, listed tools and read an actual **local-chain** vault balance. That is protocol evidence only; it is not evidence that a real ChatGPT account connected or approved a write.

`probe_write_confirmation` is a harmless, audited MCP write with no blockchain transaction. `prepare_payment` stores an immutable preview and does not broadcast. `execute_payment` accepts only request ID and digest; it cannot change recipient/amount. The service has a `chatgpt_native` adapter that trusts the client's native per-write approval **only after an operator has observed and recorded an adequate real approval UI**. OAuth alone is not human approval; the server receives no cryptographic click receipt. MCP form-mode elicitation is not used for financial authorization because the protocol prohibits collecting transaction-authorizing credentials/information there. Tool annotations are hints, not enforcement.

The default `CONFIRMATION_ADAPTER=disabled` refuses execution before signing/broadcast. `CHATGPT_APPROVAL_TESTED=1` is an operator-controlled assertion, not a technical proof. The adapter is further constrained to Sepolia, HTTPS and recognized ChatGPT client IDs. **Do not set it until the real client/version/account has been tested**, including whether its approval screen reveals the exact stored owner, vault source, full recipient, ETH amount, public memo, deadline and expected effect. If those details are not visible, the native approval approach is not adequate and remains blocked. A preview shown in a previous chat message alone is not proof that the client's execution approval screen binds to it.

## Required manual ChatGPT test

1. Deploy the vault to Sepolia and run the connector behind a stable public HTTPS endpoint with persistent storage. Keep execution disabled. Record the actual deployment manifest and endpoint privately. The connector's `/health` and discovery metadata should be reachable; a bare `/mcp` request without OAuth must return 401.
2. Check whether your ChatGPT account/workspace exposes adding a custom remote MCP server/connector. Add the exact HTTPS `/mcp` URL using ChatGPT's current official interface. If the setting is absent, stop live integration at this account-capability blocker; local MCP tests cannot substitute.
3. Follow OAuth. The browser dashboard asks for a MetaMask SIWE login signature if needed. Verify the account, chain, address and scope consent. The SIWE signature logs in; it does not move ETH. Connect only the intended owner wallet. Do not paste a private key or seed phrase.
4. In chat, ask “Which wallet and network are linked to AIChainPay?” and “What is my deposited vault balance and active agent limit?” Compare the reported values to the Sepolia contract and dashboard. Record client name/version/date and whether actual on-chain values matched.
5. Invoke `probe_write_confirmation` in chat. Observe the exact confirmation UI and whether a human must approve it before the server logs the probe. A harmless probe does **not** prove the real payment prompt is adequate. Next prepare a tiny intended payment and inspect the proposed `execute_payment` confirmation **without accepting** until the full immutable intent is visibly and unambiguously bound to the write action. If the UI shows only a UUID/digest or a generic execute label, stop; do not enable execution.
6. If the approval mechanism is actually adequate and observed, record the client/version/date/screenshot or redacted notes locally in [implementation status](../IMPLEMENTATION_STATUS.md). Only then set `CONFIRMATION_ADAPTER=chatgpt_native` and `CHATGPT_APPROVAL_TESTED=1` in the server's private configuration and restart. A small Sepolia transfer, decline/no-broadcast and revocation test remain necessary for live acceptance. Before approving a real execution, understand that it sends the displayed amount of deposited test ETH to the displayed recipient; the agent pays gas and the transfer is irreversible once mined.

Suggested prompts after setup:

> Show my AIChainPay vault balance and agent allowance on Sepolia.

> Prepare a payment of 0.001 Sepolia ETH from my AIChainPay vault to 0x… with memo “demo”, then show me the exact recipient and amount. Do not execute yet.

> Execute the prepared payment only if the exact vault, full recipient, amount and memo match what I intended. Show the current request status and real explorer link.

The client may return `submitted`; ask for `get_request_status` later. No unsolicited completion message is implemented. Claude is a second target and **has not been connected or tested**; no Claude confirmation claim is made.
