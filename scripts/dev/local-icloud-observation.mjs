// Counts and protocol metadata only. No account identifiers, field values or tokens.
export function localAppleHeaders(input) {
  const headers = new Headers(input);
  // Miniflare adds a fictitious zone marker (worker.example.com). That is local
  // emulation metadata, not an Apple protocol header or a real hosted Worker.
  headers.delete("cf-worker");
  return headers;
}
export function summarizeAppleFailure(url, { stage, status, bytesRead, elapsedMs, timeout, aborted, error }) {
  return {
    at: new Date().toISOString(), host: url.hostname, path: url.pathname, event: "local-apple-request-failed",
    stage: ["headers", "body", "observation"].includes(stage) ? stage : "unknown",
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    bytesRead: Number.isSafeInteger(bytesRead) && bytesRead >= 0 ? bytesRead : null,
    elapsedMs: Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
    failure: error?.code === "LOCAL_RESPONSE_BYTE_BUDGET" ? "response-byte-budget" : timeout ? "timeout" : aborted ? "incoming-abort" : "transport-failure",
  };
}
export function summarizeAppleResponse(url, status, body) {
  const result = { at: new Date().toISOString(), host: url.hostname, path: url.pathname, status };
  if (!body || typeof body !== "object" || Array.isArray(body)) return result;
  if (url.hostname === "setup.icloud.com" && url.pathname === "/setup/ws/1/accountLogin") {
    result.services = {};
    for (const [name, service] of Object.entries(body.webservices ?? {})) {
      if (!/^[a-z][a-z0-9_-]{0,50}$/i.test(name) || typeof service?.url !== "string") continue;
      try {
        const address = new URL(service.url);
        if (address.protocol !== "https:" || address.username || address.password || address.port || !/(^|\.)(icloud\.com|apple\.com)$/.test(address.hostname)) continue;
        result.services[name] = { origin: address.origin, disabled: service.disabled === true };
      } catch { /* Unsupported advertised service: do not log it. */ }
    }
  }
  if (/^p\d{1,3}-ckdatabasews\.icloud\.com$/.test(url.hostname)) {
    const zones = Array.isArray(body.zones) ? body.zones : [];
    result.zones = zones.length;
    result.remindersZonePresent = zones.some(z => z?.zoneID?.zoneName === "Reminders");
    const records = Array.isArray(body.records) ? body.records : zones.flatMap(z => Array.isArray(z?.records) ? z.records : []);
    result.records = records.length;
    result.recordTypes = {};
    result.relationshipFieldTypes = {};
    result.catalogueReminderShapes = {};
    for (const record of records) {
      const type = typeof record?.recordType === "string" && ["List", "Reminder", "Alarm", "AlarmTrigger", "Attachment", "Hashtag", "RecurrenceRule"].includes(record.recordType) ? record.recordType : "other";
      result.recordTypes[type] = (result.recordTypes[type] ?? 0) + 1;
      if (type === "Reminder" && url.pathname.endsWith("/changes/zone")) {
        const deleted = record.deleted === true ? "tombstone" : record.fields?.Deleted?.value === 1 ? "logical-deleted" : record.fields?.Deleted?.value === 0 ? "active" : "unknown-deletion";
        const list = record.fields?.List;
        const relationship = !list ? "no-list-field" : list.value == null ? "null-list" : list.type === "REFERENCE" ? "reference" : "other-list-type";
        const bucket = `${deleted}:${relationship}`;
        result.catalogueReminderShapes[bucket] = (result.catalogueReminderShapes[bucket] ?? 0) + 1;
      }
      if (type === "Reminder") for (const key of ["AlarmIDs", "AttachmentIDs", "HashtagIDs", "RecurrenceRuleIDs"]) {
        const field = record.fields?.[key];
        if (!field || typeof field !== "object") continue;
        const fieldType = ["STRING", "STRING_LIST", "REFERENCE_LIST", "INT64_LIST", "UNKNOWN_LIST", "EMPTY_LIST"].includes(field.type) ? field.type : "other";
        const shape = Array.isArray(field.value) ? field.value.length === 0 ? "empty-array" : "array" : field.value == null ? "null" : typeof field.value === "string" ? "string" : "other";
        const bucket = `${key}:${fieldType}:${shape}`;
        result.relationshipFieldTypes[bucket] = (result.relationshipFieldTypes[bucket] ?? 0) + 1;
      }
    }
    result.moreComing = zones.map(z => z?.moreComing === true ? true : z?.moreComing === false ? false : null);
    result.checkpointsPresent = zones.map(z => typeof z?.syncToken === "string");
    result.errors = records.filter(r => typeof r?.serverErrorCode === "string").length;
    result.responseError = typeof body.serverErrorCode === "string";
    if (result.responseError) {
      result.responseErrorCode = /^[A-Z_]{1,64}$/.test(body.serverErrorCode) ? body.serverErrorCode : "other";
      // Only fixed protocol words are retained, never Apple's free-form reason.
      const reason = typeof body.reason === "string" ? body.reason : "";
      result.errorTerms = ["unsupported", "unknown", "invalid", "missing", "query", "filter", "field", "reference", "record", "zone", "type", "limit", "List", "reminderList", "includeCompleted", "LookupValidatingReference", "permission", "index", "not found", "deleted"].filter(term => reason.toLowerCase().includes(term.toLowerCase()));
      result.errorReasonLength = reason.length;
    }
  }
  return result;
}
