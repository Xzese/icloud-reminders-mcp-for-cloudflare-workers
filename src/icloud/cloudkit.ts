import { AppError, WriteOutcomeUnknownError, requireValue as requireInput } from "../errors.ts";
import type { CloudKitWriteRecord } from "../reminders/writes.ts";
import { decodeDocument } from "../reminders/crdt.ts";
import { AppleHTTP, validatedAppleURL, appleWebHeaders } from "../transport/apple-http.ts";

const REMINDERS_ZONE = { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" } as const;
const DEFAULT_OWNER = "__defaultOwner__";
const MAX_PAGE_SIZE = 200;
// Compound pages include alarms, recurrences and attachments as well as reminders.
// The transport still enforces its independent 1 MiB response budget.
const MAX_COMPOUND_RECORDS = 1000;
const MAX_RECORD_NAME_LENGTH = 512;
const MAX_TOKEN_LENGTH = 8192;
const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const RECORD_TYPES = new Set(["List", "Reminder", "Alarm", "AlarmTrigger", "Attachment", "Hashtag", "RecurrenceRule"]);
const LIST_SUMMARY_KEYS = ["Name", "Color", "Count", "IsGroup", "Deleted"];
export interface CloudKitReadTrace { path: string; url: string; request: Record<string, unknown>; response: { status: number; returnedRecords: number; recordTypes: Record<string, number>; zones: number; moreComing: (boolean | null)[]; syncTokenPresent: boolean; continuationPresent: boolean; recordErrors: number }; }

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError("PROTOCOL_CHANGED", message);
}

export interface CloudKitConnection {
  dsid: string;
  clientId: string;
  clientBuildNumber: string;
  clientMasteringNumber: string;
  cloudKitURL: string;
  remindersZoneOwner?: string;
}

export interface CloudKitZoneID {
  zoneName: string;
  zoneType?: string;
  ownerRecordName?: string;
}

export interface CloudKitRecord {
  recordName: string;
  recordType: string;
  fields: Record<string, unknown>;
  zoneID?: CloudKitZoneID;
  deleted?: boolean;
  recordChangeTag?: string;
  raw: Record<string, unknown>;
}

export interface CloudKitTombstone {
  recordName: string;
  deleted: true;
  zoneID?: CloudKitZoneID;
  raw: Record<string, unknown>;
}

export interface CloudKitRecordError {
  recordName: string | null;
  serverErrorCode: string;
  reason: string | null;
  raw: Record<string, unknown>;
}

export type CloudKitRecordItem = CloudKitRecord | CloudKitTombstone;

export interface CloudKitPage<T extends CloudKitRecordItem = CloudKitRecordItem> {
  records: T[];
  recordErrors: CloudKitRecordError[];
  paginationComplete: boolean;
  complete: boolean;
  continuation: string | null;
  syncToken: string | null;
  moreComing?: boolean | null;
  pendingReason: "continuation" | "more_coming" | "unknown_more_coming" | "record_errors" | null;
}

export interface CloudKitZone {
  zoneID: CloudKitZoneID;
  syncToken: string | null;
  deleted: boolean;
  raw: Record<string, unknown>;
}

export interface CloudKitZoneDiscovery {
  zones: CloudKitZone[];
  remindersZone: CloudKitZone | null;
  available: boolean;
  complete: true;
}

export interface CloudKitLookupResult {
  requestedRecordNames: string[];
  records: CloudKitRecordItem[];
  recordErrors: CloudKitRecordError[];
  unresolvedRecordNames: string[];
  complete: boolean;
}

export interface RemindersList {
  id: string;
  title: string | null;
  color: string | null;
  count: number | null;
  isGroup: boolean | null;
  deleted: boolean | null;
  reminderIds: string[] | null;
  raw: Record<string, unknown>;
}

export interface Reminder {
  id: string;
  listId: string;
  title: string | null;
  notes: string | null;
  completed: boolean | null;
  completedDate: string | null;
  dueDate: string | null;
  startDate: string | null;
  priority: number | null;
  flagged: boolean | null;
  allDay: boolean | null;
  deleted: boolean | null;
  timeZone: string | null;
  parentReminderId: string | null;
  alarmIds: string[] | null;
  attachmentIds: string[] | null;
  hashtagIds: string[] | null;
  recurrenceRuleIds: string[] | null;
  created: string | null;
  modified: string | null;
  recordChangeTag: string | null;
  raw: Record<string, unknown>;
}

export class CloudKitRateLimitedError extends AppError {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("RATE_LIMITED", "Apple rate limited the Reminders read request.", 429, true);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function object(value: unknown, message: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}

function string(value: unknown, message: string, max = MAX_TOKEN_LENGTH): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= max, message);
  return value as string;
}

function optionalString(value: unknown, message: string, max = MAX_TOKEN_LENGTH): string | null {
  if (value === undefined || value === null) return null;
  return string(value, message, max);
}

function recordName(value: unknown, allowedTypes: readonly string[]): string {
  const name = string(value, "Apple returned a malformed record name.", MAX_RECORD_NAME_LENGTH);
  const separator = name.indexOf("/");
  requireValue(separator > 0 && separator < name.length - 1 && name.indexOf("/", separator + 1) === -1, "Apple returned a malformed record name.");
  requireValue(allowedTypes.includes(name.slice(0, separator)), "The record name is outside the Reminders record types.");
  requireValue(!/[\u0000-\u001f\u007f]/.test(name), "Apple returned a malformed record name.");
  return name;
}

function canonicalRecordName(value: unknown, type: string): string {
  const name = string(value, "Apple returned a malformed record relationship.", MAX_RECORD_NAME_LENGTH);
  const full = name.includes("/") ? name : `${type}/${name}`;
  return recordName(full, [type]);
}

function requestedRecordName(value: unknown, allowedTypes: readonly string[]): string {
  requireInput(typeof value === "string" && value.length <= MAX_RECORD_NAME_LENGTH, "The requested CloudKit record name is invalid.");
  const name = value as string;
  requireInput(/^[A-Za-z][A-Za-z0-9]*\/[^/]+$/.test(name) && allowedTypes.includes(name.slice(0, name.indexOf("/"))), "The requested CloudKit record name is invalid.");
  return recordName(name, allowedTypes);
}

