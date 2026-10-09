import "../lib/sites-env.mjs";
import { Miniflare, Log, LogLevel, Response as WorkerResponse } from "miniflare";
import { fetch as nodeFetch } from "undici";
import { mkdir, readFile, readdir, writeFile, chmod, appendFile, stat, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { localAppleHeaders, summarizeAppleResponse } from "./local-icloud-observation.mjs";
import { createLocalPushRelay } from "./local-icloud-push.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const state = join(root, ".sites-runtime/local-icloud");
await mkdir(state, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
const configPath = join(state, "keys.json");
try {
  await writeFile(configPath, JSON.stringify({ owner: `local-${randomBytes(16).toString("hex")}`, key: randomBytes(32).toString("base64") }), { flag: "wx", mode: 0o600 });
} catch (error) { if (error.code !== "EEXIST") throw error; }
await chmod(configPath, 0o600);
const keys = JSON.parse(await readFile(configPath, "utf8"));
if (!/^local-[a-f0-9]{32}$/.test(keys.owner) || Buffer.from(keys.key, "base64").length !== 32) throw new Error("Invalid local key configuration.");
const origin = "http://127.0.0.1:5173";
const serverRoot = join(root, "dist/server");
const config = JSON.parse(await readFile(join(serverRoot, "wrangler.json"), "utf8"));
const files = await readdir(serverRoot, { recursive: true, withFileTypes: true });
const paths = files.filter(f => f.isFile() && /\.(js|mjs)$/.test(f.name)).map(f => join(f.parentPath, f.name));
const entrypoint = join(serverRoot, "index.js");
const observations = join(state, "observations.jsonl");
let logQueue = Promise.resolve();
async function observe(summary) {
  logQueue = logQueue.then(async () => {
    const size = await stat(observations).then(s => s.size).catch(() => 0);
    if (size > 1_048_576) await rename(observations, observations + ".previous");
    await appendFile(observations, JSON.stringify(summary) + "\n", { mode: 0o600 });
  }).catch(() => { console.warn("Local diagnostic storage unavailable."); });
  await logQueue;
}
const push = createLocalPushRelay({ observe });
const worker = new Miniflare({
  host: "127.0.0.1", port: 5173, inspectorPort: 0, log: new Log(LogLevel.ERROR), d1Persist: join(state, "d1"),
  workers: [
    { name: "local-front-door", modules: true, scriptPath: join(root, "scripts/dev/local-icloud-gateway.mjs"), compatibilityDate: config.compatibility_date,
      bindings: { LOCAL_ORIGIN: origin, LOCAL_OWNER: keys.owner, LOCAL_ACCESS: randomBytes(32).toString("hex") }, serviceBindings: { APP: "local-reminders-app" } },
    { name: "local-reminders-app", modulesRoot: serverRoot,
      modules: [entrypoint, ...paths.filter(p => p !== entrypoint)].map(path => ({ type: "ESModule", path })),
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      bindings: { APP_ORIGIN: origin, REMINDERS_OWNER_ID: keys.owner, ENCRYPTION_KEY_ID: "local-live", ENCRYPTION_KEYS_JSON: JSON.stringify({ "local-live": keys.key }), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" },
      d1Databases: { DB: "isolated-local-icloud" },
      assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true } },
      outboundService: async request => {
        const url = new URL(request.url);
        if (request.headers.get("upgrade")) return push.fetch(request);
        const fixed = ["idmsa.apple.com", "setup.icloud.com", "www.icloud.com"].includes(url.hostname);
        const cloudkit = /^p\d{1,3}-ckdatabasews\.icloud\.com$/.test(url.hostname) && (/^\/database\/1\/com\.apple\.reminders\/production\/private(?:\/|$)/.test(url.pathname) || /^\/database\/1\/com\.apple\.reminders\/production\/shared\/(?:zones\/list|records\/lookup)$/.test(url.pathname));
        if (url.protocol !== "https:" || url.username || url.password || url.port || (!fixed && !cloudkit)) return new WorkerResponse("Unsupported local test endpoint.", { status: 403 });
        const response = await nodeFetch(url, { method: request.method, headers: localAppleHeaders(request.headers), body: request.body, duplex: "half", redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) });
        const reader = response.body?.getReader(); const chunks = []; let total = 0;
        try {
          if (reader) for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.length; if (total > 1_048_576) throw new Error("Local response byte budget exceeded."); chunks.push(next.value); }
        } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
        const bytes = Buffer.concat(chunks);
        let body; if (response.headers.get("content-type")?.includes("json")) { try { body = JSON.parse(bytes.toString("utf8")); } catch { /* Only status is observed. */ } }
        await observe(summarizeAppleResponse(url, response.status, body));
        return new WorkerResponse(request.method === "HEAD" || [204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    },
  ],
});
try {
  const db = await worker.getD1Database("DB", "local-reminders-app");
  await db.prepare(await readFile(join(root, "schema.sql"), "utf8")).run();
  await worker.ready;
  console.log(`Local Worker ready: ${origin}/`);
  console.log("Lists are retrieved directly on refresh; no historical or scheduled catalogue work.");
  console.log("Separate encrypted local session; reminder writes disabled. Diagnostics contain metadata and counts only.");
} catch (error) { push.close(); await worker.dispose(); throw error; }
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { push.close(); await worker.dispose(); await logQueue; process.exit(0); });
