import test from "node:test";
import assert from "node:assert/strict";
import { AppleHTTP, APPLE_USER_AGENT, validatedAppleURL } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { encodeDocument } from "../src/reminders/crdt.ts";
import { AppError } from "../src/errors.ts";
import { scanCatalogue, type ReadPage } from "../src/app/catalogue-scan.ts";
import { CloudKitRateLimitedError, CloudKitRemindersClient, normalizeList, normalizeReminder, type CloudKitConnection } from "../src/icloud/cloudkit.ts";

const connection: CloudKitConnection = {
  dsid: "123456789",
  clientId: "11111111-2222-3333-4444-555555555555",
  clientBuildNumber: "2534Project66",
  clientMasteringNumber: "2534B22",
  cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
};

type MockResponse = { status?: number; headers?: Record<string, string>; body: unknown };
type CapturedRequest = { url: URL; method: string | undefined; headers: Headers; body: Record<string, unknown> };

function clientWith(responses: MockResponse[], metadata: CloudKitConnection = connection) {
  const requests: CapturedRequest[] = [];
  const http = new AppleHTTP(new CookieJar(), async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${url.pathname}`);
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  });
  return { api: new CloudKitRemindersClient(http, metadata), requests };
}

function listRecord(recordName = "List/LIST-A") {
  return {
    recordName,
    recordType: "List",
    recordChangeTag: "tag-list-1",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" },
    fields: {
      Name: { type: "STRING", value: "<script>alert('list')</script>" },
      Count: { type: "INT64", value: 1 },
      Deleted: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: '["Reminder/REM-1"]' },
      NewAppleField: { type: "STRING", value: "retained" },
    },
  };
}

function reminderRecord(title: string) {
  return {
    recordName: "Reminder/REM-1",
    recordType: "Reminder",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    fields: {
      TitleDocument: { type: "ENCRYPTED_BYTES", value: encodeDocument(title) },
      NotesDocument: { type: "ENCRYPTED_BYTES", value: encodeDocument("<img src=x onerror=alert(1)>") },
      List: { type: "REFERENCE", value: { recordName: "List/LIST-A", action: "VALIDATE" } },
      Completed: { type: "INT64", value: 0 },
      DueDate: { type: "TIMESTAMP", value: 1_735_862_400_000 },
      Priority: { type: "INT64", value: 5 },
      AlarmIDs: { type: "STRING_LIST", value: ["Alarm/ALARM-1"] },
      AttachmentIDs: { type: "UNKNOWN_LIST", value: [] },
      HashtagIDs: { type: "UNKNOWN_LIST", value: [] },
      RecurrenceRuleIDs: { type: "UNKNOWN_LIST", value: [] },
      CustomFutureField: { type: "STRING", value: "kept" },
    },
  };
}

test("Reminders zone discovery and list query use the pinned private CloudKit request shape", async () => {
  const { api, requests } = clientWith([
    { body: { zones: [
      { zoneID: { zoneName: "Calendar", zoneType: "REGULAR_ZONE" }, syncToken: "calendar-token" },
      { zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "__defaultOwner__" }, syncToken: "zone-token" },
    ] } },
    { body: { records: [], continuationMarker: "query-next" } },
  ]);

  const discovery = await api.listZones();
  assert.equal(discovery.available, true);
  assert.equal(discovery.remindersZone?.syncToken, "zone-token");
  assert.equal(discovery.complete, true);
  const page = await api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true, limit: 20 });
  assert.equal(page.complete, false);
  assert.equal(page.paginationComplete, false);
  assert.equal(page.continuation, "query-next");

  for (const request of requests) {
    assert.equal(request.headers.get("origin"), "https://www.icloud.com");
    assert.equal(request.headers.get("referer"), "https://www.icloud.com/");
    assert.equal(request.headers.get("user-agent"), APPLE_USER_AGENT);
  }
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url.pathname, "/database/1/com.apple.reminders/production/private/zones/list");
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
    remapEnums: "true",
    getCurrentSyncToken: "true",
    clientBuildNumber: "2534Project66",
    clientMasteringNumber: "2534B22",
    clientId: connection.clientId,
    dsid: connection.dsid,
  });
  assert.deepEqual(requests[0].body, {});
  assert.equal(requests[1].url.pathname, "/database/1/com.apple.reminders/production/private/records/query");
  assert.deepEqual(requests[1].body, {
    query: { recordType: "reminderList", filterBy: [
      { comparator: "EQUALS", fieldName: "List", fieldValue: { type: "REFERENCE", value: { recordName: "List/LIST-A", action: "VALIDATE" } } },
      { comparator: "EQUALS", fieldName: "includeCompleted", fieldValue: { type: "INT64", value: 1 } },
      { comparator: "EQUALS", fieldName: "LookupValidatingReference", fieldValue: { type: "INT64", value: 1 } },
    ] },
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    resultsLimit: 20,
  });
});

test("catalogue resolves owner-bound reminder list references in one projected lookup and preserves missing lists as tombstones", async () => {
  const reference = (suffix: string, listId: string) => ({ recordName: `Reminder/${suffix}`, recordType: "Reminder", fields: { List: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } }, Deleted: { type: "INT64", value: 0 } } });
  const change = { zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: "__defaultOwner__" }, syncToken: "reference-checkpoint", moreComing: true, records: [reference("A", "List/OTHER"), reference("B", "List/OTHER"), reference("C", "List/MISSING")] }] };
  const { api, requests } = clientWith([{ body: change }, { body: { records: [listRecord("List/OTHER"), { recordName: "List/MISSING", serverErrorCode: "UNKNOWN_ITEM" }] } }]);
  const page = await api.cataloguePage({ reverse: true, limit: 10 });
  assert.deepEqual(page.records.map(record => record.recordName), ["List/OTHER", "List/MISSING"]);
  assert.equal(page.records[1].deleted, true); assert.equal(page.recordErrors.length, 0); assert.equal(page.syncToken, "reference-checkpoint");
  assert.equal(page.paginationComplete, false); assert.equal(requests.length, 2);
  const trace = JSON.stringify(api.readTrace);
  for (const privateValue of ["List/OTHER", "List/MISSING", "reference-checkpoint", connection.clientId, connection.dsid]) assert.ok(!trace.includes(privateValue));
  assert.equal(api.readTrace[1].path, "/records/lookup"); assert.equal(api.readTrace[1].response.returnedRecords, 2);
  assert.deepEqual(requests[1].body, { records: [{ recordName: "List/OTHER" }, { recordName: "List/MISSING" }], zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" }, desiredKeys: ["Name", "Color", "Count", "IsGroup", "Deleted"] });
  // Saved IDs eliminate repeated reference lookups, including tombstones.
  // References still pass owner validation before we skip their lookup.
  const known = clientWith([{ body: change }]);
  assert.equal((await known.api.cataloguePage({ reverse: true, limit: 200, knownListIds: ["List/OTHER", "List/MISSING"] })).records.length, 0);
  assert.equal(known.requests.length, 1); assert.equal(known.requests[0].body.resultsLimit, 200);
  const spoofed = clientWith([{ body: change }, { body: { records: [{ ...listRecord("List/OTHER"), zoneID: { zoneName: "Reminders", ownerRecordName: "_someone-else" } }] } }]);
  await assert.rejects(spoofed.api.cataloguePage({ reverse: true }), AppError);
  const omitted = clientWith([{ body: change }, { body: { records: [] } }]);
  await assert.rejects(omitted.api.cataloguePage({ reverse: true }), AppError);
  const diagnostic = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_bound" } }, { zoneID: { zoneName: "RemindersOther", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_bound" } }, { zoneID: { zoneName: "RemindersForeign", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_foreign" } }] } }, { body: { zones: [{ zoneID: { zoneName: "RemindersOther", ownerRecordName: "_bound" }, records: [], moreComing: false }] } }]);
  assert.deepEqual(await diagnostic.api.probeOtherZones(), { zones: [{ metadataZone: false, records: 0, recordTypes: {}, fieldNames: [], moreComing: false, responseError: false }], complete: true });
  assert.equal(diagnostic.requests.length, 2); assert.ok(!JSON.stringify(diagnostic.api.readTrace).includes("_bound")); assert.ok(!JSON.stringify(diagnostic.api.readTrace).includes("RemindersOther"));
  const versions = [{ ...listRecord(), recordChangeTag: "new-version" }, { ...listRecord(), recordChangeTag: "old-version" }];
  const history = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders" }, syncToken: "versions", moreComing: false, records: versions }] } }]);
  assert.equal((await history.api.cataloguePage({ reverse: true })).records.length, 2);
  const snapshot = clientWith([{ body: { records: versions } }]);
  await assert.rejects(snapshot.api.queryPage({ recordType: "List" }), AppError);
});

test("shared diagnostics bind exact lookups to authenticated shared-zone discovery without replacing the private owner", async () => {
  const sharedZone = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_shared-owner" };
  const discovery = { zones: [{ zoneID: sharedZone }] };
  const record = { ...listRecord(), zoneID: sharedZone };
  const { api, requests } = clientWith([{ body: discovery }, { body: { records: [record, { recordName: "List/MISSING", serverErrorCode: "NOT_FOUND" }] } }], { ...connection, remindersZoneOwner: "_private-owner" });
  assert.deepEqual(await api.probeSharedLists(["List/LIST-A", "List/MISSING"]), { database: "shared", zonesDiscovered: 1, deletedZones: 0, remindersZones: 1, otherZones: 0, lookups: [{ matchedInputIndices: [1], deletedRecords: 0, recordErrors: [{ inputIndex: 2, code: "NOT_FOUND" }] }], complete: true, contentsReturned: false });
  assert.equal(api.remindersZoneOwner, "_private-owner");
  assert.equal(requests[0].url.pathname, "/database/1/com.apple.reminders/production/shared/zones/list");
  assert.equal(requests[1].url.pathname, "/database/1/com.apple.reminders/production/shared/records/lookup");
  assert.deepEqual(requests[1].body.zoneID, sharedZone);
  const trace = JSON.stringify(api.readTrace); for (const value of ["_shared-owner", "List/LIST-A", "List/MISSING"]) assert.ok(!trace.includes(value));
  const spoofed = clientWith([{ body: discovery }, { body: { records: [{ ...record, zoneID: { ...sharedZone, ownerRecordName: "_foreign-owner" } }] } }]);
  await assert.rejects(spoofed.api.probeSharedLists(["List/LIST-A"]), AppError);
  for (const unbound of [
    { ...record, zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" } },
    { ...record, fields: { ...record.fields, Share: { type: "REFERENCE", value: { recordName: "List/LIST-A", zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" } } } } },
    { recordName: "List/LIST-A", serverErrorCode: "NOT_FOUND", zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" } },
  ]) {
    const alias = clientWith([{ body: discovery }, { body: { records: [unbound] } }]);
    await assert.rejects(alias.api.probeSharedLists(["List/LIST-A"]), AppError);
  }
  const excessive = clientWith([{ body: { zones: Array.from({ length: 4 }, (_, index) => ({ zoneID: { ...sharedZone, ownerRecordName: `_owner-${index}` } })) } }]);
  await assert.rejects(excessive.api.probeSharedLists(["List/LIST-A"]), AppError); assert.equal(excessive.requests.length, 1);
  assert.throws(() => validatedAppleURL("https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/shared/records/modify", true), AppError);
});

test("query pages expose partial per-record errors and continuation; normalizers retain hostile text and raw fields", async () => {
  const { api } = clientWith([
    { body: { records: [listRecord(), { recordName: "List/LIST-B", serverErrorCode: "CONFLICT", reason: "per-record failure" }], continuationMarker: "page-2" } },
    { body: { records: [reminderRecord("<script>alert('title')</script>")] } },
  ]);

  const first = await api.queryPage({ recordType: "List", limit: 2 });
  assert.equal(first.paginationComplete, false);
  assert.equal(first.complete, false);
  assert.equal(first.pendingReason, "continuation");
  assert.equal(first.recordErrors[0]?.serverErrorCode, "CONFLICT");
  const list = normalizeList(first.records[0] as Extract<(typeof first.records)[number], { recordType: string }>);
  assert.equal(list.title, "<script>alert('list')</script>");
  assert.equal(list.reminderIds?.[0], "Reminder/REM-1");
  assert.equal((list.raw.fields as Record<string, unknown>).NewAppleField !== undefined, true);
  const firstRecord = first.records[0] as Parameters<typeof normalizeList>[0];
  const oversizedMembership = { ...firstRecord, fields: { ...firstRecord.fields, ReminderIDs: { type: "STRING", value: JSON.stringify(Array(2001).fill("Reminder/REM-1")) } } };
  assert.throws(() => normalizeList(oversizedMembership), AppError);
  const summary = normalizeList(oversizedMembership, false);
  assert.equal(summary.reminderIds, null); assert.equal(summary.title, list.title);

  const second = await api.queryPage({ recordType: "Reminder", continuation: first.continuation });
  assert.equal(second.complete, true);
  const reminder = normalizeReminder(second.records[0] as Extract<(typeof second.records)[number], { recordType: string }>);
  assert.equal(reminder.title, "<script>alert('title')</script>");
  assert.equal(reminder.notes, "<img src=x onerror=alert(1)>");
  assert.equal(reminder.listId, "List/LIST-A");
  assert.equal(reminder.dueDate, new Date(1_735_862_400_000).toISOString());
  assert.deepEqual(reminder.alarmIds, ["Alarm/ALARM-1"]);
  assert.deepEqual(reminder.attachmentIds, []);
  assert.deepEqual(reminder.hashtagIds, []);
  assert.deepEqual(reminder.recurrenceRuleIds, []);
  const rawReminder = second.records[0] as Parameters<typeof normalizeReminder>[0];
  for (const value of [["Attachment/ATT-1"], null, ""]) {
    assert.throws(() => normalizeReminder({ ...rawReminder, fields: { ...rawReminder.fields, AttachmentIDs: { type: "UNKNOWN_LIST", value } } }), AppError);
  }
  assert.equal((reminder.raw.fields as Record<string, unknown>).CustomFutureField !== undefined, true);
});

test("200-reminder compound pages accept related records but retain hard record and request limits", async () => {
  const records = Array.from({ length: 200 }, (_, index) => ({ ...reminderRecord("Task"), recordName: `Reminder/R-${index}` }));
  const alarms = Array.from({ length: 400 }, (_, index) => ({ recordName: `Alarm/A-${index}`, recordType: "Alarm", fields: {} }));
  const full = clientWith([{ body: { records: [...records, ...alarms] } }]);
  assert.equal((await full.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: false, limit: 200 })).records.length, 600);
  assert.equal(full.requests[0].body.resultsLimit, 200);
  const excessive = clientWith([{ body: { records: Array.from({ length: 1001 }, (_, index) => ({ recordName: `Alarm/A-${index}`, recordType: "Alarm", fields: {} })) } }]);
  await assert.rejects(excessive.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: false, limit: 200 }), AppError);
  const invalid = clientWith([]);
  await assert.rejects(invalid.api.cataloguePage({ limit: 201 }), AppError);
  assert.equal(invalid.requests.length, 0);
});

test("zone ownership and record zone mismatches fail closed; change pages return explicit checkpoints", async () => {
  const wrongOwner = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: "_other-user" } }] } }], { ...connection, remindersZoneOwner: "_current-user" });
  await assert.rejects(wrongOwner.api.listZones(), AppError);

  const canonicalOwner = "_synthetic-current-user";
  const canonicalZone = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE", ownerRecordName: canonicalOwner };
  const ownedReminder = { ...reminderRecord("Owner-bound task"), zoneID: canonicalZone, fields: { ...reminderRecord("Owner-bound task").fields, ParentReminder: { type: "REFERENCE", value: null } } };
  const listReference = ownedReminder.fields.List.value as { recordName: string; action: string; zoneID?: typeof canonicalZone };
  listReference.zoneID = canonicalZone;
  const scoped = clientWith([
    { body: { zones: [{ zoneID: canonicalZone }] } },
    { body: { zones: [{ zoneID: canonicalZone, syncToken: "owned-checkpoint", moreComing: false, records: [{ ...listRecord(), zoneID: canonicalZone }] }] } },
    { body: { records: [ownedReminder] } },
    { body: { records: [{ ...ownedReminder, fields: { ...ownedReminder.fields, List: { type: "REFERENCE", value: { recordName: "List/LIST-A", action: "VALIDATE", zoneID: { ...canonicalZone, ownerRecordName: "_different-user" } } } } }] } },
    { body: { zones: [{ zoneID: { ...canonicalZone, ownerRecordName: "_different-user" }, syncToken: "wrong-owner", moreComing: false, records: [] }] } },
  ]);
  assert.equal((await scoped.api.listZones()).available, true);
  assert.equal(scoped.api.remindersZoneOwner, canonicalOwner);
  assert.equal((await scoped.api.changesPage({ desiredRecordTypes: ["List"] })).records.length, 1);
  const ownedPage = await scoped.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true });
  assert.equal(ownedPage.records.length, 1);
  assert.equal(normalizeReminder(ownedPage.records[0] as Extract<(typeof ownedPage.records)[number], { recordType: string }>, canonicalOwner).parentReminderId, null);
  await assert.rejects(scoped.api.queryRemindersPage({ listId: "List/LIST-A", includeCompleted: true }), AppError);
  await assert.rejects(scoped.api.changesPage({ desiredRecordTypes: ["List"] }), AppError);
  assert.deepEqual((scoped.requests[1].body.zones as { zoneID: unknown }[])[0].zoneID, canonicalZone);
  assert.deepEqual(scoped.requests[2].body.zoneID, canonicalZone);
  const ambiguous = clientWith([{ body: { zones: [{ zoneID: canonicalZone }, { zoneID: { ...canonicalZone, ownerRecordName: "_different-user" } }] } }]);
  await assert.rejects(ambiguous.api.listZones(), AppError); assert.equal(ambiguous.api.remindersZoneOwner, undefined);
  const absent = clientWith([{ body: { zones: [] } }]);
  assert.equal((await absent.api.listZones()).available, false); assert.equal(absent.api.remindersZoneOwner, undefined);

  const wrongZoneRecord = clientWith([{ body: { records: [{ ...listRecord(), zoneID: { zoneName: "Calendar", zoneType: "REGULAR_CUSTOM_ZONE" } }] } }]);
  await assert.rejects(wrongZoneRecord.api.lookup(["List/LIST-A"]), AppError);

  const changes = clientWith([{ body: { zones: [{
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    syncToken: "checkpoint-1",
    moreComing: true,
    records: [reminderRecord("Task")],
  }] } }]);
  const page = await changes.api.changesPage({ desiredRecordTypes: ["Reminder"], syncToken: "checkpoint-0", limit: 10 });
  assert.equal(page.complete, false);
  assert.equal(page.paginationComplete, false);
  assert.equal(page.pendingReason, "more_coming");
  assert.equal(page.syncToken, "checkpoint-1");
  assert.deepEqual(changes.requests[0].body, { zones: [{ zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" }, desiredRecordTypes: ["Reminder"], syncToken: "checkpoint-0" }], resultsLimit: 10 });
});

test("HTTP 200 record errors remain visible and HTTP auth/rate-limit failures stay typed", async () => {
  const perRecord = clientWith([{ body: { records: [{ recordName: "Reminder/REM-MISSING", serverErrorCode: "UNKNOWN_ITEM", reason: "not found" }] } }]);
  const lookup = await perRecord.api.lookup(["Reminder/REM-MISSING"]);
  assert.equal(lookup.complete, false);
  assert.equal(lookup.recordErrors[0]?.serverErrorCode, "UNKNOWN_ITEM");
  assert.deepEqual(lookup.unresolvedRecordNames, []);

  const unauthenticated = clientWith([{ status: 401, body: { reason: "expired" } }]);
  await assert.rejects(unauthenticated.api.listZones(), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED" && error.status === 409);
  const limited = clientWith([{ status: 429, headers: { "retry-after": "30" }, body: {} }]);
  await assert.rejects(limited.api.listZones(), (error: unknown) => error instanceof CloudKitRateLimitedError && error.retryAfterSeconds === 30);
  const malformed = clientWith([{ body: { continuationMarker: null } }]);
  await assert.rejects(malformed.api.queryPage({ recordType: "List" }), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
  const forbidden = clientWith([{ status: 403, body: {} }]);
  await assert.rejects(forbidden.api.listZones(), (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN");
});

test("catalogue follows pyicloud's nullable moreComing semantics instead of walking terminal checkpoints", async () => {
  for (const marker of [null, undefined]) {
    const { api, requests } = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders" }, syncToken: "terminal-checkpoint", records: [], ...(marker === undefined ? {} : { moreComing: marker }) }] } }]);
    const outcome = await scanCatalogue({ generation: 7, discover: false, startToken: null, visitedTokens: new Set(), maxPages: 25, signal: new AbortController().signal, onPage() {}, read: async body => {
      const page = await api.changesPage({ desiredRecordTypes: ["List"], syncToken: body.continuation as string | null, limit: 50 });
      assert.equal(page.complete, true); assert.equal(page.pendingReason, null); assert.equal(page.moreComing, null);
      return { ...page, continuation: page.paginationComplete ? null : page.syncToken } as unknown as ReadPage;
    } });
    assert.deepEqual(outcome, { reason: "finished", pages: 1 }); assert.equal(requests.length, 1);
  }
  const malformed = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders" }, syncToken: "bad", records: [], moreComing: "true" }] } }]);
  await assert.rejects(malformed.api.changesPage({ desiredRecordTypes: ["List"] }), AppError);
});

test("discovery URL validation rejects a non-Reminders Apple CloudKit URL", () => {
  assert.throws(() => new CloudKitRemindersClient(new AppleHTTP(), { ...connection, cloudKitURL: "https://p01-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private" }), AppError);
  assert.throws(() => new CloudKitRemindersClient(new AppleHTTP(), { ...connection, cloudKitURL: "https://attacker.example/database/1/com.apple.reminders/production/private" }), AppError);
});


test("forward catalogue history refreshes every touched list from current exact snapshots", async () => {
  const zoneID = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" };
  const history = { zones: [{ zoneID, syncToken: "next-forward", moreComing: true, records: [
    listRecord("List/KNOWN"), listRecord("List/KNOWN"),
    { recordName: "List/DELETED", deleted: true },
    { ...reminderRecord("Unrequested reminder text"), fields: { List: { type: "REFERENCE", value: { recordName: "List/NEW", action: "VALIDATE" } } } },
    { recordName: "Reminder/DELETED", deleted: true },
    { recordName: "Reminder/LOGICALLY-DELETED", recordType: "Reminder", fields: { Deleted: { type: "INT64", value: 1 } } },
    { recordName: "Reminder/LOGICALLY-DELETED-NULL", recordType: "Reminder", fields: { Deleted: { type: "INT64", value: 1 }, List: { type: "REFERENCE", value: null } } },
  ] }] };
  const currentKnown = { ...listRecord("List/KNOWN"), fields: { Name: { type: "STRING", value: "Current renamed list" } } };
  const currentNew = { ...listRecord("List/NEW"), fields: { Name: { type: "STRING", value: "Current new list" } } };
  const current = { records: [currentKnown, currentNew, { recordName: "List/DELETED", serverErrorCode: "NOT_FOUND" }] };
  const { api, requests } = clientWith([{ body: history }, { body: current }, { body: { zones: [{ zoneID, syncToken: "next-forward", moreComing: false, records: [] }] } }]);
  const first = await api.catalogueSyncPage({ syncToken: "previous-forward", limit: 10 });
  assert.deepEqual(requests[0].body, { zones: [{ zoneID, syncToken: "previous-forward", desiredRecordTypes: ["List", "Reminder"], desiredKeys: ["Name", "Color", "Count", "IsGroup", "Deleted", "List"] }], resultsLimit: 10 });
  assert.deepEqual(requests[1].body, { zoneID, records: [{ recordName: "List/KNOWN" }, { recordName: "List/DELETED" }, { recordName: "List/NEW" }], desiredKeys: ["Name", "Color", "Count", "IsGroup", "Deleted"] });
  assert.equal(first.moreComing, true); assert.equal(first.complete, false);
  assert.deepEqual(first.records.map(record => record.recordName), ["List/KNOWN", "List/NEW", "List/DELETED"]);
  assert.equal(normalizeList(first.records[0] as Parameters<typeof normalizeList>[0], false).title, "Current renamed list");
  assert.equal(first.records[2].deleted, true); assert.deepEqual(first.recordErrors, []);
  const terminal = await api.catalogueSyncPage({ syncToken: first.syncToken });
  assert.equal(terminal.syncToken, first.syncToken); assert.equal(terminal.complete, true); assert.deepEqual(terminal.records, []); assert.equal(requests.length, 3);
  for (const responses of [
    [{ body: { zones: [{ ...history.zones[0], records: [{ recordName: "List/KNOWN", serverErrorCode: "CONFLICT" }] }] } }],
    [{ body: history }, { body: { records: [] } }],
    [{ body: history }, { body: { records: [currentKnown, currentNew, { recordName: "List/DELETED", serverErrorCode: "CONFLICT" }] } }],
  ]) {
    const failed = clientWith(responses);
    await assert.rejects(failed.api.catalogueSyncPage({}), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
  }
  // Active or unproven deletion status cannot silently discard a change.
  for (const fields of [{}, { Deleted: { type: "INT64", value: 0 } }, { Deleted: { type: "INT64", value: null } }, { Deleted: { type: "STRING", value: "1" } }]) {
    const activeMissingList = clientWith([{ body: { zones: [{ zoneID, records: [{ recordName: "Reminder/MISSING-LIST", recordType: "Reminder", fields }], syncToken: "not-acknowledged", moreComing: true }] } }]);
    await assert.rejects(activeMissingList.api.catalogueSyncPage({}), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
    assert.equal(activeMissingList.requests.length, 1);
  }
  const foreignReference = { ...reminderRecord("unused"), fields: { Deleted: { type: "INT64", value: 1 }, List: { type: "REFERENCE", value: { recordName: "List/KNOWN", zoneID: { zoneName: "Reminders", ownerRecordName: "_foreign" } } } } };
  const spoofed = clientWith([{ body: { zones: [{ zoneID, records: [foreignReference], syncToken: "bad", moreComing: true }] } }]);
  await assert.rejects(spoofed.api.catalogueSyncPage({}), AppError); assert.equal(spoofed.requests.length, 1);
});

test("expired change tokens require explicit restart while unrelated and authentication errors retain their types", async () => {
  const restart = (error: unknown) => error instanceof AppError && error.code === "RESTART_REQUIRED" && /Restart the initial catalogue scan/.test(error.message);
  const top = clientWith([{ body: { serverErrorCode: "CHANGE_TOKEN_EXPIRED" } }]);
  await assert.rejects(top.api.catalogueSyncPage({ syncToken: "expired" }), restart);
  const zone = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders" }, serverErrorCode: "CHANGE_TOKEN_EXPIRED" }] } }]);
  await assert.rejects(zone.api.catalogueSyncPage({ syncToken: "expired" }), restart);
  for (const body of [{ serverErrorCode: "CHANGE_TOKEN_EXPIRED" }, { zones: [{ zoneID: { zoneName: "Reminders" }, serverErrorCode: "CHANGE_TOKEN_EXPIRED" }] }]) {
    const httpExpired = clientWith([{ status: 410, body }]);
    await assert.rejects(httpExpired.api.catalogueSyncPage({ syncToken: "expired" }), restart);
  }
  const unrelated = clientWith([{ body: { serverErrorCode: "CHANGE_TOKEN_EXPIRED" } }]);
  await assert.rejects(unrelated.api.lookup(["List/LIST-A"]), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
  const foreign = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: "_foreign" }, serverErrorCode: "CHANGE_TOKEN_EXPIRED" }] } }]);
  await assert.rejects(foreign.api.catalogueSyncPage({}), (error: unknown) => error instanceof AppError && error.code === "PROTOCOL_CHANGED");
  const unauthenticated = clientWith([{ status: 401, body: { serverErrorCode: "CHANGE_TOKEN_EXPIRED" } }]);
  await assert.rejects(unauthenticated.api.catalogueSyncPage({}), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED");
  const zoneAuth = clientWith([{ body: { zones: [{ zoneID: { zoneName: "Reminders" }, serverErrorCode: "AUTHENTICATION_REQUIRED" }] } }]);
  await assert.rejects(zoneAuth.api.catalogueSyncPage({}), (error: unknown) => error instanceof AppError && error.code === "REAUTH_REQUIRED");
});
