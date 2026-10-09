"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, ListChecks, Play, RefreshCw, Search, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppleRecordDetails, ReminderDetails, RelatedRecords } from "./reminder-details";
import { syncCatalogue, selectableList, mergeCatalogueChoices, type CatalogueRecord as RecordItem, type ReadPage as Page, type RelatedRecord, type CatalogueSync, type CatalogueAuto, type ScanReason } from "./catalogue-scan.ts";
class ReadError extends Error { constructor(message: string, readonly code?: string) { super(message); } }
async function read<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = body && typeof body === "object" && "action" in body && body.action === "sync-catalogue" ? 28_000 : 10_000;
  const timer = setTimeout(() => controller.abort(new DOMException("The read timed out. Try continuing the scan.", "TimeoutError")), timeout);
  try {
  const response = await fetch("/api/apple/read", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
  const value = await response.json() as { error?: { message?: string; code?: string }; result?: T };
  if (!response.ok || !value.result) throw new ReadError(value.error?.message ?? "The controlled read could not be completed.", value.error?.code); return value.result;
  } catch (error) {
    // Preserve caller cancellation so the scan can report Cancel or its pass limit.
    if (signal?.aborted) throw error;
    const resume = body && typeof body === "object" && "action" in body && body.action === "sync-catalogue"
      ? " Completed pages remain saved. Continue the catalogue scan to resume."
      : " Try the read again.";
    if (controller.signal.aborted) throw new ReadError(`The request timed out before a response arrived.${resume}`, "REQUEST_TIMEOUT");
    if (error instanceof Error && error.name === "AbortError") throw new ReadError(`The browser interrupted the request.${resume}`, "REQUEST_ABORTED");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export interface ScanSummary { listCount: number; busy: boolean; scanning: boolean; sync: CatalogueSync | null; auto: CatalogueAuto | null; }
export default function ControlledReadPanel({ generation, onSessionRejected, onScanChange, disabled = false }: { generation: number; onSessionRejected: (message: string) => void; onScanChange: (summary: ScanSummary) => void; disabled?: boolean }) {
  const [lists, setLists] = useState<RecordItem[]>([]); const [listPage, setListPage] = useState<Page | null>(null); const [listId, setListId] = useState("");
  const [reminders, setReminders] = useState<RecordItem[]>([]); const [page, setPage] = useState<Page | null>(null); const [busy, setBusy] = useState(true); const [error, setError] = useState(""); const [pages, setPages] = useState(0); const [listPages, setListPages] = useState(0);
  const failed = useCallback((error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : fallback;
    setError(message);
    if (error instanceof ReadError && ["NOT_CONNECTED", "REAUTH_REQUIRED", "AUTH_EXPIRED", "VERIFICATION_REQUIRED", "TERMS_ACTION_REQUIRED"].includes(error.code ?? "")) onSessionRejected(message);
  }, [onSessionRejected]);
  const active = useRef<AbortController | null>(null);
  const [catalogueSync, setCatalogueSync] = useState<CatalogueSync | null>(null);
  const [catalogueAuto, setCatalogueAuto] = useState<CatalogueAuto | null>(null);
  const [scanMessage, setScanMessage] = useState("");
  const [scanning, setScanning] = useState(false);

  const [catalogueRecords, setCatalogueRecords] = useState(0);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecord[]>([]);
  const [batchPages, setBatchPages] = useState<Page[]>([]);
  const [catalogueTrace, setCatalogueTrace] = useState<unknown[]>([]);
  const [knownListInput, setKnownListInput] = useState("");
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    void read<Page>({ action: "saved-lists", expectedGeneration: generation }, controller.signal).then(result => {
      if (active.current !== controller) return;
      setLists(mergeCatalogueChoices([], result)); setCatalogueSync(result.catalogueSync ?? null); setCatalogueAuto(result.catalogueAuto ?? null); setListPages(result.catalogueSync?.pages ?? 0); setListPage({ ...result, records: [] });
      if (result.records.length) { setListPage({ ...result, records: [] }); setScanMessage("Your saved lists are ready. Continue your scan or check for updates."); }
    }).catch(e => { if (active.current === controller && !controller.signal.aborted) failed(e, "Saved lists could not be restored."); }).finally(() => { if (active.current === controller) { active.current = null; setBusy(false); } });
    return () => { const previous = active.current; active.current = null; previous?.abort(); };
  }, [generation, failed]);
  // Display-only polling. Background execution depends on a configured runner.
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (disabled || active.current || document.visibilityState === "hidden") return;
      const controller = new AbortController(); active.current = controller;
      try {
        const saved = await read<Page>({ action: "saved-lists", expectedGeneration: generation }, controller.signal);
        if (stopped || active.current !== controller) return;
        if (listId && !saved.records.some(item => item.id === listId && selectableList(item))) { setListId(""); setPage(null); setReminders([]); setRelatedRecords([]); setPages(0); }
        setLists(mergeCatalogueChoices([], saved)); setCatalogueSync(saved.catalogueSync ?? null); setCatalogueAuto(saved.catalogueAuto ?? null); setListPages(saved.catalogueSync?.pages ?? 0); setListPage({ ...saved, records: [] });
      } catch (e) {
        if (!stopped && !controller.signal.aborted && e instanceof ReadError && ["NOT_CONNECTED", "REAUTH_REQUIRED", "AUTH_EXPIRED", "VERIFICATION_REQUIRED", "TERMS_ACTION_REQUIRED"].includes(e.code ?? "")) failed(e, "Reconnect your Apple account.");
      } finally { if (active.current === controller) active.current = null; }
    };
    const timer = setInterval(() => void refresh(), 15_000);
    const visible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [generation, disabled, failed, listId]);
  useEffect(() => { if (disabled) active.current?.abort(); }, [disabled]);
  useEffect(() => { onScanChange({ listCount: lists.filter(selectableList).length, busy, scanning, sync: catalogueSync, auto: catalogueAuto }); }, [lists, busy, scanning, catalogueSync, catalogueAuto, onScanChange]);
  async function toggleAuto() {
    if (disabled || active.current || !catalogueAuto) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError("");
    try {
      const saved = await read<Page>({ action: "catalogue-auto", expectedGeneration: generation, enabled: !catalogueAuto.enabled || catalogueAuto.pausedForError }, controller.signal);
      if (active.current === controller) { setCatalogueAuto(saved.catalogueAuto ?? null); setCatalogueSync(saved.catalogueSync ?? null); }
    } catch (e) { if (active.current === controller && !controller.signal.aborted) failed(e, "Automatic check settings could not be changed."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  async function loadLists(restart = false) {
    if (disabled || active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setScanning(true); setError(""); setScanMessage("Looking for your lists…");
    setCatalogueTrace([]); setCatalogueRecords(0);
    try {
      // A cancelled fetch can still have completed its fenced server commit.
      // Restore the authoritative cache before resuming, so no saved page is lost.
      const saved = await read<Page>({ action: "saved-lists", expectedGeneration: generation }, controller.signal);
      if (active.current !== controller) return;
      setLists(mergeCatalogueChoices([], saved)); setCatalogueSync(saved.catalogueSync ?? null); setCatalogueAuto(saved.catalogueAuto ?? null); setListPage({ ...saved, records: [] });
      const result = await syncCatalogue({ generation, restart, signal: controller.signal, read,
        onPage: next => {
          if (active.current !== controller) return;
          const status = next.catalogueSync!;
          setCatalogueTrace(previous => [...previous.slice(-99), { page: status.pages, calls: next.requestTrace ?? [] }]);
          setCatalogueSync(status); setCatalogueAuto(next.catalogueAuto ?? null); setListPages(status.pages); setListPage({ ...next, records: [] });
          setCatalogueRecords(previous => previous + next.records.length);
          setLists(previous => mergeCatalogueChoices(previous, next));
          setScanMessage(`${status.initialComplete ? "Updating lists" : "Finding lists"}: ${status.pages} pages checked. Progress saved.`);
        },
      });
      if (active.current !== controller) return;
      const messages: Record<ScanReason, string> = {
        found: "Scan progress saved.",
        finished: "Your list scan is complete. Future checks look for new or changed lists.",
        "page-limit": "The scan reached its safety limit. Open Testing & details to inspect or restart it.",
        "time-limit": "The scan paused after five minutes. Your progress is saved; continue scanning when you’re ready.",
        cancelled: "Scan paused. Your progress is saved and you can continue later.",
        "record-errors": "Apple could not return some list data. The scan stopped; details are available below.",
        stalled: "Apple did not return new progress. The scan stopped so it won’t keep retrying.",
      };
      setScanMessage(messages[result.reason]);
    } catch (e) { if (active.current === controller) { if (controller.signal.aborted) setScanMessage("Scan paused. Your progress is saved and you can continue later."); else { failed(e, "Lists are unavailable."); setScanMessage("Scan stopped. Progress remains saved. Continue scanning to pick up where you left off."); } } }
    finally { if (active.current === controller) { active.current = null; setBusy(false); setScanning(false); } }
  }
  async function lookupKnownLists(refreshSaved = false) {
    if (disabled || active.current) return;
    const listIds = [...new Set(knownListInput.match(/List\/[A-Za-z0-9_-]+/g) ?? [])];
    if (!refreshSaved && (!listIds.length || listIds.length > 10)) { setError("Enter between one and ten Apple List/ identifiers."); return; }
    const controller = new AbortController(); active.current = controller; setBusy(true); setError("");
    try {
      const result = await read<Page>(refreshSaved ? { action: "refresh-saved-lists", expectedGeneration: generation } : { action: "lookup-lists", expectedGeneration: generation, listIds }, controller.signal);
      if (active.current !== controller) return;
      setLists(previous => mergeCatalogueChoices(previous, result));
      setListPage(previous => previous ?? result);
      setCatalogueTrace(previous => [...previous, { operation: "direct-list-lookup", calls: result.requestTrace ?? [] }]);
      setScanMessage(`${refreshSaved ? "Refreshed saved lists" : `Looked up ${listIds.length} identifiers directly`}; ${result.records.filter(selectableList).length} selectable lists returned. ${result.unrefreshedLists ? `${result.unrefreshedLists} saved lists exceed this request's 100-list refresh limit. ` : ""}This does not establish a complete catalogue.`);
      if (result.recordErrors.length) setError(`Apple returned ${result.recordErrors.length} list lookup errors: ${result.recordErrors.map(item => item.code).join(", ")}.`);
    } catch (e) { if (active.current === controller && !controller.signal.aborted) failed(e, "List lookup failed."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  async function loadReminders(more = false) {
    if (disabled || !selectedListId || active.current) return; const controller = new AbortController(); active.current = controller; setBusy(true); setError("");
    try {
      const result = await read<Page>({ action: "reminders", expectedGeneration: generation, listId: selectedListId, includeCompleted, continuation: more ? page?.continuation : null, limit: 200 }, controller.signal);
      if (active.current !== controller) return;
      setReminders(previous => more ? [...previous, ...result.records] : result.records);
      setRelatedRecords(previous => more ? [...new Map([...previous, ...(result.relatedRecords ?? [])].map(record => [record.id, record])).values()] : result.relatedRecords ?? []); setPage(result); setPages(previous => more ? previous + 1 : 1);
    } catch (e) { if (active.current === controller && !controller.signal.aborted) failed(e, "Reminders are unavailable."); } finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  async function loadBatch() {
    if (disabled || active.current) return;
    const listIds = lists.filter(selectableList).slice(0, 2).map(list => list.id);
    if (listIds.length !== 2) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(""); setBatchPages([]);
    try {
      const result = await read<{ pages: Page[]; requestTrace: unknown[] }>({ action: "reminders-batch", expectedGeneration: generation, listIds, includeCompleted, limit: 200 }, controller.signal);
      if (active.current === controller) setBatchPages(result.pages.map(page => ({ ...page, requestTrace: result.requestTrace })));
    } catch (e) { if (active.current === controller && !controller.signal.aborted) failed(e, "The two-list read failed."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  const selectedListId = lists.some(item => item.id === listId && selectableList(item)) ? listId : "";
  const visibleBatchPages = batchPages.filter(page => lists.some(list => list.id === page.listId && selectableList(list)));
  const locked = busy || disabled;
  const choices = lists.filter(selectableList);
  const shownReminders = reminders.filter(item => !item.deleted);
  const scanFinished = !!catalogueSync?.initialComplete && !catalogueSync.pending;
  const scanButton = scanning ? "Scanning lists…" : catalogueSync?.pending ? "Continue list scan" : catalogueSync?.initialComplete ? "Scan lists" : "Start list scan";
  return <>
    <section className="dashboard-card" aria-labelledby="lists-title">
      <div className="card-heading"><div className="card-icon"><ListChecks size={22} aria-hidden="true" /></div><div><h2 id="lists-title">Your lists</h2><p>Find your lists once, then check for new or changed lists.</p></div><span className="status-pill">{choices.length} {choices.length === 1 ? "list" : "lists"}</span></div>
      <div className="action-row"><Button className="action-primary" disabled={locked} onClick={() => void loadLists()}><Play size={16} aria-hidden="true" />{scanButton}</Button><Button variant="outline" disabled={locked || !catalogueSync?.initialComplete} onClick={() => void loadLists()}><RefreshCw size={16} aria-hidden="true" />Check for updates</Button>{scanning && <Button variant="ghost" onClick={() => active.current?.abort()}><Square size={14} aria-hidden="true" />Pause scan</Button>}</div>
      <div className="scan-summary"><div className="scan-summary-top"><strong>{scanning ? "Finding your lists" : scanFinished ? "List scan complete" : catalogueSync?.pending ? "Scan ready to continue" : choices.length ? "Saved lists ready" : "Ready to find your lists"}</strong><span>{listPages} pages checked</span></div>{scanning && <progress className="scan-progress" aria-label="List scan in progress; total page count unknown" />}<div className="scan-stats"><span>{choices.length} lists found</span>{catalogueSync?.updatedAt && <span>Last checked {new Date(catalogueSync.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}</div>{scanMessage && <p className="fine-print" role="status">{scanMessage}</p>}</div>
      <p className="fine-print">{scanning ? "Keep this page open while scanning. You can pause and continue later." : catalogueAuto?.runner === "unavailable" ? "ChatGPT also checks for list updates when you ask for reminders." : catalogueAuto?.enabled && !catalogueAuto.pausedForError ? "Automatic list checks are enabled. ChatGPT also checks when you ask for reminders." : "Check here or ask ChatGPT to refresh your lists."}</p>
    </section>
    <section className="dashboard-card list-preview" aria-labelledby="preview-title">
      <div className="card-heading"><div className="card-icon"><Search size={21} aria-hidden="true" /></div><div><h2 id="preview-title">Preview reminders</h2><p>Choose a list to see its open reminders.</p></div></div>
      {choices.length ? <><label className="field-label" htmlFor="controlled-list">Reminder list</label><select id="controlled-list" value={selectedListId} onChange={event => { setListId(event.target.value); const saved = batchPages.find(item => item.listId === event.target.value); setPage(saved ?? null); setReminders(saved?.records ?? []); setRelatedRecords(saved?.relatedRecords ?? []); setPages(saved ? 1 : 0); }} disabled={locked}><option value="">Choose a list</option>{choices.map(item => <option key={item.id} value={item.id}>{item.title || "Unnamed list"}</option>)}</select><div className="checkbox-option"><input type="checkbox" id="include-completed" checked={includeCompleted} disabled={locked} onChange={event => { setIncludeCompleted(event.target.checked); setBatchPages([]); setPage(null); setReminders([]); setRelatedRecords([]); setPages(0); setError(""); }} /><label htmlFor="include-completed">Include completed reminders</label></div><div className="action-row"><Button disabled={locked || !selectedListId} onClick={() => void loadReminders()}><Search size={16} aria-hidden="true" />Show reminders</Button>{busy && !scanning && <Button variant="ghost" onClick={() => active.current?.abort()}>Cancel read</Button>}</div></> : <div className="empty-state"><ListChecks size={30} className="empty-icon" aria-hidden="true" /><p>{busy ? "Loading your saved lists…" : "Start a list scan to find lists you can preview."}</p></div>}
      {page && selectedListId && <div className="reminder-results"><header><h3>{choices.find(item => item.id === selectedListId)?.title || "Your reminders"}</h3><span>{shownReminders.length} {shownReminders.length === 1 ? "reminder" : "reminders"}</span></header>{!shownReminders.length && <p className="fine-print">{page.continuation ? "No reminders on this page. More pages are available." : includeCompleted ? "No reminders returned for this list." : "No open reminders returned for this list."}</p>}<ul className="reminder-samples">{shownReminders.map(item => <li key={item.id}><ReminderDetails reminder={item} /></li>)}</ul>{page.continuation && <div className="action-row"><Button variant="outline" disabled={locked || pages >= 20} onClick={() => void loadReminders(true)}>Show more reminders</Button></div>}{pages >= 20 && page.continuation && <p className="fine-print">This preview reached its page limit. More reminders may remain.</p>}{!page.complete && <p className="connection-error">Apple returned an incomplete response. See Testing &amp; details below.</p>}</div>}
      {busy && !scanning && <p className="fine-print" role="status">Reading from Apple…</p>}
      {error && <p className="connection-error" role="alert">{error}</p>}
      <details className="testing-panel"><summary><FlaskConical size={17} aria-hidden="true" />Testing &amp; details</summary><div className="testing-content"><p className="fine-print">Run a small read or inspect Apple’s response. These checks only read data.</p><div className="test-actions"><Button variant="outline" disabled={locked || !choices.length} onClick={() => void lookupKnownLists(true)}>Refresh saved list names</Button><Button variant="outline" disabled={locked || choices.length < 2} onClick={() => void loadBatch()}>Test two lists together</Button>{catalogueSync && catalogueSync.phase !== "not-started" && <Button variant="outline" disabled={locked} onClick={() => void loadLists(true)}>Restart full list scan</Button>}</div>
        {catalogueAuto && catalogueAuto.runner !== "unavailable" && <div className="diagnostics-section"><h3>Automatic list checks</h3><p className="fine-print">{catalogueAuto.pausedForError ? "Checks are paused because Apple requires attention." : catalogueAuto.enabled ? "Initial scans continue automatically, then completed catalogues are checked hourly." : "Automatic checks are paused."}{catalogueAuto.runner === "local" && " The local Worker needs to stay running."}</p>{catalogueAuto.nextCheckAt && <p className="fine-print">Next check: {new Date(catalogueAuto.nextCheckAt).toLocaleString()}.</p>}<Button variant="outline" disabled={locked} onClick={() => void toggleAuto()}>{catalogueAuto.enabled && !catalogueAuto.pausedForError ? "Pause automatic checks" : "Resume automatic checks"}</Button></div>}
        <details className="apple-record-details"><summary>Find a missing list by its Apple ID</summary><p className="fine-print">Paste up to ten List/ IDs or the query JSON from iCloud. Only IDs in your authorized Reminders zone can be read.</p><label className="field-label" htmlFor="known-list-identifiers">Apple list identifiers</label><textarea id="known-list-identifiers" rows={3} maxLength={8192} value={knownListInput} onChange={event => setKnownListInput(event.target.value)} disabled={locked} /><div className="action-row"><Button variant="outline" disabled={locked || !knownListInput.trim()} onClick={() => void lookupKnownLists()}>Find these lists</Button></div></details>
        <details className="apple-record-details"><summary>Scan details</summary><p className="fine-print">Manual scans save each completed page and pause after five minutes or 1,000 pages. Apple does not provide a total page count before the scan finishes. Saved list IDs and names are encrypted; reminder contents are read live.</p><dl className="reminder-metadata"><div><dt>Initial scan</dt><dd>{catalogueSync?.initialComplete ? "Complete" : "Not complete"}</dd></div><div><dt>Initial pages</dt><dd>{catalogueSync?.initialPages ?? "Not recorded"}</dd></div><div><dt>Total pages read</dt><dd>{catalogueSync?.totalPagesKnown === false ? "At least " : ""}{catalogueSync?.totalPages ?? listPages}</dd></div><div><dt>Updates this run</dt><dd>{catalogueRecords}</dd></div><div><dt>List errors</dt><dd>{listPage?.recordErrors.length ?? 0}</dd></div></dl></details>
        {catalogueTrace.length > 0 && <AppleRecordDetails record={{ pages: catalogueTrace }} label="List scan responses" />}
        {page?.requestTrace && <AppleRecordDetails record={{ calls: page.requestTrace }} label="Reminder read responses" />}
        {relatedRecords.length > 0 && <RelatedRecords records={relatedRecords} />}
        {!!page?.recordErrors.length && <AppleRecordDetails record={{ errors: page.recordErrors }} label="Apple response errors" />}
        {visibleBatchPages.length > 0 && <div className="diagnostics-section"><h3>Two-list test results</h3>{visibleBatchPages.map(batch => <section key={batch.listId}><h4>{choices.find(list => list.id === batch.listId)?.title || "Unnamed list"}</h4><p className="fine-print">{batch.records.filter(item => !item.deleted).length} reminders returned. {batch.paginationComplete ? "All pages read." : "More pages are available."}</p><ul className="reminder-samples">{batch.records.filter(item => !item.deleted).map(item => <li key={item.id}><ReminderDetails reminder={item} /></li>)}</ul></section>)}<AppleRecordDetails record={{ calls: visibleBatchPages[0].requestTrace }} label="Two-list read responses" /></div>}
      </div></details>
    </section>
  </>;
}
