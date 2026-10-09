import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AppleConnectionService, ControlledRead } from "../auth/service.ts";
import { publicError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { CreateReminderInput, UpdateReminderInput } from "../reminders/writes.ts";
import { requireAppleWritesEnabled } from "../auth/gates.ts";

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
        catalogueSync: page.catalogueSync, freshness: page.freshness, writesEnabled: response.writesEnabled };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const result = publicError(error, crypto.randomUUID());
      return { isError: true, structuredContent: { error: result }, content: [{ type: "text" as const, text: result.message }] };
    }
  };
  server.registerTool("get_reminder_lists", { title: "Get current iCloud reminder lists", description: "Read the owner's discovered iCloud lists after catching up the saved forward change checkpoint. This call automatically starts or resumes an unfinished initial scan; no dashboard action or background scheduler is required. Each call processes at most 25 catalogue pages within a 20-second budget and saves each successful page. If scanning is unfinished, returns retryable SYNC_IN_PROGRESS; repeat this tool to continue from saved progress rather than treating it as an empty list. No reminders are modified. An optional expectedGeneration pins the Apple session from connection_status.", inputSchema: z.object({ expectedGeneration }).strict(), annotations: readAnnotations }, args => liveRead({ ...args, action: "saved-lists" }));
  server.registerTool("get_reminders", { title: "Get current reminders from an iCloud list", description: "Automatically start or resume catalogue scanning, catch up newer changes from the saved forward checkpoint, then fetch one current Apple reminder page for listId from get_reminder_lists. Open reminders only by default; includeCompleted includes completed items. Reminder contents are fetched live, not cached. Returns paginationComplete and a continuation for further pages; do not treat a bounded page as the whole list. Retryable SYNC_IN_PROGRESS means this call advanced the bounded scan but it must finish before results are available; repeat the tool to continue. Create and edit operations require separate write tools and explicit operator opt-in.", inputSchema: z.object({ expectedGeneration, listId: z.string().min(6).max(512).startsWith("List/"), includeCompleted: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(200), continuation: z.string().min(1).max(8192).nullable().optional() }).strict(), annotations: readAnnotations }, args => liveRead({ ...args, action: "reminders" }));
  server.registerTool("get_all_open_reminders", { title: "Get open reminders across all iCloud lists", description: "Automatically start or resume catalogue scanning and catch up the saved checkpoint, then read current open reminders across every discovered selectable list, following each list's pages. Retryable SYNC_IN_PROGRESS means catalogue scanning is unfinished; repeat this tool without a continuation to continue the saved scan. Returns complete=true only when every list finishes without record errors. A bounded incomplete result includes progress and an opaque continuation; call again with that continuation and combine the returned records. Stop and inspect recordErrors or errors before retrying a failed read; respect retryAfterSeconds when provided. The continuation is short-lived and bound to this owner and Apple session. It never modifies reminders or stores their contents.", inputSchema: z.object({ expectedGeneration, continuation: z.string().uuid().nullable().optional() }).strict(), annotations: readAnnotations }, async args => {
    try {
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readAllOpenForMCP(generation, args.continuation);
      const page = response.result;
      const result = { ...page, generation: response.generation, records: page.records.map(record => { const { appleRecord: _appleRecord, ...normalized } = record; return normalized; }), writesEnabled: response.writesEnabled };
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const result = publicError(error, crypto.randomUUID());
      return { isError: true, structuredContent: { error: result }, content: [{ type: "text" as const, text: result.message }] };
    }
  });
  const write = async (action: "create" | "update", args: Record<string, unknown>) => {
    try {
      requireAppleWritesEnabled(env);
      const apple = new AppleConnectionService(env, owner);
      const generation = args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.mutate({ ...args, action, expectedGeneration: generation });
      return { structuredContent: result, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      const result = publicError(error, crypto.randomUUID());
      return { isError: true, structuredContent: { error: result }, content: [{ type: "text" as const, text: result.message }] };
    }
  };
  server.registerTool("create_reminder", {
    title: "Create an iCloud reminder",
    description: "Create one open reminder in listId from get_reminder_lists. Requires operator-enabled write access and a ready Apple session. Supply a new UUID idempotencyKey for each distinct reminder and keep that same key and input when retrying an uncertain creation; the UUID determines the Apple record ID and prevents duplicate items. Supports title, notes, priority (0 none, 1 high, 5 medium, 9 low), flagged, dueDate with an explicit ISO 8601 offset, timeZone and allDay. An all-day reminder requires a date and time zone. No alarms, recurrence, attachments, subtasks or completion changes are created. WRITE_OUTCOME_UNKNOWN means Apple may have committed: inspect the supplied reminderId and reuse the same idempotencyKey, never create a second key for that attempt. Returned replayed=true means the matching existing item was read and no new write was sent.",
    inputSchema: CreateReminderInput.extend({ expectedGeneration }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, args => write("create", args));
  server.registerTool("update_reminder", {
    title: "Edit an open iCloud reminder",
    description: "Edit one open reminder using listId, reminderId and the current recordChangeTag from get_reminders. Requires operator-enabled write access. Provide a nonempty changes object with only the fields to edit: title, notes, priority (0/1/5/9), flagged, dueDate, timeZone or allDay. Omitted fields stay unchanged; null clears a date/time zone, and clearing a date also clears its time zone and all-day marker unless explicitly overridden. Text edits replace that field's text formatting; untouched documents are preserved. Date changes on alarmed or recurring reminders are refused because their linked records require a separate protocol. A stale version returns CONFLICT; re-read and review before trying again. WRITE_OUTCOME_UNKNOWN means the change may have saved: read current state first. Never automatically retry with a new version or use force-update. Cannot complete, reopen, delete, move lists or edit linked records.",
    inputSchema: UpdateReminderInput.extend({ expectedGeneration }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, args => write("update", args));
  server.registerTool("connection_status", { title: "Reminders connection status", description: "Report connection state, session generation and available tools without fetching Apple data. A READY session supports bounded reads; writeEnabled and capabilities.create/update report the operator's explicit create/edit opt-in. Full-product/live acceptance remain separate from tool availability. Read tools start or resume an unfinished catalogue scan and return retryable SYNC_IN_PROGRESS while work remains. Creation and editing never bypass the write gate or accept Apple credentials. Completion, reopening and deletion remain unavailable.", inputSchema: z.object({}).strict(), annotations }, async () => {
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
