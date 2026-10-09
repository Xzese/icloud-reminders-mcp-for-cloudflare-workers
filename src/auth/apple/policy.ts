import { z } from "zod";
import { AppError } from "../../errors.ts";

export const APPLE_LOGIN_POLICY = "device-only-v2";
export const SESSION_RETENTION_MS = 24 * 60 * 60_000;
export const LoginAssuranceSchema = z.object({
  version: z.literal(2),
  policy: z.literal(APPLE_LOGIN_POLICY),
  factor: z.literal("trusted-device-spake2"),
  verifiedAt: z.number().int().positive().safe(),
  expiresAt: z.number().int().positive().safe(),
  consentAppleTrust: z.literal(true),
  consentPersistentSession: z.literal(true),
}).strict().refine(value => value.expiresAt === value.verifiedAt + SESSION_RETENTION_MS, "Invalid session retention deadline.");
export type LoginAssurance = z.infer<typeof LoginAssuranceSchema>;
export function loginAssurance(now = Date.now()): LoginAssurance {
  return { version: 2, policy: APPLE_LOGIN_POLICY, factor: "trusted-device-spake2", verifiedAt: now, expiresAt: now + SESSION_RETENTION_MS, consentAppleTrust: true, consentPersistentSession: true };
}
export function requireCurrentLogin(login: LoginAssurance, now = Date.now()) {
  if (login.verifiedAt > now + 5000 || now >= login.expiresAt) throw new AppError("AUTH_EXPIRED", "This connection's retained session has expired. Reconnect and verify your Apple device again.", 409);
}

// Apple has endpoint-specific success conventions. In particular, a bridge
// validation 409 is accepted by the pinned protocol. Explicit rejection is
// never overridden by an otherwise supported HTTP status.
export function requireNoAppleRejection(body: Record<string, unknown> | null) {
  if (!body) return;
  const securityCode = body.securityCode;
  const rejected = body.success === false || body.valid === false || body.verified === false || body.authenticated === false ||
    body.error !== undefined && body.error !== null || body.errorCode !== undefined && body.errorCode !== 0 && body.errorCode !== "0" ||
    Array.isArray(body.serviceErrors) && body.serviceErrors.length > 0 ||
    securityCode !== null && typeof securityCode === "object" && !Array.isArray(securityCode) && (securityCode as Record<string, unknown>).valid === false;
  if (rejected) throw new AppError("VERIFICATION_REQUIRED", "Apple rejected this authentication step. Restart sign-in; no session was saved.", 409);
}