function zoneID(value: unknown, allowMissing = false, remindersOnly = true, expectedOwner: string | null = DEFAULT_OWNER, allowDefaultOwner = true): CloudKitZoneID | undefined {
  if (value === undefined || value === null) {
    requireValue(allowMissing, "Apple omitted the Reminders zone identifier.");
    return undefined;
  }
  const raw = object(value, "Apple returned a malformed zone identifier.");
  const name = string(raw.zoneName, "Apple returned a malformed zone name.", 128);
  if (remindersOnly) requireValue(name === REMINDERS_ZONE.zoneName, "Apple returned data from a different CloudKit zone.");
  const type = optionalString(raw.zoneType, "Apple returned a malformed zone type.", 128) ?? undefined;
  if (remindersOnly) requireValue(type === undefined || type === REMINDERS_ZONE.zoneType, "Apple returned data from a different CloudKit zone type.");
  const owner = optionalString(raw.ownerRecordName, "Apple returned a malformed zone owner.", 256) ?? undefined;
  if (owner !== undefined) requireValue(!/[\u0000-\u0020\u007f]/.test(owner), "Apple returned a malformed zone owner.");
  if (remindersOnly && expectedOwner !== null) requireValue(owner === undefined || (allowDefaultOwner && owner === DEFAULT_OWNER) || owner === expectedOwner, "Apple returned data from a different CloudKit owner.");
  return { zoneName: name, ...(type ? { zoneType: type } : {}), ...(owner ? { ownerRecordName: owner } : {}) };
}

function validateToken(value: unknown, message: string): string {
  const token = string(value, message, MAX_TOKEN_LENGTH);
  requireValue(!/[\u0000-\u001f\u007f]/.test(token), message);
  return token;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? MAX_PAGE_SIZE;
  requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE, "The CloudKit page size is outside the supported limit.");
  return limit;
}

function requestedToken(value: string | null | undefined, message: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  requireInput(typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && !/[\u0000-\u001f\u007f]/.test(value), message);
  return value;
}

function readField(record: CloudKitRecord, key: string, tags: readonly string[]): unknown {
  const rawFields = record.fields;
  if (!Object.hasOwn(rawFields, key)) return undefined;
  const wrapper = object(rawFields[key], `Apple returned a malformed ${key} field.`);
  requireValue(typeof wrapper.type === "string" && tags.includes(wrapper.type), `Apple changed the ${key} field type.`);
  requireValue(Object.hasOwn(wrapper, "value"), `Apple omitted the ${key} field value.`);
  return wrapper.value;
}

function textField(record: CloudKitRecord, key: string): string | null {
  const value = readField(record, key, ["STRING"]);
  if (value === undefined || value === null) return null;
  return string(value, `Apple returned malformed text in ${key}.`, 65_536);
}

function boolField(record: CloudKitRecord, key: string): boolean | null {
  const value = readField(record, key, ["INT64"]);
  if (value === undefined || value === null) return null;
  requireValue(value === 0 || value === 1, `Apple returned an invalid boolean in ${key}.`);
  return value === 1;
}

function integerField(record: CloudKitRecord, key: string): number | null {
  const value = readField(record, key, ["INT64"]);
  if (value === undefined || value === null) return null;
  requireValue(Number.isSafeInteger(value), `Apple returned an invalid integer in ${key}.`);
  return value as number;
}

function dateField(record: CloudKitRecord, key: string): string | null {
  const value = readField(record, key, ["TIMESTAMP"]);
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.startsWith("0001-01-01")) return null;
  let millis: number;
  if (typeof value === "number") millis = value;
  else if (typeof value === "string" && /^-?\d+$/.test(value)) millis = Number(value);
  else throw new AppError("PROTOCOL_CHANGED", `Apple returned an invalid timestamp in ${key}.`);
  requireValue(Number.isSafeInteger(millis), `Apple returned an invalid timestamp in ${key}.`);
  // These ancient values are CloudKit's observed unset-date sentinels.
  if (millis <= -62_135_596_800_000) return null;
  const date = new Date(millis);
  requireValue(Number.isFinite(date.getTime()), `Apple returned an out-of-range timestamp in ${key}.`);
  return date.toISOString();
}

function referenceField(record: CloudKitRecord, key: string, type: string, expectedOwner: string): string | null {
  const value = readField(record, key, ["REFERENCE"]);
  if (value === undefined || value === null) return null;
  const reference = object(value, `Apple returned a malformed ${key} relationship.`);
  if (reference.zoneID !== undefined) zoneID(reference.zoneID, false, true, expectedOwner);
  if (reference.action !== undefined) requireValue(reference.action === "VALIDATE", `Apple returned an unsupported ${key} relationship action.`);
  return canonicalRecordName(reference.recordName, type);
}

function idListField(record: CloudKitRecord, key: string, type: string): string[] | null {
  const value = readField(record, key, ["STRING_LIST", "UNKNOWN_LIST"]);
  // CloudKit emits UNKNOWN_LIST for empty relationships because there is no
  // element from which to infer a type. Never accept populated unknown lists.
  if ((record.fields[key] as { type?: string } | undefined)?.type === "UNKNOWN_LIST") {
    requireValue(Array.isArray(value) && value.length === 0, `Apple returned an invalid ${key} untyped relationship list.`);
    return [];
  }
  if (value === undefined || value === null) return null;
  requireValue(Array.isArray(value) && value.length <= 2_000, `Apple returned an invalid ${key} relationship list.`);
  return value.map((entry) => canonicalRecordName(entry, type));
}

function documentField(record: CloudKitRecord, key: string): string | null {
  const value = readField(record, key, ["ENCRYPTED_BYTES", "STRING"]);
  if (value === undefined || value === null) return null;
  requireValue(typeof value === "string" && value.length <= 350_000, `Apple returned an invalid ${key} document.`);
  try {
    return decodeDocument(value).text;
  } catch {
    throw new AppError("PROTOCOL_CHANGED", `Apple returned a ${key} document that could not be decoded safely.`);
  }
}

export function normalizeList(record: CloudKitRecord, includeMembership = true): RemindersList {
  requireValue(record.recordType === "List", "Only Reminders List records can be normalized as lists.");
  const rawName = recordName(record.recordName, ["List"]);
  const count = integerField(record, "Count");
  if (count !== null) requireValue(count >= 0, "Apple returned a negative reminder list count.");
  let reminderIds: string[] | null = null;
  const membership = includeMembership ? readField(record, "ReminderIDs", ["STRING"]) : undefined;
  if (membership !== undefined && membership !== null) {
    requireValue(typeof membership === "string" && membership.length <= 65_536, "Apple returned invalid list membership data.");
    let parsed: unknown;
    try { parsed = JSON.parse(membership as string); }
    catch { throw new AppError("PROTOCOL_CHANGED", "Apple returned invalid list membership data."); }
    requireValue(Array.isArray(parsed) && parsed.length <= 2_000, "Apple returned invalid list membership data.");
    reminderIds = parsed.map((id) => canonicalRecordName(id, "Reminder"));
  }
  return {
    id: rawName,
    title: textField(record, "Name"),
    color: textField(record, "Color"),
    count,
    isGroup: boolField(record, "IsGroup"),
    deleted: boolField(record, "Deleted"),
    reminderIds,
    raw: record.raw,
  };
}

