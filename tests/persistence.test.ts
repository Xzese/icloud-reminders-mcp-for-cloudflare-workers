import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { AppleSessionRepository, catalogueAutoMetadata, catalogueSyncMetadata, mergeSavedLists, type AppleSession } from "../src/persistence/apple-sessions.ts";
import { runCatalogueBackground } from "../src/auth/catalogue-background.ts";
import { AppleConnectionService, ControlledRead } from "../src/auth/service.ts";
import { AppError } from "../src/errors.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import { loginAssurance } from "../src/auth/apple/policy.ts";
import { encodeDocument } from "../src/reminders/crdt.ts";
import { b64 } from "../src/crypto/bytes.ts";

// Real SQLite executes repository SQL. This adapter models D1's transactional batch.
// The produced Worker is separately tested in workerd with real D1 bindings.
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  afterStatement: ((sql: string) => Promise<void>) | null = null;
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  }
  withSession() { return this; }
  prepare(sql: string) {
    const source = this;
    function make(params: SQLInputValue[]) {
      return {
        bind(...values: SQLInputValue[]) { return make(values); },
        async first<T>() { const result = source.sqlite.prepare(sql).get(...params); if (source.afterStatement) await source.afterStatement(sql); return result as T ?? null; },
        async run() { const result = source.sqlite.prepare(sql).run(...params); if (source.afterStatement) await source.afterStatement(sql); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    }
    return make([]);
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  env() { return { DB: this as unknown as D1Database }; }
}
const key = () => new Envelopes("synthetic", { synthetic: b64(crypto.getRandomValues(new Uint8Array(32))) });
const owner = "synthetic-owner";
const appleSession = (): AppleSession => ({
  login: loginAssurance(),
  auth: {
    clientId: "auth-session-123",
    headers: { "X-Apple-Session-Token": "header-session-secret" },
    cookies: [{ name: "X-APPLE-WEBAUTH-TOKEN", value: "cookie-session-secret", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }],
  },
  connection: { dsid: "123456789", clientId: "auth-session-123", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22", cloudKitURL: "https://p123-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private" },
  pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 2, expiresAt: Date.now() + 300_000, nextAttemptAt: 0 },
});
const appleRepo = (db: SQLiteD1, who = owner, envelopes = key()) => new AppleSessionRepository({ ...db.env(), ENCRYPTION_KEY_ID: envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys) }, who, envelopes);

test("key-ring configuration is checked before any persistence can begin", () => {
  for (const ring of [null, [], [b64(new Uint8Array(32))], { key: 42 }, { key: "wrong" }, {}]) {
    assert.throws(() => new Envelopes("key", ring as unknown as Record<string, string>), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "CONFIGURATION_REQUIRED");
  }
});

test("Apple sessions are encrypted, owner-scoped, and restore the cookie jar", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  assert.deepEqual(await repository.status(), { generation: 1, version: 1, state: "CONNECTING", action: null, nextAttemptAt: 0, transportReady: false, liveReadValidated: false, expiresAt: null });
  const session = appleSession();
  session.savedLists = mergeSavedLists([], [{ id: "List/SAVED-PRIVATE-ID", title: "Private saved list" }], true);
  session.catalogueSync = { token: "PRIVATE-CATALOGUE-TOKEN", initialComplete: false, pending: true, pages: 2, seen: ["a".repeat(64)], updatedAt: Date.now() };
  await repository.commit(setup, session, "READY");
  const row = db.sqlite.prepare("SELECT * FROM apple_session_state WHERE owner_id = ? AND account_id = ?").get(owner, "apple-reminders") as Record<string, unknown>;
  const stored = JSON.stringify(row);
  for (const secret of ["header-session-secret", "cookie-session-secret", "123456789", "auth-session-123", "List/SAVED-PRIVATE-ID", "Private saved list", "PRIVATE-CATALOGUE-TOKEN", "a".repeat(64)]) assert.equal(stored.includes(secret), false);
  assert.equal(typeof row.envelope, "string");
  const loaded = await repository.load();
  assert.deepEqual(loaded.session, session);
  const restoredCookies = new CookieJar(loaded.session.auth.cookies);
  assert.match(restoredCookies.header(new URL("https://setup.icloud.com/setup/ws/1/accountLogin")) ?? "", /X-APPLE-WEBAUTH-TOKEN=cookie-session-secret/);
  assert.deepEqual(await repository.status(), { generation: 1, version: 2, state: "READY", action: null, nextAttemptAt: 0, transportReady: true, liveReadValidated: false, expiresAt: session.login.expiresAt });

  const other = appleRepo(db, "other-owner", repository.envelopes);
  assert.equal((await other.status()).state, "DISCONNECTED");
  await assert.rejects(other.load());
  await other.disconnect();
  assert.equal((await repository.status()).state, "READY");
  const restarted = appleRepo(db, owner, repository.envelopes);
  assert.deepEqual((await restarted.load()).session.savedLists, session.savedLists);
  assert.deepEqual((await restarted.load()).session.catalogueSync, session.catalogueSync);
  assert.deepEqual(catalogueSyncMetadata(session.catalogueSync), { phase: "initial", initialComplete: false, pending: true, pages: 2, updatedAt: session.catalogueSync.updatedAt, initialPages: 2, totalPages: 2, totalPagesKnown: true, lastPassPages: null });
  const historical = mergeSavedLists(session.savedLists, [{ id: "List/SAVED-PRIVATE-ID", title: "Older history name" }], false);
  assert.equal(historical[0].title, "Private saved list");
  const removed = mergeSavedLists(historical, [{ id: "List/SAVED-PRIVATE-ID", deleted: true }], true);
  assert.equal(mergeSavedLists(removed, [{ id: "List/SAVED-PRIVATE-ID", title: "Old live version" }], false)[0].deleted, true);
  const fence = await restarted.claimRead(loaded.fence.generation, loaded.fence.version);
  await restarted.commitResume(fence, { ...session, savedLists: removed }, "READY");
  assert.equal((await restarted.load()).session.savedLists?.[0].deleted, true);
  await restarted.disconnect();
  const next = await restarted.begin((await restarted.status()).generation);
  await restarted.commit(next, appleSession(), "READY");
  assert.equal((await restarted.load()).session.savedLists, undefined);
  assert.equal((await restarted.load()).session.catalogueSync, undefined);
});

test("Apple setup and disconnect fences reject stale commits and cancellation clears only its own commit", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const stale = await repository.begin(0);
  const current = await repository.begin(stale.generation);
  await assert.rejects(repository.commit(stale, appleSession(), "READY"));
  await repository.commit(current, appleSession(), "READY");
  assert.equal(await repository.abandon(current), true);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  assert.equal((await repository.status()).generation, current.generation + 1);

  const cancelled = await repository.begin(current.generation + 1);
  await repository.disconnect();
  await assert.rejects(repository.commit(cancelled, appleSession(), "READY"));
  assert.equal((await repository.status()).state, "DISCONNECTED");

  const expired = await repository.begin((await repository.status()).generation);
  db.sqlite.prepare("UPDATE apple_session_state SET transaction_expires_at = ? WHERE owner_id = ?").run(Date.now() - 1, owner);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  await assert.rejects(repository.commit(expired, appleSession(), "READY"));
});

