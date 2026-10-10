import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { LEGACY_SESSION_RETENTION_MS, RETENTION_POLICY, SESSION_RETENTION_MS } from "./apple/policy.ts";
export function appleGates(env: RuntimeEnv) {
  const liveConnectionApproved = env.LIVE_APPLE_CONNECTION_APPROVED === "controlled-device-v2";
  const cryptographyReviewed = env.APPLE_CRYPTO_REVIEW_APPROVED === "device-proof-v2";
  const enabled = liveConnectionApproved && cryptographyReviewed;
  const retentionWritesEnabled = env.APPLE_SESSION_RETENTION_WRITES === RETENTION_POLICY;
  const sessionLifetimeMs = retentionWritesEnabled ? SESSION_RETENTION_MS : LEGACY_SESSION_RETENTION_MS;
  return { enabled, liveConnectionApproved, cryptographyReviewed, loginPolicy: "device-only-v2", verificationMethod: "trusted-device-spake2", passwordLocation: "browser-only", sessionStorage: "owner-scoped-encrypted", sessionLifetimeMs, retentionDays: sessionLifetimeMs / 86_400_000, retentionWritesEnabled, renewalEnabled: env.APPLE_SESSION_RENEWAL_ENABLED === "saved-tokens-v1", socketLifetimeMs: 180_000 } as const;
}
export function appleDisabledMessage(gates: ReturnType<typeof appleGates>) {
  return gates.cryptographyReviewed
    ? "Apple sign-in is paused. The login form is disabled, so refreshing will not start a login or prompt your Apple devices."
    : "Apple sign-in is unavailable pending review and approval for a controlled account test.";
}
export function requireAppleEnabled(env: RuntimeEnv) {
  const gates = appleGates(env);
  if (!gates.enabled) throw new AppError("UNSUPPORTED_AUTH", appleDisabledMessage(gates));
}
