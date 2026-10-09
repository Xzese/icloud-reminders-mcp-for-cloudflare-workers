import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AppleConnectionService, ControlledRead } from "../auth/service.ts";
import { publicError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";

export async function handleMCP(request: Request, env: RuntimeEnv, owner: string) {
  const server = new McpServer({ name: "hosted-icloud-reminders", version: "0.1.0" });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const expectedGeneration = z.number().int().nonnegative().safe().optional();
  const liveRead = async (args: Record<string, unknown>) => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readForMCP(ControlledRead.parse({ ...args, expectedGeneration: generation }));
      const page = response.result as Record<string, unknown>;
      // Return normalized reminder fields. Raw CloudKit records/traces can carry
      // signed asset links or opaque cursors and stay in the controlled UI.
      const records = (page.records as Record<string, unknown>[]).filter(record => args.action !== "saved-lists" || (!record.deleted && !record.isGroup)).map(record => {
        const { appleRecord: _appleRecord, ...normalized } = record; return normalized;
      });
      const result = { generation: response.generation, records, complete: page.complete, paginationComplete: page.paginationComplete,
        continuation: page.continuation, pendingReason: page.pendingReason, listId: page.listId,
        recordErrors: (page.recordErrors as Record<string, unknown>[]).map(error => ({ id: error.id, code: error.code })),
        catalogueSync: page.catalogueSync, source: page.source, freshness: page.freshness, writesEnabled: false };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const result = publicError(error, crypto.randomUUID());
      return { isError: true, structuredContent: { error: result }, content: [{ type: "text" as const, text: result.message }] };
    }
  };
  server.registerTool("get_reminder_lists", { title: "Get current iCloud reminder lists", description: "Retrieve the owner's selectable lists using the configured discovery strategy. Experimental direct mode queries current private-zone Lists, follows bounded pagination, and saves only complete snapshots; it never reads historical changes. The default legacy mode starts or resumes up to 25 historical catalogue pages per call and may return retryable SYNC_IN_PROGRESS. An incomplete direct discovery returns an actionable error and preserves the previous snapshot; it never silently switches strategies. expectedGeneration pins the Apple session. No reminders are modified.", inputSchema: z.object({ expectedGeneration }).strict(), annotations: readAnnotations }, args => liveRead({ ...args, action: "saved-lists" }));
  server.registerTool("get_reminders", { title: "Get current reminders from an iCloud list", description: "Verify an exact listId with a live owner-bound lookup, then fetch one current Apple reminder page without historical catalogue synchronization. Open reminders only by default; includeCompleted includes completed items. Contents are live and never cached. Follow the opaque continuation with the same listId and includeCompleted option; paginationComplete indicates the final page. A saved list ID alone is not proof of access. All reminder writes remain disabled.", inputSchema: z.object({ expectedGeneration, listId: z.string().min(6).max(512).startsWith("List/"), includeCompleted: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(200), continuation: z.string().min(1).max(8192).nullable().optional() }).strict(), annotations: readAnnotations }, args => liveRead({ ...args, action: "reminders" }));
  server.registerTool("get_all_open_reminders", { title: "Get open reminders across all iCloud lists", description: "Discover selectable lists using the configured direct or legacy strategy, then read current open reminders across them. Experimental direct mode performs no historical scan. Default legacy discovery may return SYNC_IN_PROGRESS before starting. Resumptions use the operation's saved list selection without rediscovery. A bounded incomplete reminder result includes progress and a single-use, ten-minute owner/session-bound continuation; combine returned records across successful pages. complete=true requires every selected list to finish. Inspect errors before retrying and respect retryAfterSeconds. Reminder contents are never persisted.", inputSchema: z.object({ expectedGeneration, continuation: z.string().uuid().nullable().optional() }).strict(), annotations: readAnnotations }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readAllOpenForMCP(generation, args.continuation);
      const page = response.result;
      const result = { ...page, generation: response.generation, records: page.records.map(record => { const { appleRecord: _appleRecord, ...normalized } = record; return normalized; }), writesEnabled: false };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const result = publicError(error, crypto.randomUUID());
      return { isError: true, structuredContent: { error: result }, content: [{ type: "text" as const, text: result.message }] };
    }
  });
  server.registerTool("connection_status", { title: "Reminders connection status", description: "Report the connection, current session generation and available read-only tools. A READY connected session supports get_reminder_lists, get_reminders and get_all_open_reminders. Full-product validation remains separate from availability of these bounded reads. Known-list reads bypass catalogue synchronization. List and all-open discovery use the configured strategy; direct mode remains experimental and legacy mode can return SYNC_IN_PROGRESS. This status tool reports state without fetching Apple data. It never accepts Apple credentials.", inputSchema: z.object({}).strict(), annotations }, async () => {
    try {
      const result = await new AppleConnectionService(env, owner).status();
      return { structuredContent: result, content: [{ type: "text", text: result.message }] };
    } catch (error) {
      const result = publicError(error, crypto.randomUUID());
      return { isError: true, structuredContent: { error: result }, content: [{ type: "text", text: result.message }] };
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65_536 });
  try { await server.connect(transport); return await transport.handleRequest(request); }
  finally { await server.close(); }
}