test("PCS resume leases serialize and stale resume commits are fenced", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "DEVICE_APPROVAL_PENDING", "approve-device-consent");
  const saved = await repository.status();
  const resume = await repository.claimResume(saved.generation, saved.version);
  await assert.rejects(repository.claimResume(saved.generation, saved.version));
  assert.equal(await repository.releaseResume(resume), true);
  await assert.rejects(repository.commitResume(resume, appleSession(), "READY"));
  const next = await repository.status();
  const renewed = await repository.claimResume(next.generation, next.version);
  await repository.commitResume(renewed, (await repository.load()).session, "READY");
  assert.equal((await repository.status()).state, "READY");
});

test("ready reads claim the same short lease before committing refreshed cookies", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "READY");
  const saved = await repository.status();
  const read = await repository.claimRead(saved.generation, saved.version);
  const restored = await repository.load();
  assert.equal(restored.fence.version, read.version);
  await assert.rejects(repository.claimRead(saved.generation, read.version));
  await repository.commitResume(read, restored.session, "READY");
  assert.equal((await repository.status()).version, read.version + 1);
});

test("tampered ciphertext fails closed and an invalid decrypted snapshot is invalidated", async () => {
  const db = new SQLiteD1(); const envelopes = key(); const repository = appleRepo(db, owner, envelopes);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "READY");
  const row = db.sqlite.prepare("SELECT generation FROM apple_session_state WHERE owner_id = ?").get(owner) as { generation: number };
  const context = { ownerId: owner, accountId: "apple-reminders", generation: row.generation, recordId: "apple-session", schemaVersion: 1 as const };
  const saved = db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner) as { envelope: string };
  const envelope = JSON.parse(saved.envelope) as { ciphertext: string };
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(envelope), owner);
  await assert.rejects(repository.load());

  const afterTamper = await repository.status();
  assert.equal(afterTamper.state, "DISCONNECTED");
  const next = await repository.begin(afterTamper.generation);
  await repository.commit(next, appleSession(), "READY");
  const second = await repository.status();
  const invalidContext = { ...context, generation: second.generation };
  const invalidSnapshot = await envelopes.encrypt({ ...appleSession(), unexpectedProof: "must-not-persist" }, invalidContext);
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(invalidSnapshot), owner);
  await assert.rejects(repository.load());
  assert.equal((await repository.status()).state, "DISCONNECTED");
  const invalidated = db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner) as { envelope: string | null };
  assert.equal(invalidated.envelope, null);
});


test("absolute login expiry invalidates old policy sessions and cannot slide during operations", async () => {
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.login = loginAssurance(Date.now() - 10_000);
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const saved = await repository.status(), read = await repository.claimRead(saved.generation, saved.version);
  await assert.rejects(repository.commitResume(read, { ...session, login: loginAssurance() }, "READY"), (e: any) => e.code === "VALIDATION_ERROR");
  await repository.commitResume(read, session, "READY");
  assert.equal((await repository.status()).expiresAt, session.login.expiresAt);
  const context = { ownerId: owner, accountId: "apple-reminders", generation: saved.generation, recordId: "apple-session", schemaVersion: 1 as const };
  const expired = await repository.envelopes.encrypt({ ...session, login: loginAssurance(Date.now() - 86_400_001) }, context);
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(expired), owner);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope, null);
  const next = await repository.begin((await repository.status()).generation); await repository.commit(next, appleSession(), "READY");
  const { login: _old, ...legacy } = appleSession();
  const old = await repository.envelopes.encrypt(legacy, { ...context, generation: next.generation });
  db.sqlite.prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?").run(JSON.stringify(old), owner);
  await assert.rejects(repository.load(), (e: any) => e.code === "REAUTH_REQUIRED");
});

test("an operation crossing expiry during encryption or the final SQL cannot return success", async () => {
  for (const boundary of ["encryption", "final-sql"]) {
    const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
    const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
    const status = await repository.status(), fence = await repository.claimRead(status.generation, status.version);
    const nativeNow = Date.now, nativeEncrypt = repository.envelopes.encrypt.bind(repository.envelopes);
    if (boundary === "encryption") repository.envelopes.encrypt = async (...args: Parameters<Envelopes["encrypt"]>) => { const result = await nativeEncrypt(...args); Date.now = () => session.login.expiresAt; return result; };
    else db.afterStatement = async sql => { if (sql.startsWith("UPDATE apple_session_state SET version = version + 1, state = ?")) Date.now = () => session.login.expiresAt; };
    try { await assert.rejects(repository.commitResume(fence, session, "READY"), (e: any) => e.code === "AUTH_EXPIRED"); assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope, null); }
    finally { Date.now = nativeNow; }
  }
});