export function normalizeReminder(record: CloudKitRecord, expectedOwner = DEFAULT_OWNER): Reminder {
  requireValue(record.recordType === "Reminder", "Only Reminders Reminder records can be normalized as reminders.");
  const id = recordName(record.recordName, ["Reminder"]);
  const listId = referenceField(record, "List", "List", expectedOwner);
  requireValue(listId !== null, "Apple returned a reminder without its source-proven List relationship.");
  const parent = referenceField(record, "ParentReminder", "Reminder", expectedOwner);
  return {
    id,
    listId,
    title: documentField(record, "TitleDocument"),
    notes: documentField(record, "NotesDocument"),
    completed: boolField(record, "Completed"),
    completedDate: dateField(record, "CompletionDate"),
    dueDate: dateField(record, "DueDate"),
    startDate: dateField(record, "StartDate"),
    priority: integerField(record, "Priority"),
    flagged: boolField(record, "Flagged"),
    allDay: boolField(record, "AllDay"),
    deleted: boolField(record, "Deleted"),
    timeZone: textField(record, "TimeZone"),
    parentReminderId: parent,
    alarmIds: idListField(record, "AlarmIDs", "Alarm"),
    attachmentIds: idListField(record, "AttachmentIDs", "Attachment"),
    hashtagIds: idListField(record, "HashtagIDs", "Hashtag"),
    recurrenceRuleIds: idListField(record, "RecurrenceRuleIDs", "RecurrenceRule"),
    created: recordAuditDate(record.raw, "created"),
    modified: recordAuditDate(record.raw, "modified"),
    recordChangeTag: typeof record.recordChangeTag === "string" ? record.recordChangeTag : null,
    raw: record.raw,
  };
}

function recordAuditDate(rawRecord: Record<string, unknown>, key: string): string | null {
  if (rawRecord[key] === undefined || rawRecord[key] === null) return null;
  const info = object(rawRecord[key], `Apple returned malformed record ${key} metadata.`);
  const value = info.timestamp;
  const millis = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  requireValue(Number.isSafeInteger(millis), `Apple returned malformed record ${key} metadata.`);
  const date = new Date(millis);
  requireValue(Number.isFinite(date.getTime()), `Apple returned out-of-range record ${key} metadata.`);
  return date.toISOString();
}

function parseRecord(value: unknown, expectedOwner: string, allowDefaultOwner = true): CloudKitRecordItem | CloudKitRecordError {
  const raw = object(value, "Apple returned a malformed CloudKit record.");
  const recordZone = zoneID(raw.zoneID, true, true, expectedOwner, allowDefaultOwner);
  if (typeof raw.serverErrorCode === "string") {
    return {
      recordName: typeof raw.recordName === "string" ? raw.recordName : null,
      serverErrorCode: string(raw.serverErrorCode, "Apple returned a malformed per-record error code.", 256),
      reason: optionalString(raw.reason, "Apple returned a malformed per-record error reason.", 2_000),
      raw,
    };
  }
  const name = recordName(raw.recordName, ["List", "Reminder", "Alarm", "AlarmTrigger", "Attachment", "Hashtag", "RecurrenceRule"]);
  if (raw.deleted === true && raw.recordType === undefined) {
    return { recordName: name, deleted: true, ...(recordZone ? { zoneID: recordZone } : {}), raw };
  }
  const type = string(raw.recordType, "Apple returned a malformed record type.", 128);
  requireValue(RECORD_TYPES.has(type) && name.startsWith(`${type}/`), "Apple returned a record outside the requested Reminders record types.");
  const fields = object(raw.fields ?? {}, "Apple returned malformed record fields.");
  for (const field of Object.values(fields)) {
    if (field !== null && typeof field === "object" && !Array.isArray(field) && (field as Record<string, unknown>).type === "REFERENCE") {
      const value = (field as Record<string, unknown>).value;
      if (value === undefined || value === null) continue;
      const reference = object(value, "Apple returned a malformed record relationship.");
      if (reference.zoneID !== undefined) zoneID(reference.zoneID, false, true, expectedOwner, allowDefaultOwner);
    }
  }
  if (raw.recordChangeTag !== undefined) string(raw.recordChangeTag, "Apple returned a malformed record change tag.", 512);
  if (raw.deleted !== undefined) requireValue(typeof raw.deleted === "boolean", "Apple returned a malformed deleted marker.");
  return {
    recordName: name,
    recordType: type,
    fields,
    ...(recordZone ? { zoneID: recordZone } : {}),
    ...(typeof raw.deleted === "boolean" ? { deleted: raw.deleted } : {}),
    ...(typeof raw.recordChangeTag === "string" ? { recordChangeTag: raw.recordChangeTag } : {}),
    raw,
  };
}

function pageRecords(value: unknown, limit: number, absoluteLimit = MAX_PAGE_SIZE, expectedOwner = DEFAULT_OWNER, changeHistory = false, allowDefaultOwner = true): { records: CloudKitRecordItem[]; recordErrors: CloudKitRecordError[] } {
  requireValue(Array.isArray(value), "Apple returned a malformed CloudKit records page.");
  requireValue(value.length <= limit && value.length <= absoluteLimit, "Apple returned more records than the supported page budget.");
  const records: CloudKitRecordItem[] = [];
  const recordErrors: CloudKitRecordError[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const parsed = parseRecord(item, expectedOwner, allowDefaultOwner);
    if ("serverErrorCode" in parsed) {
      recordErrors.push(parsed);
      continue;
    }
    requireValue(changeHistory || !names.has(parsed.recordName), "Apple returned a duplicate record in one page.");
    names.add(parsed.recordName);
    records.push(parsed);
  }
  return { records, recordErrors };
}

function parseTopLevelError(body: Record<string, unknown>, context: { path: CloudKitPath; upstreamStatus: number; hasSessionCookie: boolean }): never | void {
  const code = typeof body.serverErrorCode === "string" ? body.serverErrorCode : null;
  if (!code) return;
  const normalized = code.toUpperCase();
  if (["AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED", "INVALID_AUTH_TOKEN", "AUTHENTICATION_FAILED"].includes(normalized)) {
    console.warn({ event: "apple-reminders-auth-rejected", ...context, reason: normalized });
    throw new AppError("REAUTH_REQUIRED", "Apple did not accept the Reminders connection. The stored login has been cleared; reconnect your Apple account.", 409);
  }
  if (["ACCESS_DENIED", "PERMISSION_FAILURE"].includes(normalized)) {
    throw new AppError("FORBIDDEN", "Apple denied access to the private Reminders zone.", 403);
  }
  if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(normalized)) {
    throw new CloudKitRateLimitedError(null);
  }
  if (context.path === "/records/modify") {
    if (["CONFLICT", "SERVER_RECORD_CHANGED", "ALREADY_EXISTS"].includes(normalized)) throw new AppError("CONFLICT", "The reminder changed or its create ID already exists. Read its current state before retrying.", 409);
    if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(normalized)) throw new AppError("CONFLICT", "The reminder or its list is no longer available.", 409);
    if (["BAD_REQUEST", "INVALID_ARGUMENTS", "VALIDATION_ERROR"].includes(normalized)) throw new AppError("PROTOCOL_CHANGED", "Apple rejected the reminder write fields. No automatic retry was attempted.");
    // An unfamiliar error after submission is not proof that nothing was saved.
    throw new WriteOutcomeUnknownError(String(body.recordName ?? ""));
  }
  if (context.path === "/changes/zone" && normalized === "CHANGE_TOKEN_EXPIRED") {
    throw new AppError("RESTART_REQUIRED", "Apple expired the saved catalogue checkpoint. Restart the initial catalogue scan; your saved lists are preserved.", 409);
  }
  throw new AppError("PROTOCOL_CHANGED", "Apple rejected the Reminders read request.");
}

