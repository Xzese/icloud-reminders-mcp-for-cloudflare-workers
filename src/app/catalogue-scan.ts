export interface CatalogueRecord { id: string; title?: string | null; notes?: string | null; deleted?: boolean | null; isGroup?: boolean | null; completed?: boolean | null; listId?: string; completedDate?: string | null; dueDate?: string | null; startDate?: string | null; priority?: number | null; flagged?: boolean | null; allDay?: boolean | null; timeZone?: string | null; parentReminderId?: string | null; alarmIds?: string[] | null; attachmentIds?: string[] | null; hashtagIds?: string[] | null; recurrenceRuleIds?: string[] | null; created?: string | null; modified?: string | null; recordChangeTag?: string | null; appleRecord?: Record<string, unknown>; }
export interface RelatedRecord { id: string; recordType: string; deleted: boolean; appleRecord: Record<string, unknown>; }
export interface CatalogueAuto { mode: "initial-and-hourly"; enabled: boolean; intervalMs: number; nextCheckAt: number | null; lastCheckAt: number | null; lastSuccessAt: number | null; lastErrorCode: string | null; pausedForError: boolean; runner: "local" | "cron" | "unavailable"; }
export interface CatalogueSync { initialPages?: number | null; totalPages?: number; totalPagesKnown?: boolean; lastPassPages?: number | null; phase: "not-started" | "initial" | "incremental" | "ready"; pages: number; initialComplete: boolean; pending: boolean; updatedAt: number | null; }
export interface ReadPage {
  listDiscovery?: { strategy: "direct" | "legacy"; experimental: boolean; retrievedAt: number | null }; catalogueAuto?: CatalogueAuto; catalogueSync?: CatalogueSync; records: CatalogueRecord[]; recordErrors: { id: string | null; code: string; reason?: string | null; appleRecord?: Record<string, unknown> }[]; complete: boolean; paginationComplete: boolean; continuation: string | null; pendingReason: string | null; auxiliaryRecordCounts: Record<string, number>; auxiliaryDetailsIncluded: boolean; relatedRecords?: RelatedRecord[]; requestTrace?: unknown[]; scope?: string; listId?: string; unrefreshedLists?: number; catalogueOrder?: "newest-first" | "oldest-first"; catalogueDiagnostics?: { returnedRecords: number; selectableLists: number; deletedLists: number; groups: number; moreComing: boolean | null }; }
