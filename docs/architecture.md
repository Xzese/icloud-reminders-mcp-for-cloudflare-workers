# Architecture

The shared application exposes a private dashboard, isolated credential document and stateless
HTTP MCP at `/mcp`. `src/api/router.ts` authorizes API requests before database operations.

In Sites mode, `src/worker.ts` is the platform-dispatched entrypoint. In standalone mode,
`src/index.ts` verifies the Cloudflare Access assertion, removes supplied identity headers, and
passes only the verified principal to that shared Worker. Managed OAuth is handled by Cloudflare
Access at the edge; the application does not run an OAuth authorization server.

All application code is under `src/`: `src/app/` holds the dashboard and browser login client;
`src/components/`, `src/hooks/`, `src/lib/` and `src/types/` hold shared UI, helpers and declarations.
Build-time framework plugins live in `scripts/build/`. Operational commands are grouped by
purpose under `scripts/`; built Worker acceptance runners live in `tests/integration/`.
The editable standalone configuration is `wrangler.toml`, with private/generated TOML copies
excluded from public source. Framework-generated Wrangler JSON stays inside `dist/`.

D1 holds encrypted Apple-session envelopes in `apple_session_state`. Envelope associated data
binds owner/account/generation/schema. Versioned leases fence concurrent setup, consent, reads, writes
and disconnect. `schema.sql` defines the sole application table for a new deployment. Local setup
and tests execute it directly using native D1. Standalone operators initialize D1 with Wrangler's
`d1 execute --file schema.sql`. The Sites build copies it into the platform's SQL initialization
layout at `dist/.openai/drizzle/0000_schema.sql`; this is a generated build artifact, not a separate
schema source or a dependency on Drizzle. Setup uses `CREATE TABLE IF NOT EXISTS` to preserve
existing data when repeated. Schema changes to an existing database need a separate upgrade plan.

The credential document's standalone browser bundle performs password proof processing. The
Worker handles bounded Apple HTTP/WebSocket exchanges, trusted-device verification and PCS
consent. It stores encrypted session credentials with an absolute local lifetime rather than
storing the password. The cryptography and protocol are unofficial and need independent review.

List discovery is selected by `REMINDERS_LIST_DISCOVERY`: default `legacy` keeps bounded forward
catalogue synchronization; explicit experimental `direct` uses the private CloudKit `Lists` query
without reading history. Singular `List` summaries are normalized across bounded continuations and
committed only after complete retrieval. The authoritative direct snapshot and optional legacy
recovery collection share the existing encrypted version-1 envelope. Added fields are optional,
so existing sessions, checkpoints and all-open continuations load without a schema migration.

Known-list reads use a live exact lookup within the authenticated Reminders zone before the existing
`reminderList` query. They do not inspect catalogue checkpoints. All-open starts with the configured
discovery strategy, stores selected list summaries/IDs and per-list cursors, and rotates single-use
continuations before queries. Direct resumption never rediscovers lists and a dashboard refresh
cannot skip outstanding pages. Reminder bodies are not persisted. Every remote operation retains
read leases, version/generation fences and absolute expiry checks on commit.

Direct mode suppresses the optional background scanner. Legacy scheduled events reuse the fenced
catalogue operation only when a runner is configured. Neither a background-handler declaration nor
browser polling provisions a recurring trigger. Dashboard polling reads saved state only. Direct
list discovery has synthetic coverage and an approved one-account live test of existing lists and
creation/deletion freshness. Live pagination, groups and shared database completeness remain unknown;
direct mode stays opt-in.
See [direct discovery evidence](direct-list-retrieval.md).

Reminder creation, editing, completion, reopening and deletion use the same private CloudKit
transport and session lease. They require the bound authenticated owner and a ready unexpired
Apple session, with no separate write-approval flag. Exact lookups verify the current list and reminder before dispatch.
Creates derive the Apple record ID from the caller's UUID idempotency key, while updates send
only changed fields with an exact server change tag. Resolution tokens for untouched fields
are retained. Reminder content and mutation receipts are not cached in D1, and no new database
table or resource is required. The protocol rejects force-update, replacement and hard deletion; soft deletion uses a tagged update.

Writes are never automatically retried or redirected. An uncertain upstream response or a lost
session fence after submission returns `WRITE_OUTCOME_UNKNOWN`; local fencing cannot undo an
Apple request already in flight. Read current state before another edit, or reconcile creation
using the same UUID. Successful mutations invalidate an unfinished all-open continuation so it
cannot silently skip a newly created item in a previously scanned list. See `write-access.md`.

The provenance directory preserves upstream references and licenses. Checked-in synthetic fixtures
exercise the pinned protocol reference, not a live Apple account. See SECURITY.md for invariants
and README.md for separate provisioning and identity requirements.