type ReadPath = "/zones/list" | "/records/lookup" | "/records/query" | "/changes/zone";
type CloudKitPath = ReadPath | "/records/modify";

export class CloudKitRemindersClient {
  private readonly endpoint: URL;
  private readonly params: URLSearchParams;
  private readonly http: AppleHTTP;
  private owner: string | undefined;
  readonly readTrace: CloudKitReadTrace[] = [];
  get remindersZoneOwner() { return this.owner; }
  private get expectedOwner() { return this.owner ?? DEFAULT_OWNER; }
  private get requestZone() { return { ...REMINDERS_ZONE, ...(this.owner && this.owner !== DEFAULT_OWNER ? { ownerRecordName: this.owner } : {}) }; }

  constructor(http: AppleHTTP, connection: CloudKitConnection) {
    this.http = http;
    if (connection.remindersZoneOwner !== undefined) requireInput(typeof connection.remindersZoneOwner === "string" && connection.remindersZoneOwner.length > 0 && connection.remindersZoneOwner.length <= 256 && !/[\u0000-\u0020\u007f]/.test(connection.remindersZoneOwner), "The saved Reminders zone owner is invalid.");
    this.owner = connection.remindersZoneOwner;
    requireInput(/^\d{1,32}$/.test(connection.dsid), "The Apple account identifier is invalid.");
    for (const [key, value] of [["client ID", connection.clientId], ["client build number", connection.clientBuildNumber], ["client mastering number", connection.clientMasteringNumber]] as const) {
      requireInput(typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value), `The Apple ${key} is invalid.`);
    }
    const endpoint = validatedAppleURL(connection.cloudKitURL, true);
    requireInput(endpoint.pathname.replace(/\/$/, "") === "/database/1/com.apple.reminders/production/private", "The discovered URL is not the private Reminders CloudKit database.");
    requireInput(!endpoint.search && !endpoint.hash, "The discovered Reminders URL must not contain query parameters or fragments.");
    this.endpoint = endpoint;
    this.params = new URLSearchParams();
    this.params.set("remapEnums", "true");
    this.params.set("getCurrentSyncToken", "true");
    this.params.set("clientBuildNumber", connection.clientBuildNumber);
    this.params.set("clientMasteringNumber", connection.clientMasteringNumber);
    this.params.set("clientId", connection.clientId);
    this.params.set("dsid", connection.dsid);
  }

  private async post(path: CloudKitPath, payload: Record<string, unknown>, database: "private" | "shared" = "private"): Promise<Record<string, unknown>> {
    requireInput(database === "private" || path === "/zones/list" || path === "/records/lookup", "The shared diagnostic only supports zone discovery and exact record lookups.");
    const body = JSON.stringify(payload);
    requireInput(new TextEncoder().encode(body).length <= MAX_REQUEST_BYTES, "The CloudKit request exceeded the byte budget.");
    const url = new URL(this.endpoint.href);
    if (database === "shared") url.pathname = url.pathname.replace(/\/private\/?$/, "/shared");
    url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
    url.search = this.params.toString();
    const hasSessionCookie = this.http.jar.header(url).length > 0;
    const response = await this.http.request(url.href, {
      method: "POST",
      headers: appleWebHeaders(),
      body,
      discovered: true,
      followRedirects: path !== "/records/modify",
    });
    if ([401, 421, 450].includes(response.status)) {
      console.warn({ event: "apple-reminders-auth-rejected", path, upstreamStatus: response.status, hasSessionCookie, reason: "http-auth-rejection" });
      throw new AppError("REAUTH_REQUIRED", "Apple did not accept the Reminders connection. The stored login has been cleared; reconnect your Apple account.", 409);
    }
    if (response.status === 403) {
      throw new AppError("FORBIDDEN", "Apple denied access to the private Reminders zone.", 403);
    }
    if (response.status === 429) {
      const retryText = response.headers.get("retry-after");
      const retry = retryText && /^\d+(?:\.\d+)?$/.test(retryText) ? Number(retryText) : null;
      throw new CloudKitRateLimitedError(retry !== null && Number.isFinite(retry) ? retry : null);
    }
    if (response.status !== 200) {
      if (path === "/records/modify") {
        // Only a recognized rejection is a confirmed failure. Timeouts, redirects
        // and server errors can occur after Apple commits the record.
        if (response.status >= 400 && response.status < 500) {
          let failure: Record<string, unknown> | null = null;
          try { failure = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)), "Invalid write rejection."); } catch { /* Treat unconfirmed responses as uncertain. */ }
          if (failure) parseTopLevelError(failure, { path, upstreamStatus: response.status, hasSessionCookie });
        }
        throw new WriteOutcomeUnknownError("");
      }
      // Apple can also report expired cursors as HTTP errors. Recognition is
      // restricted to this authenticated changes endpoint and this exact code;
      // authentication, access and throttling statuses above retain precedence.
      if (path === "/changes/zone" && response.status >= 400 && response.status < 500) {
        let expiredResponse: Record<string, unknown> | null = null;
        try { expiredResponse = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)), "Apple returned a malformed change error."); } catch { /* Preserve the normal HTTP error below. */ }
        if (expiredResponse?.serverErrorCode === "CHANGE_TOKEN_EXPIRED") parseTopLevelError(expiredResponse, { path, upstreamStatus: response.status, hasSessionCookie });
        if (Array.isArray(expiredResponse?.zones) && expiredResponse.zones.length === 1) {
          const errorZone = object(expiredResponse.zones[0], "Apple returned a malformed change error zone.");
          if (errorZone.serverErrorCode === "CHANGE_TOKEN_EXPIRED") {
            zoneID(errorZone.zoneID, false, true, this.expectedOwner);
            parseTopLevelError(errorZone, { path, upstreamStatus: response.status, hasSessionCookie });
          }
        }
      }
      console.warn({ event: "apple-reminders-http-rejected", path, upstreamStatus: response.status });
      if (response.status >= 500) throw new AppError("UPSTREAM_UNAVAILABLE", "Apple could not complete the Reminders read request.", 503, true);
      throw new AppError("PROTOCOL_CHANGED", "Apple returned an unexpected status for the Reminders read request.");
    }
    requireValue(response.bytes.length <= MAX_RESPONSE_BYTES, "Apple returned more data than the CloudKit response budget.");
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes)); }
    catch { throw new AppError("PROTOCOL_CHANGED", "Apple returned an invalid Reminders response."); }
    const result = object(decoded, "Apple returned a malformed Reminders response.");
    const zones = Array.isArray(result.zones) ? result.zones : [];
    const records = Array.isArray(result.records) ? result.records : zones.flatMap(zone => Array.isArray(zone?.records) ? zone.records : []);
    const recordTypes: Record<string, number> = {};
    for (const record of records) {
      const type = record && typeof record === "object" && RECORD_TYPES.has(record.recordType) ? record.recordType as string : "other";
      recordTypes[type] = (recordTypes[type] ?? 0) + 1;
    }
    if (path !== "/records/modify") {
      const redactedRequest = JSON.parse(JSON.stringify(payload, (key, value) => ["recordName", "ownerRecordName", "syncToken", "continuationMarker"].includes(key) ? "[redacted]" : key === "zoneName" && value !== "Reminders" ? "[other authorized zone]" : value)) as Record<string, unknown>;
      const redactedURL = new URL(url); redactedURL.searchParams.set("dsid", "[redacted]"); redactedURL.searchParams.set("clientId", "[redacted]");
      this.readTrace.push({ path, url: redactedURL.href, request: redactedRequest, response: { status: response.status, returnedRecords: records.length, recordTypes, zones: zones.length, moreComing: zones.map(zone => zone?.moreComing === true ? true : zone?.moreComing === false ? false : null), syncTokenPresent: typeof result.syncToken === "string" || zones.some(zone => typeof zone?.syncToken === "string"), continuationPresent: typeof result.continuationMarker === "string", recordErrors: records.filter(record => record && typeof record.serverErrorCode === "string").length } });
    }
    parseTopLevelError(result, { path, upstreamStatus: response.status, hasSessionCookie });
    return result;
  }

  async modifyReminder(operationType: "create" | "update", record: CloudKitWriteRecord): Promise<CloudKitRecord> {
    requireInput(operationType === "create" || operationType === "update", "Only reminder creation and editing are supported.");
    requireInput(this.owner !== undefined, "Discover the authenticated Reminders zone before writing.");
    requireInput(record.recordType === "Reminder" && record.recordName.length <= 255, "Only bounded Reminder records can be written.");
    requestedRecordName(record.recordName, ["Reminder"]);
    const allowedFields = new Set(["TitleDocument", "NotesDocument", "Priority", "Flagged", "DueDate", "TimeZone", "AllDay", "LastModifiedDate", "ResolutionTokenMap", ...(operationType === "create" ? ["Completed", "CompletionDate", "CreationDate", "Deleted", "Imported", "List"] : [])]);
    requireInput(Object.keys(record.fields).length > 0 && Object.keys(record.fields).every(key => allowedFields.has(key)), "The reminder write contains unsupported fields.");
    if (operationType === "update") requireInput(typeof record.recordChangeTag === "string" && record.recordChangeTag.length > 0 && record.recordChangeTag.length <= 512 && record.parent === undefined, "Reminder edits require an exact change tag and cannot move lists.");
    else requireInput(record.recordChangeTag === undefined && record.parent?.recordName.startsWith("List/"), "Reminder creation requires its list parent.");
    const payload = { zoneID: this.requestZone, atomic: true, operations: [{ operationType, record }] };
    // Pre-dispatch bounds are validation errors, not ambiguous write outcomes.
    requireInput(new TextEncoder().encode(JSON.stringify(payload)).length <= MAX_REQUEST_BYTES, "The reminder write exceeded its byte budget.");
    try {
      const result = await this.post("/records/modify", payload);
      const page = pageRecords(result.records, 1, 1, this.expectedOwner);
      if (page.recordErrors.length) {
        requireValue(page.recordErrors.length === 1 && page.recordErrors[0].recordName === record.recordName && page.records.length === 0, "Apple returned an unrelated write error.");
        parseTopLevelError({ serverErrorCode: page.recordErrors[0].serverErrorCode, recordName: record.recordName }, { path: "/records/modify", upstreamStatus: 200, hasSessionCookie: this.http.jar.header(this.endpoint).length > 0 });
      }
      requireValue(page.records.length === 1, "Apple omitted the reminder write confirmation.");
      const confirmed = page.records[0];
      requireValue("recordType" in confirmed && confirmed.recordType === "Reminder" && confirmed.recordName === record.recordName && !confirmed.deleted && typeof confirmed.recordChangeTag === "string" && confirmed.recordChangeTag.length > 0, "Apple returned an invalid reminder write confirmation.");
      if (operationType === "update") requireValue(confirmed.recordChangeTag !== record.recordChangeTag, "Apple did not advance the reminder version.");
      return confirmed;
    } catch (error) {
      if (error instanceof AppError && ["REAUTH_REQUIRED", "FORBIDDEN", "RATE_LIMITED", "CONFLICT"].includes(error.code)) throw error;
      // Explicit bad-field rejections above are also definite failures.
      if (error instanceof AppError && error.code === "PROTOCOL_CHANGED" && error.message === "Apple rejected the reminder write fields. No automatic retry was attempted.") throw error;
      throw new WriteOutcomeUnknownError(record.recordName);
    }
  }

  async listZones(): Promise<CloudKitZoneDiscovery> {
    const result = await this.post("/zones/list", {});
    requireValue(Array.isArray(result.zones) && result.zones.length <= 1_000, "Apple returned a malformed CloudKit zone list.");
    const zones: CloudKitZone[] = [];
    const matches: CloudKitZone[] = [];
    for (const value of result.zones) {
      const raw = object(value, "Apple returned a malformed CloudKit zone.");
      const id = zoneID(raw.zoneID, false, false) ?? (() => { throw new AppError("PROTOCOL_CHANGED", "Apple returned a malformed CloudKit zone."); })();
      const syncToken = optionalString(raw.syncToken, "Apple returned a malformed CloudKit zone checkpoint.");
      if (syncToken !== null) validateToken(syncToken, "Apple returned a malformed CloudKit zone checkpoint.");
      if (raw.deleted !== undefined) requireValue(typeof raw.deleted === "boolean", "Apple returned a malformed zone deleted marker.");
      const zone: CloudKitZone = { zoneID: id, syncToken, deleted: raw.deleted === true, raw };
      zones.push(zone);
      if (id.zoneName === REMINDERS_ZONE.zoneName) {
        // This is the sole bootstrap authority: the authenticated, fixed
        // private database’s zone catalogue, never a returned record.
        zoneID(raw.zoneID, false, true, this.owner ?? null);
        requireValue(raw.serverErrorCode === undefined, "Apple did not return a successful Reminders zone.");
        matches.push(zone);
      }
    }
    requireValue(matches.length <= 1, "Apple returned multiple private Reminders zones.");
    const remindersZone = matches[0] ?? null;
    if (remindersZone && !remindersZone.deleted && this.owner === undefined) this.owner = remindersZone.zoneID.ownerRecordName ?? DEFAULT_OWNER;
    return { zones, remindersZone, available: remindersZone !== null && !remindersZone.deleted, complete: true };
  }

  async probeOtherZones() {
    const discovered = await this.listZones();
    requireValue(discovered.available, "Apple did not return the private Reminders zone.");
    const candidates = discovered.zones.filter(zone => !zone.deleted && zone.zoneID.zoneName !== "Reminders" && zone.zoneID.zoneType === "REGULAR_CUSTOM_ZONE" && (zone.zoneID.ownerRecordName ?? DEFAULT_OWNER) === this.expectedOwner);
    requireValue(candidates.length <= 2, "The additional zone diagnostic exceeds its two-zone budget.");
    const summaries = [];
    for (const candidate of candidates) {
      const requestedZone = { zoneName: candidate.zoneID.zoneName, zoneType: candidate.zoneID.zoneType };
      const result = await this.post("/changes/zone", { zones: [{ zoneID: requestedZone, reverse: true }], resultsLimit: 50 });
      requireValue(Array.isArray(result.zones) && result.zones.length === 1, "Apple returned an ambiguous additional-zone response.");
      const raw = object(result.zones[0], "Apple returned a malformed additional zone.");
      const id = zoneID(raw.zoneID, false, false);
      requireValue(id?.zoneName === requestedZone.zoneName && (id.zoneType === undefined || id.zoneType === requestedZone.zoneType) && (id.ownerRecordName === undefined || id.ownerRecordName === DEFAULT_OWNER || id.ownerRecordName === this.expectedOwner), "Apple returned data outside the authorized additional zone.");
      requireValue(Array.isArray(raw.records) && raw.records.length <= 50, "Apple exceeded the additional-zone record budget.");
      const recordTypes: Record<string, number> = {}, fields = new Set<string>();
      const allowedFields = ["List", "Lists", "ListIDs", "DefaultList", "DefaultListID", "Name", "Order", "Ordering", "ListOrdering", "Deleted", "IsGroup", "Title", "Color", "Count", "ReminderIDs", "ParentList", "Share", "Sharing", "SharingInfo"];
      for (const item of raw.records) {
        const record = object(item, "Apple returned malformed additional-zone data.");
        const recordZone = zoneID(record.zoneID, true, false);
        if (recordZone) requireValue(recordZone.zoneName === id.zoneName && (recordZone.ownerRecordName === undefined || recordZone.ownerRecordName === DEFAULT_OWNER || recordZone.ownerRecordName === this.expectedOwner), "Apple returned a record outside the authorized additional zone.");
        const type = typeof record.recordType === "string" && ["List", "Reminder", "Account", "User", "Settings", "ListGroup", "SmartList", "Metadata"].includes(record.recordType) ? record.recordType : "other";
        recordTypes[type] = (recordTypes[type] ?? 0) + 1;
        if (record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)) for (const key of Object.keys(record.fields)) if (allowedFields.includes(key)) fields.add(key);
      }
      summaries.push({ metadataZone: /metadata/i.test(id.zoneName), records: raw.records.length, recordTypes, fieldNames: [...fields], moreComing: raw.moreComing === true, responseError: typeof raw.serverErrorCode === "string" });
    }
    return { zones: summaries, complete: true };
  }

  async probeSharedLists(listIds: string[]) {
    requireInput(listIds.length >= 1 && listIds.length <= 10, "The shared-list diagnostic supports one to ten identifiers.");
    const requested = listIds.map(id => requestedRecordName(id, ["List"]));
    requireInput(new Set(requested).size === requested.length, "The shared-list diagnostic contains duplicate identifiers.");
    const discovered = await this.post("/zones/list", {}, "shared");
    requireValue(Array.isArray(discovered.zones) && discovered.zones.length <= 100, "Apple exceeded the shared-zone discovery budget.");
    const candidates: CloudKitZoneID[] = [];
    let deletedZones = 0;
    const seen = new Set<string>();
    for (const item of discovered.zones) {
      const raw = object(item, "Apple returned a malformed shared zone.");
      const id = zoneID(raw.zoneID, false, false)!;
      requireValue(raw.serverErrorCode === undefined && (raw.deleted === undefined || typeof raw.deleted === "boolean"), "Apple returned an unsuccessful shared zone.");
      const key = JSON.stringify([id.zoneName, id.ownerRecordName]);
      requireValue(!seen.has(key), "Apple returned duplicate shared zones."); seen.add(key);
      if (raw.deleted === true) { deletedZones++; continue; }
      if (id.zoneName !== "Reminders") continue;
      requireValue(typeof id.ownerRecordName === "string" && id.ownerRecordName !== DEFAULT_OWNER, "Apple did not identify the shared zone owner.");
      zoneID(raw.zoneID, false, true, id.ownerRecordName);
      candidates.push(id);
    }
    requireValue(candidates.length <= 3, "The shared-list diagnostic exceeds its three-zone budget.");
    const summaries = [];
    for (const candidate of candidates) {
      const result = await this.post("/records/lookup", { records: requested.map(recordName => ({ recordName })), zoneID: candidate, desiredKeys: LIST_SUMMARY_KEYS }, "shared");
      const page = pageRecords(result.records, requested.length, 10, candidate.ownerRecordName!, false, false);
      for (const record of page.records) requireValue(requested.includes(record.recordName) && (!("recordType" in record) || record.recordType === "List"), "Apple returned an unrequested shared list.");
      for (const error of page.recordErrors) requireValue(error.recordName !== null && requested.includes(error.recordName), "Apple returned an unrequested shared-list error.");
      const answered = new Set([...page.records.map(record => record.recordName), ...page.recordErrors.map(error => error.recordName)]);
      requireValue(requested.every(id => answered.has(id)), "Apple omitted a requested shared-list result.");
      summaries.push({ matchedInputIndices: page.records.filter(record => !record.deleted).map(record => requested.indexOf(record.recordName) + 1), deletedRecords: page.records.filter(record => record.deleted).length, recordErrors: page.recordErrors.map(error => ({ inputIndex: requested.indexOf(error.recordName!) + 1, code: error.serverErrorCode })) });
    }
    return { database: "shared", zonesDiscovered: discovered.zones.length, deletedZones, remindersZones: candidates.length, otherZones: discovered.zones.length - candidates.length - deletedZones, lookups: summaries, complete: true, contentsReturned: false };
  }

  async lookup(recordNames: string[], listSummary = false): Promise<CloudKitLookupResult> {
    requireInput(Array.isArray(recordNames) && recordNames.length >= 1 && recordNames.length <= MAX_PAGE_SIZE, "The CloudKit lookup size is outside the supported limit.");
    const requestedRecordNames = recordNames.map((name) => requestedRecordName(name, ["List", "Reminder"]));
    requireInput(!listSummary || requestedRecordNames.every(name => name.startsWith("List/")), "Only list lookups can use the list-summary projection.");
    requireInput(new Set(requestedRecordNames).size === requestedRecordNames.length, "The CloudKit lookup contains duplicate record names.");
    const result = await this.post("/records/lookup", {
      records: requestedRecordNames.map((name) => ({ recordName: name })),
      zoneID: this.requestZone,
      ...(listSummary ? { desiredKeys: LIST_SUMMARY_KEYS } : {}),
    });
    const parsed = pageRecords(result.records, requestedRecordNames.length, MAX_PAGE_SIZE, this.expectedOwner);
    const requested = new Set(requestedRecordNames);
    for (const record of parsed.records) requireValue(requested.has(record.recordName), "Apple returned a record that was not requested.");
    for (const error of parsed.recordErrors) requireValue(error.recordName === null || requested.has(error.recordName), "Apple returned an error for a record that was not requested.");
    const answered = new Set([...parsed.records.map((record) => record.recordName), ...parsed.recordErrors.flatMap((error) => error.recordName ? [error.recordName] : [])]);
    const unresolvedRecordNames = requestedRecordNames.filter((name) => !answered.has(name));
    return {
      requestedRecordNames,
      records: parsed.records,
      recordErrors: parsed.recordErrors,
      unresolvedRecordNames,
      complete: parsed.recordErrors.length === 0 && unresolvedRecordNames.length === 0,
    };
  }

  async cataloguePage(options: { syncToken?: string | null; limit?: number; reverse?: boolean; knownListIds?: readonly string[] }): Promise<CloudKitPage> {
    const page = await this.changesPage({ ...options, desiredRecordTypes: ["List", "Reminder"], desiredKeys: [...LIST_SUMMARY_KEYS, "List"] });
    const lists = page.records.filter(record => record.recordName.startsWith("List/"));
    const present = new Set([...lists.map(record => record.recordName), ...(options.knownListIds ?? [])]);
    const candidates = new Set<string>();
    for (const record of page.records) {
      if (!("recordType" in record) || record.recordType !== "Reminder" || record.deleted || boolField(record, "Deleted") === true) continue;
      const listId = referenceField(record, "List", "List", this.expectedOwner);
      requireValue(listId !== null, "Apple returned a reminder without its source-proven List relationship.");
      if (!present.has(listId)) candidates.add(listId);
    }
    const errors = [...page.recordErrors];
    if (candidates.size) {
      // One bounded lookup, using only references returned by the authenticated
      // private zone. No reminder text, membership or asset data is requested.
      const lookup = await this.lookup([...candidates], true);
      requireValue(lookup.unresolvedRecordNames.length === 0, "Apple omitted a referenced list from the lookup response.");
      lists.push(...lookup.records);
      for (const error of lookup.recordErrors) {
        // Old reminder changes can refer to a list that no longer exists.
        // Keep an authoritative absence so older changes cannot resurrect it.
        if (error.serverErrorCode === "UNKNOWN_ITEM" && error.recordName) lists.push({ recordName: error.recordName, deleted: true, raw: error.raw });
        else errors.push(error);
      }
    }
    return { ...page, records: lists, recordErrors: errors, complete: page.paginationComplete && errors.length === 0, pendingReason: page.pendingReason ?? (errors.length ? "record_errors" : null) };
  }

  async catalogueSyncPage(options: { syncToken?: string | null; limit?: number }): Promise<CloudKitPage> {
    const page = await this.changesPage({ syncToken: options.syncToken, limit: options.limit, desiredRecordTypes: ["List", "Reminder"], desiredKeys: [...LIST_SUMMARY_KEYS, "List"] });
    // A checkpoint acknowledges the entire source page. Partial source errors
    // cannot be committed, even when the errored record appears unrelated.
    requireValue(page.recordErrors.length === 0, "Apple returned record errors in the catalogue change page. The saved checkpoint was not advanced.");
    const touched = new Set<string>();
    for (const record of page.records) {
      if (record.recordName.startsWith("List/")) touched.add(record.recordName);
      else if ("recordType" in record && record.recordType === "Reminder") {
        const listId = referenceField(record, "List", "List", this.expectedOwner);
        // Logical reminder deletion uses Deleted=1 as well as CloudKit's
        // tombstone marker. Such history can legitimately omit its old List.
        requireValue(listId !== null || record.deleted === true || boolField(record, "Deleted") === true, "Apple returned a reminder without its source-proven List relationship.");
        if (listId !== null) touched.add(listId);
      }
    }
    if (!touched.size) return { ...page, records: [] };
    // Historical records identify what to refresh, never the current state.
    // Lookup every touched identifier, including known lists and tombstones.
    const current = await this.lookup([...touched], true);
    requireValue(current.unresolvedRecordNames.length === 0, "Apple omitted a touched list from its current lookup. The saved checkpoint was not advanced.");
    const lists = [...current.records];
    for (const record of lists) requireValue(!("recordType" in record) || record.recordType === "List", "Apple returned an unexpected record in the current list lookup.");
    for (const error of current.recordErrors) {
      requireValue(error.recordName !== null && ["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode), "Apple could not refresh a touched list. The saved checkpoint was not advanced.");
      lists.push({ recordName: error.recordName, deleted: true, raw: error.raw });
    }
    return { ...page, records: lists, recordErrors: [], complete: page.paginationComplete };
  }

  async queryPage(options: { recordType: "List" | "Reminder"; limit?: number; continuation?: string | null }): Promise<CloudKitPage> {
    requireInput(options.recordType === "List" || options.recordType === "Reminder", "The requested Reminders query record type is invalid.");
    const limit = boundedLimit(options.limit);
    const continuation = requestedToken(options.continuation, "The CloudKit continuation marker is invalid.");
    const payload: Record<string, unknown> = { query: { recordType: options.recordType }, zoneID: this.requestZone, resultsLimit: limit };
    if (continuation) payload.continuationMarker = continuation;
    const page = this.queryResponse(await this.post("/records/query", payload), limit, continuation);
    for (const record of page.records) {
      const type = "recordType" in record ? record.recordType : record.recordName.slice(0, record.recordName.indexOf("/"));
      requireValue(type === options.recordType, "Apple returned an unrequested record type in the Reminders query page.");
    }
    return page;
  }

  async queryRemindersPage(options: { listId: string; includeCompleted: boolean; limit?: number; continuation?: string | null }): Promise<CloudKitPage> {
    requireInput(typeof options.includeCompleted === "boolean", "The completed-reminder query option must be explicit.");
    const listId = requestedRecordName(options.listId, ["List"]);
    const limit = boundedLimit(options.limit);
    const continuation = requestedToken(options.continuation, "The CloudKit continuation marker is invalid.");
    const payload: Record<string, unknown> = {
      query: {
        recordType: "reminderList",
        filterBy: [
          { comparator: "EQUALS", fieldName: "List", fieldValue: { type: "REFERENCE", value: { recordName: listId, action: "VALIDATE" } } },
          { comparator: "EQUALS", fieldName: "includeCompleted", fieldValue: { type: "INT64", value: options.includeCompleted ? 1 : 0 } },
          { comparator: "EQUALS", fieldName: "LookupValidatingReference", fieldValue: { type: "INT64", value: 1 } },
        ],
      },
      zoneID: this.requestZone,
      resultsLimit: limit,
    };
    if (continuation) payload.continuationMarker = continuation;
    // Upstream does not define whether resultsLimit includes auxiliary records.
    // Bound the flattened response independently; follow Apple's continuation.
    const page = this.queryResponse(await this.post("/records/query", payload), MAX_COMPOUND_RECORDS, continuation, MAX_COMPOUND_RECORDS);
    for (const record of page.records) {
      if ("recordType" in record && record.recordType === "Reminder") {
        requireValue(normalizeReminder(record, this.expectedOwner).listId === listId, "Apple returned a reminder linked to a different list.");
      }
    }
    return page;
  }

  private queryResponse(result: Record<string, unknown>, limit: number, requestedContinuation: string | null, absoluteLimit = MAX_PAGE_SIZE): CloudKitPage {
    const parsed = pageRecords(result.records, limit, absoluteLimit, this.expectedOwner);
    const next = optionalString(result.continuationMarker, "Apple returned a malformed query continuation marker.");
    if (next !== null) {
      validateToken(next, "Apple returned a malformed query continuation marker.");
      requireValue(next !== requestedContinuation, "Apple repeated a query continuation marker.");
    }
    const syncToken = optionalString(result.syncToken, "Apple returned a malformed query checkpoint.");
    if (syncToken !== null) validateToken(syncToken, "Apple returned a malformed query checkpoint.");
    const paginationComplete = next === null;
    const pendingReason = next !== null ? "continuation" : parsed.recordErrors.length ? "record_errors" : null;
    return { ...parsed, paginationComplete, complete: paginationComplete && parsed.recordErrors.length === 0, continuation: next, syncToken, pendingReason };
  }

  async changesPage(options: { desiredRecordTypes: Array<"List" | "Reminder">; desiredKeys?: string[]; syncToken?: string | null; limit?: number; reverse?: boolean }): Promise<CloudKitPage> {
    requireInput(Array.isArray(options.desiredRecordTypes) && options.desiredRecordTypes.length > 0 && options.desiredRecordTypes.length <= 2, "The requested Reminders change record types are invalid.");
    const desiredRecordTypes = [...options.desiredRecordTypes];
    requireInput(desiredRecordTypes.every((type) => type === "List" || type === "Reminder"), "The requested Reminders change record types are invalid.");
    requireInput(new Set(desiredRecordTypes).size === desiredRecordTypes.length, "The requested Reminders change record types contain duplicates.");
    const limit = boundedLimit(options.limit);
    const syncToken = requestedToken(options.syncToken, "The CloudKit change checkpoint is invalid.");
    const desiredKeys = options.desiredKeys;
    if (desiredKeys !== undefined) {
      const allowed = new Set(["Name", "Color", "Count", "IsGroup", "BadgeEmblem", "SortingStyle", "Deleted", "ReminderIDs", "TitleDocument", "NotesDocument", "List", "Completed", "CompletionDate", "DueDate", "StartDate", "Priority", "Flagged", "AllDay", "TimeZone", "ParentReminder", "AlarmIDs", "AttachmentIDs", "HashtagIDs", "RecurrenceRuleIDs", "CreationDate", "LastModifiedDate"]);
      requireInput(Array.isArray(desiredKeys) && desiredKeys.length <= allowed.size && desiredKeys.every((key) => allowed.has(key)), "The requested Reminders fields are outside the supported read projection.");
    }
    const zoneRequest: Record<string, unknown> = { zoneID: this.requestZone, desiredRecordTypes };
    requireInput(options.reverse === undefined || typeof options.reverse === "boolean", "The requested catalogue ordering is invalid.");
    if (options.reverse) zoneRequest.reverse = true;
    if (desiredKeys !== undefined) zoneRequest.desiredKeys = [...desiredKeys];
    if (syncToken) zoneRequest.syncToken = syncToken;
    const result = await this.post("/changes/zone", { zones: [zoneRequest], resultsLimit: limit });
    requireValue(Array.isArray(result.zones) && result.zones.length === 1, "Apple returned an ambiguous Reminders change response.");
    const zone = object(result.zones[0], "Apple returned a malformed Reminders change page.");
    zoneID(zone.zoneID, false, true, this.expectedOwner);
    parseTopLevelError(zone, { path: "/changes/zone", upstreamStatus: 200, hasSessionCookie: this.http.jar.header(this.endpoint).length > 0 });
    const nextSyncToken = validateToken(zone.syncToken, "Apple omitted the Reminders change checkpoint.");
    if (zone.moreComing === true) requireValue(nextSyncToken !== syncToken, "Apple repeated a Reminders change checkpoint while reporting more changes.");
    requireValue(zone.moreComing === true || zone.moreComing === false || zone.moreComing === null || zone.moreComing === undefined, "Apple returned an invalid Reminders pagination marker.");
    const parsed = pageRecords(zone.records, limit, MAX_PAGE_SIZE, this.expectedOwner, true);
    for (const record of parsed.records) {
      const type = "recordType" in record ? record.recordType : record.recordName.slice(0, record.recordName.indexOf("/"));
      requireValue(desiredRecordTypes.includes(type as "List" | "Reminder"), "Apple returned an unrequested record type in the Reminders change page.");
    }
    // Pinned pyicloud treats null/omitted moreComing as terminal. Apple is
    // observed to return null here; a checkpoint alone is not a next-page signal.
    const paginationComplete = zone.moreComing !== true;
    const pendingReason = !paginationComplete ? "more_coming" : parsed.recordErrors.length ? "record_errors" : null;
    return { ...parsed, paginationComplete, complete: paginationComplete && parsed.recordErrors.length === 0, continuation: null, syncToken: nextSyncToken, pendingReason, moreComing: zone.moreComing === true ? true : zone.moreComing === false ? false : null };
  }
}
