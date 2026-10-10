// Owner-authorised local rollout only. No credentials are exported and outbound
// requests are disabled throughout migration and compatible cold-start checks.
import { Miniflare, Log, LogLevel } from "miniflare";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { AppleSessionSchema } from "../../src/persistence/apple-sessions.ts";
import { SESSION_RETENTION_MS } from "../../src/auth/apple/policy.ts";

const apply = process.argv.length === 3 && process.argv[2] === "--apply-owner-approval";
if (process.argv.length !== 2 && !apply) throw new Error("Use session:retention:local [--apply-owner-approval].");
const root = resolve(new URL("../..", import.meta.url).pathname);
const state = join(root, ".sites-runtime/local-icloud");
// Refuse to run beside an incompatible development reader. Do not query its
// status endpoint: an old loader could delete a retained eligible envelope.
await new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port: 5173 });
  socket.once("connect", () => { socket.destroy(); reject(new Error("Stop the local Worker and drain its operations before migration.")); });
  socket.once("error", error => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(); else reject(error); });
  socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Could not establish that the old local reader is stopped.")); });
});
let keys;
try { keys = JSON.parse(await readFile(join(state, "keys.json"), "utf8")); }
catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new Error("The existing local key configuration is malformed. Nothing was created or replaced."); }
if (!keys || typeof keys.owner !== "string" || !/^local-[a-f0-9]{32}$/.test(keys.owner) || typeof keys.key !== "string" || Buffer.from(keys.key, "base64").length !== 32) throw new Error("The existing local owner/key configuration is invalid. Nothing was replaced.");
const directory = join(state, "d1/miniflare-D1DatabaseObject");
const databases = (await readdir(directory)).filter(name => name.endsWith(".sqlite") && name !== "metadata.sqlite");
if (databases.length !== 1) throw new Error("Expected exactly one existing local session database. No database will be created or selected arbitrarily.");
const sqlite = new DatabaseSync(join(directory, databases[0]), { readOnly: true });
let row;
try { row = sqlite.prepare("SELECT * FROM apple_session_state WHERE owner_id = ? AND account_id = 'apple-reminders'").get(keys.owner); }
finally { sqlite.close(); }
if (!row?.envelope || !["READY", "DEVICE_APPROVAL_PENDING"].includes(row.state)) throw new Error("Saved credentials are unavailable or disconnected. No backup will be restored and no new sign-in was started.");
if (row.transaction_id || row.transaction_expires_at > Date.now() || row.resume_expires_at > Date.now()) throw new Error("A setup or operation lease is active. Migration is deferred without deleting the session.");
const envelopes = new Envelopes("local-live", { "local-live": keys.key });
const context = { ownerId: keys.owner, accountId: "apple-reminders", generation: row.generation, recordId: "apple-session", schemaVersion: 1 };
function checkedSession(value) {
  const parsed = AppleSessionSchema.safeParse(value);
  if (!parsed.success) throw new Error("The saved session structure is unsupported. No credential details were exported.");
  return parsed.data;
}
const before = checkedSession(await envelopes.decrypt(JSON.parse(row.envelope), context));
const safe = (session, current) => ({
  state: current.state, generation: current.generation, version: current.version,
  loginVersion: session.login.version, verifiedAt: session.login.verifiedAt, expiresAt: session.login.expiresAt,
  cookiesCount: session.auth.cookies.length, savedListsCount: session.savedLists?.length ?? 0,
});
console.log(JSON.stringify({ phase: "before", ...safe(before, row), proposedExpiresAt: before.login.verifiedAt + SESSION_RETENTION_MS }));
if (!apply) process.exit(0);
if (Date.now() >= before.login.verifiedAt + SESSION_RETENTION_MS) throw new Error("The fixed 30-day deadline already passed. This connection cannot be revived.");
const serverRoot = join(root, "dist/server");
const config = JSON.parse(await readFile(join(serverRoot, "wrangler.json"), "utf8"));
await stat(join(serverRoot, "index.js"));
const entries = await readdir(serverRoot, { recursive: true, withFileTypes: true });
const entrypoint = join(serverRoot, "index.js");
const modules = [{ type: "ESModule", path: entrypoint }, ...entries.filter(entry => entry.isFile() && /\.(js|mjs)$/.test(entry.name) &&
  join(entry.parentPath, entry.name) !== entrypoint).map(entry => ({ type: "ESModule", path: join(entry.parentPath, entry.name) }))];
const origin = "http://127.0.0.1:5173";
let appleRequests = 0;
const options = {
  name: "local-reminders-app", modulesRoot: serverRoot, modules,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  log: new Log(LogLevel.ERROR), d1Persist: join(state, "d1"),
  d1Databases: { DB: "isolated-local-icloud" },
  assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true } },
  bindings: { APP_ORIGIN: origin, REMINDERS_OWNER_ID: keys.owner, ENCRYPTION_KEY_ID: "local-live",
    ENCRYPTION_KEYS_JSON: JSON.stringify({ "local-live": keys.key }),
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" },
  outboundService: async () => { appleRequests++; throw new Error("Apple requests are forbidden during retention migration."); },
};
const worker = new Miniflare(options);
try {
  let db = await worker.getD1Database("DB");
  const readRow = () => db.prepare("SELECT * FROM apple_session_state WHERE owner_id = ? AND account_id = 'apple-reminders'").bind(keys.owner).first();
  const bound = await readRow();
  if (!bound || bound.generation !== row.generation || bound.version !== row.version || bound.envelope !== row.envelope) throw new Error("The runtime binding does not match the inspected saved session. Nothing was migrated.");
  await worker.setOptions({ ...options, bindings: { ...options.bindings,
    APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify({ migrationId: randomUUID(), owner: keys.owner, account: "apple-reminders", generation: row.generation }) } });
  // This is an internal authorised runtime dispatch, not an externally
  // supplied owner header or a public migration/reconnect endpoint.
  const statusRequest = () => worker.dispatchFetch(origin + "/api/connection", { headers: { "oai-authenticated-user-id": keys.owner } });
  const response = await statusRequest();
  if (!response.ok) throw new Error("The compatible migration loader rejected the session. Credentials were not exported; inspect server-safe status.");
  const status = await response.json();
  db = await worker.getD1Database("DB");
  const committed = await readRow();
  if (!committed?.envelope) throw new Error("The committed encrypted session is unavailable.");
  const after = checkedSession(await envelopes.decrypt(JSON.parse(committed.envelope), context));
  const { login: oldLogin, ...oldData } = before, { login: newLogin, ...newData } = after;
  if (!isDeepStrictEqual(oldData, newData) || committed.generation !== row.generation ||
    newLogin.verifiedAt !== oldLogin.verifiedAt || newLogin.expiresAt !== oldLogin.verifiedAt + SESSION_RETENTION_MS ||
    newLogin.version !== 3 || status.expiresAt !== newLogin.expiresAt || appleRequests !== 0) throw new Error("The migration preservation checks failed. Do not reconnect or restore an old snapshot.");
  await worker.setOptions(options);
  db = await worker.getD1Database("DB");
  const restored = await (await statusRequest()).json();
  if (restored.expiresAt !== newLogin.expiresAt || restored.generation !== row.generation || appleRequests !== 0) throw new Error("Compatible restoration after removing migration approval failed.");
  console.log(JSON.stringify({ phase: "after", ...safe(after, committed), ownerBindingPreserved: true, accountBindingPreserved: true,
    credentialsAndSnapshotsPreserved: true, migrationSettingRemoved: true, compatibleRestartChecked: true, appleRequests }));
} finally { await worker.dispose(); }
