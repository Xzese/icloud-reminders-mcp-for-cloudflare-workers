import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";

// The undocumented Lists query has synthetic coverage only. Operators must
// explicitly opt in until completeness is validated on approved live accounts.
export function listDiscoveryStrategy(env: RuntimeEnv): "direct" | "legacy" {
  const strategy = env.REMINDERS_LIST_DISCOVERY ?? "legacy";
  if (strategy !== "direct" && strategy !== "legacy") throw new AppError("CONFIGURATION_REQUIRED", "REMINDERS_LIST_DISCOVERY must be direct or legacy.", 503);
  return strategy;
}