test("catalogue checkpoints resume, start incremental passes, preserve failures, and restart under one session fence", async () => {
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const setup = await repository.begin(0);
  const session = appleSession();
  session.savedLists = mergeSavedLists([], [{ id: "List/KNOWN", title: "Manual current name" }], true);
  await repository.commit(setup, session, "READY");
  const env = { ...db.env(), ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  assert.deepEqual(ControlledRead.parse({ action: "sync-catalogue", expectedGeneration: setup.generation }), { action: "sync-catalogue", expectedGeneration: setup.generation, restart: false, limit: 200 });
  for (const extra of [{ continuation: "browser-token" }, { reverse: true }, { limit: 201 }]) assert.equal(ControlledRead.safeParse({ action: "sync-catalogue", expectedGeneration: setup.generation, ...extra }).success, false);
  const zoneID = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_catalogue-owner" };
  const list = (name: string) => ({ recordName: "List/KNOWN", recordType: "List", zoneID, fields: { Name: { type: "STRING", value: name } } });
  const bodies: Record<string, unknown>[] = [];
  const replies: { body: unknown; cookie?: string; after?: () => Promise<void> }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift(); assert.ok(next, "Unexpected catalogue request");
    if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), { headers: next.cookie ? { "set-cookie": next.cookie } : {} });
  };
  const sync = (restart = false) => service().read(ControlledRead.parse({ action: "sync-catalogue", expectedGeneration: setup.generation, restart }));
  const change = (token: string, pending: boolean, records: unknown[] = []) => ({ zones: [{ zoneID, syncToken: token, moreComing: pending, records }] });
  try {
    const savedResult = (await service().read(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }))).result as { catalogueSync: ReturnType<typeof catalogueSyncMetadata> };
    assert.deepEqual(savedResult.catalogueSync, { phase: "not-started", pages: 0, initialComplete: false, pending: false, updatedAt: null, initialPages: null, totalPages: 0, totalPagesKnown: true, lastPassPages: null });
    replies.push({ body: { zones: [{ zoneID }] } }, { body: change("cursor-1", true, [list("Older history")]) }, { body: { records: [list("Current exact name")] }, cookie: "catalogue-cookie=page-one; Path=/; Secure" });
    const initial = await sync();
    const initialResult = initial.result as { catalogueSync: ReturnType<typeof catalogueSyncMetadata>; continuation: unknown; scope: string };
    assert.equal(initialResult.catalogueSync.phase, "initial"); assert.equal(initialResult.catalogueSync.pages, 1); assert.equal(initialResult.continuation, null); assert.equal(initialResult.scope, "incremental-catalogue");
    assert.ok(!JSON.stringify(initialResult).includes("cursor-1"));
    const afterFirst = await repository.load();
    assert.equal(afterFirst.session.savedLists?.[0].title, "Current exact name");
    assert.equal(afterFirst.session.catalogueSync?.token, "cursor-1");
    assert.equal(afterFirst.session.catalogueSync?.seen.length, 1);
    assert.equal(afterFirst.session.auth.cookies.some(cookie => cookie.name === "catalogue-cookie"), true);
    // Reconstruct the service between pages to model a cold process.
    replies.push({ body: change("cursor-2", false) });
    const terminal = await sync();
    assert.equal((terminal.result as typeof initialResult).catalogueSync.phase, "ready");
    assert.equal((terminal.result as typeof initialResult).catalogueSync.initialComplete, true);
    assert.equal((terminal.result as typeof initialResult).catalogueSync.initialPages, 2);
    assert.equal((terminal.result as typeof initialResult).catalogueSync.totalPages, 2);
    assert.equal((terminal.result as typeof initialResult).catalogueSync.lastPassPages, 2);
    assert.equal(((bodies[3].zones as Record<string, unknown>[])[0]).syncToken, "cursor-1");
    replies.push({ body: change("cursor-2", false) });
    const update = await sync();
    assert.equal((update.result as typeof initialResult).catalogueSync.pages, 1);
    assert.equal((update.result as typeof initialResult).catalogueSync.initialPages, 2);
    assert.equal((update.result as typeof initialResult).catalogueSync.totalPages, 3);
    assert.equal((update.result as typeof initialResult).catalogueSync.lastPassPages, 1);
    assert.deepEqual((await repository.load()).session.catalogueSync?.seen, []);
    assert.equal(((bodies[4].zones as Record<string, unknown>[])[0]).syncToken, "cursor-2");
    const lastGood = (await repository.load()).session;
    replies.push({ body: { zones: [{ zoneID, serverErrorCode: "CHANGE_TOKEN_EXPIRED" }] }, cookie: "catalogue-cookie=failed-page; Path=/; Secure" });
    await assert.rejects(sync(), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED");
    assert.deepEqual((await repository.load()).session, lastGood);
    replies.push({ body: change("cursor-restarted", true) });
    await sync(true);
    const restarted = (await repository.load()).session;
    assert.equal(((bodies[6].zones as Record<string, unknown>[])[0]).syncToken, undefined);
    assert.equal(restarted.catalogueSync?.initialComplete, false);
    assert.equal(restarted.catalogueSync?.pages, 1);
    assert.equal(restarted.catalogueSync?.initialPages, 1);
    assert.equal(restarted.catalogueSync?.totalPages, 1);
    assert.deepEqual(restarted.savedLists, lastGood.savedLists);
    // A returned cursor seen earlier in this pass cannot advance the cache.
    replies.push({ body: change("cursor-between", true) }); await sync();
    const beforeCycle = (await repository.load()).session;
    replies.push({ body: change("cursor-restarted", true) });
    await assert.rejects(sync(), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED");
    assert.deepEqual((await repository.load()).session, beforeCycle);
    // A failed current lookup cannot acknowledge history or changed cookies.
    replies.push({ body: change("cursor-not-committed", false, [list("Outdated history")]), cookie: "catalogue-cookie=failed-lookup; Path=/; Secure" }, { body: { records: [] } });
    await assert.rejects(sync(), AppError);
    assert.deepEqual((await repository.load()).session, beforeCycle);
    const capped = await repository.load();
    const capFence = await repository.claimRead(capped.fence.generation, capped.fence.version);
    await repository.commitResume(capFence, { ...capped.session, catalogueSync: { ...capped.session.catalogueSync!, pages: 1000 } }, "READY");
    const requestsBeforeCap = bodies.length;
    await assert.rejects(sync(), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED");
    assert.equal(bodies.length, requestsBeforeCap);
    // Disconnect during the request fences both the cursor and list cache.
    replies.push({ body: change("cursor-stale", false), after: () => repository.disconnect().then(() => {}) });
    await assert.rejects(sync(true), (error: unknown) => error instanceof AppError && ["CONFLICT", "NOT_CONNECTED"].includes(error.code));
    assert.equal((await repository.status()).state, "DISCONNECTED");
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
});

test("Legacy MCP list discovery initializes and resumes catalogue without a runner; local background and demand checks stay bounded", async () => {
  const originalNow = Date.now; const originalFetch = globalThis.fetch;
  let now = originalNow(); Date.now = () => now;
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const session = appleSession(); session.connection.remindersZoneOwner = "__defaultOwner__";
  session.savedLists = mergeSavedLists([], [{ id: "List/AUTO", title: "Saved current list" }], true);
  const setup = await repository.begin(0); await repository.commit(setup, session, "DEVICE_APPROVAL_PENDING", "approve-device-consent");
  const env = { ...db.env(), REMINDERS_OWNER_ID: owner, CATALOGUE_BACKGROUND_RUNNER: "local" as const, ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const toggle = (enabled: boolean) => service().read(ControlledRead.parse({ action: "catalogue-auto", expectedGeneration: setup.generation, enabled }));
  const demand = () => service().readForMCP(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }));
  const changes = (token: string, pending: boolean, records: unknown[] = []) => ({ zones: [{ zoneID: { zoneName: "Reminders" }, syncToken: token, moreComing: pending, records }] });
  const replies: { body: unknown; status?: number; headers?: Record<string, string>; after?: () => Promise<void> }[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    const next = replies.shift(); assert.ok(next, "Unexpected catalogue or reminder request");
    if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  };
  const inProgress = (error: unknown) => error instanceof AppError && error.code === "SYNC_IN_PROGRESS" && error.status === 409 && error.retryable;
  try {
    assert.equal((await runCatalogueBackground({ ...env, CATALOGUE_BACKGROUND_RUNNER: undefined })).reason, "not-configured");
    assert.equal((await runCatalogueBackground(env)).reason, "not-ready"); assert.equal(requests.length, 0);
    const approvalStatus = await repository.status(); const approval = await repository.claimResume(approvalStatus.generation, approvalStatus.version);
    await repository.commitResume(approval, session, "READY");
    await toggle(false); assert.equal((await runCatalogueBackground(env)).reason, "disabled"); await toggle(true);
    let secondRunner: Awaited<ReturnType<typeof runCatalogueBackground>> | undefined;
    for (let page = 1; page <= 25; page++) replies.push({ body: changes(`initial-${page}`, true), ...(page === 1 ? { after: async () => { secondRunner = await runCatalogueBackground(env); } } : {}) });
    // No manual catalogue scan and no configured scheduler: the first MCP read
    // must commit its bounded initial pages rather than refuse to start.
    await assert.rejects(new AppleConnectionService({ ...env, CATALOGUE_BACKGROUND_RUNNER: undefined }, owner).readForMCP(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation })), inProgress);
    assert.equal(secondRunner?.reason, "CONFLICT"); assert.equal(secondRunner?.pages, 0);
    const afterBudget = (await repository.load()).session;
    assert.equal(afterBudget.catalogueSync?.initialPages, 25); assert.equal(afterBudget.catalogueSync?.totalPages, 25);
    assert.equal((await runCatalogueBackground(env)).reason, "not-due");
    assert.equal(requests.length, 25);
    now += 60_000;
    replies.push({ status: 429, body: {}, headers: { "retry-after": "1800" } });
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED");
    assert.equal((await repository.load()).session.catalogueAuto?.nextCheckAt, now + 1_800_000);
    assert.deepEqual((await repository.load()).session.catalogueSync, afterBudget.catalogueSync);
    assert.equal((await runCatalogueBackground(env)).reason, "not-due");
    const beforeCooldownRetry = requests.length;
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED");
    assert.equal(requests.length, beforeCooldownRetry);
    now += 1_800_000;
    replies.push({ body: changes("initial-26", true) }, { body: changes("initial-27", false) });
    const initialized = await demand();
    assert.equal((initialized.result.records as Record<string, unknown>[])[0].id, "List/AUTO");
    assert.equal((requests[beforeCooldownRetry].body.zones as Record<string, unknown>[])[0].syncToken, "initial-25");
    assert.ok(requests.at(-1)!.path.endsWith("/changes/zone"));
    const initialComplete = (await repository.load()).session;
    assert.equal(initialComplete.catalogueSync?.initialPages, 27); assert.equal(initialComplete.catalogueSync?.lastPassPages, 27);
    assert.equal(initialComplete.catalogueAuto?.nextCheckAt, now + 3_600_000); assert.deepEqual(initialComplete.login, session.login);
    // Legacy five-minute routine dates migrate without an early Apple request.
    const completeFence = await repository.claimRead(setup.generation, (await repository.load()).fence.version);
    await repository.commitResume(completeFence, { ...initialComplete, catalogueAuto: { ...initialComplete.catalogueAuto!, policy: undefined, nextCheckAt: now + 300_000 } }, "READY");
    now += 600_000;
    const beforeIdle = requests.length;
    assert.equal((await runCatalogueBackground(env)).reason, "not-due"); assert.equal(requests.length, beforeIdle);
    assert.equal((await repository.load()).session.catalogueAuto?.nextCheckAt, initialComplete.catalogueAuto!.lastSuccessAt! + 3_600_000);
    assert.equal((await repository.load()).session.catalogueAuto?.policy, "initial-and-hourly");
    const visible = (await service().read(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }))).result as { catalogueAuto: { mode: string; intervalMs: number; enabled: boolean; nextCheckAt: number | null } };
    assert.deepEqual({ mode: visible.catalogueAuto.mode, intervalMs: visible.catalogueAuto.intervalMs, enabled: visible.catalogueAuto.enabled, nextCheckAt: visible.catalogueAuto.nextCheckAt }, { mode: "initial-and-hourly", intervalMs: 3_600_000, enabled: true, nextCheckAt: initialComplete.catalogueAuto!.lastSuccessAt! + 3_600_000 });
    const explicitLegacy = catalogueAutoMetadata({ ...initialComplete.catalogueAuto!, policy: undefined, nextCheckAt: now }, initialComplete.catalogueSync);
    assert.equal(explicitLegacy.nextCheckAt, now);
    now += 3_000_000;
    replies.push({ body: changes("initial-27", false) });
    assert.deepEqual(await runCatalogueBackground(env), { started: true, pages: 1, pending: false, reason: "caught-up" });
    assert.equal((await runCatalogueBackground(env)).reason, "not-due");
    await toggle(false); assert.equal((await runCatalogueBackground(env)).reason, "disabled");
    // Demand ignores routine due dates and disabled background preference,
    // catches up with exact list lookup, then returns the current saved list snapshot.
    const list = (title: string) => ({ recordName: "List/AUTO", recordType: "List", fields: { Name: { type: "STRING", value: title } } });
    replies.push({ body: changes("delta-1", true, [list("Old historical name")]) }, { body: { records: [list("Renamed current list")] } }, { body: changes("delta-2", false) });
    const current = await demand();
    assert.equal(current.result.freshness.mode, "checkpoint-then-live-query"); assert.equal(current.result.freshness.caughtUpAt, now);
    assert.equal((await repository.load()).session.savedLists?.[0].title, "Renamed current list");
    await toggle(true);
    // Budget exhaustion never returns a stale saved catalogue or reminder page.
    const beforeDemandBudget = requests.length;
    for (let page = 1; page <= 25; page++) replies.push({ body: changes(`demand-${page}`, true) });
    await assert.rejects(demand(), inProgress);
    assert.equal(requests.length, beforeDemandBudget + 25); assert.ok(requests.slice(beforeDemandBudget).every(request => request.path.endsWith("/changes/zone")));
    replies.push({ body: changes("demand-26", true) }, { body: changes("demand-27", false) });
    const completedElsewhere = await demand();
    assert.equal((completedElsewhere.result.records as Record<string, unknown>[])[0].title, "Renamed current list");
    assert.equal((await repository.load()).session.catalogueSync?.initialPages, 27); assert.equal((await repository.load()).session.catalogueSync?.lastPassPages, 27);
    replies.push({ body: changes("deadline-pending", true), after: async () => { now += 20_000; } });
    await assert.rejects(demand(), inProgress);
    assert.equal((await repository.load()).session.catalogueSync?.token, "deadline-pending");
    replies.push({ body: changes("deadline-terminal", false), after: async () => { now += 20_000; } });
    const beforeTerminalDeadline = requests.length;
    await assert.rejects(demand(), inProgress);
    assert.equal(requests.length, beforeTerminalDeadline + 1);
    assert.equal(requests.at(-1)!.path.endsWith("/changes/zone"), true);
    assert.equal((await repository.load()).session.catalogueSync?.token, "deadline-terminal");
    assert.equal((await repository.load()).session.catalogueSync?.pending, false);
    replies.push({ body: changes("deadline-terminal", false) });
    const lists = await service().readForMCP(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }));
    assert.equal((lists.result.records as Record<string, unknown>[])[0].title, "Renamed current list");
    assert.equal((requests.at(-1)!.body.zones as Record<string, unknown>[])[0].syncToken, "deadline-terminal");
    const locked = await repository.load(); const lease = await repository.claimRead(locked.fence.generation, locked.fence.version);
    const beforeConflict = requests.length;
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    assert.equal(requests.length, beforeConflict); await repository.releaseResume(lease);
    const lastGood = (await repository.load()).session;
    replies.push({ body: { zones: [{ zoneID: { zoneName: "Reminders" }, serverErrorCode: "CHANGE_TOKEN_EXPIRED" }] } });
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED");
    const paused = (await repository.load()).session;
    assert.deepEqual(paused.catalogueSync, lastGood.catalogueSync); assert.deepEqual(paused.auth, lastGood.auth); assert.deepEqual(paused.savedLists, lastGood.savedLists);
    assert.equal(paused.catalogueAuto?.pausedForError, true);
    const beforePaused = requests.length;
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED"); assert.equal(requests.length, beforePaused);
    assert.equal((await runCatalogueBackground(env)).reason, "paused");
    replies.push({ body: changes("manual-restarted", false) });
    await service().read(ControlledRead.parse({ action: "sync-catalogue", expectedGeneration: setup.generation, restart: true }));
    replies.push({ status: 429, body: {}, headers: { "retry-after": "1800" } });
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED");
    assert.equal((await repository.load()).session.catalogueAuto?.nextCheckAt, now + 1_800_000);
    const beforeThrottle = requests.length;
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && error.code === "RATE_LIMITED"); assert.equal(requests.length, beforeThrottle);
    now += 1_800_000;
    replies.push({ body: changes("manual-restarted", false) }); await demand();
    assert.equal((await repository.load()).session.catalogueAuto?.lastErrorCode, null);
    assert.deepEqual((await repository.load()).session.login, session.login);
    replies.push({ body: changes("never-committed", false), after: async () => { await repository.disconnect(); } });
    await assert.rejects(demand(), (error: unknown) => error instanceof AppError && ["NOT_CONNECTED", "CONFLICT"].includes(error.code));
    assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal((await runCatalogueBackground(env)).reason, "not-ready");
    const nextSetup = await repository.begin((await repository.status()).generation);
    const expiring = { ...appleSession(), connection: session.connection, catalogueSync: { token: "legacy-ready", initialComplete: true, pending: false, pages: 1, seen: [], updatedAt: now } };
    await repository.commit(nextSetup, expiring, "READY");
    assert.equal(catalogueSyncMetadata(expiring.catalogueSync).initialPages, null); assert.equal(catalogueSyncMetadata(expiring.catalogueSync).totalPagesKnown, false);
    now = expiring.login.expiresAt;
    const beforeExpiry = requests.length;
    await assert.rejects(service().readForMCP(ControlledRead.parse({ action: "saved-lists", expectedGeneration: nextSetup.generation })), (error: unknown) => error instanceof AppError && error.code === "AUTH_EXPIRED");
    assert.equal(requests.length, beforeExpiry); assert.equal((await repository.status()).state, "DISCONNECTED");
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});

