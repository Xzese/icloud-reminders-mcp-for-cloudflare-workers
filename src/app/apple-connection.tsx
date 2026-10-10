"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Cloud, Copy, Info, ListChecks, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import ControlledReadPanel, { type ReadSummary } from "./controlled-read";

interface Status {
  state: string;
  generation: number;
  nextAttemptAt: number;
  transportReady: boolean;
  writeEnabled: boolean;
  capabilities?: { complete: boolean; reopen: boolean; delete: boolean };
  action: string | null;
  expiresAt: number | null;
  retentionDays: number | null;
  retentionSource: string | null;
  lastValidatedAt: number | null;
  lastAppleSuccessAt: number | null;
  lastRenewedAt: number | null;
  nextRetryAt: number | null;
  requiredAction: string | null;
  message: string;
  gates: { enabled: boolean; cryptographyReviewed: boolean; liveConnectionApproved: boolean };
}
class ConnectionError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json() as { error?: { message?: string; code?: string } };
  if (!response.ok) throw new ConnectionError(value.error?.message ?? "That action didn’t finish. Please try again.", value.error?.code);
  return value as T;
}
const emptyRead: ReadSummary = { busy: false };
const dateText = (value: number) => new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function AppleConnection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [ownerIdentity, setOwnerIdentity] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [readState, setReadState] = useState<ReadSummary>(emptyRead);
  const [now, setNow] = useState(() => Date.now());
  const revision = useRef(0);
  const statusRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const errorSource = useRef<"status" | "action" | null>(null);
  const [approval, setApproval] = useState({ generation: -1, attempts: 0, failures: 0, lastAttemptAt: 0, paused: false });
  const onReadChange = useCallback((next: ReadSummary) => setReadState(next), []);
  const refresh = useCallback(async (automatic = false) => {
    if (automatic && (statusRequest.current || actionRequest.current)) return;
    const current = ++revision.current;
    statusRequest.current?.abort();
    const controller = new AbortController(); statusRequest.current = controller;
    if (!automatic) setRefreshing(true);
    try {
      const next = await call<Status>("/api/connection", undefined, controller.signal);
      if (current !== revision.current) return;
      setStatus(next); setNow(Date.now()); setOwnerIdentity(null); if (!automatic || errorSource.current === "status") { setError(""); errorSource.current = null; }
      if (next.state !== "READY") setReadState(emptyRead);
    } catch (e) {
      if (current !== revision.current || controller.signal.aborted) return;
      errorSource.current = "status";
      setError(e instanceof Error ? e.message : "Connection status is unavailable. Try again in a moment.");
      if (e instanceof ConnectionError && e.code === "OWNER_NOT_CONFIGURED") {
        try {
          const identity = await call<{ authenticatedUserId: string; automaticOwnerClaim: boolean }>("/api/bootstrap/identity", undefined, controller.signal);
          if (current === revision.current && identity.automaticOwnerClaim === false) setOwnerIdentity(identity.authenticatedUserId);
        } catch { if (current === revision.current) setOwnerIdentity(null); }
      }
    } finally {
      if (current === revision.current) { statusRequest.current = null; setRefreshing(false); }
    }
  }, []);
  useEffect(() => { let mounted = true; const revisionRef = revision; const requestRef = statusRequest; queueMicrotask(() => { if (mounted) void refresh(); }); return () => { mounted = false; revisionRef.current++; requestRef.current?.abort(); actionRequest.current?.abort(); }; }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), status?.state === "DEVICE_APPROVAL_PENDING" ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [status?.state]);
  const expired = !!status?.expiresAt && status.expiresAt <= now;
  useEffect(() => { if (!expired || status?.state !== "READY") return; const timer = setTimeout(() => void refresh(), 0); return () => clearTimeout(timer); }, [expired, status?.state, refresh]);
  const onSessionRejected = useCallback((message: string) => { setError(message); void refresh(); }, [refresh]);
  const action = useCallback(async (path: string, automatic = false) => {
    if (!status || busyAction || refreshing || actionRequest.current || (automatic && statusRequest.current)) return;
    const controller = new AbortController(); actionRequest.current = controller;
    setBusyAction(path); setError(""); errorSource.current = null;
    revision.current++; statusRequest.current?.abort();
    if (path === "/api/auth/resume") setApproval(previous => ({
      generation: status.generation, attempts: (previous.generation === status.generation ? previous.attempts : 0) + 1,
      failures: previous.generation === status.generation ? previous.failures : 0, lastAttemptAt: Date.now(), paused: false,
    }));
    try {
      await call(path, { expectedGeneration: status.generation, ...(path === "/api/auth/resume" && !automatic ? { restartApproval: true } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      if (path === "/api/auth/resume") setApproval(previous => ({ ...previous, failures: 0 }));
      await refresh();
    } catch (e) {
      if (controller.signal.aborted) return;
      // A failed request can still have saved a fenced result. Restore status
      // before deciding whether another approval check is appropriate.
      await refresh();
      if (automatic) setApproval(previous => {
        const failures = previous.failures + 1;
        const transient = !(e instanceof ConnectionError) || ["CONFLICT", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE"].includes(e.code ?? "");
        return { ...previous, failures, paused: !transient || failures >= 3 };
      });
      errorSource.current = "action";
      setError(e instanceof Error ? e.message : "That action didn’t finish. Please try again.");
    } finally {
      if (actionRequest.current === controller) { actionRequest.current = null; setBusyAction(null); }
    }
  }, [status, busyAction, refreshing, refresh]);
  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try { if (document.visibilityState !== "hidden") await refresh(true); }
      finally {
        polling = false;
        if (!stopped) timer = setTimeout(() => void poll(), status?.state === "CONNECTING" || status?.state === "DEVICE_APPROVAL_PENDING" ? 5000 : 30_000);
      }
    };
    const visible = () => { if (document.visibilityState !== "hidden") { clearTimeout(timer); void poll(); } };
    timer = setTimeout(() => void poll(), status?.state === "CONNECTING" || status?.state === "DEVICE_APPROVAL_PENDING" ? 5000 : 30_000);
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [status?.state, refresh]);
  const approvalPaused = !!status && approval.generation === status.generation && (approval.paused || approval.attempts >= 8);
  useEffect(() => {
    if (!status?.gates.enabled || status.state !== "DEVICE_APPROVAL_PENDING" || expired || refreshing || busyAction || approvalPaused) return;
    const previous = approval.generation === status.generation ? approval : null;
    const nextCheck = Math.max(status.nextAttemptAt, previous ? previous.lastAttemptAt + Math.min(60_000, 15_000 * 2 ** previous.failures) : 0);
    const timer = setTimeout(() => {
      if (document.visibilityState !== "hidden") void action("/api/auth/resume", true);
    }, Math.max(0, nextCheck - Date.now()));
    return () => clearTimeout(timer);
  }, [status, expired, refreshing, busyAction, approval, approvalPaused, action]);
  const needsVerification = status?.requiredAction === "verify-device" || status?.requiredAction === "apple-sign-in";
  const termsRequired = status?.requiredAction === "review-terms";
  const coolingDown = !!status?.nextRetryAt && status.nextRetryAt > now;
  const localExpired = expired || status?.requiredAction === "local-retention-expired";
  const ready = !!status?.gates.enabled && status.state === "READY" && status.transportReady && !expired && !needsVerification && !termsRequired && !coolingDown;
  const pending = status?.state === "DEVICE_APPROVAL_PENDING" && !expired;
  const busy = refreshing || busyAction !== null;
  const title = !status ? (error ? "Connection unavailable" : "Checking your connection…") : localExpired ? "Local connection window expired" : status.requiredAction === "apple-sign-in" ? "Apple sign-in required" : needsVerification ? "Apple verification required" : termsRequired ? "Review Apple terms" : coolingDown ? "Connection temporarily unavailable" : ready ? "Apple account connected" : pending ? "Approve access on your Apple device" : !status.gates.enabled ? "Apple connection is paused" : "Connect your Apple account";
  const description = !status ? (error ? "Your connection status could not be loaded. Refresh to try again." : "We’re checking whether your Apple account is connected.") : localExpired ? "The fixed application retention window ended. A new sign-in creates a new window." : needsVerification || termsRequired || coolingDown ? status.message : ready ? "You’re ready to find your lists and manage your reminders." : pending ? (status.action === "wait-for-reminders-keys" ? "Your device approval was accepted. Apple is preparing access to your reminders." : "Allow web access when Apple asks on your trusted device. We’ll check approval automatically while this page is open.") : !status.gates.enabled ? "The Apple connection is currently unavailable. You can check again here when it’s enabled." : "Connect once, then use ChatGPT or this page to check your reminders.";
  const checks = [
    { label: "Workspace signed in", checked: true },
    { label: "Apple account connected", checked: ready },
    { label: "Reminders access ready", checked: ready },
    { label: "Create and edit enabled", checked: ready && status?.writeEnabled === true },
    { label: "Complete and delete enabled", checked: ready && status?.capabilities?.delete === true },
  ];
  return <div className="dashboard-grid">
    <div className="dashboard-main">
      {ownerIdentity ? <section className="dashboard-card owner-setup-card" aria-labelledby="owner-setup-title">
        <div className="card-heading"><div className="card-icon"><ShieldCheck size={22} aria-hidden="true" /></div><div><h2 id="owner-setup-title">Link your workspace</h2><p>This workspace needs to be linked to your signed-in account before you can connect Apple.</p></div></div>
        <details className="testing-panel"><summary>Workspace setup</summary><div className="testing-content"><p>Copy this setup identity for the person configuring your workspace.</p><label htmlFor="site-identity">Your Site identity</label><input id="site-identity" value={ownerIdentity} readOnly /><div className="action-row"><Button variant="outline" onClick={() => void navigator.clipboard.writeText(ownerIdentity).then(() => setCopied(true)).catch(() => setError("Copy didn’t work. Select the setup identity and copy it manually."))}><Copy size={16} aria-hidden="true" />{copied ? "Copied" : "Copy Site identity"}</Button><Button variant="ghost" disabled={busy} onClick={() => void refresh()}>Check setup</Button></div></div></details>
      </section> : <section className="dashboard-card" aria-labelledby="connection-title">
        <div className="card-heading"><div className="card-icon"><Cloud size={23} aria-hidden="true" /></div><div><h2 id="connection-title">{title}</h2><p>{description}</p></div></div>
        {ready ? <div className="account-banner"><ShieldCheck size={20} aria-hidden="true" /><span>You can create, edit, complete, reopen and delete reminders with ChatGPT.</span></div> : termsRequired || coolingDown ? <p className="fine-print" role="status">Your encrypted connection is preserved. {status?.nextRetryAt ? `Retry after ${dateText(status.nextRetryAt)}.` : "Resolve the required action through Apple's official interface."}</p> : pending ? <div className="action-row"><Button className="action-primary" disabled={busy || now < (status?.nextAttemptAt ?? 0)} onClick={() => void action("/api/auth/resume")}><RefreshCw size={17} className={busyAction ? "animate-spin" : undefined} aria-hidden="true" />{busyAction ? "Checking approval…" : "Check Apple approval"}</Button><p className="fine-print" role="status">{approvalPaused ? "Automatic approval checks are paused. Check again manually to start a new bounded attempt; your Apple account is preserved." : "We’re checking Apple approval automatically. You can also check now."}</p></div> : status?.gates.enabled && <><a className="button-link action-primary" href="/connect/apple" target="_top">{status.state === "CONNECTING" ? "Continue Apple sign-in" : "Connect Apple account"}<ArrowRight size={17} aria-hidden="true" /></a><div className="notice"><Info size={17} className="notice-icon" aria-hidden="true" /><p>This uses an unofficial iCloud connection. On the next page, this app processes your Apple password to sign in and Apple verifies your device.</p></div></>}
        {status?.retentionSource === "owner-authorised-migration" && <p className="fine-print">Your saved connection now uses a {status.retentionDays}-day session window. No new Apple sign-in was needed for this update.</p>}
        <div className="action-row"><Button variant="outline" disabled={busy || readState.busy} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />{refreshing ? "Checking connection…" : "Refresh connection"}</Button></div>
      </section>}
      {error && !ownerIdentity && <p className="connection-error notice notice-warning" role="alert">{error}</p>}
      {ready ? <ControlledReadPanel key={status!.generation} generation={status!.generation} disabled={busyAction !== null} onReadChange={onReadChange} onSessionRejected={onSessionRejected} /> : <>
        <section className="dashboard-card"><div className="card-heading"><div className="card-icon"><ListChecks size={22} aria-hidden="true" /></div><div><h2>Your lists</h2><p>Retrieve current lists directly from Apple.</p></div></div><div className="empty-state"><ListChecks size={30} className="empty-icon" aria-hidden="true" /><p>{ownerIdentity ? "Finish workspace setup to get started." : "Connect your Apple account to refresh your lists."}</p></div></section>
        <section className="dashboard-card"><div className="card-heading"><h2>Preview reminders</h2></div><p className="fine-print">Once you’re connected, choose a list to check its open reminders.</p><details className="testing-panel"><summary>Testing &amp; details</summary><div className="testing-content"><p>Connection tests and response details will be available after you connect Apple.</p></div></details></section>
      </>}
    </div>
    <aside className="status-sidebar" aria-labelledby="status-title">
      <section className="dashboard-card"><div className="card-heading"><h2 id="status-title">Connection status</h2><span className={`status-pill ${ready ? "is-connected" : pending ? "is-pending" : "is-disconnected"}`}>{ready ? "Connected" : pending ? "Needs approval" : status ? "Not connected" : error ? "Unavailable" : "Checking"}</span></div>
        <ul className="status-checklist">{checks.map(item => <li key={item.label} className={item.checked ? "is-complete" : "is-pending"}><input type="checkbox" checked={item.checked} disabled aria-label={item.label} /><span>{item.label}</span></li>)}</ul>
        <div className="status-divider" /><dl className="status-metrics">{status?.expiresAt && !expired && <div><dt>Connection allowed until</dt><dd>{dateText(status.expiresAt)}</dd></div>}{status?.lastValidatedAt && <div><dt>Last session check</dt><dd>{dateText(status.lastValidatedAt)}</dd></div>}{status?.lastAppleSuccessAt && <div><dt>Last Apple operation</dt><dd>{dateText(status.lastAppleSuccessAt)}</dd></div>}{status?.lastRenewedAt && <div><dt>Last token renewal</dt><dd>{dateText(status.lastRenewedAt)}</dd></div>}</dl>
        {status?.expiresAt && !expired && <p className="fine-print">Apple may require verification before this date. Status polling does not contact Apple.</p>}
        <p className="fine-print">{ready ? "Use Refresh lists above for current Apple data. This panel reads the saved list snapshot." : "Connect Apple to read your reminders."}</p>
        {status && ["READY", "DEVICE_APPROVAL_PENDING", "CONNECTING"].includes(status.state) && <div className="account-actions"><AlertDialog><AlertDialogTrigger asChild><Button variant="outline" className="disconnect-button" disabled={busy}><Unplug size={16} aria-hidden="true" />Disconnect Apple account</Button></AlertDialogTrigger><AlertDialogContent className="dialog-card"><AlertDialogHeader><AlertDialogTitle>Disconnect Apple account?</AlertDialogTitle><AlertDialogDescription>This removes the saved Apple connection and list snapshot from this workspace. You can connect again any time.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter className="dialog-actions"><AlertDialogCancel>Keep connected</AlertDialogCancel><AlertDialogAction className="disconnect-button" onClick={() => void action("/api/auth/disconnect")}>Disconnect Apple account</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>}
      </section>
      <div className="notice"><ShieldCheck size={17} className="notice-icon" aria-hidden="true" /><p>{status?.writeEnabled ? (status?.capabilities?.delete ? "Creating, editing, completing, reopening and deleting are enabled for supported reminders." : "Creating and editing are enabled. Completing and deleting reminders remain turned off.") : "This workspace reads reminders. Creating and editing are turned off."}</p></div>
    </aside>
  </div>;
}
