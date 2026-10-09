import { z } from "zod";
import { AuthSnapshotSchema, type AuthSnapshot } from "../auth/apple/http.ts";
import type { PcsCheckpoint } from "../auth/apple/pcs.ts";
import { Envelopes, type Envelope, type EnvelopeContext } from "../crypto/envelopes.ts";
import { AppError } from "../errors.ts";
import type { CloudKitConnection } from "../icloud/cloudkit.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { validatedAppleURL } from "../transport/apple-http.ts";
import { LoginAssuranceSchema, requireCurrentLogin, type LoginAssurance } from "../auth/apple/policy.ts";

const ACCOUNT = "apple-reminders";
const RECORD = "apple-session";
const SETUP_LEASE_MS = 180_000;
const RESUME_LEASE_MS = 30_000;
const APPROVAL_ACTIONS = ["approve-device-consent", "wait-for-reminders-keys"] as const;
const cloudKitURL = z.string().max(2048).url().refine((value) => {
  try {
    const url = validatedAppleURL(value, true);
    return url.pathname === "/database/1/com.apple.reminders/production/private" && !url.search;
  } catch { return false; }
}, "Invalid CloudKit service URL.");
const CloudKitConnectionSchema = z.object({
  dsid: z.string().min(1).max(32).regex(/^\d+$/),
  clientId: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/),
  clientBuildNumber: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  clientMasteringNumber: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  cloudKitURL,
  remindersZoneOwner: z.string().min(1).max(256).refine(value => !/[\u0000-\u0020\u007f]/.test(value)).optional(),
}).strict();
const PcsCheckpointSchema = z.object({
  consentRequested: z.boolean(),
  pcsAttempts: z.number().int().min(0).max(10),
  consentChecks: z.number().int().min(0).max(10),
  expiresAt: z.number().int().positive().safe(),
  nextAttemptAt: z.number().int().nonnegative().safe(),
}).strict();
export const SavedListSchema = z.object({
  id: z.string().min(6).max(512).regex(/^List\/[^/\u0000-\u0020\u007f]+$/),
  title: z.string().max(256).nullable(),
  deleted: z.boolean(),
  isGroup: z.boolean(),
  checkedAt: z.number().int().nonnegative().safe(),
}).strict();
const SavedListsSchema = z.array(SavedListSchema).max(1000).refine(lists => new Set(lists.map(list => list.id)).size === lists.length, "Saved list identifiers must be unique.");
export type SavedList = z.infer<typeof SavedListSchema>;
export function mergeSavedLists(previous: SavedList[], records: { id: string; title?: string | null; deleted?: boolean | null; isGroup?: boolean | null }[], now = Date.now()): SavedList[] {
  const merged = new Map(previous.map(list => [list.id, list]));
  for (const record of records) {
    merged.set(record.id, SavedListSchema.parse({ id: record.id, title: record.title?.slice(0, 256) ?? null, deleted: !!record.deleted, isGroup: !!record.isGroup, checkedAt: now }));
  }
  if (merged.size > 1000) throw new AppError("UNSUPPORTED_FEATURE", "The saved list snapshot reached its 1,000-identifier limit.", 409);
  return [...merged.values()];
}
const AllOpenScanSchema = z.object({
  token: z.string().uuid(),
  expiresAt: z.number().int().positive().safe(),
  listIds: z.array(SavedListSchema.shape.id).max(1000).refine(ids => new Set(ids).size === ids.length),
  index: z.number().int().min(0).max(1000),
  cursor: z.string().min(1).max(8192).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).nullable(),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),
  listPages: z.number().int().min(0).max(1000),
  totalPages: z.number().int().min(0).max(10000),
  caughtUpAt: z.number().int().nonnegative().safe(),
  source: z.literal("direct-cloudkit-query"),
  lists: SavedListsSchema,
}).strict().refine(scan => scan.index <= scan.listIds.length, "The all-open scan list index is invalid.")
  .refine(scan => scan.lists.length === scan.listIds.length && scan.lists.every((list, index) => list.id === scan.listIds[index] && !list.deleted && !list.isGroup), "The all-open list selection is inconsistent.");