export const CATALOGUE_SCAN_PAGES = 25;
export const CATALOGUE_TOTAL_PAGES = 100;
export const CATALOGUE_SCAN_MS = 30_000;
export const selectableList = (item: CatalogueRecord) => item.id.startsWith("List/") && !item.deleted && !item.isGroup;
// Keep dropdown choices small: list membership arrays and other returned
// metadata are not retained across catalogue pages.
export const catalogueChoice = (item: CatalogueRecord): CatalogueRecord => ({ id: item.id, title: item.title?.slice(0, 256) ?? null, deleted: !!item.deleted, isGroup: !!item.isGroup });
export function mergeCatalogueChoices(previous: CatalogueRecord[], page: ReadPage): CatalogueRecord[] {
  const merged = new Map(previous.map(item => [item.id, item]));
  for (const item of page.records) {
    // A newest-first scan must not let an older record or tombstone replace
    // the version already seen. Legacy forward pages retain update semantics.
    if (page.catalogueOrder !== "newest-first" || !merged.has(item.id)) merged.set(item.id, catalogueChoice(item));
  }
  return [...merged.values()];
}
export type ScanReason = "found" | "finished" | "page-limit" | "time-limit" | "cancelled" | "record-errors" | "stalled";
type Reader = (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
// The loop stays in the browser: every iteration is a separately bounded,
// owner-authorized Worker read, with no long-lived Worker or background job.
export async function scanCatalogue(options: { generation: number; discover: boolean; startToken: string | null; initialCatalogue?: CatalogueRecord[]; visitedTokens: Set<string>; maxPages: number; signal: AbortSignal; read: Reader; onPage: (page: ReadPage) => void; timeBudgetMs?: number }) {
  const controller = new AbortController(); let timedOut = false;
  const cancel = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) cancel(); else options.signal.addEventListener("abort", cancel, { once: true });
  const budget = Math.min(CATALOGUE_SCAN_MS, Math.max(1, options.timeBudgetMs ?? CATALOGUE_SCAN_MS));
  const deadline = Date.now() + budget;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
  let pages = 0;
  const outcome = (reason: ScanReason) => ({ reason, pages });
  try {
    controller.signal.throwIfAborted();
    const maximum = Math.min(CATALOGUE_SCAN_PAGES, Math.max(0, options.maxPages));
    if (maximum === 0) return outcome("page-limit");
    if (options.discover) {
      const zone = await options.read({ action: "discover", expectedGeneration: options.generation }, controller.signal) as { available: boolean };
      controller.signal.throwIfAborted();
      if (!zone.available) throw new Error("Apple did not report an available modern Reminders zone. No list read was attempted.");
    }
    let continuation = options.startToken;
    let catalogue = options.initialCatalogue ?? [];
    const alreadyFound = new Set(catalogue.filter(selectableList).map(item => item.id));
    if (continuation) options.visitedTokens.add(continuation);
    while (pages < maximum) {
      if (Date.now() >= deadline) return outcome("time-limit");
      controller.signal.throwIfAborted();
      const page = await options.read({ action: "lists", expectedGeneration: options.generation, continuation, limit: 200, reverse: true }, controller.signal) as ReadPage;
      controller.signal.throwIfAborted(); pages++;
      options.onPage(page);
      catalogue = mergeCatalogueChoices(catalogue, page);
      if (page.recordErrors.length) return outcome("record-errors");
      if (catalogue.some(item => selectableList(item) && !alreadyFound.has(item.id))) return outcome("found");
      if (page.paginationComplete) return outcome("finished");
      if (!page.continuation || options.visitedTokens.has(page.continuation)) return outcome("stalled");
      options.visitedTokens.add(page.continuation); continuation = page.continuation;
      if (pages === maximum) return outcome("page-limit");
    }
    return outcome("page-limit");
  } catch (error) {
    if (controller.signal.aborted) return outcome(timedOut ? "time-limit" : "cancelled");
    throw error;
  } finally { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); }
}

// Initial history and later deltas use a forward, server-held checkpoint.
// A found list never stops this loop; each successful page is saved atomically.
export const CATALOGUE_SYNC_PAGES = 1000;
export const CATALOGUE_SYNC_MS = 300_000;
export async function syncCatalogue(options: { generation: number; restart?: boolean; signal: AbortSignal; read: Reader; onPage: (page: ReadPage) => void; maxPages?: number; timeBudgetMs?: number }) {
  const controller = new AbortController(); let timedOut = false;
  const cancel = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) cancel(); else options.signal.addEventListener("abort", cancel, { once: true });
  const budget = Math.min(CATALOGUE_SYNC_MS, Math.max(1, options.timeBudgetMs ?? CATALOGUE_SYNC_MS));
  const deadline = Date.now() + budget;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
  let pages = 0;
  const outcome = (reason: ScanReason) => ({ reason, pages });
  try {
    const maximum = Math.min(CATALOGUE_SYNC_PAGES, Math.max(0, options.maxPages ?? CATALOGUE_SYNC_PAGES));
    while (pages < maximum) {
      if (Date.now() >= deadline) return outcome("time-limit");
      controller.signal.throwIfAborted();
      const page = await options.read({ action: "sync-catalogue", expectedGeneration: options.generation, restart: pages === 0 && !!options.restart, limit: 200 }, controller.signal) as ReadPage;
      controller.signal.throwIfAborted();
      if (!page.catalogueSync || !Number.isSafeInteger(page.catalogueSync.pages) || typeof page.catalogueSync.pending !== "boolean") throw new Error("The catalogue sync status was missing. The scan stopped.");
      pages++; options.onPage(page);
      if (page.recordErrors.length) return outcome("record-errors");
      if (!page.catalogueSync.pending) return outcome("finished");
      if (page.catalogueSync.pages >= CATALOGUE_SYNC_PAGES) return outcome("page-limit");
    }
    return outcome("page-limit");
  } catch (error) {
    if (controller.signal.aborted) return outcome(timedOut ? "time-limit" : "cancelled");
    throw error;
  } finally { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); }
}
