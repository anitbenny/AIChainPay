import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, formatEther, parseEther, randomBytes, hexlify, type Eip1193Provider } from "ethers";
import { ArrowDownToLine, ArrowUpRight, Check, Copy, ExternalLink, Link2, LockKeyhole, RotateCcw, ShieldCheck, Wallet, XCircle } from "lucide-react";
import { parseAmountEth, normalizeAddress, validateMemo, VAULT_ABI } from "@aichainpay/shared";

type Config = { chainId: number; contractAddress: string; agentAddress: string | null; mcpUrl: string; explorerUrl: string | null; executionEnabled: boolean };
type Permission = { active: boolean; remainingAllowanceEth: string; maxPerPaymentEth: string; expiresAt: number; epoch: string; restrictedRecipients: boolean };
type Dashboard = { address: string; walletEth: string; vaultEth: string; agentGasEth: string | null; permission: Permission | null; mcpRequestObserved: boolean; verifiedConnectorActivity: { action: string; detail: string; at: number }[] };
type Payment = { id: bigint; owner: string; recipient: string; executor: string; amount: bigint; memo: string; requestId: string; timestamp: bigint };
type IndexedPayment = Payment & { txHash: string; explorerUrl: string | null };
type PreparedRequest = { request_id: string; recipient: string; amount_eth: string; memo: string; state: string; request_deadline: string; transaction_hash: string | null };
type Tab = "overview" | "setup" | "connector" | "activity" | "developer";
type Ethereum = Eip1193Provider & { on?: (event: string, handler: (...args: unknown[]) => void) => void; removeListener?: (event: string, handler: (...args: unknown[]) => void) => void };

const localFallback: Config = {
  chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 11155111),
  contractAddress: import.meta.env.VITE_CONTRACT_ADDRESS ?? "",
  agentAddress: null,
  mcpUrl: "",
  explorerUrl: "https://sepolia.etherscan.io",
  executionEnabled: false,
};
const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";
const eth = () => (window as Window & { ethereum?: Ethereum }).ethereum;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const displayEth = (value: string | undefined) => { if (!value) return "—"; const [whole, fraction] = value.split("."); return fraction && fraction.length > 4 && /[1-9]/.test(fraction.slice(4)) ? `${whole}.${fraction.slice(0, 4)}…` : value; };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Operation failed";
function formatDate(seconds: number | bigint) { return new Date(Number(seconds) * 1000).toLocaleString(); }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

