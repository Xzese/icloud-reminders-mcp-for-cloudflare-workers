// Explicit, one-item live acceptance through the isolated local Worker's MCP API.
// Credentials/cookies stay in memory; output contains only our synthetic test ID.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const origin = "http://127.0.0.1:5173";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usage = "npm run test:icloud-write -- --confirm --list-name 'MCP Test' [--idempotency-key UUID] [--finish-existing]";

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
function requireTest(condition, message) {
  if (!condition) throw fail("TEST_FAILED", message);
}

export function parseWriteTestArgs(args) {
  let confirmed = false, finishExisting = false, listName, key;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--confirm" && !confirmed) confirmed = true;
    else if (option === "--finish-existing" && !finishExisting) finishExisting = true;
    else if ((option === "--list-name" && listName === undefined) || (option === "--idempotency-key" && key === undefined)) {
      const value = args[++index];
      if (typeof value !== "string" || value.startsWith("--")) throw fail("INVALID_ARGUMENT", usage);
      if (option === "--list-name") listName = value;
      else key = value;
    }
    else throw fail("INVALID_ARGUMENT", usage);
  }
  if (!confirmed || typeof listName !== "string" || !listName.trim() || listName.length > 2048 || listName.startsWith("--") || (key !== undefined && !uuid.test(key)) || (finishExisting && key === undefined)) {
    throw fail("INVALID_ARGUMENT", usage);
  }
  return { listName, idempotencyKey: key ?? randomUUID(), ...(finishExisting ? { finishExisting: true } : {}) };
}

export async function runControlledLifecycleChecks(invoke, { listId, generation, idempotencyKey }) {
  requireTest(/^List\/[\x21-\x2e\x30-\x7e]{1,250}$/.test(listId) && Number.isSafeInteger(generation) && generation >= 0 && uuid.test(idempotencyKey), "Invalid test target or session.");
  const reminderId = `Reminder/${idempotencyKey.toUpperCase()}`;
  const title = `MCP write test ${idempotencyKey} (edited)`;
  const deadline = Date.now() + 180_000;
  const call = (name, args) => {
    requireTest(Date.now() < deadline, "Test deadline reached; reconcile the retained test ID before continuing.");
    return invoke(name, args, Math.min(40_000, deadline - Date.now()));
  };
  const verify = (record, completed, deleted = false) => {
    requireTest(record?.id === reminderId && record.listId === listId && record.title === title && record.notes === "Temporary local create/edit acceptance item." && record.priority === 5 && record.flagged === true && record.completed === completed && record.deleted === deleted && typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0, "The retained test item no longer matches its synthetic content. Stop; no unrelated item will be modified.");
    requireTest(completed ? typeof record.completedDate === "string" && Number.isFinite(Date.parse(record.completedDate)) : record.completedDate === null, "The completion timestamp did not match the requested state.");
    return record;
  };
  const read = async (includeCompleted, completed, absent = false) => {
    let continuation = null;
    const seen = new Set();
    for (let index = 0; index < 5; index++) {
      const page = await call("get_reminders", { listId, expectedGeneration: generation, includeCompleted, limit: 200, continuation });
      requireTest(Array.isArray(page.records) && Array.isArray(page.recordErrors) && page.recordErrors.length === 0, "The lifecycle read contained errors; stop before another write.");
      const record = page.records.find(record => record.id === reminderId && !record.deleted);
      if (record) {
        requireTest(!absent, "The test item still appeared in a query that should exclude it.");
        return verify(record, completed);
      }
      if (page.paginationComplete) {
        requireTest(absent, "The retained test item was not found. No create or repair is attempted.");
        return null;
      }
      requireTest(typeof page.continuation === "string" && !seen.has(page.continuation), "The lifecycle read continuation did not advance.");
      continuation = page.continuation;
      seen.add(continuation);
    }
    throw fail("TEST_FAILED", "The lifecycle read exceeded five pages; absence has not been established.");
  };
  const target = record => ({ listId, reminderId, expectedGeneration: generation, recordChangeTag: record.recordChangeTag });
  const before = await read(false, false);
  const completed = await call("complete_reminder", target(before));
  verify(completed.record, true);
  requireTest(completed.record.recordChangeTag !== before.recordChangeTag, "Completion did not advance the version.");
  await read(false, true, true);
  const completedLookup = await call("get_reminder", { listId, reminderId, expectedGeneration: generation });
  const completedRead = verify(completedLookup.record, true);
  try {
    await call("delete_reminder", target(before));
    throw fail("TEST_FAILED", "Stale deletion was accepted; stop before another write.");
  } catch (error) { if (error.code !== "CONFLICT") throw error; }
  const reopened = await call("reopen_reminder", target(completedRead));
  verify(reopened.record, false);
  requireTest(reopened.record.recordChangeTag !== completedRead.recordChangeTag, "Reopening did not advance the version.");
  const reopenedRead = await read(false, false);
  const deleted = await call("delete_reminder", target(reopenedRead));
  verify(deleted.record, false, true);
  requireTest(deleted.record.recordChangeTag !== reopenedRead.recordChangeTag, "Deletion did not advance the version.");
  const deletedLookup = await call("get_reminder", { listId, reminderId, expectedGeneration: generation });
  if (!deletedLookup.missing) verify(deletedLookup.record, false, true);
  await read(false, false, true);
  return { reminderId, idempotencyKey, title, deleted: true, checks: ["complete-and-read-completion-timestamp", "completed-item-absent-from-open-query", "stale-delete-rejected", "reopen-clears-completion-timestamp", "delete-exact-readback-and-confirm-open-query-absence"] };
}

