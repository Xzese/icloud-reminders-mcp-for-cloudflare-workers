// Acceptance journey against the exact production bundle in workerd, with synthetic data.
import { Miniflare, Log, LogLevel } from "miniflare";
import { fetch as mockFetch, MockAgent } from "undici";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { scanCatalogue } from "../../src/app/catalogue-scan.ts";
import { createHash, randomBytes } from "node:crypto";
import { verifyReminderWrites } from "./reminder-writes.mjs";
const root = resolve(new URL("../..", import.meta.url).pathname);
const config = JSON.parse(await readFile(join(root, "dist/server/wrangler.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "reminders-worker-acceptance-"));
const origin = "https://private.example.test"; const owner = "synthetic-owner";
const secret = randomBytes(32).toString("base64");
const serverRoot = join(root, "dist/server");
const files = await readdir(serverRoot, { recursive: true, withFileTypes: true });
const paths = files.filter((entry) => entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
const entrypoint = join(serverRoot, "index.js");
const options = {
  name: "reminders-acceptance", modulesRoot: serverRoot, unsafeTriggerHandlers: true,
  modules: [entrypoint, ...paths.filter((p) => p !== entrypoint)].map((path) => ({ type: "ESModule", path })),
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  bindings: { APP_ORIGIN: origin, REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: "synthetic", ENCRYPTION_KEYS_JSON: JSON.stringify({ synthetic: secret }) },
  d1Databases: { DB: "reminders-acceptance-db" }, d1Persist: directory,
  assets: { directory: join(root, "dist/client"), routerConfig: { has_user_worker: true } }, log: new Log(LogLevel.ERROR),
};
const withScheduler = options => {
  const { d1Persist, log, unsafeTriggerHandlers, ...app } = options;
  return { d1Persist, log, unsafeTriggerHandlers, workers: [app, { ...app, name: "catalogue-scheduler-test", assets: undefined, routes: ["http://catalogue-background.local/*"] }] };
};
let worker;
const request = async (path, { user = owner, method = "GET", body, requestOrigin = origin, host = origin } = {}) => {
  const headers = { ...(user ? { "oai-authenticated-user-id": user, "oai-authenticated-user-email": "synthetic@example.invalid" } : {}) };
  if (method === "POST") Object.assign(headers, { "content-type": "application/json", origin: requestOrigin, accept: "application/json, text/event-stream" });
  return worker.dispatchFetch(host + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
};
function socketMessages(socket) {
  const queued = []; const waiting = [];
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    const next = waiting.shift(); if (next) next(event.data); else queued.push(event.data);
  });
  socket.accept();
  return async () => {
    if (queued.length) return queued.shift();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Synthetic socket message timed out.")), 60_000);
      waiting.push((message) => { clearTimeout(timeout); resolve(message); });
    });
  };
}
try {
  worker = new Miniflare(options); const db = await worker.getD1Database("DB");
  const schema = await readFile(join(root, "schema.sql"), "utf8");
  // Exercise the SQL packaged for Sites, rather than a separate test schema.
  assert.equal(await readFile(join(root, "dist/.openai/drizzle/0000_schema.sql"), "utf8"), schema);
  await db.prepare(schema).run();
  assert.deepEqual((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'probe_%'").all()).results, []);
  assert.equal((await request("/api/connection", { user: null })).status, 401);
  assert.equal((await request("/api/connection", { user: "wrong-owner" })).status, 403);
  assert.equal((await request("/api/connection", { host: "https://raw-worker.example.test" })).status, 403);
  assert.equal((await request("/api/auth/disconnect", { method: "POST", requestOrigin: "https://evil.example", body: {} })).status, 403);
  for (const path of ["/api/lists", "/api/reminders", "/api/feasibility/status", "/api/feasibility/socket"]) assert.equal((await request(path)).status, 404);
  assert.equal((await request("/api/feasibility/run", { method: "POST", body: {} })).status, 404);
  const auth = await request("/api/auth/start", { method: "POST", body: { password: "synthetic-artifact-sentinel" } });
  assert.equal(auth.status, 422); assert.ok(!(await auth.text()).includes("synthetic-artifact-sentinel"));
  const configReply = await (await request("/api/auth/config")).json(); assert.equal(configReply.enabled, false); assert.equal(configReply.passwordLocation, "browser-only");
  const gatedSocket = await worker.dispatchFetch(origin + "/api/auth/socket?generation=0", { headers: { "oai-authenticated-user-id": owner, upgrade: "websocket", origin, "sec-websocket-protocol": "reminders-auth-v2" } });
  assert.equal(gatedSocket.status, 422);
  assert.equal(await db.prepare("SELECT owner_id FROM apple_session_state WHERE owner_id = ?").bind(owner).first(), null);
  const mcp = async (method, params) => {
    const response = await request("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params } });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-acceptance", version: "1" } });
  assert.equal(init.result.serverInfo.name, "hosted-icloud-reminders");
  const tools = await mcp("tools/list", {}); assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ["complete_reminder", "connection_status", "create_reminder", "delete_reminder", "get_all_open_reminders", "get_reminder", "get_reminder_lists", "get_reminders", "reopen_reminder", "update_reminder"]);
  const gatedRead = await mcp("tools/call", { name: "get_reminders", arguments: { listId: "List/NEW" } }); assert.equal(gatedRead.result.isError, true);
  const call = await mcp("tools/call", { name: "connection_status", arguments: {} }); assert.equal(call.result.structuredContent.connected, false);
  assert.deepEqual(JSON.parse(call.result.content[0].text), call.result.structuredContent);
  const removed = await mcp("tools/call", { name: "feasibility_status", arguments: {} }); assert.equal(removed.result.isError, true);
  const gatedAll = await mcp("tools/call", { name: "get_all_open_reminders", arguments: {} }); assert.equal(gatedAll.result.isError, true);
  assert.equal((await request("/mcp", { user: "wrong-owner", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 403);
  assert.equal((await request("/mcp", { user: "wrong-owner", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_all_open_reminders", arguments: { expectedGeneration: 0 } } } })).status, 403);
  const page = await request("/"); assert.equal(page.status, 200); const html = await page.text();
  assert.ok(html.includes("Reminders connection")); assert.ok(!html.includes("Run runtime checks")); assert.ok(!html.includes("Evidence so far")); assert.ok(!html.includes(secret));
  assert.ok(page.headers.get("content-security-policy")?.includes("strict-dynamic"));
  assert.ok(!/\<script\b(?![^>]*\bnonce=)/i.test(html));
  // Enable the transport only in this disposable Worker, with all network
  // destinations intercepted. This never opens or contacts an Apple account.
  const fetchMock = new MockAgent(); fetchMock.disableNetConnect();
  const fixtures = JSON.parse(await readFile(join(root, "tests/fixtures/protocol.json"), "utf8")); const f = fixtures.srp[0];
  const apple = fetchMock.get("https://idmsa.apple.com");
  apple.intercept({ path: /\/appleauth\/auth\/authorize\/signin\?/, method: "GET" }).reply(200, "synthetic authorization");
  apple.intercept({ path: "/appleauth/auth/signin/init", method: "POST" }).reply(200, { salt: Buffer.from(f.salt, "hex").toString("base64"), b: Buffer.from(f.B, "hex").toString("base64"), c: "synthetic-challenge", iteration: f.iterations, protocol: f.protocol });
  apple.intercept({ path: "/appleauth/auth/signin/complete?isRememberMeEnabled=true", method: "POST" }).reply(200, {}, { headers: { "X-Apple-Session-Token": "synthetic-apple-token", "X-Apple-ID-Account-Country": "GB" } });
  const ck = fetchMock.get("https://p01-ckdatabasews.icloud.com");
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/shared\/zones\/list\?/, method: "POST" }).reply(200, { zones: [] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/records\/query\?/, method: "POST", headers: { cookie: "synthetic-session=restore-me", origin: "https://www.icloud.com", referer: "https://www.icloud.com/", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15" } }).reply(200, { records: [
    { recordName: "Reminder/SYNTHETIC", recordType: "Reminder", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { List: { type: "REFERENCE", value: { recordName: "List/SYNTHETIC", action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" } } } } },
    { recordName: "Alarm/SYNTHETIC", recordType: "Alarm", fields: {} },
    { recordName: "List/SYNTHETIC", recordType: "List", fields: { ReminderIDs: { type: "STRING", value: JSON.stringify(Array(2001).fill("Reminder/SYNTHETIC")) } } },
  ] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/records\/lookup\?/, method: "POST" }).reply(200, { records: [{ recordName: "List/SYNTHETIC", recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { Name: { type: "STRING", value: "Synthetic test list" } } }, { recordName: "List/MISSING", serverErrorCode: "NOT_FOUND" }] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/records\/lookup\?/, method: "POST" }).reply(200, { records: [{ recordName: "List/SYNTHETIC", recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { Name: { type: "STRING", value: "Renamed saved list" } } }, { recordName: "List/MISSING", recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { Name: { type: "STRING", value: "Restored saved list" } } }] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/zones\/list\?/, method: "POST" }).reply(200, { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "synthetic-private-owner" } }] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/changes\/zone\?/, method: "POST" }).reply(200, { zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, syncToken: "synthetic-empty-checkpoint", moreComing: true, records: [] }] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/changes\/zone\?/, method: "POST" }).reply(200, { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "synthetic-private-owner" }, syncToken: "synthetic-catalogue-checkpoint", moreComing: null, records: [{ recordName: "List/SYNTHETIC", recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { Name: { type: "STRING", value: "Synthetic test list" } } }] }] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/zones\/list\?/, method: "POST", headers: { origin: "https://www.icloud.com" } }).reply(421, {});
  let syncScenario = null;
  let mcpReminderScenario = null;
  let allOpenScenario = null;
  let catalogueRequestCount = 0;
  let batchScenario = null;
  const startBatchScenario = () => {
    let reached;
    const ready = new Promise(resolve => { reached = resolve; });
    batchScenario = { arrivals: [], responses: new Map(), ready, reached };
    return batchScenario;
  };
  const awaitBatchQueries = async scenario => {
    let timer;
    try {
      await Promise.race([scenario.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Both batch queries must arrive before either receives a response.")), 2000); })]);
    } finally { clearTimeout(timer); }
    assert.deepEqual(scenario.arrivals.sort(), ["List/BATCH-A", "List/BATCH-B"]);
  };
  const batchReply = (listId, headers = {}) => new Response(JSON.stringify({ records: [
    { recordName: `Reminder/${listId.slice(5)}`, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } } } },
    { recordName: `Alarm/${listId.slice(5)}`, recordType: "Alarm", fields: {} },
  ], continuationMarker: `first-page-${listId.slice(5)}` }), { headers: { "content-type": "application/json", ...headers } });
  const enabledOptions = { ...options, bindings: { ...options.bindings, LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2", CATALOGUE_BACKGROUND_RUNNER: "cron" }, outboundService: async req => {
    if (syncScenario && ["/changes/zone", "/records/lookup"].some(path => new URL(req.url).pathname.endsWith(path))) {
      const body = await req.clone().json();
      syncScenario.requests.push(body);
      if (new URL(req.url).pathname.endsWith("/changes/zone")) {
        const next = syncScenario.pages.shift(); assert.ok(next, "Unexpected sync page");
        assert.equal(body.resultsLimit, 200); assert.equal(body.zones[0].reverse, undefined);
        assert.deepEqual(body.zones[0].desiredRecordTypes, ["List", "Reminder"]);
        assert.equal(body.zones[0].syncToken, next.requestToken);
        return new Response(JSON.stringify({ zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, ...next.response }] }), { headers: { "content-type": "application/json" } });
      }
      assert.deepEqual(body.desiredKeys, ["Name", "Color", "Count", "IsGroup", "Deleted"]);
      return new Response(JSON.stringify({ records: body.records.map(({ recordName }) => syncScenario.current[recordName]) }), { headers: { "content-type": "application/json" } });
    }
    if (allOpenScenario && new URL(req.url).pathname.endsWith("/records/query")) {
      const body = await req.clone().json(); allOpenScenario.requests.push(body);
      const listId = body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName;
      assert.equal(body.query.recordType, "reminderList"); assert.equal(body.resultsLimit, 200);
      assert.equal(body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value, 0);
      const page = allOpenScenario.pages[listId].shift(); assert.ok(page, "Unexpected all-open query");
      assert.equal(body.continuationMarker, page.inputCursor);
      return new Response(JSON.stringify(page.reply), { headers: { "content-type": "application/json" } });
    }
    if (mcpReminderScenario && new URL(req.url).pathname.endsWith("/records/query")) {
      const body = await req.clone().json(); mcpReminderScenario.requests.push(body);
      assert.equal(body.query.recordType, "reminderList");
      assert.equal(body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value, 0);
      assert.equal(body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName, "List/NEW");
      return new Response(JSON.stringify({ records: mcpReminderScenario.records }), { headers: { "content-type": "application/json" } });
    }
    if (batchScenario && new URL(req.url).pathname.endsWith("/records/query")) {
      const body = await req.clone().json();
      const listId = body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName;
      assert.ok(["List/BATCH-A", "List/BATCH-B"].includes(listId));
      assert.equal(body.resultsLimit, 200); assert.equal(body.continuationMarker, undefined);
      assert.equal(body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value, 1);
      batchScenario.arrivals.push(listId);
      const response = new Promise(resolve => { batchScenario.responses.set(listId, resolve); });
      if (batchScenario.arrivals.length === 2) batchScenario.reached();
      return response;
    }
    if (new URL(req.url).pathname.endsWith("/changes/zone")) {
      // Miniflare forwards streaming bodies to Undici, whose string body
      // matcher cannot inspect them. Decode a clone before the mock dispatch.
      assert.ok(catalogueRequestCount < 2, "Unexpected reverse catalogue read");
      assert.deepEqual(await req.clone().json(), { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "synthetic-private-owner" }, desiredRecordTypes: ["List", "Reminder"], reverse: true, desiredKeys: ["Name", "Color", "Count", "IsGroup", "Deleted", "List"], ...(catalogueRequestCount === 1 ? { syncToken: "synthetic-empty-checkpoint" } : {}) }], resultsLimit: 200 });
      catalogueRequestCount++;
    }
    // Miniflare and the harness can use different Undici versions. Transfer
    // web-standard fields instead of passing a version-branded Request object.
    return mockFetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers), body: req.body, duplex: "half", redirect: "manual", signal: req.signal, dispatcher: fetchMock });
  } };
  await worker.dispose(); worker = new Miniflare(withScheduler(enabledOptions));
  const openAuth = async (generation, requestOrigin = origin) => worker.dispatchFetch(`${origin}/api/auth/socket?generation=${generation}`, { headers: { "oai-authenticated-user-id": owner, upgrade: "websocket", origin: requestOrigin, "sec-websocket-protocol": "reminders-auth-v2" } });
  assert.equal((await openAuth(0, "https://evil.example")).status, 403);
  const credentialPage = await request("/connect/apple"); assert.equal(credentialPage.status, 200);
  const credentialHTML = await credentialPage.text(); assert.equal((credentialHTML.match(/<script /g) ?? []).length, 1);
  assert.ok(credentialHTML.includes('src="/api/auth/client.js"')); assert.ok(!credentialHTML.includes('/assets/'));
  assert.ok(credentialPage.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  for (const tag of credentialHTML.matchAll(/<(script|style)\b[^>]*nonce="([^"]+)"/g)) assert.ok(credentialPage.headers.get("content-security-policy").includes(`\'nonce-${tag[2]}\'`));
  assert.ok(credentialHTML.includes('id="verification-fields" disabled'));
  const scriptResponse = await request("/api/auth/client.js"); assert.equal(scriptResponse.status, 200); assert.ok((await scriptResponse.text()).length > 1000);
  assert.equal((await request("/connect/apple", { user: "wrong-owner" })).status, 403);
  const invalidAuth = await openAuth(0); assert.equal(invalidAuth.status, 101); const invalidNext = socketMessages(invalidAuth.webSocket); await invalidNext();
  invalidAuth.webSocket.send(JSON.stringify({ type: "start", accountName: f.account, publicA: Buffer.from(f.A, "hex").toString("base64"), consentPersistentSession: true, password: "synthetic-forbidden-password" }));
  const invalidAuthResult = await invalidNext(); assert.equal(JSON.parse(invalidAuthResult).type, "failed"); assert.ok(!invalidAuthResult.includes("synthetic-forbidden-password")); invalidAuth.webSocket.close();
  await request("/api/auth/disconnect", { method: "POST", body: {} });
  const beforeSignIn = await (await request("/api/connection")).json();
  const authResponse = await openAuth(beforeSignIn.generation); assert.equal(authResponse.status, 101); const authSocket = authResponse.webSocket; const authNext = socketMessages(authSocket);
  const hello = JSON.parse(await authNext()); assert.equal(hello.generation, beforeSignIn.generation + 1);
  authSocket.send(JSON.stringify({ type: "start", transactionId: hello.transactionId, nonce: hello.nonce, sequence: 0, consentAppleTrust: true, accountName: f.account, publicA: Buffer.from(f.A, "hex").toString("base64"), consentPersistentSession: true }));
  const challenge = JSON.parse(await authNext()); assert.equal(challenge.type, "srp-challenge", JSON.stringify(challenge));
  authSocket.send(JSON.stringify({ type: "srp-proof", transactionId: hello.transactionId, nonce: hello.nonce, sequence: 1, m1: Buffer.from(f.M1, "hex").toString("base64"), m2: Buffer.from(f.M2, "hex").toString("base64") }));
  const signedIn = JSON.parse(await authNext()); assert.equal(signedIn.type, "failed", JSON.stringify(signedIn)); assert.equal(signedIn.error.code, "UNSUPPORTED_AUTH"); authSocket.close();
  // Full modern bridge ordering is tested with a synthetic APNS peer in the
  // flow tests. Separately seed a valid encrypted device-policy fixture to
  // exercise cold restore and reads in the exact produced Worker.
  await request("/api/auth/disconnect", { method: "POST", body: {} });
  const empty = await (await request("/api/connection")).json();
  const fixtureSession = {
    login: loginAssurance(),
    auth: { clientId: "synthetic-client", headers: { "X-Apple-Session-Token": "synthetic-apple-token" }, cookies: [{ name: "synthetic-session", value: "restore-me", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }] },
    connection: { dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" },
    pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 },
  };
  const envelope = await new Envelopes("synthetic", { synthetic: secret }).encrypt(fixtureSession, { ownerId: owner, accountId: "apple-reminders", generation: empty.generation, recordId: "apple-session", schemaVersion: 1 });
  const sessionDB = await worker.getD1Database("DB");
  await sessionDB.prepare("UPDATE apple_session_state SET state = 'READY', envelope = ?, action = NULL, next_attempt_at = 0, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, version = version + 1 WHERE owner_id = ?").bind(JSON.stringify(envelope), owner).run();
  const encryptedSession = await sessionDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  assert.ok(encryptedSession?.envelope && !encryptedSession.envelope.includes("synthetic-apple-token") && !encryptedSession.envelope.includes("restore-me"));
  const beforeSchemaRepeat = (await sessionDB.prepare("SELECT * FROM apple_session_state").all()).results;
  await sessionDB.prepare(schema).run();
  assert.deepEqual((await sessionDB.prepare("SELECT * FROM apple_session_state").all()).results, beforeSchemaRepeat);
  await worker.dispose(); worker = new Miniflare(withScheduler(enabledOptions));
  const restoredApple = await (await request("/api/connection")).json(); assert.equal(restoredApple.state, "READY"); assert.equal(restoredApple.capabilities.liveRead, true); assert.equal(restoredApple.capabilities.listReminders, true); assert.equal(restoredApple.capabilities.allOpenReminders, true); assert.equal(restoredApple.liveReadValidated, undefined); assert.equal(restoredApple.validation.fullProductAcceptance, false); assert.equal(restoredApple.writeEnabled, false);
  const discoveredReply = await request("/api/apple/read", { method: "POST", body: { action: "discover", expectedGeneration: empty.generation } });
  const discoveredZone = await discoveredReply.json(); assert.equal(discoveredReply.status, 200, JSON.stringify(discoveredZone));
  assert.equal(discoveredZone.result.available, true); assert.equal(discoveredZone.result.remindersZone.zoneID.ownerRecordName, undefined);
  const ownerEnvelope = await (await worker.getD1Database("DB")).prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  assert.ok(!ownerEnvelope.envelope.includes("synthetic-private-owner"));
  await worker.dispose(); worker = new Miniflare(withScheduler(enabledOptions));
  const cataloguePages = [];
  const scan = await scanCatalogue({ generation: empty.generation, discover: false, startToken: null, visitedTokens: new Set(), maxPages: 25, signal: new AbortController().signal, onPage: page => cataloguePages.push(page), read: async body => {
    const reply = await request("/api/apple/read", { method: "POST", body });
    const value = await reply.json(); assert.equal(reply.status, 200, JSON.stringify(value)); return value.result;
  } });
  assert.deepEqual(scan, { reason: "found", pages: 2 }); assert.equal(catalogueRequestCount, 2);
  assert.equal(cataloguePages[0].continuation, "synthetic-empty-checkpoint"); assert.equal(cataloguePages[0].catalogueDiagnostics.returnedRecords, 0);
  assert.equal(cataloguePages[1].records[0].title, "Synthetic test list"); assert.equal(cataloguePages[1].continuation, null); assert.equal(cataloguePages[1].paginationComplete, true);
  assert.deepEqual(cataloguePages[1].catalogueDiagnostics, { returnedRecords: 1, selectableLists: 1, deletedLists: 0, groups: 0, moreComing: null });
  const savedCiphertext = await (await worker.getD1Database("DB")).prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  for (const value of ["List/SYNTHETIC", "Synthetic test list"]) assert.ok(!savedCiphertext.envelope.includes(value));
  await worker.dispose(); worker = new Miniflare(withScheduler(enabledOptions));
  const savedResponse = await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } });
  const savedLists = await savedResponse.json(); assert.equal(savedResponse.status, 200, JSON.stringify(savedLists));
  assert.equal(savedLists.result.records[0].id, "List/SYNTHETIC"); assert.equal(savedLists.result.records[0].title, "Synthetic test list");
  assert.deepEqual(savedLists.result.requestTrace, []); assert.equal(catalogueRequestCount, 2);
  assert.equal((await request("/api/apple/read", { user: "other-owner", method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } })).status, 403);
  const mismatchedLookup = await request("/api/apple/read", { method: "POST", body: { action: "lookup-lists", expectedGeneration: empty.generation, listIds: ["List/SYNTHETIC"], expectedZoneOwner: "different-owner" } });
  assert.equal(mismatchedLookup.status, 403);
  const directLookupResponse = await request("/api/apple/read", { method: "POST", body: { action: "lookup-lists", expectedGeneration: empty.generation, listIds: ["List/SYNTHETIC", "List/MISSING"], expectedZoneOwner: "synthetic-private-owner" } });
  const directLookup = await directLookupResponse.json(); assert.equal(directLookupResponse.status, 200, JSON.stringify(directLookup));
  assert.equal(directLookup.result.records[0].title, "Synthetic test list"); assert.equal(directLookup.result.recordErrors[0].code, "NOT_FOUND");
  assert.equal(directLookup.result.records[1].id, "List/MISSING"); assert.equal(directLookup.result.records[1].deleted, true);
  assert.equal(directLookup.result.complete, false); assert.equal(directLookup.result.scope, "controlled-lookup");
  assert.equal(directLookupResponse.headers.get("cache-control"), "private, no-store");
  assert.ok(!JSON.stringify(directLookup.result.requestTrace).includes("synthetic-private-owner"));
  const refreshSaved = await request("/api/apple/read", { method: "POST", body: { action: "refresh-saved-lists", expectedGeneration: empty.generation } });
  const refreshedSaved = await refreshSaved.json(); assert.equal(refreshSaved.status, 200, JSON.stringify(refreshedSaved)); assert.equal(refreshedSaved.result.records[0].title, "Renamed saved list");
  const retainedSaved = await (await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } })).json();
  assert.equal(retainedSaved.result.records[0].title, "Renamed saved list"); assert.equal(retainedSaved.result.records[1].deleted, false); assert.equal(retainedSaved.result.records[1].title, "Restored saved list");
  const sharedDiagnostic = await request("/api/apple/read", { method: "POST", body: { action: "probe-shared-lists", expectedGeneration: empty.generation, listIds: ["List/MISSING"] } });
  const sharedValue = await sharedDiagnostic.json(); assert.equal(sharedDiagnostic.status, 200, JSON.stringify(sharedValue));
  assert.equal(sharedValue.result.database, "shared"); assert.equal(sharedValue.result.zonesDiscovered, 0); assert.deepEqual(sharedValue.result.lookups, []);
  assert.equal(sharedValue.result.contentsReturned, false); assert.equal(sharedValue.writesEnabled, false);
  const compoundResponse = await request("/api/apple/read", { method: "POST", body: { action: "reminders", expectedGeneration: empty.generation, listId: "List/SYNTHETIC", includeCompleted: true, limit: 1 } });
  const compound = await compoundResponse.json(); assert.equal(compoundResponse.status, 200, JSON.stringify(compound)); assert.equal(compound.result.records.length, 1); assert.equal(compound.result.auxiliaryRecordCounts.Alarm, 1); assert.equal(compound.result.auxiliaryRecordCounts.List, 1); assert.equal(compound.result.auxiliaryDetailsIncluded, true); assert.equal(compound.liveReadValidated, false);
  assert.equal(compoundResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(compound.result.records[0].appleRecord.fields.List.value.recordName, "List/SYNTHETIC");
  assert.equal(compound.result.relatedRecords.length, 2); assert.equal(compound.result.relatedRecords[0].recordType, "Alarm");
  assert.equal(JSON.parse(compound.result.relatedRecords[1].appleRecord.fields.ReminderIDs.value).length, 2001);
  const batchBody = { action: "reminders-batch", expectedGeneration: empty.generation, listIds: ["List/BATCH-A", "List/BATCH-B"], includeCompleted: true };
  for (const invalid of [
    { ...batchBody, listIds: [] }, { ...batchBody, listIds: ["List/BATCH-A", "List/BATCH-A"] },
    { ...batchBody, listIds: ["List/BATCH-A", "List/BATCH-B", "List/BATCH-C"] },
    { ...batchBody, listIds: ["Reminder/BATCH-A"] }, { ...batchBody, continuation: "forbidden" }, { ...batchBody, limit: 201 },
  ]) assert.equal((await request("/api/apple/read", { method: "POST", body: invalid })).status, 422);
  const concurrentBatch = startBatchScenario();
  const batchRead = request("/api/apple/read", { method: "POST", body: batchBody });
  await awaitBatchQueries(concurrentBatch);
  concurrentBatch.responses.get("List/BATCH-B")(batchReply("List/BATCH-B", { "set-cookie": "batch-b=second; Domain=icloud.com; Path=/; Secure" }));
  concurrentBatch.responses.get("List/BATCH-A")(batchReply("List/BATCH-A", { "set-cookie": "batch-a=first; Domain=icloud.com; Path=/; Secure" }));
  const batchResponse = await batchRead; const batchValue = await batchResponse.json();
  assert.equal(batchResponse.status, 200, JSON.stringify(batchValue)); assert.equal(batchValue.writesEnabled, false);
  assert.deepEqual(batchValue.result.pages.map(page => page.listId), batchBody.listIds);
  for (const page of batchValue.result.pages) {
    assert.equal(page.records.length, 1); assert.equal(page.records[0].listId, page.listId);
    assert.equal(page.auxiliaryRecordCounts.Alarm, 1); assert.equal(page.relatedRecords.length, 1);
    assert.equal(page.continuation, `first-page-${page.listId.slice(5)}`); assert.equal(page.paginationComplete, false);
  }
  assert.equal(batchValue.result.requestTrace.length, 2); assert.equal(concurrentBatch.arrivals.length, 2);
  const batchDB = await worker.getD1Database("DB");
  const batchContext = { ownerId: owner, accountId: "apple-reminders", generation: empty.generation, recordId: "apple-session", schemaVersion: 1 };
  const batchEnvelope = new Envelopes("synthetic", { synthetic: secret });
  const afterBatch = await batchDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  const batchSession = await batchEnvelope.decrypt(JSON.parse(afterBatch.envelope), batchContext);
  assert.deepEqual(batchSession.auth.cookies.filter(cookie => cookie.name.startsWith("batch-")).map(cookie => cookie.name).sort(), ["batch-a", "batch-b"]);
  const drainedBatch = startBatchScenario(); let failedBatchSettled = false;
  const failedBatchRead = request("/api/apple/read", { method: "POST", body: batchBody }).then(response => { failedBatchSettled = true; return response; });
  await awaitBatchQueries(drainedBatch);
  drainedBatch.responses.get("List/BATCH-A")(new Response("{}", { status: 503 }));
  const duringBatch = await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } });
  assert.equal(duringBatch.status, 409); assert.equal((await duringBatch.json()).error.code, "CONFLICT");
  assert.equal(failedBatchSettled, false, "A failed query must not release the lease while its peer is pending.");
  drainedBatch.responses.get("List/BATCH-B")(batchReply("List/BATCH-B", { "set-cookie": "failed-batch=discard; Domain=icloud.com; Path=/; Secure" }));
  const failedBatchResponse = await failedBatchRead; assert.equal(failedBatchResponse.status, 503);
  assert.equal((await failedBatchResponse.json()).error.code, "UPSTREAM_UNAVAILABLE");
  const afterFailure = await batchDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  assert.equal(afterFailure.envelope, afterBatch.envelope, "A partially successful batch must not commit cookies or pages.");
  batchScenario = null;
  assert.equal((await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } })).status, 200);
  // Server-held forward checkpoints survive a cold restart and switch to deltas.
  const currentList = (id, title) => ({ recordName: id, recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { Name: { type: "STRING", value: title } } });
  syncScenario = { requests: [], current: { "List/NEW": currentList("List/NEW", "Initial current name") }, pages: [
    { requestToken: undefined, response: { records: [currentList("List/NEW", "Old history name")], syncToken: "sync-initial-next", moreComing: true } },
    { requestToken: "sync-initial-next", response: { records: [], syncToken: "sync-head", moreComing: false } },
  ] };
  // Scheduled events run as the configured owner, without browser identity headers.
  const scheduledTick = async () => {
    const response = await worker.dispatchFetch("http://catalogue-background.local/cdn-cgi/handler/scheduled?cron=*+*+*+*+*");
    assert.equal(response.status, 200, await response.clone().text()); await response.text();
  };
  const waitingStatus = await mcp("tools/call", { name: "connection_status", arguments: {} });
  assert.deepEqual(JSON.parse(waitingStatus.result.content[0].text), waitingStatus.result.structuredContent);
  assert.equal(waitingStatus.result.structuredContent.capabilities.listReminders, true);
  assert.equal(syncScenario.requests.length, 0, "Connection status does not initiate Apple reads.");
  const initialPause = await request("/api/apple/read", { method: "POST", body: { action: "catalogue-auto", expectedGeneration: empty.generation, enabled: false } }); assert.equal(initialPause.status, 200);
  await scheduledTick(); assert.equal(syncScenario.requests.length, 0, "A paused initial scan does not call Apple.");
  const syncBody = { action: "sync-catalogue", expectedGeneration: empty.generation };
  assert.equal((await request("/api/apple/read", { method: "POST", body: { ...syncBody, continuation: "client-token-forbidden" } })).status, 422);
  const firstSyncResponse = await request("/api/apple/read", { method: "POST", body: syncBody });
  const firstSync = await firstSyncResponse.json(); assert.equal(firstSyncResponse.status, 200, JSON.stringify(firstSync));
  assert.equal(firstSync.result.records[0].title, "Initial current name"); assert.equal(firstSync.result.catalogueSync.phase, "initial");
  assert.equal(firstSync.result.catalogueSync.pending, true); assert.equal(firstSync.result.continuation, null);
  assert.ok(!JSON.stringify(firstSync).includes("sync-initial-next"));
  const syncDB = await worker.getD1Database("DB");
  const syncEnvelopeBefore = (await syncDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first()).envelope;
  assert.ok(!syncEnvelopeBefore.includes("sync-initial-next"));
  await worker.dispose(); worker = new Miniflare(withScheduler(enabledOptions));
  const restoreSync = await (await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } })).json();
  assert.equal(restoreSync.result.catalogueSync.phase, "initial"); assert.equal(restoreSync.result.catalogueSync.pages, 1);
  assert.equal(syncScenario.requests.length, 2); assert.ok(!JSON.stringify(restoreSync).includes("sync-initial-next"));
  const initialResume = await request("/api/apple/read", { method: "POST", body: { action: "catalogue-auto", expectedGeneration: empty.generation, enabled: true } }); assert.equal(initialResume.status, 200);
  await scheduledTick();
  const terminalSyncResponse = await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } });
  const terminalSync = await terminalSyncResponse.json(); assert.equal(terminalSyncResponse.status, 200, JSON.stringify(terminalSync));
  assert.equal(terminalSync.result.catalogueSync.phase, "ready"); assert.equal(terminalSync.result.catalogueSync.initialComplete, true); assert.equal(terminalSync.result.catalogueSync.pages, 2);
  assert.equal(terminalSync.result.catalogueAuto.mode, "initial-and-hourly"); assert.equal(terminalSync.result.catalogueAuto.intervalMs, 3_600_000);
  assert.ok(terminalSync.result.catalogueAuto.nextCheckAt > Date.now() + 3_590_000);
  syncScenario.current = { "List/NEW": currentList("List/NEW", "Renamed current list"), "List/SYNTHETIC": { recordName: "List/SYNTHETIC", serverErrorCode: "NOT_FOUND" } };
  syncScenario.pages.push({ requestToken: "sync-head", response: { records: [currentList("List/NEW", "Stale name"), { recordName: "List/SYNTHETIC", deleted: true }], syncToken: "sync-new-head", moreComing: false } });
  const deltaResponse = await request("/api/apple/read", { method: "POST", body: syncBody }); const delta = await deltaResponse.json();
  assert.equal(deltaResponse.status, 200, JSON.stringify(delta)); assert.equal(delta.result.catalogueSync.initialComplete, true); assert.equal(delta.result.catalogueSync.pages, 1);
  assert.equal(delta.result.records.find(record => record.id === "List/NEW").title, "Renamed current list");
  assert.equal(delta.result.records.find(record => record.id === "List/SYNTHETIC").deleted, true);
  syncScenario.pages.push({ requestToken: "sync-new-head", response: { records: [], syncToken: "sync-new-head", moreComing: false } });
  const noChanges = await request("/api/apple/read", { method: "POST", body: syncBody }); assert.equal(noChanges.status, 200, await noChanges.clone().text());
  const beforeTickRequests = syncScenario.requests.length;
  await scheduledTick(); assert.equal(syncScenario.requests.length, beforeTickRequests, "A completed initial scan waits an hour before background deltas.");
  syncScenario.pages.push({ requestToken: "sync-new-head", response: { records: [], syncToken: "sync-new-head", moreComing: false } });
  const mcpLists = await mcp("tools/call", { name: "get_reminder_lists", arguments: {} });
  assert.ok(!mcpLists.result.isError, JSON.stringify(mcpLists));
  assert.equal(mcpLists.result.structuredContent.records.find(record => record.id === "List/NEW").title, "Renamed current list");
  assert.equal(mcpLists.result.structuredContent.catalogueSync.initialPages, 2); assert.equal(mcpLists.result.structuredContent.catalogueSync.totalPages, 5);
  const openReminder = { recordName: "Reminder/OPEN", recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: "List/NEW", action: "VALIDATE" } }, Completed: { type: "INT64", value: 0 } } };
  mcpReminderScenario = { requests: [], records: [openReminder] };
  syncScenario.pages.push({ requestToken: "sync-new-head", response: { records: [], syncToken: "sync-new-head", moreComing: false } });
  const firstOpenRead = await mcp("tools/call", { name: "get_reminders", arguments: { listId: "List/NEW" } });
  assert.ok(!firstOpenRead.result.isError, JSON.stringify(firstOpenRead)); assert.equal(firstOpenRead.result.structuredContent.records[0].id, "Reminder/OPEN");
  assert.equal(firstOpenRead.result.structuredContent.records[0].completed, false); assert.ok(!JSON.stringify(firstOpenRead).includes("appleRecord"));
  // Completing the previously returned item produces a Reminder change. The
  // current includeCompleted=0 query now excludes it; cached rows are not reused.
  syncScenario.pages.push({ requestToken: "sync-new-head", response: { records: [{ ...openReminder, fields: { ...openReminder.fields, Completed: { type: "INT64", value: 1 } } }], syncToken: "sync-completed-head", moreComing: false } });
  mcpReminderScenario.records = [];
  const completedOpenRead = await mcp("tools/call", { name: "get_reminders", arguments: { listId: "List/NEW" } });
  assert.ok(!completedOpenRead.result.isError, JSON.stringify(completedOpenRead)); assert.equal(completedOpenRead.result.structuredContent.records.length, 0);
  assert.equal(mcpReminderScenario.requests.length, 2);
  const requestsAfterDemand = syncScenario.requests.length; await scheduledTick(); assert.equal(syncScenario.requests.length, requestsAfterDemand);
  mcpReminderScenario = null;
  // One real MCP call reads every available list and each current query page.
  const allReminder = (id, listId, completed = 0) => ({ recordName: id, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } }, Completed: { type: "INT64", value: completed } } });
  syncScenario.current = { ...syncScenario.current, "List/ALL-A": currentList("List/ALL-A", "All list A"), "List/ALL-B": currentList("List/ALL-B", "All list B"), "List/MISSING": { recordName: "List/MISSING", serverErrorCode: "NOT_FOUND" } };
  syncScenario.pages.push({ requestToken: "sync-completed-head", response: { records: [currentList("List/ALL-A", "All list A"), currentList("List/ALL-B", "All list B"), { recordName: "List/MISSING", deleted: true }], syncToken: "sync-all-head", moreComing: false } });
  allOpenScenario = { requests: [], pages: {
    "List/NEW": [{ reply: { records: [] } }],
    "List/ALL-A": [{ reply: { records: [allReminder("Reminder/A1", "List/ALL-A")], continuationMarker: "all-a-next" } }, { inputCursor: "all-a-next", reply: { records: [allReminder("Reminder/A2", "List/ALL-A"), allReminder("Reminder/CLOSED", "List/ALL-A", 1), { ...allReminder("Reminder/DELETED", "List/ALL-A"), deleted: true }] } }],
    "List/ALL-B": [{ reply: { records: [allReminder("Reminder/B1", "List/ALL-B")] } }],
  } };
  const readStatus = await mcp("tools/call", { name: "connection_status", arguments: {} }); assert.equal(readStatus.result.structuredContent.capabilities.listReminders, true); assert.equal(readStatus.result.structuredContent.capabilities.create, false);
  const allOpenReply = await mcp("tools/call", { name: "get_all_open_reminders", arguments: {} }); assert.ok(!allOpenReply.result.isError, JSON.stringify(allOpenReply));
  const allOpen = allOpenReply.result.structuredContent;
  assert.equal(allOpen.complete, true); assert.equal(allOpen.continuation, null); assert.equal(allOpen.writesEnabled, false);
  assert.deepEqual(allOpen.progress, { listsTotal: 3, listsCompleted: 3, pagesRead: 4, totalPages: 4 });
  assert.deepEqual(allOpen.records.map(record => record.id).sort(), ["Reminder/A1", "Reminder/A2", "Reminder/B1"]);
  assert.equal(allOpen.recordErrors.length, 0); assert.equal(allOpenScenario.requests.length, 4);
  for (const privateValue of ["appleRecord", "all-a-next", "synthetic-private-owner", "restore-me"]) assert.ok(!JSON.stringify(allOpen).includes(privateValue));
  allOpenScenario = null;
  const currentSyncDB = await worker.getD1Database("DB");
  const beforeExpiredToken = (await currentSyncDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first()).envelope;
  syncScenario.pages.push({ requestToken: "sync-all-head", response: { serverErrorCode: "CHANGE_TOKEN_EXPIRED" } });
  const expiredToken = await request("/api/apple/read", { method: "POST", body: syncBody }); assert.equal((await expiredToken.json()).error.code, "RESTART_REQUIRED");
  assert.equal((await currentSyncDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first()).envelope, beforeExpiredToken);
  syncScenario.pages.push({ requestToken: undefined, response: { records: [], syncToken: "sync-restarted-head", moreComing: false } });
  const resetSync = await request("/api/apple/read", { method: "POST", body: { ...syncBody, restart: true } }); assert.equal(resetSync.status, 200, await resetSync.clone().text());
  const finalSyncCache = await (await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } })).json();
  assert.equal(finalSyncCache.result.records.find(record => record.id === "List/NEW").title, "Renamed current list");
  assert.equal(finalSyncCache.result.records.find(record => record.id === "List/SYNTHETIC").deleted, true);
  assert.equal(syncScenario.pages.length, 0); syncScenario = null;
  const authBatchDB = await worker.getD1Database("DB");
  const beforeAuthBatch = await authBatchDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  const authBatch = startBatchScenario();
  const authBatchRead = request("/api/apple/read", { method: "POST", body: batchBody });
  await awaitBatchQueries(authBatch);
  authBatch.responses.get("List/BATCH-A")(new Response("{}", { status: 503 }));
  authBatch.responses.get("List/BATCH-B")(new Response("{}", { status: 421 }));
  const authBatchResponse = await authBatchRead; assert.equal(authBatchResponse.status, 409);
  assert.equal((await authBatchResponse.json()).error.code, "REAUTH_REQUIRED", "Authentication rejection must take precedence over an earlier upstream failure.");
  const afterAuthBatch = await (await request("/api/connection")).json(); assert.equal(afterAuthBatch.state, "DISCONNECTED");
  batchScenario = null;
  // Restore the synthetic fixture to retain the existing single-read invalidation journey.
  const restoreBatchSession = await batchEnvelope.decrypt(JSON.parse(beforeAuthBatch.envelope), batchContext);
  const restoredBatchEnvelope = await batchEnvelope.encrypt(restoreBatchSession, { ...batchContext, generation: afterAuthBatch.generation });
  await authBatchDB.prepare("UPDATE apple_session_state SET state = 'READY', envelope = ?, resume_id = NULL, resume_expires_at = NULL, version = version + 1 WHERE owner_id = ?").bind(JSON.stringify(restoredBatchEnvelope), owner).run();
  const rejectedRead = await request("/api/apple/read", { method: "POST", body: { action: "discover", expectedGeneration: afterAuthBatch.generation } });
  assert.equal(rejectedRead.status, 409);
  assert.equal((await rejectedRead.json()).error.code, "REAUTH_REQUIRED");
  const rejectedStatus = await (await request("/api/connection")).json();
  assert.equal(rejectedStatus.state, "DISCONNECTED"); assert.equal(rejectedStatus.capabilities.controlledRead, false); assert.equal(rejectedStatus.expiresAt, null);
  await request("/api/auth/disconnect", { method: "POST", body: {} });
  assert.equal((await request("/api/apple/read", { method: "POST", body: { action: "discover", expectedGeneration: empty.generation } })).status, 409);
  fetchMock.assertNoPendingInterceptors();
  const writeAcceptance = await verifyReminderWrites(options);
  console.log(JSON.stringify({ result: "passed", runtime: "local-workerd", productionBundle: true, checks: ["owner-denial", "origin-CSRF", "removed-feasibility-surfaces", "stateless-MCP", "nonce-CSP", "gated-auth-no-state", "unverified-Apple-success-rejected", "dedicated-credential-document", "encrypted-session-cold-start", "restored-cookie-compound-read", "two-list-concurrent-read", "incremental-catalogue-cold-restart", "expired-catalogue-token", "scheduled-catalogue-without-browser", "background-initial-scan-pause-resume", "on-demand-MCP-catch-up", "all-open-reminders-across-three-lists", "completion-removes-open-reminder", "persistent-catalogue-page-counts", "failed-batch-drains-lease", "batch-auth-invalidation", "disconnect-rejects-read", ...writeAcceptance.checks], liveAppleValidated: false }));
} finally {
  if (worker) await worker.dispose(); await rm(directory, { recursive: true, force: true });
}
