"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Cloud, Copy, Info, ListChecks, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import ControlledReadPanel, { type ScanSummary } from "./controlled-read";

interface Status {
  state: string;
  generation: number;
  nextAttemptAt: number;
  transportReady: boolean;
  action: string | null;
  expiresAt: number | null;
  gates: { enabled: boolean; cryptographyReviewed: boolean; liveConnectionApproved: boolean };
}
class ConnectionError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json() as { error?: { message?: string; code?: string } };
  if (!response.ok) throw new ConnectionError(value.error?.message ?? "That action didn’t finish. Please try again.", value.error?.code);
  return value as T;
}
const emptyScan: ScanSummary = { listCount: 0, busy: false, scanning: false, sync: null, auto: null };
const dateText = (value: number) => new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function AppleConnection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [ownerIdentity, setOwnerIdentity] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanSummary>(emptyScan);
  const [now, setNow] = useState(() => Date.now());
  const revision = useRef(0);
  const statusRequest = useRef<AbortController | null>(null);
  const onScanChange = useCallback((next: ScanSummary) => setScan(next), []);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    statusRequest.current?.abort();
    const controller = new AbortController(); statusRequest.current = controller;
    setRefreshing(true);
    try {
      const next = await call<Status>("/api/connection", undefined, controller.signal);
      if (current !== revision.current) return;
      setStatus(next); setNow(Date.now()); setOwnerIdentity(null); setError("");
      if (next.state !== "READY") setScan(emptyScan);
    } catch (e) {
      if (current !== revision.current || controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Connection status is unavailable. Try again in a moment.");
      if (e instanceof ConnectionError && e.code === "OWNER_NOT_CONFIGURED") {
        try {
          const identity = await call<{ authenticatedUserId: string; automaticOwnerClaim: boolean }>("/api/bootstrap/identity", undefined, controller.signal);
          if (current === revision.current && identity.automaticOwnerClaim === false) setOwnerIdentity(identity.authenticatedUserId);
        } catch { if (current === revision.current) setOwnerIdentity(null); }
      }
    } finally { if (current === revision.current) setRefreshing(false); }
  }, []);
  useEffect(() => { let mounted = true; const revisionRef = revision; const requestRef = statusRequest; queueMicrotask(() => { if (mounted) void refresh(); }); return () => { mounted = false; revisionRef.current++; requestRef.current?.abort(); }; }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), status?.state === "DEVICE_APPROVAL_PENDING" ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [status?.state]);
  const expired = !!status?.expiresAt && status.expiresAt <= now;
  useEffect(() => { if (!expired || status?.state !== "READY") return; const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, [expired, status?.state, refresh]);
  const onSessionRejected = useCallback((message: string) => { setError(message); void refresh(); }, [refresh]);
  async function action(path: string) {
    if (!status || busyAction || refreshing) return;
    setBusyAction(path); setError("");
    revision.current++; statusRequest.current?.abort();
    try { await call(path, { expectedGeneration: status.generation }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "That action didn’t finish. Please try again."); }
    finally { setBusyAction(null); }
  }
  const ready = !!status?.gates.enabled && status.state === "READY" && status.transportReady && !expired;
  const pending = status?.state === "DEVICE_APPROVAL_PENDING" && !expired;
  const busy = refreshing || busyAction !== null;
  const title = !status ? (error ? "Connection unavailable" : "Checking your connection…") : expired ? "Connect again to continue" : ready ? "Apple account connected" : pending ? "Approve access on your Apple device" : !status.gates.enabled ? "Apple connection is paused" : "Connect your Apple account";
  const description = !status ? (error ? "Your connection status could not be loaded. Refresh to try again." : "We’re checking whether your Apple account is connected.") : expired ? "Your Apple session has ended. Connect again to refresh your lists and reminders." : ready ? "You’re ready to find your lists and read your reminders." : pending ? (status.action === "wait-for-reminders-keys" ? "Your device approval was accepted. Apple is preparing access to your reminders." : "Allow web access when Apple asks on your trusted device, then check approval below.") : !status.gates.enabled ? "The Apple connection is currently unavailable. You can check again here when it’s enabled." : "Connect once, then use ChatGPT or this page to check your reminders.";
  const checks = [
    { label: "Workspace signed in", checked: true },
    { label: "Apple account connected", checked: ready },
    { label: "Reminders access ready", checked: ready },
    { label: "Lists found", checked: ready && scan.listCount > 0 },
    { label: "List scan complete", checked: ready && !!scan.sync?.initialComplete && !scan.sync.pending },
  ];
  return <div className="dashboard-grid">
    <div className="dashboard-main">
      {ownerIdentity ? <section className="dashboard-card owner-setup-card" aria-labelledby="owner-setup-title">
        <div className="card-heading"><div className="card-icon"><ShieldCheck size={22} aria-hidden="true" /></div><div><h2 id="owner-setup-title">Link your workspace</h2><p>This workspace needs to be linked to your signed-in account before you can connect Apple.</p></div></div>
        <details className="testing-panel"><summary>Workspace setup</summary><div className="testing-content"><p>Copy this setup identity for the person configuring your workspace.</p><label htmlFor="site-identity">Your Site identity</label><input id="site-identity" value={ownerIdentity} readOnly /><div className="action-row"><Button variant="outline" onClick={() => void navigator.clipboard.writeText(ownerIdentity).then(() => setCopied(true)).catch(() => setError("Copy didn’t work. Select the setup identity and copy it manually."))}><Copy size={16} aria-hidden="true" />{copied ? "Copied" : "Copy Site identity"}</Button><Button variant="ghost" disabled={busy} onClick={() => void refresh()}>Check setup</Button></div></div></details>
      </section> : <section className="dashboard-card" aria-labelledby="connection-title">
        <div className="card-heading"><div className="card-icon"><Cloud size={23} aria-hidden="true" /></div><div><h2 id="connection-title">{title}</h2><p>{description}</p></div></div>
        {ready ? <div className="account-banner"><ShieldCheck size={20} aria-hidden="true" /><span>Your connection is ready. Reminder changes are turned off.</span></div> : pending ? <div className="action-row"><Button className="action-primary" disabled={busy || now < (status?.nextAttemptAt ?? 0)} onClick={() => void action("/api/auth/resume")}><RefreshCw size={17} className={busyAction ? "animate-spin" : undefined} aria-hidden="true" />{busyAction ? "Checking approval…" : "Check Apple approval"}</Button>{status && status.nextAttemptAt > now && <p className="fine-print" role="status">Try again in {Math.ceil((status.nextAttemptAt - now) / 1000)} seconds.</p>}</div> : status?.gates.enabled && <><a className="button-link action-primary" href="/connect/apple" target="_top">{status.state === "CONNECTING" ? "Continue Apple sign-in" : "Connect Apple account"}<ArrowRight size={17} aria-hidden="true" /></a><div className="notice"><Info size={17} className="notice-icon" aria-hidden="true" /><p>This uses an unofficial iCloud connection. On the next page, this app processes your Apple password to sign in and Apple verifies your device.</p></div></>}
        <div className="action-row"><Button variant="outline" disabled={busy || scan.busy} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />{refreshing ? "Checking connection…" : "Refresh connection"}</Button></div>
      </section>}
      {error && !ownerIdentity && <p className="connection-error notice notice-warning" role="alert">{error}</p>}
      {ready ? <ControlledReadPanel key={status!.generation} generation={status!.generation} disabled={busyAction !== null} onScanChange={onScanChange} onSessionRejected={onSessionRejected} /> : <>
        <section className="dashboard-card"><div className="card-heading"><div className="card-icon"><ListChecks size={22} aria-hidden="true" /></div><div><h2>Your lists</h2><p>Find your lists and keep them up to date.</p></div></div><div className="action-row"><Button disabled>Start list scan</Button><Button variant="outline" disabled>Check for updates</Button></div><div className="empty-state"><ListChecks size={30} className="empty-icon" aria-hidden="true" /><p>{ownerIdentity ? "Finish workspace setup to get started." : "Connect your Apple account to find your lists."}</p></div></section>
        <section className="dashboard-card"><div className="card-heading"><h2>Preview reminders</h2></div><p className="fine-print">Once you’re connected, choose a list to check its open reminders.</p><details className="testing-panel"><summary>Testing &amp; details</summary><div className="testing-content"><p>Connection tests and response details will be available after you connect Apple.</p></div></details></section>
      </>}
    </div>
    <aside className="status-sidebar" aria-labelledby="status-title">
      <section className="dashboard-card"><div className="card-heading"><h2 id="status-title">Connection status</h2><span className={`status-pill ${ready ? "is-connected" : pending ? "is-pending" : "is-disconnected"}`}>{ready ? "Connected" : pending ? "Needs approval" : status ? "Not connected" : error ? "Unavailable" : "Checking"}</span></div>
        <ul className="status-checklist">{checks.map(item => <li key={item.label} className={item.checked ? "is-complete" : "is-pending"}><input type="checkbox" checked={item.checked} disabled aria-label={item.label} /><span>{item.label}</span></li>)}</ul>
        <div className="status-divider" /><dl className="status-metrics"><div><dt>Lists found</dt><dd>{ready ? scan.listCount : "—"}</dd></div><div><dt>Pages checked</dt><dd>{ready ? (scan.sync?.totalPages ?? scan.sync?.pages ?? 0) : "—"}</dd></div><div><dt>Last list check</dt><dd>{ready && scan.sync?.updatedAt ? dateText(scan.sync.updatedAt) : "Not yet"}</dd></div>{status?.expiresAt && !expired && <div><dt>Session until</dt><dd>{dateText(status.expiresAt)}</dd></div>}</dl>
        <p className="fine-print">{ready ? (scan.scanning ? "A list scan is running. Keep this page open until it finishes or pause it." : scan.auto?.runner === "unavailable" ? "ChatGPT checks for list updates when you ask for reminders." : scan.auto?.enabled && !scan.auto.pausedForError ? "Automatic list checks are enabled." : "Automatic checks are paused. ChatGPT can still check on demand.") : "Connect Apple to see your lists and scan progress."}</p>
        {status && ["READY", "DEVICE_APPROVAL_PENDING", "CONNECTING"].includes(status.state) && <div className="account-actions"><AlertDialog><AlertDialogTrigger asChild><Button variant="outline" className="disconnect-button" disabled={busy}><Unplug size={16} aria-hidden="true" />Disconnect Apple account</Button></AlertDialogTrigger><AlertDialogContent className="dialog-card"><AlertDialogHeader><AlertDialogTitle>Disconnect Apple account?</AlertDialogTitle><AlertDialogDescription>This removes the saved Apple connection and list scan progress from this workspace. You can connect again any time.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter className="dialog-actions"><AlertDialogCancel>Keep connected</AlertDialogCancel><AlertDialogAction className="disconnect-button" onClick={() => void action("/api/auth/disconnect")}>Disconnect Apple account</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>}
      </section>
      <div className="notice"><ShieldCheck size={17} className="notice-icon" aria-hidden="true" /><p>This workspace reads reminders. Editing and completing reminders are turned off.</p></div>
    </aside>
  </div>;
}