export async function runControlledWriteChecks(invoke, { listId, generation, idempotencyKey }) {
  requireTest(/^List\/[\x21-\x2e\x30-\x7e]{1,250}$/.test(listId) && Number.isSafeInteger(generation) && generation >= 0 && uuid.test(idempotencyKey), "Invalid test target or session.");
  const reminderId = `Reminder/${idempotencyKey.toUpperCase()}`;
  const title = `MCP write test ${idempotencyKey}`;
  const editedTitle = `${title} (edited)`;
  const input = { listId, expectedGeneration: generation, idempotencyKey, title, notes: "Temporary local create/edit acceptance item.", priority: 5, flagged: true };
  const deadline = Date.now() + 180_000;
  const call = async (name, args) => {
    requireTest(Date.now() < deadline, "Test deadline reached; reconcile the retained test ID before continuing.");
    return invoke(name, args, Math.min(40_000, deadline - Date.now()));
  };
  const verify = (record, expectedTitle) => {
    requireTest(record?.id === reminderId && record.listId === listId && record.title === expectedTitle && record.notes === input.notes && record.priority === 5 && record.flagged === true && record.completed === false && !record.deleted && typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0, "The test reminder's identity, content, or version did not match. Stop and inspect it in Apple's app.");
    return record;
  };
  const read = async (expectedTitle) => {
    let continuation = null;
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      const page = await call("get_reminders", { listId, expectedGeneration: generation, limit: 200, continuation });
      requireTest(Array.isArray(page.records) && Array.isArray(page.recordErrors) && page.recordErrors.length === 0, "The test-list read was incomplete or contained record errors.");
      const record = page.records.find(record => record.id === reminderId);
      if (record) return verify(record, expectedTitle);
      if (page.paginationComplete) break;
      requireTest(typeof page.continuation === "string" && !seen.has(page.continuation), "The test-list continuation did not advance.");
      continuation = page.continuation;
      seen.add(continuation);
    }
    throw fail("TEST_FAILED", "The test reminder was not found within five current pages. Inspect Apple's app before another attempt.");
  };
  const created = await call("create_reminder", input);
  verify(created.record, title);
  const replay = await call("create_reminder", input);
  verify(replay.record, title);
  requireTest(replay.replayed === true && replay.record.recordChangeTag === created.record.recordChangeTag, "Create replay did not preserve the same item and version.");
  const beforeEdit = await read(title);
  const edit = { listId, reminderId, expectedGeneration: generation, recordChangeTag: beforeEdit.recordChangeTag, changes: { title: editedTitle } };
  const updated = await call("update_reminder", edit);
  verify(updated.record, editedTitle);
  requireTest(updated.record.recordChangeTag !== beforeEdit.recordChangeTag, "The edit did not advance the reminder version.");
  await read(editedTitle);
  try {
    await call("update_reminder", { ...edit, changes: { title: `${title} (stale attempt)` } });
  } catch (error) {
    if (error.code !== "CONFLICT") throw error;
    await read(editedTitle);
    return { reminderId, idempotencyKey, title: editedTitle, checks: ["create", "same-item-replay", "current-list-read", "title-edit-preserves-notes-priority-flag", "stale-tag-rejected"] };
  }
  throw fail("TEST_FAILED", "A stale version was unexpectedly accepted. Inspect the test item; no repair is attempted.");
}

