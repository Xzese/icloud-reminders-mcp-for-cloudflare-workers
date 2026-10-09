// Acceptance journey against the exact production bundle in workerd, with synthetic data.
import { Miniflare, Log, LogLevel } from "miniflare";
import { fetch as mockFetch, MockAgent } from "undici";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { randomBytes } from "node:crypto";
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
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/records\/query\?/, method: "POST", headers: { cookie: "synthetic-session=restore-me", origin: "https://www.icloud.com", referer: "https://www.icloud.com/", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15" } }).reply(200, { records: [
    { recordName: "Reminder/SYNTHETIC", recordType: "Reminder", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { List: { type: "REFERENCE", value: { recordName: "List/SYNTHETIC", action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" } } } } },
    { recordName: "Alarm/SYNTHETIC", recordType: "Alarm", fields: {} },
    { recordName: "List/SYNTHETIC", recordType: "List", fields: { ReminderIDs: { type: "STRING", value: JSON.stringify(Array(2001).fill("Reminder/SYNTHETIC")) } } },
  ] });
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/records\/query\?/, method: "POST" }).reply(421, {});
  ck.intercept({ path: /\/database\/1\/com\.apple\.reminders\/production\/private\/zones\/list\?/, method: "POST" }).reply(200, { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "synthetic-private-owner" } }] });
  let directMcpScenario = null;
  let controlledReadLookups = [];
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
  const enabledOptions = { ...options, bindings: { ...options.bindings, LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" }, outboundService: async req => {
    const pathname = new URL(req.url).pathname;
    if (directMcpScenario) {
      directMcpScenario.paths[pathname] = (directMcpScenario.paths[pathname] ?? 0) + 1;
      if (pathname.endsWith("/zones/list")) return new Response(JSON.stringify({ zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "synthetic-private-owner" } }] }), { headers: { "content-type": "application/json" } });
      if (pathname.endsWith("/records/lookup")) {
        const body = await req.clone().json();
        assert.deepEqual(body.desiredKeys, ["Name", "Color", "Count", "IsGroup", "Deleted"]);
        assert.deepEqual(body.records, [{ recordName: "List/KNOWN" }]);
        assert.equal(body.zoneID.ownerRecordName, "synthetic-private-owner");
        return new Response(JSON.stringify({ records: [directMcpScenario.knownList] }), { headers: { "content-type": "application/json" } });
      }
      if (pathname.endsWith("/records/query")) {
        const body = await req.clone().json();
        if (body.query.recordType === "Lists") {
          directMcpScenario.listQueries++;
          assert.equal(body.resultsLimit, 200);
          const discovery = directMcpScenario.listDiscoveries[directMcpScenario.listDiscoveryRequests++];
          assert.ok(discovery, "Unexpected direct Lists query");
          assert.equal(body.continuationMarker, discovery.inputCursor);
          return new Response(JSON.stringify(discovery.reply), { headers: { "content-type": "application/json" } });
        }
        assert.equal(body.query.recordType, "reminderList");
        assert.equal(body.resultsLimit, 200);
        const listId = body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName;
        assert.equal(body.query.filterBy.find(filter => filter.fieldName === "includeCompleted").fieldValue.value, 0);
        const page = directMcpScenario.reminderPages[listId].shift();
        assert.ok(page, `Unexpected direct all-open query for ${listId}`);
        assert.equal(body.continuationMarker, page.inputCursor);
        const reply = page.reply;
        return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
      }
      assert.ok(false, `Unexpected direct-mode CloudKit request: ${pathname}`);
    }
    if (pathname.endsWith("/records/lookup")) {
      const body = await req.clone().json(); controlledReadLookups.push(body);
      const ids = body.records.map(({ recordName }) => recordName);
      assert.deepEqual(body.desiredKeys, ["Name", "Color", "Count", "IsGroup", "Deleted"]);
      const list = (id, title) => ({ recordName: id, recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { Name: { type: "STRING", value: title }, Count: { type: "INT64", value: 0 }, IsGroup: { type: "INT64", value: 0 }, Deleted: { type: "INT64", value: 0 } } });
      assert.ok(ids.every(id => ["List/SYNTHETIC", "List/BATCH-A", "List/BATCH-B"].includes(id)), `Unexpected controlled lookup: ${ids.join(",")}`);
      return new Response(JSON.stringify({ records: ids.map(id => list(id, id === "List/SYNTHETIC" ? "Synthetic test list" : `Test ${id.slice(5)}`)) }), { headers: { "content-type": "application/json" } });
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
    // Miniflare and the harness can use different Undici versions. Transfer
    // web-standard fields instead of passing a version-branded Request object.
    return mockFetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers), body: req.body, duplex: "half", redirect: "manual", signal: req.signal, dispatcher: fetchMock });
  } };
  await worker.dispose(); worker = new Miniflare(enabledOptions);
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
  await worker.dispose(); worker = new Miniflare(enabledOptions);
  const restoredApple = await (await request("/api/connection")).json(); assert.equal(restoredApple.state, "READY"); assert.equal(restoredApple.capabilities.liveRead, true); assert.equal(restoredApple.capabilities.listReminders, true); assert.equal(restoredApple.capabilities.allOpenReminders, true); assert.equal(restoredApple.liveReadValidated, undefined); assert.equal(restoredApple.validation, undefined); assert.equal(restoredApple.writeEnabled, true);
  const compoundResponse = await request("/api/apple/read", { method: "POST", body: { action: "reminders", expectedGeneration: empty.generation, listId: "List/SYNTHETIC", includeCompleted: true, limit: 1 } });
  const compound = await compoundResponse.json(); assert.equal(compoundResponse.status, 200, JSON.stringify(compound)); assert.equal(compound.result.records.length, 1); assert.equal(compound.result.auxiliaryRecordCounts.Alarm, 1); assert.equal(compound.result.auxiliaryRecordCounts.List, 1); assert.equal(compound.result.auxiliaryDetailsIncluded, true); assert.equal(compound.liveReadValidated, false);
  assert.deepEqual(controlledReadLookups.at(-1).records, [{ recordName: "List/SYNTHETIC" }], "A controlled single-list reminder read authorizes the list before querying reminders.");
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
  assert.equal(batchResponse.status, 200, JSON.stringify(batchValue)); assert.equal(batchValue.writesEnabled, true);
  assert.deepEqual(batchValue.result.pages.map(page => page.listId), batchBody.listIds);
  for (const page of batchValue.result.pages) {
    assert.equal(page.records.length, 1); assert.equal(page.records[0].listId, page.listId);
    assert.equal(page.auxiliaryRecordCounts.Alarm, 1); assert.equal(page.relatedRecords.length, 1);
    assert.equal(page.continuation, `first-page-${page.listId.slice(5)}`); assert.equal(page.paginationComplete, false);
  }
  assert.equal(batchValue.result.requestTrace.length, 3); assert.equal(batchValue.result.requestTrace.filter(entry => entry.path.endsWith("/records/lookup")).length, 1); assert.equal(concurrentBatch.arrivals.length, 2);
  assert.deepEqual(controlledReadLookups.at(-1).records, [{ recordName: "List/BATCH-A" }, { recordName: "List/BATCH-B" }], "A controlled batch authorizes every list before starting its reminder queries.");
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
  const duringBatch = await request("/api/apple/read", { method: "POST", body: { action: "reminders", expectedGeneration: empty.generation, listId: "List/SYNTHETIC", includeCompleted: true, limit: 1 } });
  assert.equal(duringBatch.status, 409); assert.equal((await duringBatch.json()).error.code, "CONFLICT");
  assert.equal(failedBatchSettled, false, "A failed query must not release the lease while its peer is pending.");
  drainedBatch.responses.get("List/BATCH-B")(batchReply("List/BATCH-B", { "set-cookie": "failed-batch=discard; Domain=icloud.com; Path=/; Secure" }));
  const failedBatchResponse = await failedBatchRead; assert.equal(failedBatchResponse.status, 503);
  assert.equal((await failedBatchResponse.json()).error.code, "UPSTREAM_UNAVAILABLE");
  const afterFailure = await batchDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").bind(owner).first();
  assert.equal(afterFailure.envelope, afterBatch.envelope, "A partially successful batch must not commit cookies or pages.");
  batchScenario = null;
  assert.equal((await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: empty.generation } })).status, 200);
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
  const rejectedRead = await request("/api/apple/read", { method: "POST", body: { action: "reminders", expectedGeneration: afterAuthBatch.generation, listId: "List/SYNTHETIC", includeCompleted: true, limit: 1 } });
  assert.equal(rejectedRead.status, 409);
  assert.equal((await rejectedRead.json()).error.code, "REAUTH_REQUIRED");
  const rejectedStatus = await (await request("/api/connection")).json();
  assert.equal(rejectedStatus.state, "DISCONNECTED"); assert.equal(rejectedStatus.capabilities.controlledRead, false); assert.equal(rejectedStatus.expiresAt, null);
  await request("/api/auth/disconnect", { method: "POST", body: {} });
  assert.equal((await request("/api/apple/read", { method: "POST", body: { action: "reminders", expectedGeneration: empty.generation, listId: "List/SYNTHETIC", includeCompleted: true, limit: 1 } })).status, 409);
  fetchMock.assertNoPendingInterceptors();
  await worker.dispose();
  worker = new Miniflare(enabledOptions);
  const directDB = await worker.getD1Database("DB");
  await directDB.prepare("INSERT OR IGNORE INTO apple_session_state (owner_id, account_id) VALUES (?, 'apple-reminders')").bind(owner).run();
  const directStatus = await (await request("/api/connection")).json();
  const directGeneration = directStatus.generation;
  const oldContinuation = "00000000-0000-4000-8000-000000000123";
  const oldLegacyList = { id: "List/OLD", title: "Obsolete history list", deleted: false, isGroup: false, checkedAt: Date.now() };
  const oldLegacySession = {
    ...fixtureSession,
    diagnosticCatalogue: { token: "synthetic-diagnostic-token", seen: [], pages: 1, expiresAt: Date.now() + 60_000, complete: false },
    catalogueSync: { token: "synthetic-expired-checkpoint", initialComplete: true, pending: false, pages: 8, seen: [], updatedAt: Date.now(), initialPages: 8, totalPages: 8, totalPagesKnown: true, lastPassPages: 8 },
    catalogueAuto: { policy: "initial-and-hourly", enabled: true, nextCheckAt: Date.now(), lastCheckAt: Date.now(), lastSuccessAt: Date.now(), lastErrorCode: null, pausedForError: false, failures: 0, runId: null, runUntil: 0 },
    legacySavedLists: [oldLegacyList],
    allOpenScan: { token: oldContinuation, expiresAt: Date.now() + 60_000, listIds: [oldLegacyList.id], index: 0, cursor: null, seen: [], listPages: 0, totalPages: 0, caughtUpAt: Date.now(), source: "legacy-catalogue", lists: [oldLegacyList] },
  };
  const directEnvelope = await new Envelopes("synthetic", { synthetic: secret }).encrypt(oldLegacySession, { ownerId: owner, accountId: "apple-reminders", generation: directGeneration, recordId: "apple-session", schemaVersion: 1 });
  await directDB.prepare("UPDATE apple_session_state SET state = 'READY', envelope = ?, action = NULL, next_attempt_at = 0, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, version = version + 1 WHERE owner_id = ? AND account_id = 'apple-reminders'").bind(JSON.stringify(directEnvelope), owner).run();
  const restoredLegacyStatus = await (await request("/api/connection")).json();
  assert.equal(restoredLegacyStatus.state, "READY"); assert.equal(restoredLegacyStatus.generation, directGeneration);
  const oldContinuationReply = await mcp("tools/call", { name: "get_all_open_reminders", arguments: { expectedGeneration: directGeneration, continuation: oldContinuation } });
  assert.equal(oldContinuationReply.result.isError, true); assert.equal(oldContinuationReply.result.structuredContent.error.code, "CONFLICT");
  const stillConnected = await (await request("/api/connection")).json();
  assert.equal(stillConnected.state, "READY", "Discarding obsolete scan state keeps the valid Apple session connected.");
  assert.equal((await request("/api/apple/read", { user: "other-owner", method: "POST", body: { action: "current-lists", expectedGeneration: directGeneration } })).status, 403);
  for (const action of ["sync-catalogue", "catalogue-auto", "lists", "probe-other-zones"]) {
    const removedAction = await request("/api/apple/read", { method: "POST", body: { action, expectedGeneration: directGeneration } });
    assert.equal(removedAction.status, 422, `${action} is no longer a supported read action.`);
  }
  const directListRecord = (id, title, { count = 0, isGroup = false, deleted = false } = {}) => ({ recordName: id, recordType: "List", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, ...(deleted ? { deleted: false } : {}), fields: { Name: { type: "STRING", value: title }, Count: { type: "INT64", value: count }, IsGroup: { type: "INT64", value: isGroup ? 1 : 0 }, Deleted: { type: "INT64", value: deleted ? 1 : 0 } } });
  const directReminder = (id, listId, completed = 0) => ({ recordName: id, recordType: "Reminder", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" }, fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: "synthetic-private-owner" } } }, Completed: { type: "INT64", value: completed } } });
  const pageOne = [directListRecord("List/EMPTY", "Empty list"), directListRecord("List/GROUP", "Group", { isGroup: true })];
  const pageTwo = [directListRecord("List/ACTIVE", "Active list", { count: 1 }), directListRecord("List/DELETED", "Deleted list", { deleted: true })];
  directMcpScenario = {
    paths: {}, listDiscoveryRequests: 0, listQueries: 0, knownList: directListRecord("List/KNOWN", "Known list"),
    listDiscoveries: [
      { reply: { records: pageOne, continuationMarker: "direct-list-next" } },
      { inputCursor: "direct-list-next", reply: { records: pageTwo } },
      { reply: { records: pageOne, continuationMarker: "direct-list-next" } },
      { inputCursor: "direct-list-next", reply: { records: pageTwo } },
      { reply: { records: pageOne, continuationMarker: "direct-list-next" } },
      { inputCursor: "direct-list-next", reply: { records: pageTwo } },
    ],
    reminderPages: {
      "List/KNOWN": [{ reply: { records: [directReminder("Reminder/KNOWN", "List/KNOWN")] } }, { reply: { records: [] } }],
      "List/EMPTY": [{ reply: new Response("{}", { status: 503 }) }, { reply: { records: [] } }],
      "List/ACTIVE": [
        { reply: { records: [directReminder("Reminder/ACTIVE-1", "List/ACTIVE"), directReminder("Reminder/CLOSED", "List/ACTIVE", 1), { ...directReminder("Reminder/DELETED", "List/ACTIVE"), deleted: true }], continuationMarker: "active-next" } },
        { inputCursor: "active-next", reply: { records: [directReminder("Reminder/ACTIVE-2", "List/ACTIVE")] } },
      ],
    },
  };
  const measuredMcp = async (name, call) => {
    const before = { ...directMcpScenario.paths };
    const started = performance.now();
    const value = await call();
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    const pathCounts = Object.fromEntries(Object.keys(directMcpScenario.paths).map(path => [path, directMcpScenario.paths[path] - (before[path] ?? 0)]).filter(([, count]) => count > 0));
    return { name, elapsedMs, pathCounts, value };
  };
  const knownMetric = await measuredMcp("known-list read with stale checkpoint", () => mcp("tools/call", { name: "get_reminders", arguments: { expectedGeneration: directGeneration, listId: "List/KNOWN" } }));
  assert.ok(!knownMetric.value.result.isError, JSON.stringify(knownMetric.value));
  assert.equal(knownMetric.value.result.structuredContent.source, "direct-known-list-query");
  assert.deepEqual(knownMetric.pathCounts, { "/database/1/com.apple.reminders/production/private/zones/list": 1, "/database/1/com.apple.reminders/production/private/records/lookup": 1, "/database/1/com.apple.reminders/production/private/records/query": 1 });
  const completedKnownRead = await mcp("tools/call", { name: "get_reminders", arguments: { expectedGeneration: directGeneration, listId: "List/KNOWN" } });
  assert.ok(!completedKnownRead.result.isError, JSON.stringify(completedKnownRead));
  assert.equal(completedKnownRead.result.structuredContent.records.length, 0, "A newly completed reminder disappears from the next live read.");
  const migratedEnvelope = await directDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ? AND account_id = 'apple-reminders'").bind(owner).first();
  const migratedSession = await new Envelopes("synthetic", { synthetic: secret }).decrypt(JSON.parse(migratedEnvelope.envelope), { ownerId: owner, accountId: "apple-reminders", generation: directGeneration, recordId: "apple-session", schemaVersion: 1 });
  for (const key of ["catalogueSync", "catalogueAuto", "diagnosticCatalogue", "legacySavedLists", "allOpenScan"]) assert.equal(migratedSession[key], undefined, `The obsolete ${key} checkpoint is stripped while restoring the valid session.`);
  assert.equal(directMcpScenario.paths["/database/1/com.apple.reminders/production/private/changes/zone"] ?? 0, 0, "Known-list reads make no historical changes request.");
  const currentListsResponse = await request("/api/apple/read", { method: "POST", body: { action: "current-lists", expectedGeneration: directGeneration } });
  const currentLists = await currentListsResponse.json();
  assert.equal(currentListsResponse.status, 200, JSON.stringify(currentLists));
  assert.equal(currentLists.result.source, "direct-cloudkit-query"); assert.equal(currentLists.result.freshness.mode, "live");
  assert.equal(currentLists.result.complete, true); assert.equal(directMcpScenario.listQueries, 2);
  const queriesBeforeSnapshot = directMcpScenario.listQueries;
  const snapshotResponse = await request("/api/apple/read", { method: "POST", body: { action: "saved-lists", expectedGeneration: directGeneration } });
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshot));
  assert.deepEqual(snapshot.result.records.map(record => record.id).sort(), ["List/ACTIVE", "List/DELETED", "List/EMPTY", "List/GROUP"]);
  assert.equal(directMcpScenario.listQueries, queriesBeforeSnapshot, "Displaying the encrypted saved-lists snapshot does not query Apple.");
  const directListsMetric = await measuredMcp("direct selectable-list retrieval", () => mcp("tools/call", { name: "get_reminder_lists", arguments: { expectedGeneration: directGeneration } }));
  assert.ok(!directListsMetric.value.result.isError, JSON.stringify(directListsMetric.value));
  assert.equal(directListsMetric.value.result.structuredContent.source, "direct-cloudkit-query");
  assert.equal(directListsMetric.value.result.structuredContent.freshness.mode, "live");
  assert.deepEqual(directListsMetric.value.result.structuredContent.records.map(record => record.id).sort(), ["List/ACTIVE", "List/EMPTY"]);
  assert.equal(directMcpScenario.listQueries, 4);
  const persistedDirectEnvelope = await directDB.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ? AND account_id = 'apple-reminders'").bind(owner).first();
  for (const privateValue of ["List/ACTIVE", "Active list", "synthetic-private-owner"]) assert.ok(!persistedDirectEnvelope.envelope.includes(privateValue));
  const persistedDirectSession = await new Envelopes("synthetic", { synthetic: secret }).decrypt(JSON.parse(persistedDirectEnvelope.envelope), { ownerId: owner, accountId: "apple-reminders", generation: directGeneration, recordId: "apple-session", schemaVersion: 1 });
  assert.deepEqual(persistedDirectSession.savedLists.map(list => list.id).sort(), ["List/ACTIVE", "List/DELETED", "List/EMPTY", "List/GROUP"], "A complete direct query persists the full snapshot, including nonselectable summaries.");
  assert.equal(persistedDirectSession.savedLists.find(list => list.id === "List/DELETED").deleted, true, "The logical Deleted field takes effect when CloudKit's top-level deleted marker is false.");
  assert.equal(persistedDirectSession.directListSnapshot.updatedAt > 0, true);
  for (const key of ["catalogueSync", "catalogueAuto", "diagnosticCatalogue", "legacySavedLists", "allOpenScan"]) assert.equal(persistedDirectSession[key], undefined);
  assert.equal(directMcpScenario.paths["/database/1/com.apple.reminders/production/private/zones/list"], 1, "The private-zone owner is bootstrapped once and then reused.");
  const directOpenInitialMetric = await measuredMcp("direct all-open initial discovery", () => mcp("tools/call", { name: "get_all_open_reminders", arguments: { expectedGeneration: directGeneration } }));
  const directOpenInitial = directOpenInitialMetric.value.result.structuredContent;
  assert.ok(!directOpenInitialMetric.value.result.isError, JSON.stringify(directOpenInitialMetric.value));
  assert.equal(directOpenInitial.complete, false); assert.equal(directOpenInitial.errors[0].code, "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(directOpenInitial.progress, { listsTotal: 2, listsCompleted: 0, pagesRead: 0, totalPages: 0 });
  const listQueriesAfterInitial = directMcpScenario.listQueries;
  assert.equal(listQueriesAfterInitial, 6, "All-open discovery follows both bounded Lists pages exactly once.");
  assert.equal(directMcpScenario.paths["/database/1/com.apple.reminders/production/private/zones/list"], 1);
  const directOpenResumeMetric = await measuredMcp("direct all-open resume", () => mcp("tools/call", { name: "get_all_open_reminders", arguments: { expectedGeneration: directGeneration, continuation: directOpenInitial.continuation } }));
  const directOpenResume = directOpenResumeMetric.value.result.structuredContent;
  assert.ok(!directOpenResumeMetric.value.result.isError, JSON.stringify(directOpenResumeMetric.value));
  assert.equal(directOpenResume.complete, true); assert.equal(directOpenResume.source, "direct-cloudkit-query");
  assert.equal(directOpenResume.freshness.mode, "live"); assert.equal(directOpenResume.progress.listsTotal, 2); assert.equal(directOpenResume.progress.listsCompleted, 2);
  assert.deepEqual(directOpenResume.lists.map(list => list.id), ["List/EMPTY", "List/ACTIVE"]);
  assert.deepEqual(directOpenResume.records.map(record => record.id), ["Reminder/ACTIVE-1", "Reminder/ACTIVE-2"]);
  assert.equal(directOpenResume.progress.pagesRead, 3);
  assert.ok(!directOpenResume.records.some(record => record.id === "Reminder/CLOSED" || record.id === "Reminder/DELETED"));
  assert.equal(directMcpScenario.listQueries, listQueriesAfterInitial, "A continuation resumes the saved list selection without rediscovering Lists.");
  const replayedContinuation = await mcp("tools/call", { name: "get_all_open_reminders", arguments: { expectedGeneration: directGeneration, continuation: directOpenInitial.continuation } });
  assert.equal(replayedContinuation.result.isError, true); assert.equal(replayedContinuation.result.structuredContent.error.code, "CONFLICT", "A completed all-open continuation cannot be replayed.");
  assert.equal(directMcpScenario.paths["/database/1/com.apple.reminders/production/private/changes/zone"] ?? 0, 0);
  assert.equal(directMcpScenario.paths["/database/1/com.apple.reminders/production/private/zones/list"], 1);
  console.log(JSON.stringify({ type: "synthetic-performance", liveAppleData: false, measurements: [knownMetric, directListsMetric, directOpenInitialMetric, directOpenResumeMetric].map(({ name, elapsedMs, pathCounts }) => ({ name, elapsedMs, pathCounts })) }));
  const writeAcceptance = await verifyReminderWrites(options);
  console.log(JSON.stringify({ result: "passed", runtime: "local-workerd", productionBundle: true, checks: ["owner-denial", "origin-CSRF", "removed-feasibility-surfaces", "stateless-MCP", "nonce-CSP", "gated-auth-no-state", "unverified-Apple-success-rejected", "dedicated-credential-document", "encrypted-session-cold-start", "legacy-envelope-restores-without-disconnect", "removed-history-actions", "saved-lists-display-only-snapshot", "direct-current-lists-pagination", "known-list-exact-authorization", "known-list-read-without-history", "direct-all-open-retry-and-frozen-resume", "all-open-continuation-replay-rejected", "restored-cookie-compound-read", "single-and-batch-list-authorization", "two-list-concurrent-read", "completion-removes-open-reminder", "failed-batch-drains-lease", "batch-auth-invalidation", "disconnect-rejects-read", ...writeAcceptance.checks], liveAppleValidated: false }));
} finally {
  if (worker) await worker.dispose(); await rm(directory, { recursive: true, force: true });
}