export type AllOpenScan = z.infer<typeof AllOpenScanSchema>;
// Compatibility is limited to recognized retired fields; unknown active fields
// still fail strict validation. No credentials, login policy or fences change.
function discardRetiredCatalogueState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = { ...value } as Record<string, unknown>;
  for (const field of ["diagnosticCatalogue", "catalogueSync", "catalogueAuto", "legacySavedLists"]) delete current[field];
  const scan = current.allOpenScan;
  if (scan && typeof scan === "object" && !Array.isArray(scan)) {
    const source = (scan as Record<string, unknown>).source;
    // Old historical selections cannot claim to be a complete direct discovery.
    // Retire only their continuation, preserving the valid Apple connection.
    if (source === undefined || source === "legacy-catalogue") delete current.allOpenScan;
  }
  return current;
}
export const AppleSessionSchema = z.preprocess(discardRetiredCatalogueState, z.object({
  auth: AuthSnapshotSchema,
  connection: CloudKitConnectionSchema,
  pcs: PcsCheckpointSchema,
  login: LoginAssuranceSchema,
  allOpenScan: AllOpenScanSchema.optional(),
  savedLists: SavedListsSchema.optional(),
  // Optional metadata preserves version-1 encrypted list snapshots.
  directListSnapshot: z.object({ updatedAt: z.number().int().nonnegative().safe() }).strict().optional(),
}).strict());
export type AppleSession = {
  auth: AuthSnapshot;
  connection: CloudKitConnection;
  pcs: PcsCheckpoint;
  login: LoginAssurance;
  allOpenScan?: AllOpenScan;
  savedLists?: SavedList[];
  directListSnapshot?: { updatedAt: number };
};
export type ApprovalAction = typeof APPROVAL_ACTIONS[number];
export type AppleSessionState = "READY" | "DEVICE_APPROVAL_PENDING";
export interface SessionFence { generation: number; version: number; }
export interface SetupFence extends SessionFence { transactionId: string; expiresAt: number; }
export interface ResumeFence extends SessionFence { resumeId: string; expiresAt: number; }
export interface AppleSessionStatus extends SessionFence {
  state: "DISCONNECTED" | "CONNECTING" | AppleSessionState;
  action: ApprovalAction | null;
  nextAttemptAt: number;
  transportReady: boolean;
  liveReadValidated: false;
  expiresAt: number | null;
}

interface StateRow extends SessionFence {
  state: string;
  action: string | null;
  next_attempt_at: number;
  envelope: string | null;
  transaction_id: string | null;
  transaction_expires_at: number | null;
  resume_id: string | null;
  resume_expires_at: number | null;
}
type FenceRow = SessionFence;

function configuredEnvelopes(env: RuntimeEnv) {
  if (!env.ENCRYPTION_KEY_ID || !env.ENCRYPTION_KEYS_JSON) throw new AppError("CONFIGURATION_REQUIRED", "The server-only encryption secret must be configured before Apple sessions can be stored.", 503);
  let keys: unknown;
  try { keys = JSON.parse(env.ENCRYPTION_KEYS_JSON); }
  catch { throw new AppError("CONFIGURATION_REQUIRED", "The encryption key ring is invalid.", 503); }
  return new Envelopes(env.ENCRYPTION_KEY_ID, keys as Record<string, string>);
}

function invalidSession() {
  return new AppError("REAUTH_REQUIRED", "The saved Apple session is invalid. Reconnect through setup.", 409);
}

function connectionAction(state: AppleSessionState, action?: ApprovalAction): ApprovalAction | null {
  if (state === "READY" && action === undefined) return null;
  if (state === "DEVICE_APPROVAL_PENDING" && action && APPROVAL_ACTIONS.includes(action)) return action;
  throw new AppError("VALIDATION_ERROR", "The Apple session state and approval action do not match.", 400);
}

function envelopeFromJSON(value: string): Envelope {
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new AppError("PROTOCOL_CHANGED", "The saved Apple session envelope is invalid.", 503); }
  const parsed = z.object({ version: z.literal(1), keyId: z.string().min(1).max(64), iv: z.string(), ciphertext: z.string() }).strict().safeParse(raw);
  if (!parsed.success) throw new AppError("PROTOCOL_CHANGED", "The saved Apple session envelope is invalid.", 503);
  return parsed.data;
}

