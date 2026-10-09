import { z } from "zod";
import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { AppleSessionRepository, mergeSavedLists, type AppleSession, type AllOpenScan, type ResumeFence } from "../persistence/apple-sessions.ts";
import { CloudKitRateLimitedError, CloudKitRemindersClient, normalizeList, normalizeReminder, type CloudKitPage } from "../icloud/cloudkit.ts";
import { AppleAuthHTTP } from "./apple/http.ts";
import { advancePcs } from "./apple/pcs.ts";
import { appleDisabledMessage, appleGates, requireAppleEnabled } from "./gates.ts";

export const ResumeRequest = z.object({ expectedGeneration: z.number().int().nonnegative().safe() }).strict();
const common = { expectedGeneration: z.number().int().nonnegative().safe(), continuation: z.string().min(1).max(8192).nullable().optional(), limit: z.number().int().min(1).max(200).default(200) };
const listIdSchema = z.string().min(6).max(512).regex(/^List\/[^/\u0000-\u0020\u007f]+$/);
const authenticationFailure = (error: unknown) => error instanceof AppError && ["REAUTH_REQUIRED", "AUTH_EXPIRED", "TERMS_ACTION_REQUIRED", "VERIFICATION_REQUIRED"].includes(error.code);
export const ControlledRead = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("saved-lists"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("current-lists"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("refresh-saved-lists"), expectedGeneration: common.expectedGeneration }).strict(),
  z.object({ action: z.literal("probe-shared-lists"), expectedGeneration: common.expectedGeneration, listIds: z.array(z.string().min(6).max(512).startsWith("List/")).min(1).max(10) }).strict(),
  z.object({ action: z.literal("lookup-lists"), expectedGeneration: common.expectedGeneration, listIds: z.array(z.string().min(6).max(512).startsWith("List/")).min(1).max(10), expectedZoneOwner: z.string().min(1).max(256).optional() }).strict(),
  z.object({ action: z.literal("reminders-batch"), expectedGeneration: common.expectedGeneration, listIds: z.array(listIdSchema).min(1).max(2).refine(ids => new Set(ids).size === ids.length, "List IDs must be unique."), includeCompleted: z.boolean(), limit: common.limit }).strict(),
  z.object({ action: z.literal("reminders"), ...common, listId: listIdSchema, includeCompleted: z.boolean() }).strict(),
]);
type PageOptions = { action: "reminders"; listId: string; includeCompleted?: boolean };
interface MCPReadPage extends Record<string, unknown> {
  records: Record<string, unknown>[];
  recordErrors: { id: string | null; code: string }[];
  complete: boolean;
  paginationComplete: boolean;
  continuation: string | null;
  source: string;
  freshness: { mode: string; caughtUpAt?: number | null; retrievedAt?: number };
}
interface MCPReadResult { result: MCPReadPage; generation: number; liveReadValidated: boolean; writesEnabled: boolean; }
function normalizeReadPage(page: CloudKitPage, options: PageOptions, remindersZoneOwner?: string) {
  if (page.recordErrors.some(error => ["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.serverErrorCode.toUpperCase()))) throw new AppError("REAUTH_REQUIRED", "Apple rejected the Reminders read. Reconnect your Apple account.", 409);
  const auxiliaryRecordCounts: Record<string, number> = {};
  const relatedRecords: { id: string; recordType: string; deleted: boolean; appleRecord: Record<string, unknown> }[] = [];
  const records = page.records.flatMap<Record<string, unknown>>(record => {
    const recordType = "recordType" in record ? record.recordType : record.recordName.split("/")[0];
    if (recordType !== "Reminder") {
      auxiliaryRecordCounts[recordType] = (auxiliaryRecordCounts[recordType] ?? 0) + 1;
      relatedRecords.push({ id: record.recordName, recordType, deleted: record.deleted === true, appleRecord: record.raw });
      return [];
    }
    if (record.deleted) return [{ id: record.recordName, deleted: true, appleRecord: record.raw }];
    if (!("recordType" in record)) throw new AppError("PROTOCOL_CHANGED", "Apple omitted the type of a returned record.");
    const normalized = normalizeReminder(record, remindersZoneOwner);
    if (!options.includeCompleted && normalized.completed === true) return [];
    const { raw, ...safe } = normalized;
    return [{ ...safe, appleRecord: raw }];
  });
  return { records, recordErrors: page.recordErrors.map(error => ({ id: error.recordName, code: error.serverErrorCode, reason: error.reason, appleRecord: error.raw })), complete: page.complete, paginationComplete: page.paginationComplete, continuation: page.continuation, pendingReason: page.pendingReason, scope: "controlled-page", auxiliaryRecordCounts, auxiliaryDetailsIncluded: true, relatedRecords, listId: options.listId };
}

export class AppleConnectionService {
  readonly env: RuntimeEnv; readonly owner: string;
  constructor(env: RuntimeEnv, owner: string) { this.env = env; this.owner = owner; }
  async status() {
    const gates = appleGates(this.env);
    const session = await new AppleSessionRepository(this.env, this.owner).status();
    const readsAvailable = gates.enabled && session.transportReady;
    const { liveReadValidated: _readValidation, ...connection } = session;
    return { ...connection, listDiscovery: { strategy: "direct", liveValidated: false, experimental: true }, gates, connected: readsAvailable, writeEnabled: false, phase: "read-only", capabilities: { liveRead: readsAvailable, controlledRead: readsAvailable, listReminders: readsAvailable, allOpenReminders: readsAvailable, search: false, create: false, update: false, complete: false, reopen: false, delete: false }, validation: { fullProductAcceptance: false }, mcpTools: ["connection_status", "get_reminder_lists", "get_reminders", "get_all_open_reminders"], message: !gates.enabled ? appleDisabledMessage(gates) : session.state === "READY" ? "Read-only reminder tools are available. Use get_all_open_reminders for current open reminders across all lists. Known-list reminder reads use a current authorized lookup without catalogue scanning. List discovery queries current private-zone Lists directly, without historical synchronization. Reminder changes remain disabled." : session.state === "DEVICE_APPROVAL_PENDING" ? (session.action === "wait-for-reminders-keys" ? "Apple accepted device approval. Check again shortly while Apple makes the Reminders keys available." : "Approve Apple's web-access prompt on your device, then check approval again.") : "Connect your Apple account through the private Site's secure connection form." };
  }
  async disconnect() { return await new AppleSessionRepository(this.env, this.owner).disconnect(); }
  private async operation<T>(expectedGeneration: number, mode: "read" | "pcs", run: (http: AppleAuthHTTP, saved: Awaited<ReturnType<AppleSessionRepository["load"]>>, repository: AppleSessionRepository, fence: ResumeFence) => Promise<T>) {
    requireAppleEnabled(this.env);
    const repository = new AppleSessionRepository(this.env, this.owner);
    const saved = await repository.load();
    if (saved.fence.generation !== expectedGeneration) throw new AppError("CONFLICT", "The Apple session changed. Refresh status before continuing.", 409);
    if (mode === "pcs" && Date.now() < saved.session.pcs.nextAttemptAt) throw new AppError("RATE_LIMITED", "Wait until the displayed retry time before checking approval.", 429, true);
    const fence = mode === "pcs" ? await repository.claimResume(expectedGeneration, saved.fence.version) : await repository.claimRead(expectedGeneration, saved.fence.version);
    const http = AppleAuthHTTP.restore(saved.session.auth);
    try { return await run(http, saved, repository, fence); }
    catch (error) {
      if (authenticationFailure(error)) await repository.invalidate(fence);
      throw error;
    } finally { await repository.releaseResume(fence); }
  }
  async resume(expectedGeneration: number) {
    await this.operation(expectedGeneration, "pcs", async (http, saved, repository, fence) => {
      const result = await advancePcs(http, saved.session.connection.dsid, saved.session.pcs);
      await repository.commitResume(fence, { ...saved.session, auth: http.snapshot(), pcs: result.checkpoint }, result.state, result.state === "DEVICE_APPROVAL_PENDING" ? result.action : undefined);
    });
    return this.status();
  }
  private async fetchDirectLists(http: AppleAuthHTTP, session: AppleSession) {
    const client = new CloudKitRemindersClient(http.http, session.connection);
    const found = await client.queryAllLists();
    if (!found.complete) throw new AppError("UNSUPPORTED_FEATURE", "Direct list discovery did not finish within its safe limits or returned record errors. The previous snapshot is preserved. Retry a refresh; if the error persists, direct discovery is not supported for this account or exceeds the current limits.", 409);
    const now = Date.now();
    const records = found.lists.map(({ raw: _raw, ...list }) => list);
    const savedLists = mergeSavedLists([], records, now);
    return { records, pagesRead: found.pagesRead, session: { ...session,
      connection: { ...session.connection, remindersZoneOwner: client.remindersZoneOwner },
      savedLists, directListSnapshot: { updatedAt: now },
      auth: http.snapshot() } };
  }
  async getCurrentLists(expectedGeneration: number): Promise<MCPReadResult> {
    return this.operation(expectedGeneration, "read", async (http, saved, repository, fence) => {
      const current = await this.fetchDirectLists(http, saved.session);
      await repository.commitResume(fence, current.session, "READY");
      return { result: { records: current.records, recordErrors: [], complete: true, paginationComplete: true,
        continuation: null, pendingReason: null, source: "direct-cloudkit-query", freshness: { mode: "live", retrievedAt: current.session.directListSnapshot.updatedAt },
        listDiscovery: { strategy: "direct", experimental: true, retrievedAt: current.session.directListSnapshot.updatedAt }, pagesRead: current.pagesRead },
        generation: fence.generation, liveReadValidated: false, writesEnabled: false };
    });
  }
  async readForMCP(input: z.infer<typeof ControlledRead>): Promise<MCPReadResult> {
    if (input.action !== "saved-lists" && input.action !== "reminders") throw new AppError("VALIDATION_ERROR", "This MCP read supports only lists or current reminders.", 400);
    if (input.action === "reminders") {
      const read = await this.controlledRead(input);
      return { ...read, result: { ...read.result as MCPReadPage, freshness: { mode: "live" }, source: "direct-known-list-query" } };
    }
    return this.getCurrentLists(input.expectedGeneration);
  }
  private async startAllOpenScan(expectedGeneration: number, continuation: string | null) {
    return this.operation(expectedGeneration, "read", async (http, saved, repository, fence) => {
      let session = saved.session;
      if (!continuation) session = (await this.fetchDirectLists(http, session)).session;
      let scan: AllOpenScan;
      if (continuation) {
        if (!session.allOpenScan || session.allOpenScan.token !== continuation) throw new AppError("CONFLICT", "The all-open continuation was replaced or already used. Restart the all-open read.", 409);
        if (session.allOpenScan.expiresAt <= Date.now()) {
          await repository.commitResume(fence, { ...session, allOpenScan: undefined }, "READY");
          throw new AppError("RESTART_REQUIRED", "The ten-minute all-open read expired. Start a new all-open read.", 409);
        }
        scan = { ...session.allOpenScan, token: crypto.randomUUID() };
      } else {
        const lists = session.savedLists ?? [];
        scan = { source: "direct-cloudkit-query", lists: lists.filter(list => !list.deleted && !list.isGroup), token: crypto.randomUUID(), expiresAt: Math.min(Date.now() + 600_000, session.login.expiresAt), listIds: lists.filter(list => !list.deleted && !list.isGroup).map(list => list.id), index: 0, cursor: null, seen: [], listPages: 0, totalPages: 0, caughtUpAt: session.directListSnapshot!.updatedAt };
      }
      // Rotation is fenced before the first query, making the supplied token
      // single-use even when another instance resumes concurrently.
      await repository.commitResume(fence, { ...session, allOpenScan: scan.listIds.length ? scan : undefined }, "READY");
      return { scan, lists: scan.lists };
    });
  }
  private async allOpenPage(expectedGeneration: number, token: string, remainingBytes: number, remainingRecords: number) {
    return this.operation(expectedGeneration, "read", async (http, saved, repository, fence) => {
      const session = saved.session; const scan = session.allOpenScan;
      if (!scan || scan.token !== token) throw new AppError("CONFLICT", "The all-open read changed. Restart with the latest continuation.", 409);
      if (scan.expiresAt <= Date.now()) {
        await repository.commitResume(fence, { ...session, allOpenScan: undefined }, "READY");
        throw new AppError("RESTART_REQUIRED", "The ten-minute all-open read expired. Start a new all-open read.", 409);
      }
      if (scan.totalPages >= 10000 || scan.listPages >= 1000) throw new AppError("UNSUPPORTED_FEATURE", "The all-open read reached its safe pagination limit. Start a new read.", 409);
      const next: AllOpenScan = { ...scan, token: crypto.randomUUID() };
      const listId = scan.listIds[scan.index];
      let records: Record<string, unknown>[] = [];
      let recordErrors: { id: string | null; code: string }[] = [];
      let reason: string | null = null;
      let queried = false;
      {
        const client = new CloudKitRemindersClient(http.http, session.connection);
        const page = await client.queryRemindersPage({ listId, includeCompleted: false, limit: 200, continuation: scan.cursor });
        queried = true;
        records = page.records.flatMap(record => {
          if (!("recordType" in record) || record.recordType !== "Reminder" || record.deleted) return [];
          const { raw: _raw, ...reminder } = normalizeReminder(record, client.remindersZoneOwner);
          return reminder.deleted || reminder.completed === true ? [] : [reminder];
        });
        if (records.length > 200) throw new AppError("PROTOCOL_CHANGED", "Apple returned more reminders than the all-open page budget.");
        recordErrors = page.recordErrors.map(error => ({ id: error.recordName, code: error.serverErrorCode }));
        if (recordErrors.some(error => ["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.code))) throw new AppError("REAUTH_REQUIRED", "Apple rejected the all-open reminder read. Reconnect your Apple account.", 409);
        if (recordErrors.length) records = [];
        const bytes = new TextEncoder().encode(JSON.stringify({ records, recordErrors })).length;
        if (bytes > 1_048_576 - 4096) throw new AppError("UNSUPPORTED_FEATURE", "One current reminder page exceeds the all-open response budget. Read individual lists instead.", 409);
        if (bytes > remainingBytes || records.length > remainingRecords) {
          // Do not acknowledge a page that cannot fit. The next invocation
          // re-queries this exact input cursor rather than skipping its records.
          records = []; recordErrors = []; reason = "response-limit";
        } else if (recordErrors.length) {
          reason = "record_errors";
        } else {
          next.totalPages++; next.listPages++;
          if (page.continuation !== null) {
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(page.continuation));
            const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
            if (scan.seen.includes(fingerprint)) throw new AppError("PROTOCOL_CHANGED", "Apple repeated an all-open reminder continuation. Start a new read.");
            next.cursor = page.continuation; next.seen = [...scan.seen, fingerprint];
          } else {
            next.index++; next.cursor = null; next.seen = []; next.listPages = 0;
          }
        }
      }
      const complete = next.index >= next.listIds.length;
      await repository.commitResume(fence, { ...session, allOpenScan: complete ? undefined : next, auth: http.snapshot() }, "READY");
      return { scan: next, records, recordErrors, reason, queried };
    });
  }
  async readAllOpenForMCP(expectedGeneration: number, continuation?: string | null) {
    const token = continuation ?? null;
    if (token !== null && !z.string().uuid().safeParse(token).success) throw new AppError("VALIDATION_ERROR", "The all-open continuation is invalid.", 400);
    const started = await this.startAllOpenScan(expectedGeneration, token);
    const until = Date.now() + 20_000;
    let scan = started.scan;
    const records: Record<string, unknown>[] = [];
    const recordErrors: { id: string | null; code: string }[] = [];
    const errors: { code: string; retryable: boolean; retryAfterSeconds?: number }[] = [];
    let pagesRead = 0;
    let reason: string | null = null;
    const resultFor = () => {
      const complete = scan.index >= scan.listIds.length && recordErrors.length === 0 && errors.length === 0;
      return { records, lists: started.lists, recordErrors, errors, complete, paginationComplete: complete, continuation: complete ? null : scan.token,
        pendingReason: complete ? null : reason ?? (Date.now() >= until ? "deadline" : "page-budget"),
        progress: { listsTotal: scan.listIds.length, listsCompleted: scan.index, pagesRead, totalPages: scan.totalPages },
        source: "direct-cloudkit-query", freshness: { mode: "live", retrievedAt: scan.caughtUpAt }, scope: "all-open-reminders" };
    };
    let bytesUsed = new TextEncoder().encode(JSON.stringify(resultFor())).length + 4096;
    if (bytesUsed > 1_048_576) throw new AppError("UNSUPPORTED_FEATURE", "The saved list summaries exceed the all-open response budget. Read individual lists instead.", 409);
    while (scan.index < scan.listIds.length && pagesRead < 20 && records.length < 5000 && Date.now() < until) {
      try {
        const page = await this.allOpenPage(expectedGeneration, scan.token, 1_048_576 - bytesUsed, 5000 - records.length);
        scan = page.scan; if (page.queried) pagesRead++;
        records.push(...page.records); recordErrors.push(...page.recordErrors);
        bytesUsed += new TextEncoder().encode(JSON.stringify({ records: page.records, recordErrors: page.recordErrors })).length;
        if (page.reason) { reason = page.reason; break; }
      } catch (error) {
        if (error instanceof AppError && ["RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "CONFLICT"].includes(error.code)) {
          // A failed query never acknowledges a page. Expose the rotated token
          // only after checking it is still the owner's current saved scan.
          const current = await new AppleSessionRepository(this.env, this.owner).load();
          if (current.fence.generation !== expectedGeneration || current.session.allOpenScan?.token !== scan.token || current.session.allOpenScan.expiresAt <= Date.now()) throw new AppError("CONFLICT", "The all-open scan changed during this request. Start a new all-open read.", 409);
          const retryAfterSeconds = error instanceof CloudKitRateLimitedError ? error.retryAfterSeconds : null;
          errors.push({ code: error.code, retryable: true, ...(retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? { retryAfterSeconds } : {}) }); reason = "read_error"; break;
        }
        throw error;
      }
    }
    return { result: resultFor(), generation: expectedGeneration, liveReadValidated: false, writesEnabled: false };
  }
  private async authorizeLists(client: CloudKitRemindersClient, ids: string[]) {
    if (client.remindersZoneOwner === undefined && !(await client.listZones()).available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
    const found = await client.lookup(ids, true);
    for (const error of found.recordErrors) {
      if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("REAUTH_REQUIRED", "Apple rejected the list lookup. Reconnect your Apple account.", 409);
      if (["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("FORBIDDEN", "Apple denied access to the requested list.", 403);
      if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(error.serverErrorCode.toUpperCase())) throw new CloudKitRateLimitedError(null);
      if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode.toUpperCase())) throw new AppError("FORBIDDEN", "The requested list is not accessible.", 403);
      throw new AppError("PROTOCOL_CHANGED", "Apple could not verify the requested list.");
    }
    if (!found.complete || found.records.length !== ids.length) throw new AppError("PROTOCOL_CHANGED", "Apple omitted a requested list authorization result.");
    for (const record of found.records) {
      if (!("recordType" in record) || record.recordType !== "List" || record.deleted) throw new AppError("FORBIDDEN", "The requested list is unavailable.", 403);
      const list = normalizeList(record, false);
      if (list.deleted || list.isGroup) throw new AppError("FORBIDDEN", "The requested list is unavailable or is a group.", 403);
    }
  }
  async read(input: z.infer<typeof ControlledRead>) {
    if (input.action === "current-lists") return this.getCurrentLists(input.expectedGeneration);
    return this.controlledRead(input);
  }
  private async controlledRead(input: z.infer<typeof ControlledRead>) {
    return this.operation(input.expectedGeneration, "read", async (http, saved, repository, fence) => {
      const client = new CloudKitRemindersClient(http.http, saved.session.connection);
      let result: unknown;
      let connection = saved.session.connection;
      let savedLists = saved.session.savedLists ?? [];
      if (input.action === "current-lists") throw new AppError("VALIDATION_ERROR", "Use current list discovery.", 400);
      if (input.action === "saved-lists") {
        result = { records: savedLists, recordErrors: [], complete: true, paginationComplete: true, continuation: null, pendingReason: null, scope: "saved-list-snapshot", auxiliaryRecordCounts: {}, auxiliaryDetailsIncluded: false, listDiscovery: { strategy: "direct", experimental: true, retrievedAt: saved.session.directListSnapshot?.updatedAt ?? null } };
      } else if (input.action === "discover") {
        const discovered = await client.listZones();
        if (client.remindersZoneOwner !== undefined) connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        // Do not expose unrelated private zone names or arbitrary Apple fields.
        result = { available: discovered.available, complete: discovered.complete, zoneDiagnostics: discovered.zones.map(zone => ({ category: zone.zoneID.zoneName === "Reminders" ? "primary-reminders" : zone.zoneID.zoneName.toLowerCase().includes("reminder") ? "other-reminders" : "other", type: zone.zoneID.zoneType ?? null, matchesPrimaryOwner: (zone.zoneID.ownerRecordName ?? "__defaultOwner__") === client.remindersZoneOwner, deleted: zone.deleted })), remindersZone: discovered.remindersZone ? { zoneID: { zoneName: discovered.remindersZone.zoneID.zoneName, ...(discovered.remindersZone.zoneID.zoneType ? { zoneType: discovered.remindersZone.zoneID.zoneType } : {}) }, deleted: discovered.remindersZone.deleted } : null };
      } else if (input.action === "probe-shared-lists") {
        result = await client.probeSharedLists(input.listIds);
      } else if (input.action === "lookup-lists" || input.action === "refresh-saved-lists") {
        if (client.remindersZoneOwner === undefined) {
          const discovered = await client.listZones();
          if (!discovered.available) throw new AppError("PROTOCOL_CHANGED", "Apple did not return an available private Reminders zone.");
          connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        }
        if (input.action === "lookup-lists" && input.expectedZoneOwner !== undefined && input.expectedZoneOwner !== client.remindersZoneOwner) throw new AppError("FORBIDDEN", "The supplied zone owner does not match this Apple session.", 403);
        const listIds = input.action === "lookup-lists" ? input.listIds : savedLists.slice(0, 100).map(list => list.id);
        if (!listIds.length) throw new AppError("VALIDATION_ERROR", "There are no saved lists to refresh.", 400);
        const found = await client.lookup(listIds, true);
        if (found.unresolvedRecordNames.length) throw new AppError("PROTOCOL_CHANGED", "Apple omitted a requested list from its lookup response.");
        const records = [...found.records.map(record => {
          if (record.deleted) return { id: record.recordName, deleted: true };
          if (!("recordType" in record) || record.recordType !== "List") throw new AppError("PROTOCOL_CHANGED", "Apple returned an unexpected record in the list lookup.");
          const { raw, ...summary } = normalizeList(record, false); return summary;
        }), ...found.recordErrors.flatMap(error => error.recordName && ["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode) ? [{ id: error.recordName, deleted: true }] : [])];
        savedLists = mergeSavedLists(savedLists, records);
        result = { records, recordErrors: found.recordErrors.map(error => ({ id: error.recordName, code: error.serverErrorCode })), complete: found.complete, paginationComplete: true, continuation: null, pendingReason: found.complete ? null : "record_errors", scope: "controlled-lookup", auxiliaryRecordCounts: {}, auxiliaryDetailsIncluded: false, unrefreshedLists: input.action === "refresh-saved-lists" ? Math.max(0, saved.session.savedLists!.length - listIds.length) : 0 };
      } else if (input.action === "reminders-batch") {
        // Drain every request while this operation still owns the lease and jar.
        // An authentication rejection must invalidate the session even if a
        // different request reports an ordinary upstream error first.
        await this.authorizeLists(client, input.listIds);
        connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        const pages = await Promise.allSettled(input.listIds.map(listId => client.queryRemindersPage({ listId, includeCompleted: input.includeCompleted, limit: input.limit })));
        const failures = pages.filter((page): page is PromiseRejectedResult => page.status === "rejected");
        if (failures.length) throw (failures.find(page => authenticationFailure(page.reason)) ?? failures[0]).reason;
        result = { pages: pages.map((page, index) => {
          if (page.status !== "fulfilled") throw new AppError("PROTOCOL_CHANGED", "Apple did not return a requested reminders page.");
          return normalizeReadPage(page.value, { action: "reminders", listId: input.listIds[index], includeCompleted: input.includeCompleted }, client.remindersZoneOwner);
        }) };
      } else {
        if (input.action === "reminders") await this.authorizeLists(client, [input.listId]);
        if (client.remindersZoneOwner !== undefined) connection = { ...connection, remindersZoneOwner: client.remindersZoneOwner };
        const page = await client.queryRemindersPage({ listId: input.listId, includeCompleted: input.includeCompleted, continuation: input.continuation, limit: input.limit });
        const normalized = normalizeReadPage(page, input, client.remindersZoneOwner);
        result = normalized;
      }
      // Cookie changes and the response share a generation/version fence. A
      // concurrent disconnect prevents both the save and a successful response.
      await repository.commitResume(fence, { ...saved.session, connection, savedLists, auth: http.snapshot() }, "READY");
      result = { ...(result as Record<string, unknown>), requestTrace: client.readTrace };
      return { result, generation: fence.generation, liveReadValidated: false, writesEnabled: false };
    });
  }
}
