// Synthetic create/edit acceptance journeys against the production Worker bundle.
// Every outbound request is intercepted here; no Apple account or network is used.
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Envelopes } from "../../src/crypto/envelopes.ts";
import { loginAssurance } from "../../src/auth/apple/policy.ts";
import { encodeDocument } from "../../src/reminders/crdt.ts";
import { runControlledWriteChecks } from "../../scripts/dev/validate-local-reminder-writes.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const listId = "List/WRITE-ACCEPTANCE";
const zoneOwner = "synthetic-private-owner";
const reminderId = "Reminder/WRITE-EXISTING";
const opaqueMetadata = "synthetic-private-apple-field";

const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

function field(type, value) { return { type, value }; }

function listRecord() {
  return {
    recordName: listId, recordType: "List", recordChangeTag: "list-tag-1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner },
    fields: { Name: field("STRING", "Synthetic acceptance list"), Deleted: field("INT64", 0), IsGroup: field("INT64", 0) },
  };
}

function reminderRecord(id, { recurrence = false, alarm = false } = {}) {
  const fields = {
    TitleDocument: field("STRING", encodeDocument(`Existing ${id}`)),
    NotesDocument: field("STRING", encodeDocument("Preserve these notes 📝")),
    List: field("REFERENCE", { recordName: listId, action: "VALIDATE", zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner } }),
    Completed: field("INT64", 0), CompletionDate: field("TIMESTAMP", null), Deleted: field("INT64", 0),
    Flagged: field("INT64", 1), Priority: field("INT64", 5), AllDay: field("INT64", 0),
    DueDate: field("TIMESTAMP", Date.parse("2030-03-04T09:15:00.000Z")),
    TimeZone: field("STRING", "Europe/London"),
    CreationDate: field("TIMESTAMP", Date.parse("2029-01-01T00:00:00.000Z")),
    LastModifiedDate: field("TIMESTAMP", Date.parse("2029-01-02T00:00:00.000Z")),
    ResolutionTokenMap: field("STRING", JSON.stringify({ map: {} })),
    ApplePrivateMetadata: field("STRING", opaqueMetadata),
  };
  if (recurrence) fields.RecurrenceRuleIDs = field("STRING_LIST", ["RecurrenceRule/WRITE-RECURRING"]);
  if (alarm) fields.AlarmIDs = field("STRING_LIST", ["Alarm/WRITE-ALARMED"]);
  return {
    recordName: id, recordType: "Reminder", recordChangeTag: `tag-${id}`,
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner }, fields,
  };
}

function sessionFixture(expired = false) {
  const now = Date.now();
  return {
    login: loginAssurance(expired ? now - 86_400_001 : now),
    auth: {
      clientId: "synthetic-client",
      headers: { "X-Apple-Session-Token": "synthetic-apple-token" },
      cookies: [{ name: "synthetic-session", value: "restore-me", domain: "icloud.com", hostOnly: false, path: "/", secure: true, expiresAt: null }],
    },
    connection: {
      dsid: "123456789", clientId: "synthetic-client", clientBuildNumber: "2534Project66",
      clientMasteringNumber: "2534B22",
      cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
      remindersZoneOwner: zoneOwner,
    },
    pcs: { consentRequested: true, pcsAttempts: 1, consentChecks: 1, expiresAt: now + 300_000, nextAttemptAt: 0 },
  };
}

function requestHeaders(user, requestOrigin, method) {
  const headers = { ...(user ? { "oai-authenticated-user-id": user, "oai-authenticated-user-email": "synthetic@example.invalid" } : {}) };
  if (method === "POST") Object.assign(headers, { "content-type": "application/json", origin: requestOrigin, accept: "application/json, text/event-stream" });
  return headers;
}