export class AppleSessionRepository {
  readonly db: D1DatabaseSession;
  readonly owner: string;
  readonly envelopes: Envelopes;

  constructor(env: RuntimeEnv, owner: string, envelopes = configuredEnvelopes(env)) {
    if (!env.DB) throw new AppError("CONFIGURATION_REQUIRED", "Persistent storage has not been provisioned.", 503);
    if (typeof owner !== "string" || owner.length < 1 || owner.length > 256) throw new AppError("VALIDATION_ERROR", "An authenticated owner is required.", 400);
    this.db = env.DB.withSession("first-primary");
    this.owner = owner;
    this.envelopes = envelopes;
  }

  private async ensureRow() {
    await this.db.prepare("INSERT OR IGNORE INTO apple_session_state (owner_id, account_id) VALUES (?, ?)").bind(this.owner, ACCOUNT).run();
  }

  async status(retry = 0): Promise<AppleSessionStatus> {
    const row = await this.db.prepare("SELECT generation, version, state, action, next_attempt_at, transaction_expires_at FROM apple_session_state WHERE owner_id = ? AND account_id = ?")
      .bind(this.owner, ACCOUNT).first<{ generation: number; version: number; state: string; action: string | null; next_attempt_at: number; transaction_expires_at: number | null }>();
    const currentState = row?.state === "CONNECTING" && (!row.transaction_expires_at || row.transaction_expires_at <= Date.now()) ? "DISCONNECTED" : row?.state;
    const validState: AppleSessionStatus["state"] = currentState && ["CONNECTING", "READY", "DEVICE_APPROVAL_PENDING"].includes(currentState) ? currentState as AppleSessionStatus["state"] : "DISCONNECTED";
    if (validState === "READY" || validState === "DEVICE_APPROVAL_PENDING") {
      try {
        const saved = await this.load();
        // Use the restored row's metadata, rather than comparing it with an
        // earlier status SELECT while a concurrent operation advances the version.
        return { ...saved.fence, state: saved.state, action: saved.action,
          nextAttemptAt: saved.session.pcs.nextAttemptAt, transportReady: saved.state === "READY",
          liveReadValidated: false, expiresAt: saved.session.login.expiresAt };
      } catch (error) {
        if (error instanceof AppError && ["REAUTH_REQUIRED", "AUTH_EXPIRED", "NOT_CONNECTED", "CONFLICT"].includes(error.code)) { if (retry >= 2) throw new AppError("CONFLICT", "The Apple session changed. Refresh connection.", 409); return this.status(retry + 1); }
        throw error;
      }
    }
    return {
      generation: row?.generation ?? 0,
      version: row?.version ?? 0,
      state: validState,
      action: null,
      nextAttemptAt: row?.next_attempt_at ?? 0,
      transportReady: false,
      liveReadValidated: false,
      expiresAt: null,
    };
  }

