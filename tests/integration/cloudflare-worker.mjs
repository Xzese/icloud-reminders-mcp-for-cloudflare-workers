// Smoke journey through the built standalone edge. Synthetic JWT/JWKS only.
import { Miniflare, Log, LogLevel } from "miniflare";
import { fetch as mockFetch, MockAgent } from "undici";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parse } from "smol-toml";
const root = resolve(new URL("../..", import.meta.url).pathname);
const server = join(root, "dist/server");
const config = parse(await readFile(join(root, "wrangler.generated.toml"), "utf8"));
assert.equal(config.assets.run_worker_first, true);
const directory = await mkdtemp(join(tmpdir(), "reminders-access-acceptance-"));
const origin = "https://worker.example.test";
const issuer = "https://synthetic-team.cloudflareaccess.com";
const owner = "synthetic-access-owner";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), alg: "RS256", use: "sig", kid: "synthetic-key" };
const sign = sub => new SignJWT({ email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(sub).setIssuer(issuer).setAudience("synthetic-audience").setIssuedAt().setExpirationTime("5m").sign(privateKey);
const mock = new MockAgent(); mock.disableNetConnect();
mock.get(issuer).intercept({ path: "/cdn-cgi/access/certs", method: "GET" }).reply(200, { keys: [jwk] }).persist();
const paths = (await readdir(server, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
const worker = new Miniflare({
  name: "standalone-access-acceptance", modulesRoot: server,
  modules: [join(server, "index.js"), ...paths.filter(path => path !== join(server, "index.js"))].map(path => ({ type: "ESModule", path })),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  bindings: { APP_ORIGIN: origin, REMINDERS_OWNER_ID: owner, TEAM_DOMAIN: issuer, POLICY_AUD: "synthetic-audience", ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: randomBytes(32).toString("base64") }) },
  d1Databases: { DB: "synthetic-reminders-access" }, d1Persist: directory,
  assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
  outboundService: request => mockFetch(request, { dispatcher: mock }), log: new Log(LogLevel.ERROR),
});
try {
  const db = await worker.getD1Database("DB");
  await db.prepare(await readFile(join(root, "schema.sql"), "utf8")).run();
  const token = await sign(owner);
  const signed = { "Cf-Access-Jwt-Assertion": token, "oai-authenticated-user-id": "forged-owner", "oai-authenticated-user-email": "forged@example.invalid" };
  const missing = await worker.dispatchFetch(origin + "/api/bootstrap/identity", { headers: { "oai-authenticated-user-id": owner } });
  assert.equal(missing.status, 401);
  const asset = await worker.dispatchFetch(origin + "/favicon.svg"); assert.equal(asset.status, 401);
  const identity = await worker.dispatchFetch(origin + "/api/bootstrap/identity", { headers: signed });
  assert.equal(identity.status, 200, await identity.clone().text()); assert.deepEqual(await identity.json(), { authenticatedUserId: owner, ownerBound: true, automaticOwnerClaim: false });
  const denied = await worker.dispatchFetch(origin + "/api/connection", { headers: { "Cf-Access-Jwt-Assertion": await sign("other-synthetic-owner"), "oai-authenticated-user-id": owner } });
  assert.equal(denied.status, 403);
  const connection = await worker.dispatchFetch(origin + "/api/connection", { headers: signed });
  assert.equal(connection.status, 200, await connection.clone().text()); assert.equal((await connection.json()).state, "DISCONNECTED");
  const home = await worker.dispatchFetch(origin + "/", { headers: signed });
  assert.equal(home.status, 200);
  const dashboard = await home.text();
  assert.ok(dashboard.includes("Reminders connection"));
  assert.ok(dashboard.includes('href="/cdn-cgi/access/logout"'));
  assert.ok(!dashboard.includes('href="/signout-with-chatgpt'));
  const mcp = await worker.dispatchFetch(origin + "/mcp", { method: "POST", headers: { ...signed, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "connection_status", arguments: {} } }) });
  assert.equal(mcp.status, 200); const response = await mcp.json();
  assert.equal(response.result.structuredContent.writeEnabled, false);
  assert.equal(response.result.structuredContent.state, "DISCONNECTED");
  console.log(JSON.stringify({ result: "passed", runtime: "local-workerd", standaloneBundle: true, checks: ["verified-access-identity", "forged-header-denial", "static-asset-auth", "owner-isolation", "dashboard-and-MCP-routing"] }));
} finally { await worker.dispose(); await rm(directory, { recursive: true, force: true }); await mock.close(); }