function Address({ value, explorer }: { value: string; explorer?: string | null }) {
  const [copied, setCopied] = useState(false);
  return <span className="address" title={value}><code>{value}</code><button type="button" className="icon-btn" aria-label={`Copy ${value}`} onClick={() => { void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); }}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>{explorer && <a href={explorer} target="_blank" rel="noreferrer" aria-label="View in Sepolia explorer"><ExternalLink size={14}/></a>}</span>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [config, setConfig] = useState<Config>(localFallback);
  const [backendOnline, setBackendOnline] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const [session, setSession] = useState<{ address: string; csrf: string } | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [payments, setPayments] = useState<IndexedPayment[]>([]);
  const [historyComplete, setHistoryComplete] = useState<boolean | null>(null);
  const [requests, setRequests] = useState<PreparedRequest[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [allowance, setAllowance] = useState("");
  const [cap, setCap] = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [allowlist, setAllowlist] = useState("");
  const [payRecipient, setPayRecipient] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payMemo, setPayMemo] = useState("");

  const provider = useCallback(() => { const injected = eth(); if (!injected) throw new Error("MetaMask is not available in this browser"); return new BrowserProvider(injected); }, []);
  const refreshWallet = useCallback(async () => {
    if (!eth()) { setWallet(null); setWalletChain(null); return; }
    const p = provider();
    const accounts = await p.send("eth_accounts", []) as string[];
    setWallet(accounts[0] ? normalizeAddress(accounts[0]) : null);
    setWalletChain(Number((await p.getNetwork()).chainId));
  }, [provider]);
  const refreshData = useCallback(async () => {
    if (!session || !wallet || session.address.toLowerCase() !== wallet.toLowerCase()) { setDashboard(null); setPayments([]); setRequests([]); setHistoryComplete(null); return; }
    try { setDashboard(await api<Dashboard>("/api/dashboard")); } catch { setDashboard(null); }
    try {
      const history = await api<{ items: { payment_id: string; owner: string; recipient: string; executor: string; amount_wei: string; memo: string; request_id: string; timestamp: number; tx_hash: string; explorer_url: string | null }[]; indexing: { complete: boolean } }>("/api/payments");
      setPayments(history.items.map(item => ({ id: BigInt(item.payment_id), owner: item.owner, recipient: item.recipient, executor: item.executor, amount: BigInt(item.amount_wei), memo: item.memo, requestId: item.request_id, timestamp: BigInt(item.timestamp), txHash: item.tx_hash, explorerUrl: item.explorer_url })));
      setHistoryComplete(history.indexing.complete);
    } catch { setPayments([]); setHistoryComplete(null); }
    try { setRequests((await api<{ items: PreparedRequest[] }>("/api/requests")).items); } catch { setRequests([]); }
  }, [session, wallet]);

  useEffect(() => {
    void api<Config>("/api/config").then(value => { setConfig(value); setBackendOnline(true); }).catch(() => setBackendOnline(false));
    void api<{ address: string | null; csrf?: string }>("/api/auth/me").then(value => setSession(value.address && value.csrf ? { address: value.address, csrf: value.csrf } : null)).catch(() => {});
    void refreshWallet().catch(() => {});
    const injected = eth();
    const reset = () => { setSession(null); setDashboard(null); setPayments([]); setRequests([]); setNotice(""); void refreshWallet().catch(() => {}); };
    injected?.on?.("accountsChanged", reset);
    injected?.on?.("chainChanged", reset);
    return () => { injected?.removeListener?.("accountsChanged", reset); injected?.removeListener?.("chainChanged", reset); };
  }, [refreshWallet]);
  useEffect(() => { void refreshData(); }, [refreshData]);
  useEffect(() => { const target = new URLSearchParams(location.search).get("return"); if (target && session && new URL(target, location.origin).origin === location.origin) location.href = target; }, [session]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); await refreshData(); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function connect() { await act("Connecting wallet", async () => { const p = provider(); const accounts = await p.send("eth_requestAccounts", []) as string[]; setWallet(normalizeAddress(accounts[0])); setWalletChain(Number((await p.getNetwork()).chainId)); setNotice("Wallet connected. Sign the separate login challenge to access your connector account."); }); }
  async function switchNetwork() { await act("Switching network", async () => {
    const injected = eth(); if (!injected) throw new Error("MetaMask missing");
    const chainId = `0x${config.chainId.toString(16)}`;
    try { await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] }); }
    catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902 || config.chainId !== 31337) throw error;
      await injected.request({ method: "wallet_addEthereumChain", params: [{
        chainId, chainName: "AIChainPay local test chain",
        nativeCurrency: { name: "Simulated Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: ["http://127.0.0.1:8545"],
      }] });
      await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    await refreshWallet();
  }); }
  async function signer() {
    if (!wallet) throw new Error("Connect MetaMask first");
    const p = provider();
    const chain = Number((await p.getNetwork()).chainId);
    if (chain !== config.chainId) throw new Error(`Switch MetaMask to chain ${config.chainId} before signing`);
    const s = await p.getSigner();
    if ((await s.getAddress()).toLowerCase() !== wallet.toLowerCase()) throw new Error("Wallet account changed; reconnect");
    if (!config.contractAddress) throw new Error("Vault address is not configured");
    return s;
  }
  async function login() { await act("Signing in", async () => {
    if (!wallet) throw new Error("Connect MetaMask first");
    const s = await signer();
    const challenge = await api<{ message: string }>("/api/auth/challenge", { method: "POST", body: JSON.stringify({ address: wallet }) });
    const signature = await s.signMessage(challenge.message);
    const result = await api<{ address: string; csrf: string }>("/api/auth/verify", { method: "POST", body: JSON.stringify({ message: challenge.message, signature }) });
    setSession(result); setNotice("Wallet ownership verified. This signature did not grant spending permission.");
  }); }
  async function ownerTx(label: string, fn: (vault: Contract) => Promise<{ wait: () => Promise<unknown>; hash: string }>) { await act(label, async () => { const s = await signer(); const vault = new Contract(config.contractAddress, VAULT_ABI, s); const tx = await fn(vault); setNotice(`Transaction submitted: ${tx.hash}. Waiting for receipt…`); await tx.wait(); setNotice(`Transaction mined: ${tx.hash}`); }); }
  async function deposit() { const wei = parseAmountEth(depositAmount); await ownerTx("Depositing", vault => vault.deposit({ value: wei })); }
  async function withdraw() { const wei = parseAmountEth(withdrawAmount); await ownerTx("Withdrawing", vault => vault.withdraw(wei)); }
  async function grant() {
    if (!config.agentAddress) { setError("Agent address is not configured"); return; }
    const total = parseAmountEth(allowance); const maximum = parseAmountEth(cap);
    if (maximum > total) { setError("Per-payment cap cannot exceed total allowance"); return; }
    const hours = Number(expiryHours);
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) { setError("Expiry must be 1–720 hours"); return; }
    const recipients = allowlist.trim() ? allowlist.split(/[\s,]+/).filter(Boolean).map(normalizeAddress) : [];
    if (recipients.length > 20 || new Set(recipients).size !== recipients.length) { setError("Use at most 20 distinct allowlisted addresses"); return; }
    await ownerTx("Granting agent", vault => vault.grantAgent(config.agentAddress, total, maximum, Math.floor(Date.now() / 1000) + hours * 3600, recipients));
  }
  async function revoke() { if (!config.agentAddress) { setError("Agent address is not configured"); return; } await ownerTx("Revoking agent", vault => vault.revokeAgent(config.agentAddress)); }
  async function directPay() { const recipient = normalizeAddress(payRecipient); const amount = parseAmountEth(payAmount); const memo = validateMemo(payMemo); await ownerTx("Owner payment", vault => vault.pay(recipient, amount, memo, hexlify(randomBytes(32)))); }
  async function logout() { await act("Disconnecting session", async () => { if (session) await api("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": session.csrf } }); setSession(null); setDashboard(null); setNotice("Browser session disconnected. Any on-chain agent grant remains active until revoked separately."); }); }

  const wrongChain = wallet && walletChain !== config.chainId;
  const walletReady = wallet && !wrongChain;
  const loggedIn = walletReady && session?.address.toLowerCase() === wallet.toLowerCase();
  const vaultReady = Boolean(loggedIn && dashboard?.permission?.active && dashboard.permission.expiresAt > Date.now() / 1000 && Number(dashboard.permission.remainingAllowanceEth) > 0 && Number(dashboard.vaultEth) > 0);
  const chatActivityObserved = Boolean(loggedIn && dashboard?.mcpRequestObserved);
  const completedSetupSteps = Number(Boolean(walletReady)) + Number(Boolean(loggedIn)) + Number(vaultReady) + Number(chatActivityObserved);
  const nav: { key: Tab; label: string }[] = [{ key: "overview", label: "Overview" }, { key: "setup", label: "Vault setup" }, { key: "connector", label: "AI connector" }, { key: "activity", label: "Activity" }, { key: "developer", label: "Developer diagnostics" }];
  const explorer = config.explorerUrl;

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><Link2 size={23}/></span><span><strong>AIChainPay</strong><small>VAULT PAYMENTS</small></span></div><div className="sidebar-label">WORKSPACE</div><nav>{nav.map(item => <button key={item.key} className={tab === item.key ? "nav active" : "nav"} onClick={() => setTab(item.key)}>{item.label}</button>)}</nav><div className="sidebar-bottom"><span className="status-dot"/> {config.chainId === 11155111 ? "Sepolia network" : "Local chain 31337"} <small>{config.chainId === 11155111 ? "Educational testnet application" : "Simulated development network"}</small></div></aside>
    <main className="main"><div className="testnet-banner"><ShieldCheck size={16}/> {config.chainId === 11155111 ? "SEPOLIA TESTNET — TEST FUNDS ONLY" : "LOCAL TEST CHAIN 31337 — SIMULATED FUNDS ONLY"}</div>
      <header className="topbar"><div><div className="eyebrow">NATURAL-LANGUAGE BLOCKCHAIN PAYMENTS</div><h1>{tab === "overview" ? "Your vault, in view." : tab === "setup" ? "Vault setup & permissions" : tab === "connector" ? "Connect your AI client" : tab === "developer" ? "Developer diagnostics" : "Vault activity"}</h1><p className="subtitle">Set limits with MetaMask. Routine payments are designed to happen in chat.</p></div><div className="header-actions"><span className={`pill ${backendOnline ? "online" : "offline"}`}>{backendOnline ? "Connector online" : "Connector offline"}</span>{wallet ? <button className="wallet-button" onClick={() => setTab("setup")}><Wallet size={16}/>{short(wallet)}</button> : <button className="primary" onClick={() => void connect()}><Wallet size={16}/> Connect MetaMask</button>}</div></header>
      {error && <div className="alert error"><XCircle size={18}/><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div>}
      {notice && <div className="alert notice"><Check size={18}/><span>{notice}</span><button onClick={() => setNotice("")}>Dismiss</button></div>}
      {wrongChain && <div className="alert warning">MetaMask is on chain {walletChain}; AIChainPay is configured for chain {config.chainId}. <button onClick={() => void switchNetwork()}>Switch network</button></div>}
      {walletReady && !loggedIn && <div className="alert warning">Wallet connected, but ownership is not yet verified. <button onClick={() => void login()}>Verify wallet — sign login message</button></div>}

      {tab === "overview" && <><div className="hero"><div><span className="hero-kicker">DELEGATED VAULT CONTROL</span><h2>Pay from chat.<br/><em>Stay in control.</em></h2><p>Deposit test ETH, set a bounded agent allowance, then request transfers through a connected AI client. The agent never touches ETH in your ordinary wallet.</p><button onClick={() => setTab("setup")}>Review setup <ArrowUpRight size={16}/></button></div><div className="hero-orbit"><div className="orbit-center"><ShieldCheck size={36}/></div><span className="orbit-node orbit-a">OWNER</span><span className="orbit-node orbit-b">AGENT</span><span className="orbit-node orbit-c">VAULT</span></div></div>
        <div className="metric-grid"><div className="metric"><span>WALLET ETH</span><strong title={dashboard?.walletEth}>{displayEth(dashboard?.walletEth)}</strong><small>Ordinary MetaMask balance</small></div><div className="metric accent"><span>VAULT ETH</span><strong>{dashboard?.vaultEth ?? "—"}</strong><small>Deposited and withdrawable</small></div><div className="metric"><span>AGENT ALLOWANCE</span><strong>{dashboard?.permission?.remainingAllowanceEth ?? "—"}</strong><small>{dashboard?.permission?.active ? "Active grant" : "No active grant"}</small></div><div className="metric"><span>AGENT GAS</span><strong title={dashboard?.agentGasEth ?? undefined}>{displayEth(dashboard?.agentGasEth ?? undefined)}</strong><small>Paid by dedicated signer</small></div></div>
        <div className="two-col"><section className="panel"><div className="panel-heading"><h3>Connection checklist</h3><span>{String(completedSetupSteps).padStart(2, "0")} / 04</span></div><div className="checkline"><span className={walletReady ? "check done" : "check"}>{walletReady ? <Check size={14}/> : "1"}</span><div><strong>Connect MetaMask</strong><small>Owner wallet stays in your browser</small></div></div><div className="checkline"><span className={loggedIn ? "check done" : "check"}>{loggedIn ? <Check size={14}/> : "2"}</span><div><strong>Verify wallet ownership</strong><small>Expiring SIWE login signature</small></div></div><div className="checkline"><span className={vaultReady ? "check done" : "check"}>{vaultReady ? <Check size={14}/> : "3"}</span><div><strong>Fund and grant the vault</strong><small>Requires credit and an active, unexpired allowance</small></div></div><div className="checkline"><span className={chatActivityObserved ? "check done" : "check"}>{chatActivityObserved ? <Check size={14}/> : "4"}</span><div><strong>Connect your AI client</strong><small>Authenticated MCP request observed for this wallet; not proof of a current connection</small></div></div></section><section className="panel"><div className="panel-heading"><h3>Deployment</h3><span>CHAIN {config.chainId}</span></div><div className="detail-row"><span>Vault contract</span>{config.contractAddress ? <Address value={config.contractAddress} explorer={explorer && `${explorer}/address/${config.contractAddress}`}/> : <strong>Not configured</strong>}</div><div className="detail-row"><span>Verified owner</span>{wallet ? <Address value={wallet} explorer={explorer && `${explorer}/address/${wallet}`}/> : <strong>Connect wallet</strong>}</div><div className="detail-row"><span>Execution</span><strong className="amber">{config.executionEnabled ? "Configured" : "Disabled pending chat approval test"}</strong></div></section></div>
      </>}

      {tab === "setup" && <><div className="section-intro"><h2>One-time owner controls</h2><p>Wallet verification is a message signature, not a transaction. Deposits and permissions are separate MetaMask transactions.</p></div><div className="two-col"><section className="panel"><div className="panel-heading"><h3>1. Wallet & login</h3><Wallet size={18}/></div><div className="detail-row"><span>Connected wallet</span>{wallet ? <Address value={wallet}/> : <strong>Not connected</strong>}</div><div className="detail-row"><span>Network</span><strong>{walletChain ?? "Not detected"} (required: {config.chainId})</strong></div><div className="button-row">{!wallet && <button className="primary" onClick={() => void connect()}>Connect MetaMask</button>}{wallet && !loggedIn && <button className="primary" disabled={Boolean(wrongChain) || !backendOnline || Boolean(busy)} onClick={() => void login()}>Verify wallet — sign login message</button>}{wrongChain && <button className="secondary" disabled={Boolean(busy)} onClick={() => void switchNetwork()}>Switch to required network</button>}{loggedIn && <button className="secondary" onClick={() => void logout()}>Disconnect browser session</button>}</div>{wallet && !backendOnline && <p className="hint">The connector is offline. Wallet sign-in will be available when it starts.</p>}{wrongChain && <p className="hint">Switch MetaMask to chain {config.chainId} before signing in. The sign-in button stays visible but is disabled on the wrong network.</p>}<p className="hint">The login signature proves wallet ownership. It does not permit the agent to spend or transfer ETH. Disconnecting this session does not revoke any on-chain grant.</p></section><section className="panel"><div className="panel-heading"><h3>2. Fund the vault</h3><ArrowDownToLine size={18}/></div><p className="balance-callout">{dashboard?.vaultEth ?? "—"} <span>{config.chainId === 11155111 ? "Sepolia ETH" : "Simulated ETH"} deposited</span></p><label>Deposit amount (ETH)<input value={depositAmount} onChange={e => setDepositAmount(e.target.value)} placeholder="0.01" inputMode="decimal"/></label><button className="primary full" disabled={!walletReady || Boolean(busy)} onClick={() => void deposit()}>Deposit with MetaMask</button><p className="hint">Only explicit deposit() credits your vault balance. Your wallet pays deposit gas.</p></section></div>
        <section className="panel grant-panel"><div className="panel-heading"><h3>3. Bounded agent permission</h3><LockKeyhole size={18}/></div><p>Grant replaces the previous grant rather than adding to it. An empty recipient list allows any valid recipient. An allowance above today's balance can also spend future deposits until used, expired, or revoked.</p><div className="detail-row"><span>Dedicated agent</span>{config.agentAddress ? <Address value={config.agentAddress} explorer={explorer && `${explorer}/address/${config.agentAddress}`}/> : <strong>Not configured</strong>}</div><div className="form-grid"><label>Total allowance (ETH)<input value={allowance} onChange={e => setAllowance(e.target.value)} placeholder="0.05" inputMode="decimal"/></label><label>Maximum per payment (ETH)<input value={cap} onChange={e => setCap(e.target.value)} placeholder="0.01" inputMode="decimal"/></label><label>Expiry (hours from now)<input value={expiryHours} onChange={e => setExpiryHours(e.target.value)} inputMode="numeric"/></label><label>Allowed recipients (optional)<textarea value={allowlist} onChange={e => setAllowlist(e.target.value)} placeholder="One address per line; blank means unrestricted" rows={3}/></label></div><div className="button-row"><button className="primary" disabled={!walletReady || !config.agentAddress || Boolean(busy)} onClick={() => void grant()}>Grant / replace with MetaMask</button><button className="danger" disabled={!walletReady || !config.agentAddress || Boolean(busy)} onClick={() => void revoke()}>Revoke agent</button></div><p className="hint">Revocation takes effect once its transaction is mined. It cannot undo completed payments or guarantee ordering against pending ones.</p></section>
        <div className="two-col"><section className="panel"><div className="panel-heading"><h3>Withdraw your credit</h3><ArrowUpRight size={18}/></div><label>Amount (ETH)<input value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} placeholder="0.01" inputMode="decimal"/></label><button className="secondary full" disabled={!walletReady || Boolean(busy)} onClick={() => void withdraw()}>Withdraw with MetaMask</button><p className="hint">An agent grant never blocks your withdrawal. Future deposits may still be spendable under an active grant.</p></section><section className="panel"><div className="panel-heading"><h3>Direct owner payment</h3><ArrowUpRight size={18}/></div><p className="hint">Optional assignment demonstration. This is MetaMask-signed and is not the AI chat flow.</p><label>Recipient address<input value={payRecipient} onChange={e => setPayRecipient(e.target.value)} placeholder="0x…"/></label><div className="form-grid"><label>Amount (ETH)<input value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.001"/></label><label>Public memo<input value={payMemo} onChange={e => setPayMemo(e.target.value)} placeholder="Optional, max 140 bytes"/></label></div><button className="secondary full" disabled={!walletReady || Boolean(busy)} onClick={() => void directPay()}>Pay directly with MetaMask</button></section></div></>}

      {tab === "connector" && <><div className="section-intro"><h2>ChatGPT connection</h2><p>The chat client, not this page, handles routine payment requests. A verified OAuth connection and client confirmation are still required before delegated execution is enabled.</p></div><section className="panel"><div className="panel-heading"><h3>Remote MCP endpoint</h3><Link2 size={18}/></div><div className="endpoint">{config.mcpUrl || "No endpoint configured"}{config.mcpUrl && <button onClick={() => void navigator.clipboard.writeText(config.mcpUrl)} aria-label="Copy MCP URL"><Copy size={16}/></button>}</div><p className="hint">ChatGPT needs a publicly reachable HTTPS endpoint or a supported secure tunnel. Localhost is only for local protocol tests. OAuth linking may open a browser for wallet sign-in; payment approval must stay in chat.</p><div className="detail-row"><span>Server</span><strong>{backendOnline ? "Online locally" : "Unavailable"}</strong></div><div className="detail-row"><span>Authenticated MCP activity</span><strong>{chatActivityObserved ? "Request observed for this wallet" : "Not observed"}</strong></div><div className="detail-row"><span>Payment execution</span><strong className="amber">{config.executionEnabled ? "Enabled" : "Disabled until approval gate tested"}</strong></div></section><section className="panel"><div className="panel-heading"><h3>Connection steps</h3><span>CHATGPT FIRST</span></div><ol className="steps"><li>Deploy the connector with HTTPS and persistent SQLite storage; configure the actual Sepolia RPC, vault, agent signer and local secrets.</li><li>In ChatGPT Plugins, add a custom MCP server using the endpoint above. Account/workspace capability is required.</li><li>Authorize the OAuth connection using your verified wallet session; review the requested scopes separately from the on-chain grant.</li><li>Test read tools and a harmless write-confirmation prompt before any transfer. Execution remains disabled until that result is verified.</li></ol><p className="hint">Claude is a second target and is not claimed to work until tested separately.</p></section></>}

      {tab === "activity" && <><div className="section-intro"><h2>Real vault records</h2><p>These records come from indexed contract events. They are not full wallet history; memos and addresses are public on-chain.</p></div><section className="panel"><div className="panel-heading"><h3>Payments involving your wallet</h3><button className="text-btn" onClick={() => void refreshData()}><RotateCcw size={14}/> Refresh</button></div>{historyComplete === false && <p className="hint">Event indexing is catching up; this list may be incomplete.</p>}{payments.length ? <div className="payment-list">{payments.map(payment => <div className="payment" key={payment.txHash}><div className="payment-icon"><ArrowUpRight size={18}/></div><div><strong>{formatEther(payment.amount)} ETH</strong><small>To {short(payment.recipient)} · {formatDate(payment.timestamp)}</small>{payment.memo && <small>Public memo: {payment.memo}</small>}{payment.explorerUrl && <a className="payment-link" href={payment.explorerUrl} target="_blank" rel="noreferrer">View real transaction <ExternalLink size={12}/></a>}</div><span className="payment-id">#{payment.id.toString()}</span></div>)}</div> : <p className="empty">No indexed contract payments loaded. Connect and sign in to view actual records.</p>}</section><section className="panel"><div className="panel-heading"><h3>Verified connector activity</h3></div>{dashboard?.verifiedConnectorActivity?.length ? dashboard.verifiedConnectorActivity.map((item, index) => <div className="detail-row" key={index}><span>{item.action}</span><span>{formatDate(item.at)}</span></div>) : <p className="empty">No authenticated MCP activity has been observed for this wallet.</p>}</section></>}
      {tab === "activity" && <section className="panel"><div className="panel-heading"><h3>Prepared chat requests</h3><span>OFF-CHAIN STATE</span></div><p className="hint">These are wallet-linked connector records, not proof of a mined transaction. Use request status and a real receipt to verify settlement.</p>{requests.length ? requests.map(request => <div className="detail-row" key={request.request_id}><span>{request.amount_eth} ETH to {short(request.recipient)}<br/><small>{request.state} · expires {new Date(request.request_deadline).toLocaleString()}</small></span><strong>{request.transaction_hash ? <Address value={request.transaction_hash} explorer={explorer && `${explorer}/tx/${request.transaction_hash}`}/> : request.state}</strong></div>) : <p className="empty">No prepared requests for this wallet.</p>}</section>}
      {tab === "developer" && <><div className="section-intro"><h2>Read-only developer diagnostics</h2><p>Uses the same wallet-authenticated dashboard, request and indexed-payment APIs as the main screens. This is not a payment approval or execution path.</p></div>{!loggedIn ? <section className="panel"><p className="empty">Connect the owner MetaMask wallet and verify ownership to inspect wallet-scoped records.</p></section> : <><section className="panel"><div className="panel-heading"><h3>Current configuration and chain state</h3><button className="text-btn" onClick={() => void refreshData()}><RotateCcw size={14}/> Refresh</button></div><div className="detail-row"><span>Network</span><strong>{config.chainId === 11155111 ? "Sepolia" : "Local test chain"} ({config.chainId})</strong></div><div className="detail-row"><span>Vault</span><Address value={config.contractAddress} explorer={explorer && `${explorer}/address/${config.contractAddress}`}/></div><div className="detail-row"><span>Verified owner</span><Address value={session!.address} explorer={explorer && `${explorer}/address/${session!.address}`}/></div><div className="detail-row"><span>Vault credit</span><strong>{dashboard?.vaultEth ?? "Unavailable"} ETH</strong></div><div className="detail-row"><span>Agent permission</span><strong>{dashboard?.permission ? `${dashboard.permission.active ? "Active" : "Inactive"}; epoch ${dashboard.permission.epoch}; ${dashboard.permission.remainingAllowanceEth} ETH remaining` : "Unavailable"}</strong></div><div className="detail-row"><span>Indexed vault payments</span><strong>{payments.length}{historyComplete === false ? " (indexing incomplete)" : ""}</strong></div></section><section className="panel"><div className="panel-heading"><h3>Wallet-scoped request states</h3><span>NO EXECUTION CONTROL</span></div>{requests.length ? requests.map(request => <div className="detail-row" key={request.request_id}><span><code>{request.request_id}</code><br/><small>{request.amount_eth} ETH to {request.recipient}</small></span><strong>{request.transaction_hash ? <Address value={request.transaction_hash} explorer={explorer && `${explorer}/tx/${request.transaction_hash}`}/> : request.state}</strong></div>) : <p className="empty">No requests returned for this verified wallet.</p>}<p className="hint">A prepared or submitted state is not payment proof. Inspect the actual receipt and event before claiming settlement; routine approval remains inside ChatGPT.</p></section></>}</>}
      <footer><span>AIChainPay · {config.chainId === 11155111 ? "Sepolia" : "Local-chain"} educational demo</span><span>{config.chainId === 11155111 ? "Test ETH" : "Simulated ETH"} only · Not audited financial infrastructure</span></footer>
    </main>
  </div>;
}
