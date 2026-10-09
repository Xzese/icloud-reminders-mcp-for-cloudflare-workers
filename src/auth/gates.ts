import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export function appleGates(env: RuntimeEnv) {
  const liveConnectionApproved = env.LIVE_APPLE_CONNECTION_APPROVED === "controlled-device-v2";
  const cryptographyReviewed = env.APPLE_CRYPTO_REVIEW_APPROVED === "device-proof-v2";
  return { enabled: liveConnectionApproved && cryptographyReviewed, liveConnectionApproved, cryptographyReviewed, writesEnabled: false, loginPolicy: "device-only-v2", verificationMethod: "trusted-device-spake2", passwordLocation: "browser-only", sessionStorage: "owner-scoped-encrypted", sessionLifetimeMs: 86_400_000, socketLifetimeMs: 180_000 } as const;
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