test("all-open reads cover selectable lists, resume live pages without skips, and fence encrypted continuations", async () => {
  const originalFetch = globalThis.fetch; const originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  const db = new SQLiteD1(); const repository = appleRepo(db);
  const session = appleSession(); session.connection.remindersZoneOwner = "__defaultOwner__";
  session.catalogueSync = { token: "all-open-head", initialComplete: true, pending: false, pages: 1, seen: [], updatedAt: now };
  session.savedLists = mergeSavedLists([], [{ id: "List/A", title: "A" }, { id: "List/B", title: "B" }, { id: "List/C", title: "C" }, { id: "List/DELETED", deleted: true }, { id: "List/GROUP", isGroup: true }], true);
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const changes = { zones: [{ zoneID: { zoneName: "Reminders" }, syncToken: "all-open-head", moreComing: false, records: [] }] };
  const reminder = (id: string, listId: string, extra: Record<string, unknown> = {}) => ({ recordName: `Reminder/${id}`, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId } }, Completed: { type: "INT64", value: 0 }, ...extra } });
  const replies: { status?: number; body: unknown; headers?: Record<string, string>; after?: () => Promise<void> }[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    const next = replies.shift(); assert.ok(next, "Unexpected all-open request"); if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  };
  try {
    replies.push({ body: changes });
    for (let page = 1; page <= 20; page++) replies.push({ body: { records: [reminder(`A-${page}`, "List/A"), ...(page === 1 ? [reminder("COMPLETED", "List/A", { Completed: { type: "INT64", value: 1 } }), reminder("DELETED", "List/A", { Deleted: { type: "INT64", value: 1 } }), { recordName: "Reminder/TOMBSTONE", deleted: true }] : [])], continuationMarker: `A-page-${page}` } });
    const partial = await service().readAllOpenForMCP(setup.generation);
    assert.equal(partial.result.complete, false); assert.equal(partial.result.records.length, 20); assert.equal(partial.result.progress.pagesRead, 20); assert.equal(partial.result.progress.listsTotal, 3); assert.equal(partial.result.progress.listsCompleted, 0);
    assert.deepEqual(partial.result.lists.map(list => list.id), ["List/A", "List/B", "List/C"]);
    const token = partial.result.continuation!; const saved = (await repository.load()).session;
    assert.equal(saved.allOpenScan?.cursor, "A-page-20"); assert.equal(JSON.stringify(saved).includes("Reminder/A-20"), false);
    const encrypted = String(db.sqlite.prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?").get(owner)?.envelope);
    assert.equal(encrypted.includes(token), false); assert.equal(encrypted.includes("A-page-20"), false);
    const requestsBeforeMismatch = requests.length;
    await assert.rejects(service().readAllOpenForMCP(setup.generation - 1, token), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    const other = appleRepo(db, "other-all-open-owner", repository.envelopes); const otherSetup = await other.begin(0); await other.commit(otherSetup, session, "READY");
    await assert.rejects(new AppleConnectionService(env, "other-all-open-owner").readAllOpenForMCP(otherSetup.generation, token), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    assert.equal(requests.length, requestsBeforeMismatch);
    replies.push({ body: { records: [reminder("A-LAST", "List/A")] } }, { body: { records: [reminder("B", "List/B")] } }, { body: { records: [reminder("C-FIRST", "List/C")], continuationMarker: "C-page-1" } }, { body: { records: [reminder("C-LAST", "List/C")] } });
    const resumed = await service().readAllOpenForMCP(setup.generation, token);
    assert.equal(resumed.result.complete, true); assert.equal(resumed.result.continuation, null); assert.equal(resumed.result.records.length, 4); assert.equal(resumed.result.progress.listsCompleted, 3);
    assert.equal(requests[requestsBeforeMismatch].body.continuationMarker, "A-page-20"); assert.equal((await repository.load()).session.allOpenScan, undefined);
    assert.ok(requests.slice(requestsBeforeMismatch).every(request => request.path.endsWith("/records/query")));
    for (const request of requests.filter(request => request.path.endsWith("/records/query"))) {
      const query = request.body.query as { filterBy: { fieldName: string; fieldValue: { value: number } }[] };
      assert.equal(query.filterBy.find(filter => filter.fieldName === "includeCompleted")?.fieldValue.value, 0);
    }
    await assert.rejects(service().readAllOpenForMCP(setup.generation, token), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    // A page that does not fit must be fetched again from the same cursor.
    const largeText = "x".repeat(64_000); const document = encodeDocument(largeText);
    const largePage = (prefix: string) => Array.from({ length: 6 }, (_, index) => reminder(`${prefix}-${index}`, "List/A", { TitleDocument: { type: "ENCRYPTED_BYTES", value: document }, NotesDocument: { type: "ENCRYPTED_BYTES", value: document } }));
    replies.push({ body: changes }, { body: { records: largePage("LARGE-FIRST"), continuationMarker: "large-next" } }, { body: { records: largePage("LARGE-NEXT") } });
    const byteLimited = await service().readAllOpenForMCP(setup.generation);
    assert.equal(byteLimited.result.complete, false); assert.equal(byteLimited.result.pendingReason, "response-limit"); assert.equal(byteLimited.result.records.length, 6);
    assert.ok(new TextEncoder().encode(JSON.stringify(byteLimited)).length <= 1_048_576);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, "large-next");
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 1);
    replies.push({ body: { records: largePage("LARGE-NEXT") } }, { body: { records: [reminder("BYTE-B", "List/B")] } }, { body: { records: [reminder("BYTE-C", "List/C")] } });
    const byteResumed = await service().readAllOpenForMCP(setup.generation, byteLimited.result.continuation);
    assert.equal(byteResumed.result.complete, true); assert.equal(byteResumed.result.records.length, 8);
    assert.equal(requests.at(-3)!.body.continuationMarker, "large-next");
    // Recoverable failures expose the current token without losing records or
    // acknowledging the failed page, including a failed first resume query.
    replies.push({ body: changes }, { body: { records: [reminder("TRANSIENT-FIRST", "List/A")], continuationMarker: "transient-next" } }, { status: 503, body: {} });
    const transient = await service().readAllOpenForMCP(setup.generation);
    assert.equal(transient.result.complete, false); assert.equal(transient.result.records.length, 1); assert.equal(transient.result.pendingReason, "read_error");
    assert.deepEqual(transient.result.errors, [{ code: "UPSTREAM_UNAVAILABLE", retryable: true }]);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, "transient-next");
    replies.push({ status: 503, body: {} });
    const failedResume = await service().readAllOpenForMCP(setup.generation, transient.result.continuation);
    assert.equal(failedResume.result.complete, false); assert.equal(failedResume.result.records.length, 0); assert.equal(failedResume.result.errors[0].code, "UPSTREAM_UNAVAILABLE");
    assert.notEqual(failedResume.result.continuation, transient.result.continuation);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, "transient-next");
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 1);
    await assert.rejects(service().readAllOpenForMCP(setup.generation, transient.result.continuation), (error: unknown) => error instanceof AppError && error.code === "CONFLICT");
    replies.push({ body: { records: [reminder("TRANSIENT-LAST", "List/A")] } }, { body: { records: [reminder("TRANSIENT-B", "List/B")] } }, { body: { records: [reminder("TRANSIENT-C", "List/C")] } });
    const recovered = await service().readAllOpenForMCP(setup.generation, failedResume.result.continuation);
    assert.equal(recovered.result.complete, true); assert.equal(recovered.result.records.length, 3);
    assert.equal(requests.at(-3)!.body.continuationMarker, "transient-next");
    replies.push({ body: changes }, { body: { records: [reminder("SAFE-ON-ERRORED-PAGE", "List/A"), { recordName: "Reminder/ERRORED", serverErrorCode: "CONFLICT" }], continuationMarker: "unacknowledged-marker" } });
    const recordFailure = await service().readAllOpenForMCP(setup.generation);
    assert.equal(recordFailure.result.complete, false); assert.equal(recordFailure.result.pendingReason, "record_errors"); assert.equal(recordFailure.result.records.length, 0);
    assert.deepEqual(recordFailure.result.recordErrors, [{ id: "Reminder/ERRORED", code: "CONFLICT" }]);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, null); assert.equal((await repository.load()).session.allOpenScan?.totalPages, 0);
    replies.push({ body: { records: [reminder("SAFE-ON-ERRORED-PAGE", "List/A")] } }, { body: { records: [] } }, { body: { records: [] } });
    const recordRecovered = await service().readAllOpenForMCP(setup.generation, recordFailure.result.continuation);
    assert.equal(recordRecovered.result.complete, true); assert.equal(recordRecovered.result.records.length, 1);
    replies.push({ body: changes }, { status: 429, body: {}, headers: { "retry-after": "30" } });
    const throttled = await service().readAllOpenForMCP(setup.generation);
    assert.equal(throttled.result.complete, false); assert.equal(throttled.result.records.length, 0);
    assert.deepEqual(throttled.result.errors, [{ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 30 }]);
    now += 30_000;
    replies.push({ body: { records: [reminder("RATE-RECOVERED", "List/A")] } }, { body: { records: [] } }, { body: { records: [] } });
    assert.equal((await service().readAllOpenForMCP(setup.generation, throttled.result.continuation)).result.complete, true);
    // Expiry discards progress rather than reusing an old list/query snapshot.
    replies.push({ body: changes }, { body: { records: [reminder("EXPIRING", "List/A")], continuationMarker: "expiry-next" }, after: async () => { now += 20_000; } });
    const expiring = await service().readAllOpenForMCP(setup.generation); assert.equal(expiring.result.complete, false);
    now += 600_000; const beforeExpiry = requests.length;
    await assert.rejects(service().readAllOpenForMCP(setup.generation, expiring.result.continuation), (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED");
    assert.equal(requests.length, beforeExpiry); assert.equal((await repository.load()).session.allOpenScan, undefined);
    replies.push({ body: changes }, { status: 401, body: {} });
    await assert.rejects(service().readAllOpenForMCP(setup.generation), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED");
    assert.equal((await repository.status()).state, "DISCONNECTED");
    const nextSetup = await repository.begin((await repository.status()).generation); await repository.commit(nextSetup, { ...session, login: loginAssurance() }, "READY");
    assert.equal((await repository.load()).session.allOpenScan, undefined);
    replies.push({ body: changes }, { body: { records: [reminder("LATE", "List/A")] }, after: async () => { await repository.disconnect(); } });
    await assert.rejects(service().readAllOpenForMCP(nextSetup.generation), (error: unknown) => error instanceof AppError && ["NOT_CONNECTED", "CONFLICT"].includes(error.code));
    assert.equal((await repository.status()).state, "DISCONNECTED");
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});

test("direct list snapshots replace only after complete discovery and stay isolated from legacy history", async () => {
  const originalFetch = globalThis.fetch;
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.savedLists = mergeSavedLists([], [{ id: "List/OLD", title: "Previous snapshot" }], true);
  session.catalogueSync = { token: "expired-history", initialComplete: false, pending: true, pages: 4, seen: [], updatedAt: Date.now() };
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), REMINDERS_LIST_DISCOVERY: "direct", CATALOGUE_BACKGROUND_RUNNER: "local" as const, REMINDERS_OWNER_ID: owner, ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const zoneID = { zoneName: "Reminders", ownerRecordName: "synthetic-direct-owner" };
  const list = (id: string, title: string, extra = {}) => ({ recordName: id, recordType: "List", zoneID, fields: { Name: { type: "STRING", value: title }, Count: { type: "INT64", value: 0 }, ...extra } });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const replies: { body: unknown; status?: number; after?: () => Promise<void> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    const next = replies.shift(); assert.ok(next, "Unexpected direct discovery request");
    if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  try {
    assert.equal((await runCatalogueBackground(env)).reason, "direct-discovery");
    replies.push({ body: { zones: [{ zoneID }] } }, { body: { records: [list("List/EMPTY", "Empty list"), list("List/GROUP", "Group", { IsGroup: { type: "INT64", value: 1 } })], continuationMarker: "direct-next" } }, { body: { records: [{ ...list("List/DELETED", "Removed", { Deleted: { type: "INT64", value: 1 } }), deleted: false }, list("List/NEW", "Current name")] } });
    const first = await service().getCurrentLists(setup.generation);
    assert.equal(first.result.complete, true); assert.equal(first.result.source, "direct-cloudkit-query"); assert.equal(first.result.freshness.mode, "live");
    assert.equal(first.result.records.find(item => item.id === "List/DELETED")?.deleted, true); assert.equal(first.result.records.length, 4); assert.equal(first.result.records[0].count, 0);
    const snapshot = (await repository.load()).session;
    assert.equal(snapshot.savedLists?.some(item => item.id === "List/OLD"), false);
    assert.equal(snapshot.legacySavedLists?.[0].id, "List/OLD"); assert.deepEqual(snapshot.catalogueSync, session.catalogueSync);
    assert.ok(requests.every(request => !request.path.endsWith("/changes/zone")));
    const count = requests.length;
    await service().read(ControlledRead.parse({ action: "saved-lists", expectedGeneration: setup.generation }));
    assert.equal(requests.length, count, "Dashboard polling must be display-only");
    // Record failures and HTTP errors never erase the last complete snapshot.
    for (const reply of [{ body: { records: [{ recordName: "List/NEW", serverErrorCode: "BAD_REQUEST" }] } }, { body: {}, status: 503 }, { body: {}, status: 403 }]) {
      replies.push(reply); await assert.rejects(service().getCurrentLists(setup.generation), AppError);
      assert.deepEqual((await repository.load()).session.savedLists, snapshot.savedLists);
    }
    // A diagnostic legacy scan writes only its separate recovery collection.
    replies.push({ body: { zones: [{ zoneID, syncToken: "legacy-next", moreComing: false, records: [list("List/OLD", "Historical candidate")] }] } }, { body: { records: [list("List/OLD", "Current legacy name")] } });
    await service().read(ControlledRead.parse({ action: "sync-catalogue", expectedGeneration: setup.generation }));
    assert.deepEqual((await repository.load()).session.savedLists, snapshot.savedLists);
    assert.equal((await repository.load()).session.legacySavedLists?.[0].title, "Current legacy name");
    // Refresh reflects renames/removals and a genuinely empty collection.
    replies.push({ body: { records: [list("List/NEW", "Renamed")] } }); await service().getCurrentLists(setup.generation);
    assert.deepEqual((await repository.load()).session.savedLists?.map(item => item.title), ["Renamed"]);
    replies.push({ body: { records: [] } }); assert.equal((await service().getCurrentLists(setup.generation)).result.records.length, 0);
    assert.deepEqual((await repository.load()).session.savedLists, []);
    // A failed encrypted commit cannot publish new summaries or corrupt saved ones.
    const encrypt = Envelopes.prototype.encrypt;
    replies.push({ body: { records: [list("List/NEW", "Must not be saved")] } });
    Envelopes.prototype.encrypt = async () => { throw new Error("synthetic encryption failure"); };
    try { await assert.rejects(service().getCurrentLists(setup.generation)); }
    finally { Envelopes.prototype.encrypt = encrypt; }
    assert.deepEqual((await repository.load()).session.savedLists, []);
    replies.push({ body: { records: [list("List/NEW", "Never committed")] }, after: async () => { await repository.disconnect(); } });
    await assert.rejects(service().getCurrentLists(setup.generation), (e: unknown) => e instanceof AppError && ["NOT_CONNECTED", "CONFLICT"].includes(e.code));
    assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal(replies.length, 0);
  } finally { globalThis.fetch = originalFetch; db.sqlite.close(); }
});

test("known-list reads authorize live without any historical checkpoint and fence failures", async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const input = (includeCompleted = false, continuation: string | null = null) => ControlledRead.parse({ action: "reminders", expectedGeneration: setup.generation, listId: "List/KNOWN", includeCompleted, continuation });
  const zoneID = { zoneName: "Reminders", ownerRecordName: "synthetic-known-owner" };
  const list = { recordName: "List/KNOWN", recordType: "List", zoneID, fields: { Name: { type: "STRING", value: "Current authorized list" } } };
  const reminder = (id: string, completed: number, listId = "List/KNOWN") => ({ recordName: id, recordType: "Reminder", zoneID, fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE", zoneID } }, Completed: { type: "INT64", value: completed } } });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const replies: { body: unknown; status?: number; headers?: Record<string, string>; after?: () => Promise<void> }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift(); assert.ok(reply, "Unexpected known-list request");
    if (reply.after) await reply.after();
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  try {
    replies.push({ body: { zones: [{ zoneID }] } }, { body: { records: [list] } }, { body: { records: [reminder("Reminder/OPEN", 0), reminder("Reminder/CLOSED", 1), { recordName: "Alarm/A", recordType: "Alarm", zoneID, fields: {} }], continuationMarker: "known-next" } });
    const first = await service().readForMCP(input());
    assert.deepEqual((first.result.records as { id: string }[]).map(item => item.id), ["Reminder/OPEN"]); assert.equal(first.result.continuation, "known-next");
    assert.equal((await repository.load()).session.catalogueSync, undefined);
    const saved = await repository.load(), lease = await repository.claimRead(saved.fence.generation, saved.fence.version);
    await repository.commitResume(lease, { ...saved.session, catalogueSync: { token: "expired-checkpoint", initialComplete: false, pending: true, pages: 5, seen: [], updatedAt: Date.now() }, catalogueAuto: { policy: "initial-and-hourly", enabled: true, nextCheckAt: null, lastCheckAt: null, lastSuccessAt: null, lastErrorCode: "RESTART_REQUIRED", pausedForError: true, failures: 1, runId: null, runUntil: 0 } }, "READY");
    replies.push({ body: { records: [list] } }, { body: { records: [reminder("Reminder/CLOSED", 1)] } });
    const second = await service().readForMCP(input(true, "known-next"));
    assert.equal((second.result.records as { completed: boolean }[])[0].completed, true);
    assert.equal(requests.at(-1)!.body.continuationMarker, "known-next");
    assert.ok(requests.every(request => !request.path.endsWith("/changes/zone")));
    for (const invalid of ["List/A/B", "List/ bad", "List/a\n", "Reminder/A"]) assert.equal(ControlledRead.safeParse({ ...input(), listId: invalid }).success, false);
    for (const bad of [{ ...list, deleted: true }, { ...list, fields: { IsGroup: { type: "INT64", value: 1 } } }, { recordName: list.recordName, serverErrorCode: "NOT_FOUND" }, { ...list, zoneID: { ...zoneID, ownerRecordName: "other-owner" } }]) {
      const before = requests.length; replies.push({ body: { records: [bad] } });
      await assert.rejects(service().readForMCP(input()), AppError); assert.equal(requests.length, before + 1);
    }
    for (const reply of [{ status: 403, body: {} }, { status: 429, headers: { "retry-after": "9" }, body: {} }, { status: 503, body: {} }, { body: { records: [{}] } }]) {
      replies.push(reply); await assert.rejects(service().readForMCP(input()), AppError);
    }
    replies.push({ body: { records: [list] } }, { body: { records: [reminder("Reminder/OTHER", 0, "List/OTHER")] } });
    await assert.rejects(service().readForMCP(input()), (e: unknown) => e instanceof AppError && e.code === "PROTOCOL_CHANGED");
    replies.push({ body: { records: [list] } }, { body: { records: [] }, after: async () => { Date.now = () => session.login.expiresAt; } });
    await assert.rejects(service().readForMCP(input()), (e: unknown) => e instanceof AppError && e.code === "AUTH_EXPIRED"); Date.now = originalNow;
    assert.equal((await repository.status()).state, "DISCONNECTED"); assert.equal(replies.length, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});

test("direct all-open resumes its original list selection without rediscovery after a refresh", async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = originalNow(); Date.now = () => now;
  const db = new SQLiteD1(), repository = appleRepo(db), session = appleSession();
  session.connection.remindersZoneOwner = "__defaultOwner__";
  const setup = await repository.begin(0); await repository.commit(setup, session, "READY");
  const env = { ...db.env(), REMINDERS_LIST_DISCOVERY: "direct", ENCRYPTION_KEY_ID: repository.envelopes.active, ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys), LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2" };
  const service = () => new AppleConnectionService(env, owner);
  const list = (id: string, extra = {}) => ({ recordName: id, recordType: "List", fields: { Name: { type: "STRING", value: id.slice(5) }, ...extra } });
  const reminder = (id: string, listId: string) => ({ recordName: id, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } }, Completed: { type: "INT64", value: 0 } } });
  const requests: Record<string, unknown>[] = [];
  const replies: { body: unknown; after?: () => void }[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); const next = replies.shift(); assert.ok(next, "Unexpected direct all-open request"); next.after?.();
    return new Response(JSON.stringify(next.body));
  };
  try {
    replies.push({ body: { records: [list("List/A"), list("List/EMPTY"), list("List/GROUP", { IsGroup: { type: "INT64", value: 1 } }), list("List/DELETED", { Deleted: { type: "INT64", value: 1 } })] } }, { body: { records: [reminder("Reminder/A1", "List/A")], continuationMarker: "a-next" }, after: () => { now += 20_000; } });
    const first = await service().readAllOpenForMCP(setup.generation);
    assert.equal(first.result.complete, false); assert.equal(first.result.pendingReason, "deadline"); assert.equal(first.result.progress.listsTotal, 2);
    assert.equal(first.result.source, "direct-cloudkit-query"); assert.deepEqual(first.result.records.map(item => item.id), ["Reminder/A1"]);
    const token = first.result.continuation!;
    // Another complete retrieval removes A from the dashboard snapshot, but
    // cannot skip its outstanding all-open page or change this operation's lists.
    replies.push({ body: { records: [list("List/NEW")] } }); await service().getCurrentLists(setup.generation);
    assert.equal((await repository.load()).session.savedLists?.[0].id, "List/NEW");
    const beforeResume = requests.length;
    replies.push({ body: { records: [reminder("Reminder/A2", "List/A")] } }, { body: { records: [] } });
    const resumed = await service().readAllOpenForMCP(setup.generation, token);
    assert.equal(resumed.result.complete, true); assert.deepEqual(resumed.result.records.map(item => item.id), ["Reminder/A2"]);
    assert.deepEqual(resumed.result.lists.map(item => item.id), ["List/A", "List/EMPTY"]);
    assert.equal(requests[beforeResume].continuationMarker, "a-next");
    assert.ok(requests.slice(beforeResume).every(body => (body.query as { recordType: string }).recordType === "reminderList"));
    const beforeReplay = requests.length;
    await assert.rejects(service().readAllOpenForMCP(setup.generation, token), (e: unknown) => e instanceof AppError && e.code === "CONFLICT"); assert.equal(requests.length, beforeReplay);
    // Switching to legacy uses its recovery collection, never the direct snapshot.
    const current = await repository.load(), fence = await repository.claimRead(current.fence.generation, current.fence.version);
    await repository.commitResume(fence, { ...current.session, legacySavedLists: mergeSavedLists([], [{ id: "List/LEGACY", title: "Legacy" }], true), catalogueSync: { token: "legacy-head", pending: false, initialComplete: true, pages: 1, seen: [], updatedAt: now } }, "READY");
    replies.push({ body: { zones: [{ zoneID: { zoneName: "Reminders" }, records: [], moreComing: false, syncToken: "legacy-head" }] } }, { body: { records: [reminder("Reminder/LEGACY", "List/LEGACY")] } });
    const legacy = await new AppleConnectionService({ ...env, REMINDERS_LIST_DISCOVERY: "legacy" }, owner).readAllOpenForMCP(setup.generation);
    assert.equal(legacy.result.complete, true); assert.deepEqual(legacy.result.records.map(item => item.id), ["Reminder/LEGACY"]);
    replies.push({ body: { records: [list("List/A")] } }, { body: { records: [], continuationMarker: "other-next" }, after: () => { now += 20_000; } });
    const pending = await service().readAllOpenForMCP(setup.generation);
    await repository.disconnect(); const nextSetup = await repository.begin((await repository.status()).generation); await repository.commit(nextSetup, appleSession(), "READY");
    await assert.rejects(service().readAllOpenForMCP(nextSetup.generation, pending.result.continuation), (e: unknown) => e instanceof AppError && e.code === "CONFLICT");
    assert.equal((await repository.load()).session.allOpenScan, undefined); assert.equal(replies.length, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.sqlite.close(); }
});
