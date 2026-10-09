// Agent-side read-only diagnostics through the normal local HTTP boundary.
// Cookies stay in memory; tool summaries contain no Apple content or tokens.
import http from "node:http";
const origin = "http://127.0.0.1:5173";
const [command = "status", option] = process.argv.slice(2);
if (!["status", "discover", "read-test", "write-shapes", "catalogue", "other-zones", "lookup-lists", "shared-lists", "saved-lists", "batch-read", "sync-catalogue", "mcp-open-reminders", "mcp-all-open-reminders"].includes(command)) throw new Error("Use status, discover, other-zones, catalogue <1..100 pages>, lookup-lists <List/id ...>, read-test, or write-shapes.");
if (command === "read-test" && option !== undefined && option !== "open") throw new Error("Use read-test [open].");
const pages = command === "catalogue" ? Number(option ?? 25) : 1;
if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error("The page budget must be 1..100.");
const cookie = await new Promise((resolve, reject) => {
  const request = http.get(origin, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }, response => {
    response.resume(); response.on("end", () => {
      const value = response.headers["set-cookie"]?.find(v => v.startsWith("local-icloud="))?.split(";")[0];
      if (response.statusCode !== 200 || !value) reject(new Error("The local Worker dashboard is unavailable.")); else resolve(value);
    });
  });
  request.setTimeout(3000, () => request.destroy(new Error("Local dashboard timed out."))); request.on("error", reject);
});
const call = async (path, body, signal) => {
  const requestTimeout = path === "/mcp" ? 40_000 : body?.action === "sync-catalogue" ? 28_000 : 15_000;
  const response = await fetch(origin + path, { headers: { cookie, ...(body ? { origin, "content-type": "application/json", accept: "application/json, text/event-stream" } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout) });
  const value = await response.json();
  if (!response.ok) { console.log(JSON.stringify({ httpStatus: response.status, error: value.error })); throw new Error("Read-only local diagnostic failed."); }
  return value;
};
const status = await call("/api/connection");
console.log(JSON.stringify({ operation: "status", state: status.state, generation: status.generation, transportReady: status.transportReady, action: status.action, writesEnabled: status.gates.writesEnabled }));
if (command === "status") process.exit(0);
if (status.state !== "READY") throw new Error("The Apple connection is not ready for a controlled read.");
if (command === "write-shapes") {
  const { buildUpdateReminder } = await import("../../src/reminders/writes.ts");
  // Inspect bounded read metadata only. No account/list/record identifiers,
  // titles, documents, asset links, change tags or token values are printed.
  const saved = await call("/api/apple/read", { action: "saved-lists", expectedGeneration: status.generation });
  const lists = saved.result.records.filter(record => !record.deleted && !record.isGroup).slice(0, 3);
  for (const [index, list] of lists.entries()) {
    const page = await call("/api/apple/read", { action: "reminders", expectedGeneration: status.generation, listId: list.id, includeCompleted: false, limit: 1 });
    const record = page.result.records.find(record => record.id.startsWith("Reminder/") && !record.deleted);
    const fields = record?.appleRecord?.fields ?? {};
    const types = Object.fromEntries(Object.entries(fields).filter(([name]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)).map(([name, field]) => [name, typeof field?.type === "string" && /^[A-Z0-9_]{1,32}$/.test(field.type) ? field.type : "unknown"]));
    let resolutionMapEntries = null;
    try { const value = JSON.parse(fields.ResolutionTokenMap?.value); if (value?.map && typeof value.map === "object" && !Array.isArray(value.map)) resolutionMapEntries = Object.keys(value.map).length; } catch { /* No private values are logged. */ }
    let titleEditCodecSupported = false, codecRejectionCode = null;
    if (record?.appleRecord && record.recordChangeTag) {
      try {
        const raw = record.appleRecord;
        // Build and discard a plain-text patch in memory. This tests the codec
        // and token-map shape only; it never dispatches or validates ownership.
        buildUpdateReminder({ listId: list.id, reminderId: record.id, recordChangeTag: record.recordChangeTag, changes: { title: "Controlled local codec probe" } }, { ...raw, raw }, raw.zoneID?.ownerRecordName ?? "__defaultOwner__");
        titleEditCodecSupported = true;
      } catch (error) { codecRejectionCode = /^[A-Z_]{1,32}$/.test(error?.code ?? "") ? error.code : "VALIDATION_ERROR"; }
    }
    console.log(JSON.stringify({ operation: "write-shapes-read-only", listIndex: index + 1, reminderFound: !!record, changeTagPresent: typeof record?.recordChangeTag === "string", fieldTypes: types, resolutionMapEntries, hasAlarms: !!record?.alarmIds?.length, hasRecurrence: !!record?.recurrenceRuleIds?.length, allDay: record?.allDay, dueDatePresent: typeof record?.dueDate === "string", timeZonePresent: typeof record?.timeZone === "string", titleEditCodecSupported, codecRejectionCode, writesEnabled: false }));
  }
} else if (command === "sync-catalogue") {
  const { syncCatalogue, mergeCatalogueChoices, selectableList } = await import("../../src/app/catalogue-scan.ts");
  const saved = await call("/api/apple/read", { action: "saved-lists", expectedGeneration: status.generation });
  let catalogue = saved.result.records, progress = saved.result.catalogueSync; const started = Date.now();
  const result = await syncCatalogue({ generation: status.generation, restart: option === "restart", signal: new AbortController().signal,
    read: async (body, signal) => (await call("/api/apple/read", body, signal)).result,
    onPage: page => { catalogue = mergeCatalogueChoices(catalogue, page); progress = page.catalogueSync; if (progress.pages % 25 === 0 || !progress.pending) console.log(JSON.stringify({ operation: "sync-progress", elapsedMs: Date.now() - started, ...progress, selectableLists: catalogue.filter(selectableList).length })); },
  });
  console.log(JSON.stringify({ operation: "sync-summary", elapsedMs: Date.now() - started, reason: result.reason, ...progress, selectableLists: catalogue.filter(selectableList).length, writesEnabled: false }));
} else if (command === "saved-lists") {
  const response = await call("/api/apple/read", { action: "saved-lists", expectedGeneration: status.generation });
  console.log(JSON.stringify({ operation: "saved-lists", knownListsFound: response.result.records.flatMap(record => !record.deleted && !record.isGroup ? (["Shopping", "Software to do list", "Reminders"].find(name => name.toLowerCase() === record.title?.toLowerCase()) ?? []) : []), identifiers: response.result.records.length, availableLists: response.result.records.filter(record => !record.deleted && !record.isGroup).length, namesPresent: response.result.records.filter(record => typeof record.title === "string").length, appleRequests: response.result.requestTrace.length, catalogueSync: response.result.catalogueSync, catalogueAuto: response.result.catalogueAuto, writesEnabled: false }));
} else if (command === "mcp-open-reminders") {
  const invoke = async (name, args) => {
    const response = await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    if (response.result.isError) { console.log(JSON.stringify({ operation: name, error: response.result.structuredContent.error })); throw new Error("Read-only MCP diagnostic failed."); }
    return response.result.structuredContent;
  };
  const started = Date.now();
  const lists = await invoke("get_reminder_lists", { expectedGeneration: status.generation });
  const selected = lists.records.find(list => list.title?.toLowerCase() === "reminders") ?? lists.records[0];
  if (!selected) throw new Error("No selectable reminder list is available.");
  const page = await invoke("get_reminders", { expectedGeneration: status.generation, listId: selected.id });
  console.log(JSON.stringify({ operation: "mcp-open-reminders", elapsedMs: Date.now() - started, selectableLists: lists.records.length, reminderRecords: page.records.length, openReminders: page.records.filter(record => !record.deleted && record.completed === false).length, completedReminders: page.records.filter(record => record.completed === true).length, paginationComplete: page.paginationComplete, recordErrors: page.recordErrors.map(error => error.code), freshness: page.freshness, writesEnabled: false }));
} else if (command === "mcp-all-open-reminders") {
  const started = Date.now(); let continuation = null; let records = 0; let errors = 0; let complete = false; let progress;
  const seen = new Set();
  for (let index = 0; index < 100 && Date.now() - started < 300_000; index++) {
    const reply = await call("/mcp", { jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: "get_all_open_reminders", arguments: { expectedGeneration: status.generation, continuation } } });
    if (reply.result.isError) { console.log(JSON.stringify({ operation: command, error: reply.result.structuredContent.error })); throw new Error("All-list read failed."); }
    const page = reply.result.structuredContent;
    records += page.records.length; errors += page.recordErrors.length; progress = page.progress; complete = page.complete;
    console.log(JSON.stringify({ operation: "all-open-progress", batch: index + 1, elapsedMs: Date.now() - started, batchRecords: page.records.length, totalOpenReminders: records, progress, complete, pendingReason: page.pendingReason, recordErrors: page.recordErrors.map(error => error.code), errors: page.errors, writesEnabled: false }));
    continuation = page.continuation;
    if (!continuation || complete || page.pendingReason === "read_error" || page.recordErrors.length) break;
    if (seen.has(continuation)) throw new Error("All-list continuation repeated.");
    seen.add(continuation);
  }
  console.log(JSON.stringify({ operation: command, elapsedMs: Date.now() - started, totalOpenReminders: records, complete, progress, recordErrors: errors, continuationAvailable: !!continuation, writesEnabled: false }));
  if (!complete) process.exitCode = 1;
} else if (command === "batch-read") {
  const saved = await call("/api/apple/read", { action: "saved-lists", expectedGeneration: status.generation });
  const listIds = saved.result.records.filter(list => !list.deleted && !list.isGroup).slice(0, 2).map(list => list.id);
  const started = Date.now();
  const response = await call("/api/apple/read", { action: "reminders-batch", expectedGeneration: status.generation, listIds, includeCompleted: false, limit: 200 });
  console.log(JSON.stringify({ operation: "batch-read", elapsedMs: Date.now() - started, lists: response.result.pages.map(page => ({ records: page.records.length, openReminders: page.records.filter(record => !record.deleted && record.completed === false).length, recordErrors: page.recordErrors.length, paginationComplete: page.paginationComplete })), appleRequests: response.result.requestTrace.length, writesEnabled: false }));
} else if (command === "shared-lists") {
  const response = await call("/api/apple/read", { action: "probe-shared-lists", expectedGeneration: status.generation, listIds: process.argv.slice(3) });
  console.log(JSON.stringify(response));
} else if (command === "lookup-lists") {
  const listIds = process.argv.slice(3).filter(value => value.startsWith("List/"));
  const expectedZoneOwner = process.argv.slice(3).find(value => value.startsWith("owner="))?.slice(6);
  const response = await call("/api/apple/read", { action: "lookup-lists", expectedGeneration: status.generation, listIds, ...(expectedZoneOwner ? { expectedZoneOwner } : {}) });
  console.log(JSON.stringify({ operation: "direct-list-lookup", requested: listIds.length, returned: response.result.records.length, knownListNames: response.result.records.map(record => ["Shopping", "Software to do list", "Reminders"].find(name => name.toLowerCase() === record.title?.toLowerCase()) ?? "[other list]"), returnedInputIndices: response.result.records.map(record => listIds.indexOf(record.id) + 1), errorInputIndices: response.result.recordErrors.map(error => listIds.indexOf(error.id) + 1), recordErrors: response.result.recordErrors.map(error => error.code), expectedZoneOwnerMatched: expectedZoneOwner ? true : undefined, requestTrace: response.result.requestTrace }));
  for (const listId of listIds) {
    const list = response.result.records.find(record => record.id === listId);
    if (list?.deleted || list?.isGroup) continue;
    const reminderResponse = await call("/api/apple/read", { action: "reminders", expectedGeneration: status.generation, listId, includeCompleted: false, limit: 200 });
    console.log(JSON.stringify({ operation: "direct-open-reminders-read", inputIndex: listIds.indexOf(listId) + 1, listName: ["Shopping", "Software to do list", "Reminders"].find(name => name.toLowerCase() === list?.title?.toLowerCase()) ?? "[other list]", reminderRecords: reminderResponse.result.records.length, openReminders: reminderResponse.result.records.filter(record => record.completed === false && !record.deleted).length, completedReminders: reminderResponse.result.records.filter(record => record.completed === true).length, paginationComplete: reminderResponse.result.paginationComplete, recordErrors: reminderResponse.result.recordErrors.map(error => error.code), relatedRecordCounts: reminderResponse.result.auxiliaryRecordCounts, requestTrace: reminderResponse.result.requestTrace, writesEnabled: false }));
  }
} else if (command === "catalogue") {
  const { scanCatalogue, mergeCatalogueChoices, selectableList } = await import("../../src/app/catalogue-scan.ts");
  const restored = await call("/api/apple/read", { action: "saved-lists", expectedGeneration: status.generation });
  const started = Date.now();
  let catalogue = restored.result.records, token = null, readPages = 0; const visited = new Set(); const deadline = Date.now() + 30_000 * Math.ceil(pages / 25);
  while (readPages < pages && Date.now() < deadline && catalogue.filter(selectableList).length < 3) {
    const result = await scanCatalogue({ generation: status.generation, discover: readPages === 0, startToken: token, initialCatalogue: catalogue, visitedTokens: visited, maxPages: pages - readPages, timeBudgetMs: deadline - Date.now(), signal: new AbortController().signal,
      read: async (body, signal) => (await call("/api/apple/read", body.action === "lists" ? { ...body, limit: 200, ...(process.argv[4] === "oldest" ? { reverse: false } : {}) } : body, signal)).result,
      onPage: page => { readPages++; catalogue = mergeCatalogueChoices(catalogue, page); token = page.continuation; console.log(JSON.stringify({ operation: "catalogue", page: readPages, pageRecords: page.records.length, selectableLists: catalogue.filter(selectableList).length, recordErrors: page.recordErrors.length, paginationComplete: page.paginationComplete })); },
    });
    if (!["found", "page-limit"].includes(result.reason) || !token) { console.log(JSON.stringify({ stopped: result.reason, pages: readPages, selectableLists: catalogue.filter(selectableList).length })); break; }
  }
  console.log(JSON.stringify({ operation: "catalogue-summary", elapsedMs: Date.now() - started, pages: readPages, selectableLists: catalogue.filter(selectableList).length, morePages: !!token, writesEnabled: false }));
} else if (command === "read-test") {
  let continuation = null; const seen = new Set(); const deadline = Date.now() + 30_000;
  for (let index = 0; index < 5 && Date.now() < deadline; index++) {
    const response = await call("/api/apple/read", { action: "lists", expectedGeneration: status.generation, reverse: true, continuation, limit: 200 });
    const page = response.result;
    const selected = page.records.find(record => record.id.startsWith("List/") && !record.deleted && !record.isGroup);
    console.log(JSON.stringify({ operation: "newest-catalogue", page: index + 1, records: page.records.length, selectableListFound: !!selected, recordErrors: page.recordErrors.length, paginationComplete: page.paginationComplete }));
    if (page.recordErrors.length) break;
    if (selected) {
      const read = await call("/api/apple/read", { action: "reminders", expectedGeneration: status.generation, listId: selected.id, includeCompleted: option !== "open", limit: 200 });
      console.log(JSON.stringify({ operation: "bounded-test-list-read", openOnly: option === "open", records: read.result.records.length, reminderRecords: read.result.records.filter(record => record.id.startsWith("Reminder/") && !record.deleted).length, completedRecords: read.result.records.filter(record => record.completed === true).length, openRecords: read.result.records.filter(record => record.completed === false && !record.deleted).length, unknownCompletionRecords: read.result.records.filter(record => record.completed == null && !record.deleted).length, titlesPresent: read.result.records.filter(record => typeof record.title === "string" && record.title.length > 0).length, recordErrors: read.result.recordErrors.length, paginationComplete: read.result.paginationComplete, relatedRecordCounts: read.result.auxiliaryRecordCounts, writesEnabled: read.writesEnabled }));
      break;
    }
    if (page.paginationComplete || !page.continuation || seen.has(page.continuation)) break;
    seen.add(page.continuation); continuation = page.continuation;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
} else if (command === "discover" || command === "other-zones") {
  const result = await call("/api/apple/read", { action: command === "discover" ? "discover" : "probe-other-zones", expectedGeneration: status.generation });
  console.log(JSON.stringify({ operation: "discover", ...result }));
}
