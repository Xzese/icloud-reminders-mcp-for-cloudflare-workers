import { AppError } from "../errors.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { AppleConnectionService } from "./service.ts";
import { appleGates } from "./gates.ts";
import { listDiscoveryStrategy } from "./list-discovery.ts";

export interface CatalogueBackgroundResult {
  started: boolean;
  pages: number;
  pending: boolean;
  reason: string;
}

// Called only by trusted runtime scheduling, never an HTTP route. The owner is
// server configuration, and every page uses the normal session generation lease.
export async function runCatalogueBackground(env: RuntimeEnv): Promise<CatalogueBackgroundResult> {
  let started = false;
  let pages = 0;
  let pending = false;
  if (listDiscoveryStrategy(env) === "direct") return { started, pages, pending, reason: "direct-discovery" };
  if (!env.REMINDERS_OWNER_ID) return { started, pages, pending, reason: "owner-not-configured" };
  if (env.CATALOGUE_BACKGROUND_RUNNER !== "local" && env.CATALOGUE_BACKGROUND_RUNNER !== "cron") return { started, pages, pending, reason: "not-configured" };
  if (!appleGates(env).enabled) return { started, pages, pending, reason: "apple-disabled" };
  try {
    const repository = new AppleSessionRepository(env, env.REMINDERS_OWNER_ID);
    const status = await repository.status();
    if (status.state !== "READY") return { started, pages, pending, reason: "not-ready" };
    const service = new AppleConnectionService(env, env.REMINDERS_OWNER_ID);
    const run = { id: crypto.randomUUID(), until: Date.now() + 30_000 };
    while (pages < 25 && Date.now() < run.until) {
      const page = await service.backgroundCataloguePage(status.generation, run);
      pending = page.pending;
      started ||= page.started;
      if (page.reason !== null) return { started, pages, pending, reason: page.reason };
      pages++;
      if (!pending) return { started, pages, pending, reason: "caught-up" };
    }
    return { started, pages, pending, reason: pages >= 25 ? "page-budget" : "deadline" };
  } catch (error) {
    // Detailed Apple error text and record data never enter scheduler output.
    return { started, pages, pending, reason: error instanceof AppError ? error.code : "UPSTREAM_UNAVAILABLE" };
  }
}
