import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import Provider, { errors, type AdapterPayload, type Configuration } from "oidc-provider";
import type { Config } from "../config.js";

const SCOPES = "wallet:read payments:prepare payments:execute";

function signingKey(path: string): JsonWebKey {
  const absolute = resolve(dirname(path), "oauth-signing.jwk");
  if (existsSync(absolute)) return JSON.parse(readFileSync(absolute, "utf8")) as JsonWebKey;
  mkdirSync(dirname(absolute), { recursive: true });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })).export({ format: "jwk" }) as JsonWebKey & { kid?: string; use?: string; alg?: string };
  jwk.kid = "aichainpay-local-1";
  jwk.use = "sig";
  jwk.alg = "RS256";
  writeFileSync(absolute, JSON.stringify(jwk), { flag: "wx", mode: 0o600 });
  return jwk;
}

export function sqliteAdapter(db: Database.Database) {
  return (model: string) => ({
    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      const expiry = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;
      db.prepare("INSERT INTO oauth_objects(model,id,payload,expires_at,grant_id,uid,user_code) VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,grant_id=excluded.grant_id,uid=excluded.uid,user_code=excluded.user_code")
        .run(model, id, JSON.stringify(payload), expiry, payload.grantId ?? null, payload.uid ?? null, payload.userCode ?? null);
    },
    async find(id: string) { return read("model=? AND id=?", model, id); },
    async findByUid(uid: string) { return read("model=? AND uid=?", model, uid); },
    async findByUserCode(code: string) { return read("model=? AND user_code=?", model, code); },
    async consume(id: string) {
      const payload = read("model=? AND id=?", model, id);
      if (payload) {
        payload.consumed = Math.floor(Date.now() / 1000);
        db.prepare("UPDATE oauth_objects SET payload=? WHERE model=? AND id=?").run(JSON.stringify(payload), model, id);
      }
    },
    async destroy(id: string) { db.prepare("DELETE FROM oauth_objects WHERE model=? AND id=?").run(model, id); },
    async revokeByGrantId(grantId: string) { db.prepare("DELETE FROM oauth_objects WHERE grant_id=?").run(grantId); },
  });

  function read(where: string, first: string, second: string): AdapterPayload | undefined {
    const row = db.prepare(`SELECT payload,expires_at FROM oauth_objects WHERE ${where}`).get(first, second) as { payload: string; expires_at: number | null } | undefined;
    if (!row || (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000))) return undefined;
    return JSON.parse(row.payload) as AdapterPayload;
  }
}

export function createOAuthProvider(db: Database.Database, config: Config): Provider {
  const resource = `${config.publicBaseUrl}/mcp`;
  const configuration: Configuration = {
    adapter: sqliteAdapter(db),
    clients: config.chainId === 31337 ? [{ client_id: "aichainpay-local-test", redirect_uris: ["http://127.0.0.1:3999/callback"], token_endpoint_auth_method: "none", response_types: ["code"], grant_types: ["authorization_code"] }] : [],
    jwks: { keys: [signingKey(config.databasePath)] },
    cookies: { keys: [config.sessionSecret], short: { sameSite: "lax", secure: config.publicBaseUrl.startsWith("https:") }, long: { sameSite: "lax", secure: config.publicBaseUrl.startsWith("https:") } },
    scopes: SCOPES.split(" "),
    ttl: { AccessToken: 3600, AuthorizationCode: 300, Interaction: 600, Session: 12 * 3600, Grant: 12 * 3600 },
    responseTypes: ["code"],
    pkce: { required: () => true },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    findAccount: async (_ctx, address) => {
      const user = db.prepare("SELECT address FROM users WHERE address=?").get(address) as { address: string } | undefined;
      if (!user) return undefined;
      return { accountId: user.address, async claims() { return { sub: user.address }; } };
    },
    features: {
      devInteractions: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: async (_ctx, clientId) => /^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[^/]+\/client\.json)$/.test(clientId),
        allowClient: async (_ctx, client) => client.clientId.startsWith("https://chatgpt.com/oauth/"),
      },
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo: async (_ctx, requested) => {
          if (requested !== resource) throw new errors.InvalidTarget("Unknown resource");
          return { scope: SCOPES, audience: resource, accessTokenTTL: 3600, accessTokenFormat: "opaque" };
        },
        defaultResource: async () => resource,
      },
    },
  };
  const provider = new Provider(config.issuer, configuration);
  // TLS terminates at the HTTPS forwarding proxy. Without Koa proxy mode,
  // discovery advertises http:// authorization/token URLs from the local hop.
  provider.proxy = config.publicBaseUrl.startsWith("https:");
  return provider;
}

export type Principal = { address: string; clientId: string; scopes: Set<string> };

export async function verifyBearer(provider: Provider, config: Config, header?: string): Promise<Principal | undefined> {
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+)$/.exec(header ?? "");
  if (!match) return undefined;
  const token = await provider.AccessToken.find(match[1]);
  if (!token || !token.accountId || !token.clientId || !token.exp || token.exp <= Math.floor(Date.now() / 1000)) return undefined;
  if (token.aud !== `${config.publicBaseUrl}/mcp` && !(Array.isArray(token.aud) && token.aud.includes(`${config.publicBaseUrl}/mcp`))) return undefined;
  const scopes = new Set((token.scope ?? "").split(" ").filter(Boolean));
  if (!scopes.has("wallet:read")) return undefined;
  return { address: token.accountId, clientId: token.clientId, scopes };
}
