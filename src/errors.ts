export type ErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "OWNER_NOT_CONFIGURED"
  | "NOT_CONNECTED" | "UNSUPPORTED_AUTH" | "UNSUPPORTED_FEATURE"
  | "VALIDATION_ERROR" | "PROTOCOL_CHANGED" | "UPSTREAM_UNAVAILABLE"
  | "RATE_LIMITED" | "CONFIGURATION_REQUIRED" | "CONFLICT"
  | "REAUTH_REQUIRED" | "VERIFICATION_REQUIRED" | "DEVICE_APPROVAL_PENDING"
  | "TERMS_ACTION_REQUIRED" | "AUTH_EXPIRED" | "RESTART_REQUIRED" | "WRITE_OUTCOME_UNKNOWN";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, status = 422, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class WriteOutcomeUnknownError extends AppError {
  readonly reminderId: string;
  readonly idempotencyKey?: string;
  constructor(reminderId: string, idempotencyKey?: string) {
    super("WRITE_OUTCOME_UNKNOWN", "Apple may have saved the reminder, but this request could not confirm the result. Read the reminder before trying another change. For creation, reuse the same idempotencyKey; never generate another ID for this attempt.", 503, false);
    this.reminderId = reminderId;
    this.idempotencyKey = idempotencyKey;
  }
}

export function publicError(error: unknown, requestId: string) {
  const e = error instanceof AppError ? error : new AppError(
    "UPSTREAM_UNAVAILABLE", "This operation could not be completed. Try the connection again.", 503, true,
  );
  return { code: e.code, message: e.message, retryable: e.retryable, requestId, ...(e instanceof WriteOutcomeUnknownError ? { reminderId: e.reminderId, ...(e.idempotencyKey ? { idempotencyKey: e.idempotencyKey } : {}) } : {}) };
}

export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AppError("VALIDATION_ERROR", message);
}