export async function verifyReminderWrites(options) {
  assert.ok(Array.isArray(options.modules) && options.modules.length > 0, "Pass the exact built Worker modules from worker.mjs.");
  assert.ok(options.d1Persist, "Pass the disposable D1 persistence directory from worker.mjs.");
  const owner = options.bindings.REMINDERS_OWNER_ID;
  const origin = options.bindings.APP_ORIGIN;
  assert.ok(owner && origin, "Pass the authenticated owner and private Site origin from worker.mjs.");
  const schema = await readFile(join(root, "schema.sql"), "utf8");
  const secret = options.bindings.ENCRYPTION_KEYS_JSON;
  const keyRing = JSON.parse(secret);
  const keyId = options.bindings.ENCRYPTION_KEY_ID;

  const makeWorker = async ({ writes = true } = {}) => {
    const state = {
      records: new Map([[listId, listRecord()], [reminderId, reminderRecord(reminderId)],
        ["Reminder/WRITE-RECURRING", reminderRecord("Reminder/WRITE-RECURRING", { recurrence: true })],
        ["Reminder/WRITE-ALARMED", reminderRecord("Reminder/WRITE-ALARMED", { alarm: true })]]),
      requests: [], modifies: [], nextModify: null, holdLookup: null, holdModify: null,
    };
    const bindings = {
      ...options.bindings,
      LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
      APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
      ...(writes ? { LIVE_APPLE_WRITES_APPROVED: "controlled-create-edit-v1" } : {}),
    };
    if (!writes) delete bindings.LIVE_APPLE_WRITES_APPROVED;
    const outboundService = async request => {
      const url = new URL(request.url);
      state.requests.push({ method: request.method, path: url.pathname });
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      if (url.pathname.endsWith("/changes/zone")) {
        return jsonResponse({ zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: zoneOwner }, records: [listRecord()], syncToken: "synthetic-write-test-head", moreComing: false }] });
      }
      if (url.pathname.endsWith("/records/query")) {
        assert.equal(body.query.recordType, "reminderList");
        assert.equal(body.query.filterBy.find(filter => filter.fieldName === "List").fieldValue.value.recordName, listId);
        return jsonResponse({ records: [...state.records.values()].filter(record => record.recordType === "Reminder" && record.fields.List.value.recordName === listId && record.fields.Completed.value === 0) });
      }
      if (url.pathname.endsWith("/records/lookup")) {
        if (state.holdLookup) {
          const held = state.holdLookup;
          state.holdLookup = null;
          held.reached();
          await held.releasePromise;
        }
        const records = body.records.map(({ recordName }) => state.records.get(recordName) ?? { recordName, serverErrorCode: "NOT_FOUND" });
        return jsonResponse({ records });
      }
      if (url.pathname.endsWith("/records/modify")) {
        const operation = body.operations[0];
        assert.equal(body.operations.length, 1, "Each controlled action sends one exact reminder write.");
        assert.equal(operation.record.recordType, "Reminder");
        state.modifies.push({ operationType: operation.operationType, recordName: operation.record.recordName, fields: Object.keys(operation.record.fields).sort() });
        const action = state.nextModify;
        state.nextModify = null;
        if (action === "redirect-307") return new Response(null, { status: 307, headers: { location: request.url } });
        if (action === "record-conflict") return jsonResponse({ records: [{ recordName: operation.record.recordName, serverErrorCode: "CONFLICT" }] });

        const current = state.records.get(operation.record.recordName);
        const next = operation.operationType === "create"
          ? { ...operation.record, zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: zoneOwner }, recordChangeTag: `tag-created-${state.modifies.length}` }
          : { ...current, fields: { ...current.fields, ...operation.record.fields }, recordChangeTag: `tag-updated-${state.modifies.length}` };
        delete next.parent;
        state.records.set(next.recordName, next);
        if (state.holdModify) {
          const held = state.holdModify;
          state.holdModify = null;
          held.reached();
          await held.releasePromise;
        }
        if (action === "committed-500") return jsonResponse({ serverErrorCode: "SERVICE_UNAVAILABLE" }, 500);
        if (action === "committed-network-drop") throw new Error("Synthetic response lost after commit.");
        return jsonResponse({ records: [next] });
      }
      return jsonResponse({ serverErrorCode: "UNEXPECTED_SYNTHETIC_REQUEST" }, 500);
    };
    const worker = new Miniflare({
      ...options,
      name: `reminder-write-acceptance-${randomUUID()}`,
      d1Databases: { ...options.d1Databases, DB: `reminder-write-acceptance-${randomUUID()}` },
      bindings,
      outboundService,
    });
    const db = await worker.getD1Database("DB");
    await db.prepare(schema).run();
    const request = async (path, { user = owner, method = "GET", body, requestOrigin = origin, host = origin } = {}) => {
      const headers = requestHeaders(user, requestOrigin, method);
      return worker.dispatchFetch(host + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const seedReady = async (expired = false) => {
      await db.prepare("INSERT OR IGNORE INTO apple_session_state (owner_id, account_id) VALUES (?, ?)").bind(owner, "apple-reminders").run();
      const statusResponse = await request("/api/connection");
      assert.equal(statusResponse.status, 200);
      const { generation } = await statusResponse.json();
      const envelope = await new Envelopes(keyId, keyRing).encrypt(sessionFixture(expired), {
        ownerId: owner, accountId: "apple-reminders", generation, recordId: "apple-session", schemaVersion: 1,
      });
      await db.prepare("UPDATE apple_session_state SET state = 'READY', envelope = ?, action = NULL, next_attempt_at = 0, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, version = version + 1 WHERE owner_id = ?")
        .bind(JSON.stringify(envelope), owner).run();
      return generation;
    };
    const mcp = async (method, params) => {
      const response = await request("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: randomUUID(), method, params } });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    return { worker, db, state, request, seedReady, mcp };
  };

  let workerHarness;
  try {
    // The off switch, owner check and origin check all stop before session or Apple state changes.
    workerHarness = await makeWorker({ writes: false });
    const gateDB = workerHarness.db;
    const gateBefore = await gateDB.prepare("SELECT * FROM apple_session_state").all();
    const gated = await workerHarness.request("/api/mutations", { method: "POST", body: { action: "create" } });
    assert.equal(gated.status, 403);
    assert.equal((await gated.json()).error.code, "UNSUPPORTED_FEATURE");
    assert.equal((await workerHarness.request("/api/mutations", { user: "different-owner", method: "POST", body: {} })).status, 403);
    assert.equal((await workerHarness.request("/api/mutations", { method: "POST", requestOrigin: "https://evil.example", body: {} })).status, 403);
    assert.equal((await workerHarness.request("/mcp", { user: "different-owner", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 403);
    assert.deepEqual(workerHarness.state.requests, []);
    assert.deepEqual((await gateDB.prepare("SELECT * FROM apple_session_state").all()).results, gateBefore.results);
    await workerHarness.worker.dispose(); workerHarness = undefined;

    workerHarness = await makeWorker();
    const { request, state, mcp } = workerHarness;
    let generation = await workerHarness.seedReady();

    const toolsReply = await mcp("tools/list", {});
    const tools = toolsReply.result.tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["connection_status", "create_reminder", "get_all_open_reminders", "get_reminder_lists", "get_reminders", "update_reminder"]);
    const createTool = tools.find(tool => tool.name === "create_reminder");
    const updateTool = tools.find(tool => tool.name === "update_reminder");
    assert.deepEqual({ readOnly: createTool.annotations.readOnlyHint, destructive: createTool.annotations.destructiveHint, idempotent: createTool.annotations.idempotentHint }, { readOnly: false, destructive: false, idempotent: true });
    assert.deepEqual({ readOnly: updateTool.annotations.readOnlyHint, destructive: updateTool.annotations.destructiveHint, idempotent: updateTool.annotations.idempotentHint }, { readOnly: false, destructive: true, idempotent: false });

    const createKey = "46cf8eef-6cab-4aa2-a725-219769337d8b";
    const createArgs = { listId, idempotencyKey: createKey, title: "Café 🧭 — 東京", notes: "Keep this note 🌿", priority: 1, flagged: true };
    const created = await mcp("tools/call", { name: "create_reminder", arguments: createArgs });
    assert.equal(created.result.isError, undefined, JSON.stringify(created.result.structuredContent));
    assert.equal(created.result.structuredContent.operation, "create");
    assert.equal(created.result.structuredContent.record.title, createArgs.title);
    assert.equal(created.result.structuredContent.record.notes, createArgs.notes);
    assert.equal(created.result.structuredContent.replayed, false);
    assert.equal(state.modifies.length, 1);
    assert.equal(state.modifies[0].recordName, `Reminder/${createKey.toUpperCase()}`);
    assert.ok(!JSON.stringify(created).includes(opaqueMetadata));
    assert.ok(!JSON.stringify(created).includes("synthetic-private-owner"));

    const replay = await mcp("tools/call", { name: "create_reminder", arguments: createArgs });
    assert.equal(replay.result.structuredContent.replayed, true);
    assert.equal(state.modifies.length, 1, "An identical create replay must reconcile from lookup without another modify.");
    const changedReplay = await mcp("tools/call", { name: "create_reminder", arguments: { ...createArgs, title: "A different item" } });
    assert.equal(changedReplay.result.isError, true);
    assert.equal(changedReplay.result.structuredContent.error.code, "CONFLICT");
    assert.equal(state.modifies.length, 1, "Reusing a create key for changed content must never modify Apple.");

    // API writes require a pinned generation. A title-only edit keeps notes and Apple-owned fields.
    const beforeEdit = state.records.get(reminderId);
    const oldTag = beforeEdit.recordChangeTag;
    const editBody = { action: "update", listId, reminderId, recordChangeTag: oldTag, changes: { title: "Edited through API ✨" }, expectedGeneration: generation };
    const editedResponse = await request("/api/mutations", { method: "POST", body: editBody });
    const edited = await editedResponse.json();
    assert.equal(editedResponse.status, 200, JSON.stringify(edited));
    assert.equal(edited.operation, "update");
    assert.equal(edited.record.title, editBody.changes.title);
    assert.equal(edited.record.notes, "Preserve these notes 📝");
    assert.equal(edited.record.flagged, true);
    assert.equal(edited.record.priority, 5);
    assert.equal(edited.record.dueDate, "2030-03-04T09:15:00.000Z");
    assert.equal(edited.record.timeZone, "Europe/London");
    assert.notEqual(edited.record.recordChangeTag, oldTag);
    assert.deepEqual(state.modifies[1].fields, ["LastModifiedDate", "ResolutionTokenMap", "TitleDocument"]);
    assert.equal(state.records.get(reminderId).fields.NotesDocument.value, beforeEdit.fields.NotesDocument.value);
    assert.equal(state.records.get(reminderId).fields.ApplePrivateMetadata.value, opaqueMetadata);
    assert.ok(!JSON.stringify(edited).includes(opaqueMetadata));

    const modifyCountAfterEdit = state.modifies.length;
    const staleResponse = await request("/api/mutations", { method: "POST", body: { ...editBody, changes: { title: "Stale update" } } });
    assert.equal(staleResponse.status, 409);
    assert.equal((await staleResponse.json()).error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountAfterEdit, "A stale change tag must fail before modify.");
    const unpinnedResponse = await request("/api/mutations", { method: "POST", body: { action: "update", listId, reminderId, recordChangeTag: edited.record.recordChangeTag, changes: { title: "Missing generation" } } });
    assert.equal(unpinnedResponse.status, 400);
    assert.equal(state.modifies.length, modifyCountAfterEdit);

    // Apple-side per-record conflicts are surfaced once; the client never force-writes or retries.
    state.nextModify = "record-conflict";
    const conflictBody = { ...editBody, recordChangeTag: edited.record.recordChangeTag, changes: { title: "Conflict stays a conflict" } };
    const conflictResponse = await request("/api/mutations", { method: "POST", body: conflictBody });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).error.code, "CONFLICT");
    assert.equal(state.modifies.length, modifyCountAfterEdit + 1);

    // Unsupported completion and linked due-date edits are rejected without modify.
    const beforeUnsupported = state.modifies.length;
    const completionResponse = await request("/api/mutations", { method: "POST", body: { ...editBody, changes: { completed: true } } });
    assert.equal(completionResponse.status, 400);
    for (const [id, tag] of [["Reminder/WRITE-RECURRING", "tag-Reminder/WRITE-RECURRING"], ["Reminder/WRITE-ALARMED", "tag-Reminder/WRITE-ALARMED"]]) {
      const unsupported = await request("/api/mutations", { method: "POST", body: { action: "update", listId, reminderId: id, recordChangeTag: tag, changes: { dueDate: "2030-04-01T09:00:00.000Z" }, expectedGeneration: generation } });
      assert.equal(unsupported.status, 422);
      assert.equal((await unsupported.json()).error.code, "UNSUPPORTED_FEATURE");
    }
    assert.equal(state.modifies.length, beforeUnsupported);

    // Exact IDs survive uncertain 5xx and network failures; retry safely reconciles the committed record.
    for (const [key, mode] of [["9de431a5-27a6-4b40-a23b-7a76a1dcae7d", "committed-500"], ["bb3d717e-1712-4ea2-baa5-8f5728b34f96", "committed-network-drop"]]) {
      const args = { action: "create", listId, idempotencyKey: key, title: `Uncertain ${mode}`, expectedGeneration: generation };
      const before = state.modifies.length;
      state.nextModify = mode;
      const uncertainResponse = await request("/api/mutations", { method: "POST", body: args });
      const uncertain = await uncertainResponse.json();
      assert.equal(uncertainResponse.status, 503, JSON.stringify(uncertain));
      assert.equal(uncertain.error.code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal(uncertain.error.retryable, false);
      assert.equal(uncertain.error.reminderId, `Reminder/${key.toUpperCase()}`);
      assert.equal(uncertain.error.idempotencyKey, key);
      assert.equal(state.modifies.length, before + 1);
      const reconciledResponse = await request("/api/mutations", { method: "POST", body: args });
      const reconciled = await reconciledResponse.json();
      assert.equal(reconciledResponse.status, 200, JSON.stringify(reconciled));
      assert.equal(reconciled.replayed, true);
      assert.equal(state.modifies.length, before + 1);
    }

    // A 307 response is never followed or replayed for a POST modify.
    const redirectKey = "d92b886c-0f7a-4b48-b497-4fc88a97a2e4";
    state.nextModify = "redirect-307";
    const beforeRedirect = state.modifies.length;
    const redirectResponse = await request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: redirectKey, title: "No redirect replay", expectedGeneration: generation } });
    const redirectResult = await redirectResponse.json();
    assert.equal(redirectResponse.status, 503);
    assert.equal(redirectResult.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeRedirect + 1);
    assert.equal(state.requests.filter(request => request.path.endsWith("/records/modify")).length, beforeRedirect + 1);

    // Disconnect during preflight invalidates the lease before the write is dispatched.
    const preflightKey = "1cdf7593-e38e-4b34-a01d-7962fc67d237";
    let lookupReached;
    let releaseLookup;
    const lookupReady = new Promise(resolve => { lookupReached = resolve; });
    const lookupRelease = new Promise(resolve => { releaseLookup = resolve; });
    state.holdLookup = { reached: lookupReached, releasePromise: lookupRelease };
    const beforePreflightDisconnect = state.modifies.length;
    const preflightRequest = request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: preflightKey, title: "Disconnect in preflight", expectedGeneration: generation } });
    await lookupReady;
    const disconnectDuringLookup = await request("/api/auth/disconnect", { method: "POST", body: {} });
    assert.equal(disconnectDuringLookup.status, 200);
    releaseLookup();
    const preflightResponse = await preflightRequest;
    assert.equal(preflightResponse.status, 409);
    assert.equal(state.modifies.length, beforePreflightDisconnect);

    // Restore the same synthetic session at the new generation, then disconnect after modify dispatch.
    generation = await workerHarness.seedReady();
    const duringModifyKey = "08b44b21-e311-4ef1-bb51-17fa343d0b6f";
    let modifyReached;
    let releaseModify;
    const modifyReady = new Promise(resolve => { modifyReached = resolve; });
    const modifyRelease = new Promise(resolve => { releaseModify = resolve; });
    state.holdModify = { reached: modifyReached, releasePromise: modifyRelease };
    const beforeModifyDisconnect = state.modifies.length;
    const modifyRequest = request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: duringModifyKey, title: "Disconnect during Apple modify", expectedGeneration: generation } });
    await modifyReady;
    const disconnectDuringModify = await request("/api/auth/disconnect", { method: "POST", body: {} });
    assert.equal(disconnectDuringModify.status, 200);
    releaseModify();
    const modifyResponse = await modifyRequest;
    const modifyResult = await modifyResponse.json();
    assert.equal(modifyResponse.status, 503, JSON.stringify(modifyResult));
    assert.equal(modifyResult.error.code, "WRITE_OUTCOME_UNKNOWN");
    assert.equal(modifyResult.error.idempotencyKey, duringModifyKey);
    assert.equal(state.modifies.length, beforeModifyDisconnect + 1);

    // Exercise the operator's one-item live-test procedure through the real MCP boundary.
    generation = await workerHarness.seedReady();
    const invoke = async (name, args) => {
      const reply = await mcp("tools/call", { name, arguments: args });
      if (reply.result.isError) throw Object.assign(new Error("Synthetic MCP tool rejected the operation."), { code: reply.result.structuredContent.error.code });
      return reply.result.structuredContent;
    };
    const testKey = randomUUID();
    const beforeControlledTest = state.modifies.length;
    const controlled = await runControlledWriteChecks(invoke, { listId, generation, idempotencyKey: testKey });
    assert.equal(controlled.reminderId, `Reminder/${testKey.toUpperCase()}`);
    assert.equal(state.modifies.length, beforeControlledTest + 2, "Replay and stale-tag checks must not produce extra modifications.");
    assert.equal(state.records.get(controlled.reminderId).fields.Priority.value, 5);
    assert.equal(state.records.get(controlled.reminderId).fields.Flagged.value, 1);

    const uncertainKey = randomUUID();
    state.nextModify = "committed-network-drop";
    const beforeUncertainTest = state.modifies.length;
    await assert.rejects(runControlledWriteChecks(invoke, { listId, generation, idempotencyKey: uncertainKey }), error => error.code === "WRITE_OUTCOME_UNKNOWN");
    assert.equal(state.modifies.length, beforeUncertainTest + 1, "An uncertain creation must stop before replay or edit.");

    // Expired device assurance is rejected before any Apple request, even when row state says READY.
    generation = await workerHarness.seedReady(true);
    const beforeExpired = state.requests.length;
    const expiredResponse = await request("/api/mutations", { method: "POST", body: { action: "create", listId, idempotencyKey: "6734def8-8505-47ab-8145-0f41020d77e4", title: "Expired session", expectedGeneration: generation } });
    assert.equal(expiredResponse.status, 409);
    assert.equal((await expiredResponse.json()).error.code, "AUTH_EXPIRED");
    assert.equal(state.requests.length, beforeExpired);

    return { checks: [
      "write-gate-owner-origin-denial-before-state-or-Apple-access",
      "MCP-discovery-annotations-Unicode-create-and-idempotent-reconciliation",
      "API-title-edit-preserves-notes-and-opaque-Apple-fields",
      "stale-generation-tag-and-Apple-conflict-have-no-force-retry",
      "completion-recurring-and-alarmed-date-edits-refused",
      "committed-5xx-and-network-drop-return-unknown-and-reconcile",
      "307-modify-response-never-follows-or-replays",
      "disconnect-fences-preflight-and-modify-confirmation",
      "one-item-local-acceptance-procedure-and-uncertain-outcome-stop",
      "expired-session-rejected-before-Apple-access",
    ] };
  } finally {
    if (workerHarness) await workerHarness.worker.dispose();
  }
}
