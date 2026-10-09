import test from "node:test";
import assert from "node:assert/strict";
import { scanCatalogue, syncCatalogue, catalogueChoice, mergeCatalogueChoices, type ReadPage } from "../src/app/catalogue-scan.ts";
const emptyPage = (token: string | null, records: ReadPage["records"] = []): ReadPage => ({ records, recordErrors: [], paginationComplete: token === null, complete: token === null, continuation: token, pendingReason: token === null ? null : "more_coming", auxiliaryRecordCounts: {}, auxiliaryDetailsIncluded: false });
function run(reader: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, extra: Partial<Parameters<typeof scanCatalogue>[0]> = {}) {
  const completed: ReadPage[] = [];
  return { completed, result: scanCatalogue({ generation: 7, discover: false, startToken: null, visitedTokens: new Set(), maxPages: 25, signal: new AbortController().signal, read: reader, onPage: page => completed.push(page), ...extra }) };
}
test("catalogue scan skips empty/deleted/group pages, finds a usable list, and carries the checkpoint when continued", async () => {
  const tokens = new Set<string>();
  const first = run(async body => {
    assert.equal(body.expectedGeneration, 7); assert.equal(body.limit, 200); assert.equal(body.reverse, true);
    return body.continuation === null ? emptyPage("a") : emptyPage("b", [{ id: "List/GROUP", isGroup: true }, { id: "List/DELETED", deleted: true }]);
  }, { maxPages: 2, visitedTokens: tokens });
  assert.equal((await first.result).reason, "page-limit");
  const next = run(async body => {
    assert.equal(body.continuation, "b"); return emptyPage("c", [{ id: "List/TEST", title: "Test list" }]);
  }, { startToken: first.completed.at(-1)!.continuation, visitedTokens: tokens });
  assert.deepEqual(await next.result, { reason: "found", pages: 1 });
  assert.equal(next.completed[0].records[0].title, "Test list");
  const heavy = { id: "List/TEST", title: "x".repeat(65_536), reminderIds: Array(2000).fill("unused"), notes: "unused" };
  const choice = catalogueChoice(heavy);
  assert.equal(choice.title?.length, 256); assert.equal(choice.id, "List/TEST");
  assert.deepEqual(Object.keys(choice).sort(), ["deleted", "id", "isGroup", "title"]);
  const newest = [{ id: "List/TEST", title: "Current" }, { id: "List/REMOVED", deleted: true }];
  const older = { ...emptyPage("older", [{ id: "List/TEST", deleted: true }, { id: "List/REMOVED", title: "Old" }]), catalogueOrder: "newest-first" as const };
  assert.deepEqual(mergeCatalogueChoices(newest, older), newest);
  assert.equal(mergeCatalogueChoices(newest, { ...older, catalogueOrder: "oldest-first" })[0].deleted, true);
  let pageIndex = 0;
  const reversePages = [emptyPage("deleted", [{ id: "List/X", deleted: true }]), emptyPage("old", [{ id: "List/X", title: "Old version" }]), emptyPage("usable", [{ id: "List/Y", title: "Current list" }])];
  const reverse = run(async () => ({ ...reversePages[pageIndex++], catalogueOrder: "newest-first" }));
  assert.deepEqual(await reverse.result, { reason: "found", pages: 3 });
  const resumed = run(async () => ({ ...reversePages[1], catalogueOrder: "newest-first" }), { initialCatalogue: [{ id: "List/X", deleted: true }], startToken: "deleted", maxPages: 1 });
  assert.equal((await resumed.result).reason, "page-limit");
  let continuedIndex = 0;
  const continuedPages = [emptyPage("blank"), emptyPage("known", [{ id: "List/TEST", title: "Older known list" }]), emptyPage("new", [{ id: "List/OTHER", title: "Another list" }])];
  const continued = run(async () => ({ ...continuedPages[continuedIndex++], catalogueOrder: "newest-first" }), { initialCatalogue: [{ id: "List/TEST", title: "Known list" }], startToken: "previous" });
  assert.deepEqual(await continued.result, { reason: "found", pages: 3 });
});
test("catalogue scan terminates on completion, record errors, checkpoint cycles, and its hard page cap", async () => {
  assert.equal((await run(async () => emptyPage(null)).result).reason, "finished");
  assert.equal((await run(async () => ({ ...emptyPage("a"), recordErrors: [{ id: null, code: "ACCESS_DENIED" }] })).result).reason, "record-errors");
  assert.deepEqual(await run(async body => emptyPage(body.continuation === "a" ? "b" : "a")).result, { reason: "stalled", pages: 3 });
  let n = 0;
  assert.deepEqual(await run(async () => emptyPage(String(++n)), { maxPages: 1000 }).result, { reason: "page-limit", pages: 25 });
  assert.deepEqual(await run(async () => { throw new Error("No page budget should make no read."); }, { maxPages: 0 }).result, { reason: "page-limit", pages: 0 });
});
test("cancellation, deadline, and upstream errors stop scanning without committing late pages or retrying", async () => {
  const controller = new AbortController(); let release!: (page: ReadPage) => void;
  const pending = run(() => new Promise<ReadPage>(resolve => { release = resolve; }), { signal: controller.signal });
  controller.abort(); release(emptyPage("late", [{ id: "List/LATE" }]));
  assert.equal((await pending.result).reason, "cancelled"); assert.equal(pending.completed.length, 0);
  const deadline = run(async (_body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { discover: true, timeBudgetMs: 10 });
  assert.equal((await deadline.result).reason, "time-limit"); assert.equal(deadline.completed.length, 0);
  const failure = new Error("Synthetic rate limit"); let reads = 0;
  await assert.rejects(run(async () => { reads++; throw failure; }).result, error => error === failure); assert.equal(reads, 1);
});

test("persistent catalogue sync drains past found lists and 25 pages, then uses server-held progress for updates", async () => {
  let reads = 0; const completed: ReadPage[] = [];
  const runSync = (read: Parameters<typeof syncCatalogue>[0]["read"], extra: Partial<Parameters<typeof syncCatalogue>[0]> = {}) => syncCatalogue({ generation: 7, signal: new AbortController().signal, read, onPage: page => completed.push(page), ...extra });
  const page = (pending: boolean, index: number): ReadPage => ({ ...emptyPage(null, index === 2 ? [{ id: "List/FOUND" }] : []), catalogueSync: { phase: pending ? "initial" : "ready", pages: index, initialComplete: !pending, pending, updatedAt: 1 } });
  const first = await runSync(async body => {
    reads++; assert.equal(body.action, "sync-catalogue"); assert.equal(body.limit, 200); assert.equal(body.expectedGeneration, 7);
    assert.equal(body.restart, reads === 1); assert.equal("continuation" in body, false);
    return page(reads < 30, reads);
  }, { restart: true });
  assert.deepEqual(first, { reason: "finished", pages: 30 }); assert.equal(completed.length, 30);
  assert.deepEqual(await runSync(async body => { assert.equal(body.restart, false); return page(false, 1); }), { reason: "finished", pages: 1 });
  assert.deepEqual(await runSync(async () => page(true, 1000)), { reason: "page-limit", pages: 1 });
  const controller = new AbortController(); let release!: (page: ReadPage) => void;
  const before = completed.length;
  const pending = runSync(() => new Promise<ReadPage>(resolve => { release = resolve; }), { signal: controller.signal });
  controller.abort(); release(page(true, 1));
  assert.equal((await pending).reason, "cancelled"); assert.equal(completed.length, before);
  const deadline = await runSync(async (_body, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { timeBudgetMs: 5 });
  assert.equal(deadline.reason, "time-limit");
});
