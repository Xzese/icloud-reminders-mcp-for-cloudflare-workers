import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";

export async function verifySessionRetention(options) {
  const owner = options.bindings.REMINDERS_OWNER_ID, origin = options.bindings.APP_ORIGIN;
  const envelopes = new Envelopes(options.bindings.ENCRYPTION_KEY_ID, JSON.parse(options.bindings.ENCRYPTION_KEYS_JSON));
  const context = { ownerId: owner, accountId: "apple-reminders", generation: 7, recordId: "apple-session", schemaVersion: 1 };
  const verifiedAt = Date.now() - 2 * 86_400_000;
  const original = {
    login: loginAssurance(verifiedAt, false),
    auth: { clientId: "synthetic-retention-client",
      headers: { "X-Apple-Session-Token": "synthetic-retention-token", "X-Apple-TwoSV-Trust-Token": "synthetic-retention-trust" },
      cookies: [{ name: "X-APPLE-WEBAUTH-TOKEN", value: "synthetic-retention-cookie", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }] },
    connection: { dsid: "987654321", clientId: "synthetic-retention-client", clientBuildNumber: "2534Project66", clientMasteringNumber: "2534B22", cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private", remindersZoneOwner: "__defaultOwner__" },
    pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: verifiedAt + 600_000, nextAttemptAt: 0 },
    savedLists: [{ id: "List/SYNTHETIC", title: "Synthetic saved list", deleted: false, isGroup: false, checkedAt: verifiedAt }],
    directListSnapshot: { updatedAt: verifiedAt },
  };
  let appleRequests = 0, exchanges = 0, validations = 0, rateLimit = false;
  const outboundService = async request => {
    appleRequests++;
    const url = new URL(request.url);
    const body = await request.json();
    if (url.pathname.endsWith("/validate")) {
      validations++; assert.equal(body, null);
      return new Response("{}", { status: rateLimit ? 429 : 401, headers: rateLimit ? { "retry-after": "7200" } : {} });
    }
    if (url.pathname.endsWith("/accountLogin")) {
      exchanges++; assert.equal(body.dsWebAuthToken, "synthetic-retention-token"); assert.equal(body.trustToken, "synthetic-retention-trust");
      return new Response(JSON.stringify({ hsaTrustedBrowser: true, hsaChallengeRequired: false, dsInfo: { dsid: "987654321" },
        webservices: { ckdatabasews: { url: "https://p42-ckdatabasews.icloud.com" } } }), {
        headers: { "X-Apple-Session-Token": "synthetic-renewed-token", "set-cookie": "X-APPLE-WEBAUTH-TOKEN=synthetic-renewed-cookie; Domain=icloud.com; Path=/; Secure; Max-Age=86400" },
      });
    }
    assert.equal(url.hostname, "p42-ckdatabasews.icloud.com", "The requested read must use renewed service information.");
    assert.ok(url.pathname.endsWith("/records/query"));
    return new Response('{"records":[]}');
  };
  const compatibleOptions = {
    ...options, name: "session-retention-acceptance", d1Databases: { DB: "synthetic-session-retention" }, outboundService,
    bindings: { ...options.bindings, LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2", APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
      APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify({ migrationId: "synthetic-approved-migration", owner, account: "apple-reminders", generation: 7 }) },
  };
  let worker = new Miniflare(compatibleOptions);
  const request = (path, { user = owner, body } = {}) => worker.dispatchFetch(origin + path, {
    headers: { ...(user ? { "oai-authenticated-user-id": user } : {}), ...(body ? { origin, "content-type": "application/json", accept: "application/json, text/event-stream" } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  try {
    let db = await worker.getD1Database("DB");
    await db.prepare(await readFile(new URL("../../schema.sql", import.meta.url), "utf8")).run();
    const encrypted = JSON.stringify(await envelopes.encrypt(original, context));
    await db.prepare("INSERT INTO apple_session_state VALUES (?, 'apple-reminders', 7, 3, 'READY', NULL, 0, ?, NULL, NULL, NULL, NULL, ?)").bind(owner, encrypted, verifiedAt).run();
    assert.equal((await request("/api/connection", { user: null })).status, 401);
    assert.equal((await request("/api/connection", { user: "wrong-owner" })).status, 403);
    assert.equal((await db.prepare("SELECT version FROM apple_session_state").first()).version, 3);
    const status = await (await request("/api/connection")).json();
    assert.equal(status.state, "READY"); assert.equal(status.generation, 7); assert.equal(status.version, 4);
    assert.equal(status.retentionDays, 30); assert.equal(status.retentionSource, "owner-authorised-migration");
    assert.equal(status.expiresAt, verifiedAt + 2_592_000_000); assert.equal(appleRequests, 0);
    const committed = await db.prepare("SELECT * FROM apple_session_state").first();
    const migrated = await envelopes.decrypt(JSON.parse(committed.envelope), context);
    const { login, ...rest } = migrated, { login: legacyLogin, ...previous } = original;
    assert.deepEqual(rest, previous); assert.equal(login.verifiedAt, legacyLogin.verifiedAt);
    assert.equal(login.previousExpiresAt, legacyLogin.expiresAt);
    assert.notEqual(committed.envelope, encrypted);
    assert.equal((await (await request("/api/connection")).json()).version, 4);
    assert.equal(appleRequests, 0);
    // Remove the one-time setting, retain compatible readers, and only now
    // enable renewal. A cold start uses the same disposable D1 namespace.
    await worker.dispose();
    const { APPLE_SESSION_RETENTION_MIGRATION_JSON: unused, ...bindings } = compatibleOptions.bindings;
    void unused;
    worker = new Miniflare({ ...compatibleOptions, bindings: { ...bindings, APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1", APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1" } });
    db = await worker.getD1Database("DB");
    const restarted = await (await request("/api/connection")).json();
    assert.equal(restarted.expiresAt, status.expiresAt); assert.equal(restarted.generation, 7); assert.equal(appleRequests, 0);
    const read = await request("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_reminder_lists", arguments: { expectedGeneration: 7 } } } });
    const result = await read.json(); assert.equal(result.result.isError, undefined, JSON.stringify(result));
    assert.equal(result.result.structuredContent.complete, true);
    assert.equal(validations, 1); assert.equal(exchanges, 1);
    const renewed = await envelopes.decrypt(JSON.parse((await db.prepare("SELECT envelope FROM apple_session_state").first()).envelope), context);
    assert.deepEqual(renewed.login, migrated.login);
    assert.equal(renewed.auth.headers["X-Apple-Session-Token"], "synthetic-renewed-token");
    assert.ok(renewed.renewal.lastValidatedAt); assert.ok(renewed.renewal.lastAppleSuccessAt); assert.ok(renewed.renewal.lastRenewedAt);
    const mcpStatus = await (await request("/mcp", { body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "connection_status", arguments: {} } } })).json();
    assert.equal(mcpStatus.result.isError, undefined);
    for (const secret of ["synthetic-renewed-token", "synthetic-retention-trust", "987654321", "synthetic-retention-client"]) assert.equal(JSON.stringify(mcpStatus).includes(secret), false);
    // Request-driven failure metadata persists across a cold start and honours
    // Apple's longer Retry-After rather than our bounded engineering backoff.
    rateLimit = true;
    const failedSnapshot = { ...renewed, renewal: { ...renewed.renewal, lastValidatedAt: null, lastAppleSuccessAt: null, lastErrorCode: "UPSTREAM_UNAVAILABLE" } };
    await db.prepare("UPDATE apple_session_state SET version = version + 1, envelope = ?").bind(JSON.stringify(await envelopes.encrypt(failedSnapshot, context))).run();
    const limited = await request("/api/apple/read", { body: { action: "current-lists", expectedGeneration: 7 } });
    assert.equal(limited.status, 429);
    const limitedStatus = await (await request("/api/connection")).json();
    assert.equal(limitedStatus.state, "READY"); assert.equal(limitedStatus.requiredAction, "retry");
    assert.ok(limitedStatus.nextRetryAt >= Date.now() + 7_190_000);
    const requestsBeforeRestart = appleRequests;
    await worker.dispose();
    worker = new Miniflare({ ...compatibleOptions, bindings: { ...bindings, APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1" } });
    assert.equal((await request("/api/apple/read", { body: { action: "current-lists", expectedGeneration: 7 } })).status, 429);
    assert.equal(appleRequests, requestsBeforeRestart);
    assert.equal((await (await request("/api/connection")).json()).expiresAt, status.expiresAt);
    return { checks: ["retained-legacy-owner-migration-before-expiry-cleanup", "migration-zero-Apple-requests",
      "30-day-absolute-deadline-and-credential-preservation", "compatible-cold-start-without-migration-setting",
      "saved-token-renewal-rebuilds-service", "renewal-does-not-slide-retention", "persisted-Retry-After-cold-start", "safe-retention-MCP-output"] };
  } finally { await worker.dispose(); }
}