async function localCookie() {
  return new Promise((resolve, reject) => {
    const request = http.get(origin, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }, response => {
      const cookie = response.headers["set-cookie"]?.find(value => value.startsWith("local-icloud="))?.split(";")[0];
      response.resume();
      response.on("error", reject);
      response.on("end", () => response.statusCode === 200 && cookie ? resolve(cookie) : reject(fail("LOCAL_UNAVAILABLE", "Open the isolated local Worker first.")));
    });
    request.setTimeout(3000, () => request.destroy(fail("LOCAL_UNAVAILABLE", "The local dashboard timed out.")));
    request.on("error", reject);
  });
}

async function runCLI() {
  if (process.argv.slice(2).includes("--help")) { console.log(usage); return; }
  // Confirmation and exact list selection are mandatory before opening a session.
  const { listName, idempotencyKey, finishExisting } = parseWriteTestArgs(process.argv.slice(2));
  const cookie = await localCookie();
  let requestId = 0;
  const invoke = async (name, args, timeoutMs = 40_000) => {
    const response = await fetch(origin + "/mcp", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: { cookie, origin, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
    });
    requireTest(response.ok, "The local MCP request failed. Reconcile the test ID if a write was submitted.");
    const reply = await response.json();
    if (reply.result?.isError) {
      const code = reply.result.structuredContent?.error?.code;
      throw fail(/^[A-Z_]{1,48}$/.test(code ?? "") ? code : "MCP_ERROR", "The local tool refused or could not confirm the operation. No automatic retry is performed.");
    }
    requireTest(reply.result?.structuredContent && !reply.error, "The local MCP response was malformed.");
    return reply.result.structuredContent;
  };
  const status = await invoke("connection_status", {});
  requireTest(status.state === "READY" && status.writeEnabled === true && status.capabilities?.complete === true && status.capabilities?.reopen === true && status.capabilities?.delete === true, "Sign in locally and launch the current build with npm run dev:icloud before this test.");
  const lists = await invoke("get_reminder_lists", { expectedGeneration: status.generation });
  requireTest(lists.paginationComplete === true && Array.isArray(lists.records) && Array.isArray(lists.recordErrors) && lists.recordErrors.length === 0, "Finish the catalogue scan before testing writes.");
  const candidates = lists.records.filter(list => list.title === listName && !list.deleted && !list.isGroup);
  requireTest(candidates.length === 1, "Choose one uniquely named dedicated test list; no list was selected automatically.");
  // Retain this synthetic identity even when a response is lost. No account data is logged.
  console.log(JSON.stringify({ operation: "live-write-test-start", idempotencyKey, reminderId: `Reminder/${idempotencyKey.toUpperCase()}`, title: `MCP write test ${idempotencyKey}`, finishExisting: !!finishExisting, cleanup: "The same labelled test item is deleted after completion/reopening checks." }));
  const options = { listId: candidates[0].id, generation: status.generation, idempotencyKey };
  const createEdit = finishExisting ? null : await runControlledWriteChecks(invoke, options);
  const result = await runControlledLifecycleChecks(invoke, options);
  console.log(JSON.stringify({ operation: "live-write-test-passed", ...result, checks: [...(createEdit?.checks ?? []), ...result.checks], verification: "live-api-readback" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch(error => {
    const code = /^[A-Z_]{1,48}$/.test(error.code ?? "") ? error.code : "TEST_STOPPED";
    console.error(JSON.stringify({ operation: "live-write-test-stopped", code, message: error.code ? error.message : "Local request failed. Reconcile the retained test ID in Apple's app before retrying; writes are never retried automatically." }));
    process.exitCode = 1;
  });
}
