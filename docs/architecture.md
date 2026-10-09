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
binds owner/account/generation/schema. Versioned leases fence concurrent setup, consent, reads
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

Forward catalogue pages update encrypted list snapshots/checkpoints. Reminder MCP calls drive
bounded initial and incremental synchronization, then live reminder queries. Reminder bodies are
not persisted. Optional standalone scheduled events reuse the same fenced catalogue operation.
Neither a background-handler declaration nor browser polling provisions a recurring trigger.

The provenance directory preserves upstream references and licenses. Checked-in synthetic fixtures
exercise the pinned protocol reference, not a live Apple account. See SECURITY.md for invariants
and README.md for separate provisioning and identity requirements.
