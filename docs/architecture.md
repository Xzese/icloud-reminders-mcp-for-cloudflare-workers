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

The envelope and associated-data schema stay at version 1. Inside it, strict login assurance accepts
legacy version 2 (exactly 24 hours from verification) and version 3 (`absolute-30d-v1`, exactly 30 days).
The authentication policy remains `device-only-v2`; retention is not another Apple verification.
Server-controlled owner/account/generation approval enables a CAS migration before expiry cleanup
in every loader, including status. It preserves credentials and generation, records separate owner
approval, re-encrypts with a fresh nonce, advances row version, and reloads the committed fence.
Active leases defer migration without destructive expiry cleanup. No new D1 table is needed.

`session-renewal.ts` performs request-driven checks under the same exclusive short D1 lease, commits
them, then releases ownership before reminder preparation. The pinned setup `/validate` body is JSON
null. Accepted account/trust/service evidence reuses credentials; a recoverable rejection allows one
saved-token `/accountLogin` exchange, never a password fallback. The six-hour engineering interval is
configurable. Recent successful reminder operations suppress unnecessary proactive checks; full
validation, successful operation and exchange times are separate encrypted metadata. Failures retain
safe state, persist bounded cooldowns/Retry-After and expose required action without raw Apple data.
Local retention expiry and confirmed account rejection are separate from PCS consent or short cursor
expiry. Expired PCS attempts require an explicit new bounded approval request, not status prompts.

Renewal and reminder calls share a complete request budget. Client reconstruction uses committed
cookies and service information. Operation modes distinguish read-only, mutation preparation, cursor
progress and PCS. Authentication recovery may replay a read-only callback or undispatched preparation
once; mutation dispatch/confirmation and cursor progress are never replayed. Existing exact lookups,
idempotency keys, version checks and the final pre-dispatch lease check remain mandatory.
See [compatible rollout and rollback](session-retention.md).

List discovery uses the private CloudKit `Lists` query without reading history. Singular `List`
summaries are normalized across bounded continuations and committed only after complete retrieval.
The encrypted snapshot supports dashboard display; MCP list calls always fetch live data.
Historical discovery, scheduler execution and strategy selection have been removed.

Known-list reads use a live exact lookup within the authenticated Reminders zone before the existing
`reminderList` query. All-open starts with direct discovery, stores selected list summaries/IDs and
per-list cursors, and rotates single-use continuations before queries. Resumption never rediscovers
lists, and a dashboard refresh cannot skip outstanding pages. Reminder bodies are not persisted.
Every remote operation retains read leases, version/generation fences and absolute expiry checks
on commit.

Version-1 session compatibility strips only recognized obsolete catalogue fields. The next successful
commit removes those fields from encrypted storage. Historical or unmarked old all-open continuations
are retired without disconnecting the Apple session; direct operation selections remain valid.
No D1 migration or reset is needed. Unknown active fields still fail strict validation.

Dashboard polling reads saved state only. There is no scheduled handler, local background timer or
historical fallback. Generated standalone configs omit triggers; operators must remove previously
provisioned catalogue schedules during their own deployment. Direct discovery has synthetic coverage
and an approved one-account live test of existing lists and creation/deletion freshness. Live
pagination, groups and shared database completeness remain unknown. See
[direct discovery evidence](direct-list-retrieval.md).

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