  async begin(expectedGeneration: number): Promise<SetupFence> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new AppError("VALIDATION_ERROR", "The expected Apple session generation is invalid.", 400);
    await this.ensureRow();
    const version = await this.db.prepare("SELECT version FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ?")
      .bind(this.owner, ACCOUNT, expectedGeneration).first<{ version: number }>();
    if (!version) throw new AppError("CONFLICT", "The Apple session changed. Refresh status and retry setup.", 409);
    const transactionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + SETUP_LEASE_MS;
    const row = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'CONNECTING', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = ?, transaction_expires_at = ?, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? RETURNING generation, version")
      .bind(transactionId, expiresAt, now, this.owner, ACCOUNT, expectedGeneration, version.version).first<FenceRow>();
    if (!row) throw new AppError("CONFLICT", "The Apple session changed. Refresh status and retry setup.", 409);
    return { generation: row.generation, version: row.version, transactionId, expiresAt };
  }

  private async checkedSession(session: unknown): Promise<AppleSession> {
    const parsed = AppleSessionSchema.safeParse(session);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "The Apple session snapshot is invalid or contains unsupported fields.", 400);
    requireCurrentLogin(parsed.data.login);
    return parsed.data;
  }

  async commit(fence: SetupFence, session: AppleSession, state: AppleSessionState, action?: ApprovalAction) {
    const parsed = await this.checkedSession(session);
    const safeAction = connectionAction(state, action);
    const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: fence.generation, recordId: RECORD, schemaVersion: 1 };
    const envelope = JSON.stringify(await this.envelopes.encrypt(parsed, context));
    const now = Date.now();
    requireCurrentLogin(parsed.login, now);
    const result = await this.db.prepare("UPDATE apple_session_state SET version = version + 1, state = ?, action = ?, next_attempt_at = ?, envelope = ?, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND transaction_id = ? AND transaction_expires_at > ? RETURNING version")
      .bind(state, safeAction, parsed.pcs.nextAttemptAt, envelope, now, this.owner, ACCOUNT, fence.generation, fence.version, fence.transactionId, now).first<{ version: number }>();
    if (!result) throw new AppError("CONFLICT", "The Apple setup attempt expired or was replaced. Restart setup.", 409);
    try { requireCurrentLogin(parsed.login); }
    catch (error) { await this.invalidate({ generation: fence.generation, version: result.version }); throw error; }
    return { generation: fence.generation, version: result.version, state, action: safeAction };
  }

  async abandon(fence: SetupFence) {
    const now = Date.now();
    const result = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND ((version = ? AND transaction_id = ?) OR (version = ? AND transaction_id IS NULL AND state IN ('READY', 'DEVICE_APPROVAL_PENDING'))) RETURNING generation")
      .bind(now, this.owner, ACCOUNT, fence.generation, fence.version, fence.transactionId, fence.version + 1).first<{ generation: number }>();
    return result !== null;
  }

  async invalidate(fence: SessionFence) {
    const now = Date.now();
    const result = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? RETURNING generation")
      .bind(now, this.owner, ACCOUNT, fence.generation, fence.version).first<{ generation: number }>();
    return result !== null;
  }

  private invalidateSnapshot(fence: SessionFence) { return this.invalidate(fence); }

  async load() { return this.loadSnapshot(); }

  private async loadSnapshot(retry = 0, generation?: number): Promise<{ session: AppleSession; fence: SessionFence; state: AppleSessionState; action: ApprovalAction | null }> {
    const row = await this.db.prepare("SELECT generation, version, state, action, next_attempt_at, envelope, transaction_id, transaction_expires_at, resume_id, resume_expires_at FROM apple_session_state WHERE owner_id = ? AND account_id = ?")
      .bind(this.owner, ACCOUNT).first<StateRow>();
    if (!row || (row.state !== "READY" && row.state !== "DEVICE_APPROVAL_PENDING")) {
      throw new AppError("NOT_CONNECTED", "Connect an Apple account before continuing.", 409);
    }
    if (generation !== undefined && row.generation !== generation) throw new AppError("CONFLICT", "The Apple account connection changed. Refresh status before continuing.", 409, true);
    const fence = { generation: row.generation, version: row.version };
    if (!row.envelope || row.transaction_id !== null) {
      await this.invalidateSnapshot(fence);
      throw invalidSession();
    }
    let decoded: unknown;
    try {
      const envelope = envelopeFromJSON(row.envelope);
      if (!Object.hasOwn(this.envelopes.keys, envelope.keyId)) throw new AppError("CONFIGURATION_REQUIRED", "An encryption key needed for this Apple session is unavailable.", 503);
      const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: row.generation, recordId: RECORD, schemaVersion: 1 };
      decoded = await this.envelopes.decrypt<unknown>(envelope, context);
    } catch (error) {
      if (error instanceof AppError && error.code === "CONFIGURATION_REQUIRED") throw error;
      await this.invalidateSnapshot(fence);
      throw invalidSession();
    }
    const parsed = AppleSessionSchema.safeParse(decoded);
    const actionValid = row.state === "READY" ? row.action === null : !!row.action && APPROVAL_ACTIONS.includes(row.action as ApprovalAction);
    if (!parsed.success || !actionValid || row.next_attempt_at !== parsed.data?.pcs.nextAttemptAt) {
      await this.invalidateSnapshot(fence);
      throw invalidSession();
    }
    try { requireCurrentLogin(parsed.data.login); }
    catch (error) { await this.invalidateSnapshot(fence); throw error; }
    const current = await this.db.prepare("SELECT 1 AS active FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state IN ('READY', 'DEVICE_APPROVAL_PENDING')")
      .bind(this.owner, ACCOUNT, fence.generation, fence.version).first<{ active: number }>();
    if (!current) {
      // Retry restoration only, never an Apple request or mutation. Pin the
      // original generation so reconnect/disconnect cannot silently switch it.
      if (retry < 2) return this.loadSnapshot(retry + 1, fence.generation);
      throw new AppError("CONFLICT", "The Apple session is busy updating. Retry the request.", 409, true);
    }
    try { requireCurrentLogin(parsed.data.login); }
    catch (error) { await this.invalidateSnapshot(fence); throw error; }
    return { session: parsed.data, fence, state: row.state, action: row.state === "READY" ? null : row.action as ApprovalAction };
  }

  async claimResume(expectedGeneration: number, expectedVersion?: number): Promise<ResumeFence> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))) {
      throw new AppError("VALIDATION_ERROR", "The expected Apple session fence is invalid.", 400);
    }
    await this.ensureRow();
    const saved = await this.load();
    if (saved.fence.generation !== expectedGeneration || expectedVersion !== undefined && saved.fence.version !== expectedVersion) throw new AppError("CONFLICT", "The Apple session changed before this operation.", 409);
    const now = Date.now();
    requireCurrentLogin(saved.session.login, now);
    const resumeId = crypto.randomUUID();
    const expiresAt = Math.min(now + RESUME_LEASE_MS, saved.session.login.expiresAt);
    const versionPredicate = expectedVersion === undefined ? "" : " AND version = ?";
    const values: (string | number)[] = [resumeId, expiresAt, now, this.owner, ACCOUNT, expectedGeneration];
    if (expectedVersion !== undefined) values.push(expectedVersion);
    values.push(now);
    const row = await this.db.prepare(`UPDATE apple_session_state SET version = version + 1, resume_id = ?, resume_expires_at = ?, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ?${versionPredicate} AND state = 'DEVICE_APPROVAL_PENDING' AND transaction_id IS NULL AND (resume_expires_at IS NULL OR resume_expires_at <= ?) RETURNING generation, version`)
      .bind(...values).first<FenceRow>();
    if (!row) throw new AppError("CONFLICT", "The Apple session is not awaiting a resumable device approval, or another resume is active.", 409, true);
    try { requireCurrentLogin(saved.session.login); }
    catch (error) { await this.invalidate(row); throw error; }
    return { generation: row.generation, version: row.version, resumeId, expiresAt };
  }

  async claimRead(expectedGeneration: number, expectedVersion?: number): Promise<ResumeFence> {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0))) {
      throw new AppError("VALIDATION_ERROR", "The expected Apple session fence is invalid.", 400);
    }
    await this.ensureRow();
    const saved = await this.load();
    if (saved.fence.generation !== expectedGeneration || expectedVersion !== undefined && saved.fence.version !== expectedVersion) throw new AppError("CONFLICT", "The Apple session changed before this operation.", 409);
    const now = Date.now();
    requireCurrentLogin(saved.session.login, now);
    const resumeId = crypto.randomUUID();
    const expiresAt = Math.min(now + RESUME_LEASE_MS, saved.session.login.expiresAt);
    const versionPredicate = expectedVersion === undefined ? "" : " AND version = ?";
    const values: (string | number)[] = [resumeId, expiresAt, now, this.owner, ACCOUNT, expectedGeneration];
    if (expectedVersion !== undefined) values.push(expectedVersion);
    values.push(now);
    const row = await this.db.prepare(`UPDATE apple_session_state SET version = version + 1, resume_id = ?, resume_expires_at = ?, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ?${versionPredicate} AND state = 'READY' AND transaction_id IS NULL AND (resume_expires_at IS NULL OR resume_expires_at <= ?) RETURNING generation, version`)
      .bind(...values).first<FenceRow>();
    if (!row) throw new AppError("CONFLICT", "The Apple session is not ready for a read, or another session operation is active.", 409, true);
    try { requireCurrentLogin(saved.session.login); }
    catch (error) { await this.invalidate(row); throw error; }
    return { generation: row.generation, version: row.version, resumeId, expiresAt };
  }

  async assertWriteLease(fence: ResumeFence) {
    // Recheck immediately before dispatch. Reads used to prepare the write must
    // not consume the remaining lease or let a disconnect/reconnect go unnoticed.
    const now = Date.now();
    const row = await this.db.prepare("SELECT 1 AS active FROM apple_session_state WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND state = 'READY' AND transaction_id IS NULL AND resume_id = ? AND resume_expires_at > ?")
      .bind(this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now + 10_000).first<{ active: number }>();
    if (!row) throw new AppError("CONFLICT", "The Apple session changed or the preparation budget expired. Refresh before retrying; no write was sent.", 409, true);
  }

  async commitResume(fence: ResumeFence, session: AppleSession, state: AppleSessionState, action?: ApprovalAction) {
    const parsed = await this.checkedSession(session);
    const saved = await this.load();
    if (saved.fence.generation !== fence.generation || saved.fence.version !== fence.version) throw new AppError("CONFLICT", "The Apple session changed during this operation.", 409);
    if (JSON.stringify(saved.session.login) !== JSON.stringify(parsed.login)) throw new AppError("VALIDATION_ERROR", "An Apple session's verification and expiry cannot be extended by an operation.", 400);
    const safeAction = connectionAction(state, action);
    const context: EnvelopeContext = { ownerId: this.owner, accountId: ACCOUNT, generation: fence.generation, recordId: RECORD, schemaVersion: 1 };
    const envelope = JSON.stringify(await this.envelopes.encrypt(parsed, context));
    const now = Date.now();
    requireCurrentLogin(parsed.login, now);
    const result = await this.db.prepare("UPDATE apple_session_state SET version = version + 1, state = ?, action = ?, next_attempt_at = ?, envelope = ?, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND resume_id = ? AND resume_expires_at > ? AND transaction_id IS NULL RETURNING version")
      .bind(state, safeAction, parsed.pcs.nextAttemptAt, envelope, now, this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId, now).first<{ version: number }>();
    if (!result) throw new AppError("CONFLICT", "The Apple resume lease expired or was replaced. Retry the approval check.", 409);
    try { requireCurrentLogin(parsed.login); }
    catch (error) { await this.invalidate({ generation: fence.generation, version: result.version }); throw error; }
    return { generation: fence.generation, version: result.version, state, action: safeAction };
  }

  async releaseResume(fence: ResumeFence) {
    const now = Date.now();
    const result = await this.db.prepare("UPDATE apple_session_state SET version = version + 1, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? AND resume_id = ? RETURNING version")
      .bind(now, this.owner, ACCOUNT, fence.generation, fence.version, fence.resumeId).first<{ version: number }>();
    return result !== null;
  }

  async disconnect() {
    await this.ensureRow();
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.db.prepare("SELECT generation, version FROM apple_session_state WHERE owner_id = ? AND account_id = ?")
        .bind(this.owner, ACCOUNT).first<SessionFence>();
      if (!current) continue;
      const now = Date.now();
      const updated = await this.db.prepare("UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED', action = NULL, next_attempt_at = 0, envelope = NULL, transaction_id = NULL, transaction_expires_at = NULL, resume_id = NULL, resume_expires_at = NULL, updated_at = ? WHERE owner_id = ? AND account_id = ? AND generation = ? AND version = ? RETURNING generation")
        .bind(now, this.owner, ACCOUNT, current.generation, current.version).first<{ generation: number }>();
      if (updated) return { generation: updated.generation, state: "DISCONNECTED" as const };
    }
    throw new AppError("CONFLICT", "The Apple session changed repeatedly while disconnecting. Retry disconnect.", 409, true);
  }
}
