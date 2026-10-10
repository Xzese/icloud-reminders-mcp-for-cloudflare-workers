"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, ListChecks, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppleRecordDetails, ReminderDetails, RelatedRecords } from "./reminder-details";
import { mergeListChoices, normalizeLists, selectableList, type ReadPage as Page, type ReadRecord, type RelatedRecord } from "./read-types.ts";

class ReadError extends Error { constructor(message: string, readonly code?: string) { super(message); } }
const authError = (error: unknown) => error instanceof ReadError && ["NOT_CONNECTED", "REAUTH_REQUIRED", "AUTH_EXPIRED", "VERIFICATION_REQUIRED", "TERMS_ACTION_REQUIRED", "DEVICE_APPROVAL_PENDING"].includes(error.code ?? "");
const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
async function read<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  const action = body && typeof body === "object" && "action" in body ? String(body.action) : "";
  const timer = setTimeout(() => controller.abort(new DOMException("The read timed out. Try again.", "TimeoutError")), action === "saved-lists" ? 10_000 : 45_000);
  try {
    const response = await fetch("/api/apple/read", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const value = await response.json() as { error?: { message?: string; code?: string }; result?: T };
    if (!response.ok || !value.result) throw new ReadError(value.error?.message ?? "The controlled read could not be completed.", value.error?.code);
    return value.result;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) throw new ReadError("The request timed out before a response arrived. Try the read again.", "REQUEST_TIMEOUT");
    if (error instanceof Error && error.name === "AbortError") throw new ReadError("The browser interrupted the request. Try the read again.", "REQUEST_ABORTED");
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export interface ReadSummary { busy: boolean; }
export default function ControlledReadPanel({ generation, onSessionRejected, onReadChange, disabled = false }: { generation: number; onSessionRejected: (message: string) => void; onReadChange: (summary: ReadSummary) => void; disabled?: boolean }) {
  const [lists, setLists] = useState<ReadRecord[]>([]);
  const [listId, setListId] = useState("");
  const [discovery, setDiscovery] = useState<Page["listDiscovery"]>();
  const [listError, setListError] = useState("");
  const [pollingError, setPollingError] = useState("");
  const [listMessage, setListMessage] = useState("");
  const [reminders, setReminders] = useState<ReadRecord[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [pages, setPages] = useState(0);
  const active = useRef<AbortController | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [relatedRecords, setRelatedRecords] = useState<RelatedRecord[]>([]);
  const [batchPages, setBatchPages] = useState<Page[]>([]);
  const [diagnosticTrace, setDiagnosticTrace] = useState<unknown[]>([]);
  const [knownListInput, setKnownListInput] = useState("");
  const failed = useCallback((error: unknown, fallback: string) => {
    const message = errorText(error, fallback);
    setError(message);
    if (authError(error)) onSessionRejected(message);
  }, [onSessionRejected]);
  const failedList = useCallback((error: unknown, fallback: string) => {
    const message = errorText(error, fallback);
    setListError(message);
    if (authError(error)) onSessionRejected(message);
  }, [onSessionRejected]);
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    void read<Page>({ action: "saved-lists", expectedGeneration: generation }, controller.signal).then(result => {
      if (active.current !== controller) return;
      setDiscovery(result.listDiscovery);
      setLists(normalizeLists(result.records));
      setListError("");
    }).catch(error => { if (active.current === controller && !controller.signal.aborted) failedList(error, "Saved lists could not be restored."); }).finally(() => {
      if (active.current === controller) { active.current = null; setBusy(false); }
    });
    return () => { const previous = active.current; active.current = null; previous?.abort(); };
  }, [generation, failedList]);

  // Status polling reads the saved snapshot only; it does not contact Apple.
  useEffect(() => {
    let stopped = false;
    const refreshSaved = async () => {
      if (disabled || active.current || document.visibilityState === "hidden") return;
      const controller = new AbortController(); active.current = controller;
      try {
        const saved = await read<Page>({ action: "saved-lists", expectedGeneration: generation }, controller.signal);
        if (stopped || active.current !== controller) return;
        const snapshot = normalizeLists(saved.records);
        if (listId && !snapshot.some(item => item.id === listId && selectableList(item))) {
          setListId(""); setPage(null); setReminders([]); setRelatedRecords([]); setPages(0);
        }
        setDiscovery(saved.listDiscovery);
        setLists(snapshot);
        setPollingError("");
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          if (authError(error)) failedList(error, "Reconnect your Apple account.");
          else setPollingError(errorText(error, "Saved list status could not be refreshed."));
        }
      } finally { if (active.current === controller) active.current = null; }
    };
    const timer = setInterval(() => void refreshSaved(), 15_000);
    const visible = () => { if (document.visibilityState !== "hidden") void refreshSaved(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [generation, disabled, failedList, listId]);
  useEffect(() => { if (disabled) active.current?.abort(); }, [disabled]);
  useEffect(() => { onReadChange({ busy }); }, [busy, onReadChange]);

  async function refreshLists() {
    if (disabled || active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setListError(""); setListMessage("");
    try {
      const result = await read<Page>({ action: "current-lists", expectedGeneration: generation }, controller.signal);
      if (active.current !== controller) return;
      const snapshot = normalizeLists(result.records);
      setDiscovery(result.listDiscovery);
      setLists(snapshot);
      setListMessage("Current lists retrieved from Apple.");
      if (result.recordErrors.length) setListError(`Apple returned ${result.recordErrors.length} list errors: ${result.recordErrors.map(item => item.code).join(", ")}.`);
    } catch (error) { if (active.current === controller && !controller.signal.aborted) failedList(error, "List retrieval failed. Your previous lists remain saved."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  async function lookupKnownLists(refreshSaved = false) {
    if (disabled || active.current) return;
    const listIds = [...new Set(knownListInput.match(/List\/[A-Za-z0-9_-]+/g) ?? [])];
    if (!refreshSaved && (!listIds.length || listIds.length > 10)) { setListError("Enter between one and ten Apple List/ identifiers."); return; }
    const controller = new AbortController(); active.current = controller; setBusy(true); setListError(""); setListMessage("");
    try {
      const result = await read<Page>(refreshSaved ? { action: "refresh-saved-lists", expectedGeneration: generation } : { action: "lookup-lists", expectedGeneration: generation, listIds }, controller.signal);
      if (active.current !== controller) return;
      setLists(previous => mergeListChoices(previous, result.records));
      setDiagnosticTrace(previous => [...previous, { operation: refreshSaved ? "refresh-saved-list-names" : "direct-list-lookup", calls: result.requestTrace ?? [] }]);
      setListMessage(`${refreshSaved ? "Refreshed saved list names" : `Looked up ${listIds.length} identifiers directly`}; ${result.records.filter(selectableList).length} selectable lists returned.${result.unrefreshedLists ? ` ${result.unrefreshedLists} saved lists exceed this request's refresh limit.` : ""}`);
      if (result.recordErrors.length) setListError(`Apple returned ${result.recordErrors.length} list lookup errors: ${result.recordErrors.map(item => item.code).join(", ")}.`);
    } catch (error) { if (active.current === controller && !controller.signal.aborted) failedList(error, "List lookup failed."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  async function loadReminders(more = false) {
    if (disabled || !selectedListId || active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError("");
    try {
      const result = await read<Page>({ action: "reminders", expectedGeneration: generation, listId: selectedListId, includeCompleted, continuation: more ? page?.continuation : null, limit: 200 }, controller.signal);
      if (active.current !== controller) return;
      setReminders(previous => more ? [...previous, ...result.records] : result.records);
      setRelatedRecords(previous => more ? [...new Map([...previous, ...(result.relatedRecords ?? [])].map(record => [record.id, record])).values()] : result.relatedRecords ?? []);
      setPage(result); setPages(previous => more ? previous + 1 : 1);
    } catch (error) { if (active.current === controller && !controller.signal.aborted) failed(error, "Reminders are unavailable."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  async function loadBatch() {
    if (disabled || active.current) return;
    const listIds = lists.filter(selectableList).slice(0, 2).map(list => list.id);
    if (listIds.length !== 2) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(""); setBatchPages([]);
    try {
      const result = await read<{ pages: Page[]; requestTrace: unknown[] }>({ action: "reminders-batch", expectedGeneration: generation, listIds, includeCompleted, limit: 200 }, controller.signal);
      if (active.current === controller) setBatchPages(result.pages.map(batch => ({ ...batch, requestTrace: result.requestTrace })));
    } catch (error) { if (active.current === controller && !controller.signal.aborted) failed(error, "The two-list read failed."); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }

  const selectedListId = lists.some(item => item.id === listId && selectableList(item)) ? listId : "";
  const visibleBatchPages = batchPages.filter(batch => lists.some(list => list.id === batch.listId && selectableList(list)));
  const locked = busy || disabled;
  const choices = lists.filter(selectableList);
  const shownReminders = reminders.filter(item => !item.deleted);
  return <>
    <section className="dashboard-card" aria-labelledby="lists-title">
      <div className="card-heading"><div className="card-icon"><ListChecks size={22} aria-hidden="true" /></div><div><h2 id="lists-title">Your lists</h2><p>Retrieve current lists directly from Apple.</p></div><span className="status-pill">{choices.length} {choices.length === 1 ? "list" : "lists"}</span></div>
      <div className="action-row"><Button disabled={locked} onClick={() => void refreshLists()}><RefreshCw size={16} aria-hidden="true" />Refresh lists</Button></div>
      <p className="fine-print">Experimental direct list retrieval. Status polling uses the saved list snapshot.</p>
      <p className="fine-print">{discovery?.retrievedAt ? `Last retrieved: ${new Date(discovery.retrievedAt).toLocaleString()}` : "No successful retrieval yet."}</p>
      {listMessage && <p className="fine-print" role="status">{listMessage}</p>}
      {listError && <p className="connection-error" role="alert">{listError}</p>}
      {pollingError && <p className="connection-error" role="alert">{pollingError}</p>}
    </section>
    <section className="dashboard-card list-preview" aria-labelledby="preview-title">
      <div className="card-heading"><div className="card-icon"><Search size={21} aria-hidden="true" /></div><div><h2 id="preview-title">Preview reminders</h2><p>Choose a list to see its open reminders.</p></div></div>
      {choices.length ? <><label className="field-label" htmlFor="controlled-list">Reminder list</label><select id="controlled-list" value={selectedListId} onChange={event => { setListId(event.target.value); const saved = batchPages.find(item => item.listId === event.target.value); setPage(saved ?? null); setReminders(saved?.records ?? []); setRelatedRecords(saved?.relatedRecords ?? []); setPages(saved ? 1 : 0); }} disabled={locked}><option value="">Choose a list</option>{choices.map(item => <option key={item.id} value={item.id}>{item.title || "Unnamed list"}</option>)}</select><div className="checkbox-option"><input type="checkbox" id="include-completed" checked={includeCompleted} disabled={locked} onChange={event => { setIncludeCompleted(event.target.checked); setBatchPages([]); setPage(null); setReminders([]); setRelatedRecords([]); setPages(0); setError(""); }} /><label htmlFor="include-completed">Include completed reminders</label></div><div className="action-row"><Button disabled={locked || !selectedListId} onClick={() => void loadReminders()}><Search size={16} aria-hidden="true" />Show reminders</Button>{busy && <Button variant="ghost" onClick={() => active.current?.abort()}>Cancel read</Button>}</div></> : <div className="empty-state"><ListChecks size={30} className="empty-icon" aria-hidden="true" /><p>{busy ? "Loading saved lists…" : "Refresh lists to find lists you can preview."}</p></div>}
      {page && selectedListId && <div className="reminder-results"><header><h3>{choices.find(item => item.id === selectedListId)?.title || "Your reminders"}</h3><span>{shownReminders.length} {shownReminders.length === 1 ? "reminder" : "reminders"}</span></header>{!shownReminders.length && <p className="fine-print">{page.continuation ? "No reminders on this page. More pages are available." : includeCompleted ? "No reminders returned for this list." : "No open reminders returned for this list."}</p>}<ul className="reminder-samples">{shownReminders.map(item => <li key={item.id}><ReminderDetails reminder={item} /></li>)}</ul>{page.continuation && <div className="action-row"><Button variant="outline" disabled={locked || pages >= 20} onClick={() => void loadReminders(true)}>Show more reminders</Button></div>}{pages >= 20 && page.continuation && <p className="fine-print">This preview reached its page limit. More reminders may remain.</p>}{!page.complete && <p className="connection-error">Apple returned an incomplete response. See Testing &amp; details below.</p>}</div>}
      {busy && <p className="fine-print" role="status">Reading saved data or Apple…</p>}
      {error && <p className="connection-error" role="alert">{error}</p>}
      <details className="testing-panel"><summary><FlaskConical size={17} aria-hidden="true" />Testing &amp; details</summary><div className="testing-content"><p className="fine-print">Run a small read or inspect Apple’s response. These checks only read data.</p><div className="test-actions"><Button variant="outline" disabled={locked || !choices.length} onClick={() => void lookupKnownLists(true)}>Refresh saved list names</Button><Button variant="outline" disabled={locked || choices.length < 2} onClick={() => void loadBatch()}>Test two lists together</Button></div>
        <details className="apple-record-details"><summary>Find a missing list by its Apple ID</summary><p className="fine-print">Paste up to ten List/ IDs or the query JSON from iCloud. Only IDs in your authorized Reminders zone can be read.</p><label className="field-label" htmlFor="known-list-identifiers">Apple list identifiers</label><textarea id="known-list-identifiers" rows={3} maxLength={8192} value={knownListInput} onChange={event => setKnownListInput(event.target.value)} disabled={locked} /><div className="action-row"><Button variant="outline" disabled={locked || !knownListInput.trim()} onClick={() => void lookupKnownLists()}>Find these lists</Button></div></details>
        {diagnosticTrace.length > 0 && <AppleRecordDetails record={{ operations: diagnosticTrace }} label="List lookup responses" />}
        {page?.requestTrace && <AppleRecordDetails record={{ calls: page.requestTrace }} label="Reminder read responses" />}
        {relatedRecords.length > 0 && <RelatedRecords records={relatedRecords} />}
        {!!page?.recordErrors.length && <AppleRecordDetails record={{ errors: page.recordErrors }} label="Apple response errors" />}
        {visibleBatchPages.length > 0 && <div className="diagnostics-section"><h3>Two-list test results</h3>{visibleBatchPages.map(batch => <section key={batch.listId}><h4>{choices.find(list => list.id === batch.listId)?.title || "Unnamed list"}</h4><p className="fine-print">{batch.records.filter(item => !item.deleted).length} reminders returned. {batch.paginationComplete ? "All pages read." : "More pages are available."}</p><ul className="reminder-samples">{batch.records.filter(item => !item.deleted).map(item => <li key={item.id}><ReminderDetails reminder={item} /></li>)}</ul></section>)}<AppleRecordDetails record={{ calls: visibleBatchPages[0].requestTrace }} label="Two-list read responses" /></div>}
      </div></details>
    </section>
  </>;
}
