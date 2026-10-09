# iCloud Reminders MCP Server for Cloudflare Workers

<p align="center">
  <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
</p>

A read-only remote MCP server for your iCloud Reminders, with a private connection dashboard.
Deploy it through **ChatGPT Sites** or to your own **Cloudflare Worker** protected by Cloudflare
Access and Managed OAuth. No containers, Python runtime, KV namespace or Durable Objects are required.

The browser performs the Apple password proof exchange. The Worker stores Apple session cookies,
tokens, list identifiers and scan checkpoints encrypted with AES-256-GCM in D1. Reminder contents
are fetched from Apple when requested and are not cached in D1.

**Experimental, unofficial integration.** This project uses Apple's undocumented web protocols,
not Sign in with Apple or an official Reminders API. The login page is served by your deployment;
you must trust its browser code with your password input. Cryptographic reference tests are not an
independent security audit. Creating, updating, completing and deleting reminders are disabled.

## Table of contents

- [Public source, private deployments](#public-source-private-deployments)
- [Tools](#tools)
- [Resources and configuration](#resources-and-configuration)
- [Local setup](#local-setup)
- [ChatGPT Sites setup](#chatgpt-sites-setup)
- [Cloudflare Worker setup](#cloudflare-worker-setup)
- [Connect ChatGPT](#connect-chatgpt)
- [Connect your Apple account](#connect-your-apple-account)
- [Use the dashboard](#use-the-dashboard)
- [Scanning and pagination](#scanning-and-pagination)
- [Cloudflare repository builds](#cloudflare-repository-builds)
- [Development and project structure](#development-and-project-structure)
- [Security and licensing](#security-and-licensing)

## Public source, private deployments

This repository publishes source under the MIT License. It does not provide a shared public
Reminders service. Each operator creates their own private deployment, database, access policy
and encryption keys. One deployment is restricted to one explicitly bound owner and one Apple
session. Do not configure it as a multi-tenant service or share the owner's MCP connection.

The development checkout is also the public source repository. The checked-in `wrangler.toml`
and `.openai/hosting.json` remain public templates. Keep the private Site binding in ignored
`.sites-runtime/hosting.json`; keep Worker-specific values in ignored deployment configuration
or the hosting platform. Never commit `.dev.vars`,
`.env`, `wrangler.production.toml`, `wrangler.generated.toml`, encryption keys, Apple cookies,
verification codes, session exports, real CloudKit records or signed asset URLs.
`npm run public-config:check` also rejects private/generated files accidentally tracked by Git.
Review Git history before publishing a repository that previously contained private metadata.

## Tools

| Tool | Behaviour |
| --- | --- |
| `connection_status` | Report connection state, session generation and read availability; does not contact Apple. |
| `get_reminder_lists` | Start/resume catalogue synchronization, then return discovered current selectable lists. |
| `get_reminders` | Synchronize the catalogue, then fetch one current page for a `listId`; open reminders by default. |
| `get_all_open_reminders` | Synchronize the catalogue, then fetch open reminders across every discovered selectable list. |

Tools return `structuredContent` plus a text copy for client compatibility. Use the IDs returned
by `get_reminder_lists`. `get_reminders` accepts `includeCompleted`, `limit` (1–200) and its returned
`continuation`. An all-open result with `complete: false` may include a separate opaque continuation;
call `get_all_open_reminders` again with that value and combine the returned records. Inspect errors
before retrying and respect any `retryAfterSeconds`. A partial result is not the entire collection.

## Resources and configuration

| Resource | ChatGPT Sites | Standalone Cloudflare |
| --- | --- | --- |
| Worker and HTTPS origin | Created and managed by Sites | Create a Worker; use its Access-protected hostname or a custom domain. |
| D1 database, binding `DB` | Declared in `.openai/hosting.json`; Sites provisions it and applies the packaged current schema. | Create D1, configure its UUID and execute `schema.sql`. |
| Owner authentication | Sites' dispatch-owned ChatGPT sign-in and Site-scoped identity | Cloudflare Access application, restrictive policy and Managed OAuth; Worker verifies Access JWTs. |
| Encryption | Operator-provided Worker secret | Operator-provided Worker secret |
| MCP registration | Site-hosted plugin at `/mcp` | Register `/mcp` as a custom OAuth MCP connection. |
| Cron (optional) | No recurring Worker trigger is provisioned by this repository | Optional Worker Cron trigger; not required for MCP-driven scanning. |

No R2 bucket, Workers KV, Queue, Durable Object, Apple developer application or OpenAI API key is
used by this implementation. Your Cloudflare plan must support the CPU/memory needs of the login
cryptography and your Access configuration; validate those limits in your deployment.

| Runtime setting | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact HTTPS origin, without a path or trailing slash. |
| `REMINDERS_OWNER_ID` | Exact authenticated principal, obtained through `/api/bootstrap/identity`; never auto-claimed. |
| `ENCRYPTION_KEY_ID` | Active key name, for example `primary`. |
| `ENCRYPTION_KEYS_JSON` **secret** | JSON key ring, for example `{"primary":"<32-byte base64 key>"}`. |
| `LIVE_APPLE_CONNECTION_APPROVED` | `controlled-device-v2` enables the operator-approved account test. |
| `APPLE_CRYPTO_REVIEW_APPROVED` | `device-proof-v2` acknowledges the operator's review of the browser proof protocol. |
| `TEAM_DOMAIN` | Standalone only: `https://<team>.cloudflareaccess.com`. |
| `POLICY_AUD` | Standalone only: Access application's audience tag. |
| `CATALOGUE_BACKGROUND_RUNNER` | Optional: `cron` only with an actual standalone Cron trigger; local launcher sets `local`. |

The two Apple approval settings default to empty. They are operator acknowledgements, not a review
or audit performed by the software. Do not enable them before reviewing the trust boundary and
accepting a controlled account test. Reminder mutations stay disabled even when login is enabled.

## Local setup

Use Node.js **24 or later**, npm and the locked dependencies:

```bash
npm run install:ci
node scripts/setup/create-local-env.mjs
npm run build
npm run db:setup:local
npm run dev
```

Open `http://127.0.0.1:5173/`. This loopback-only development preview uses a synthetic ChatGPT
identity and leaves live Apple login disabled. The environment helper creates an ignored private
`.dev.vars` with a random local encryption key and refuses to overwrite an existing file.
The database setup command executes `schema.sql` against the local preview database. Its
`CREATE TABLE IF NOT EXISTS` statement allows setup to be repeated without clearing session data.

For an explicitly approved live account investigation using the existing dashboard:

```bash
npm run build
npm run dev:icloud
```

The live launcher creates a separate encrypted local session and explicitly enables the controlled
login protocol. It listens only on IPv4 loopback, enforces a private local cookie and strips supplied
identity headers. It must remain running for local access and its automatic checks. Disconnect clears
the stored session. Its ignored `.sites-runtime/local-icloud/` is private account state, not a fixture.

Local tests and CI use synthetic data and do not require an Apple account.

## ChatGPT Sites setup

You need ChatGPT Sites access and its Site-hosted MCP/plugin capability. The platform owns the
Worker, D1 binding, ChatGPT sign-in, MCP connection and publication. Do not deploy its generated
configuration with Wrangler as a substitute for Sites publication.

1. Make this source available to a Sites-capable coding session. Ask it to create a **new private
   Site** from this repository with D1 binding `DB` and MCP capability. The public manifest starts
   without a `project_id`; the platform must register your Site. Save its exact returned identifier
   in ignored `.sites-runtime/hosting.json` as `{"project_id":"<your-project-id>"}`.
   Reuse that identifier for later updates. Never copy another operator's project ID.
2. Keep `.openai/hosting.json` configured with `"d1": "DB"` and `"capabilities": ["mcp"]`.
   Have the Sites-capable session open the Site's private source checkout in
   `.sites-runtime/sites-source` through the native Sites workflow. Run `npm run sites:prepare`
   from the main checkout to copy the current public source and add the private binding there.
   Build and publish **from that generated checkout** through the Sites source/version workflow,
   including the complete build output. The helper can reuse the main checkout's installed
   dependencies; otherwise install them in the generated checkout. Edit application code in
   the main checkout, and reconcile any unsaved Site-source changes before preparing another copy.
   The build packages `schema.sql` in Sites'
   expected SQL initialization layout; Sites provisions the logical D1 binding and applies it.
   `schema.sql` is the only schema source: no Drizzle installation or migration generation is needed.
3. Obtain the published HTTPS origin. In the Site's runtime settings, set `APP_ORIGIN` to that exact
   origin and `ENCRYPTION_KEY_ID` to `primary`. Generate the key ring locally:

   ```bash
   node scripts/deploy/create-encryption-key.mjs primary
   ```

   This output is a secret. Enter it directly as the Site secret `ENCRYPTION_KEYS_JSON`; do not
   paste it into chat or commit it. Keep both Apple approval settings empty at this stage.
4. Open the private Site and **Sign in with ChatGPT**. Use **Copy Site identity**, or open
   `/api/bootstrap/identity`, and bind the returned `authenticatedUserId` as `REMINDERS_OWNER_ID`
   in the Site runtime settings. This identifier is scoped to that Site. Refresh the dashboard.
5. Review the login protocol and security policy. If you approve the controlled test, set the two
   Apple approval settings to the exact values in the configuration table. Environment changes
   must be activated by the platform's environment/deployment workflow. Complete Apple setup as
   described below; verify the hosted connection and a small read before wider use.
6. Open the Site's plugin connection settings. Install and connect its generated plugin in ChatGPT,
   then choose it in a new chat. The endpoint is `https://<your-site>/mcp`. Sites manages the MCP
   OAuth connection; its non-user service token is not a substitute for the owner's identity.

MCP reads themselves start and resume catalogue scans. This setup does not provision hourly
closed-page background checks on Sites. Dashboard polling only displays saved progress.

## Cloudflare Worker setup

### 1. Create the Worker and database

Use your own Cloudflare account and Zero Trust organization. Copy the public configuration:

```bash
npx wrangler login
cp wrangler.toml wrangler.production.toml
npx wrangler d1 create icloud-reminders
```

In `wrangler.production.toml`, set your Worker `name` and the returned D1 `database_id`; retain
binding `DB`. Set `APP_ORIGIN` to your intended Worker HTTPS origin.
Keep Apple login disabled and owner identity empty. The generated Worker name determines the
`*.workers.dev` hostname; a custom-domain deployment must use that exact domain as `APP_ORIGIN`.

```bash
npx wrangler d1 execute icloud-reminders --remote --config wrangler.production.toml --file schema.sql
npm run deploy:cloudflare
```

The first deployment intentionally rejects requests until Access is configured. The build uses
`src/index.ts`, not the Sites-only entrypoint, and routes static assets through the verified Worker
before serving them. `wrangler.production.toml` and the generated config are ignored by Git.

### 2. Configure Cloudflare Access and Managed OAuth

1. Create an Access application covering the **entire Worker hostname**, including the dashboard,
   `/api/`, `/connect/apple`, authentication WebSockets and `/mcp`. Use a self-hosted application
   with Managed OAuth, or the current MCP application flow in your Cloudflare dashboard.
2. Restrict its Allow policy to the single intended owner. Configure your identity provider and
   MFA. Do not use a public Allow-all or Bypass policy.
3. Enable **Managed OAuth** for the application and allow only redirect URIs needed by your MCP
   clients. This makes Access's OAuth flow available to ChatGPT while the browser uses Access
   sign-in. Do not replace the assertion with a shared bearer token.
4. Copy the team domain and application AUD into `TEAM_DOMAIN` and `POLICY_AUD` in your ignored
   production config. Cover every reachable hostname with Access. Disable unused `workers.dev`
   routes if using a custom domain; preview URLs are disabled by the generated configuration.
5. Redeploy with `npm run deploy:cloudflare`.

The Worker independently verifies the signed `Cf-Access-Jwt-Assertion`, issuer, audience, validity
and owner identity before API, dashboard or WebSocket routing. Client-supplied ChatGPT identity
headers are removed. Managed OAuth tokens are opaque; Access resolves them at the edge and
forwards a signed user assertion. The Worker does not treat an arbitrary OAuth bearer as a JWT.

See Cloudflare's [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
and [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
guides for current application setup and token behaviour.

### 3. Bind your owner and install encryption

Sign in through Access, then open `https://<worker-host>/api/bootstrap/identity`. Copy the verified
`authenticatedUserId` into `REMINDERS_OWNER_ID`. The server never claims the first visitor as owner.
Other routes remain unavailable until this binding is configured.

For a **brand-new** deployment, install the key ring without writing it to a file:

```bash
node scripts/deploy/create-encryption-key.mjs primary | npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.production.toml
```

Set `ENCRYPTION_KEY_ID` to `primary`. Do not replace the key ring on an existing deployment: existing
sessions need their original key. Keep previous keys available during intentional rotation, or
explicitly disconnect sessions before removing their keys.

After reviewing the browser proof protocol and approving a controlled account test, set
`LIVE_APPLE_CONNECTION_APPROVED` and `APPLE_CRYPTO_REVIEW_APPROVED` to the values in the table,
then deploy:

```bash
npm run deploy:cloudflare
```

Open `https://<worker-host>/` and complete the Apple setup below. Verify Access denial for an
unauthenticated request, correct owner binding, device verification and a controlled reminder read
on your actual deployment. Synthetic tests do not prove the deployed Access policy or Apple flow.

## Connect ChatGPT

For a standalone Worker, add this endpoint as a custom OAuth MCP connection:

```text
https://<worker-host>/mcp
```

Enable developer/custom MCP connections where available in your ChatGPT account, create the
connection using the endpoint and **OAuth**, and complete Cloudflare Access sign-in. ChatGPT UI
labels and account availability can change; use the current custom plugin/app connection flow.
Choose the connection in a new chat and ask it to call `connection_status`, then
`get_all_open_reminders`. For ChatGPT Sites, use the generated Site plugin instead.

Never send your Apple password, device code, encryption keys or cookies to the chat or an MCP tool.

## Connect your Apple account

1. Open your own private deployment and select its iCloud connection action. The dedicated
   credential page opens at `/connect/apple`; it is your project's page, not an Apple OAuth page.
2. Enter your Apple Account and password there. The browser derives authentication proofs; the
   application API does not accept the raw password or password-derived keys.
3. Read and accept the remembered-browser and encrypted-session consent statements. Apple's
   remembered trust may last longer than this application's local session limit.
4. Approve the trusted-device prompt and enter the six-digit code **on the credential page** when
   its code field appears. SMS, voice and legacy device-code fallbacks are not supported.
5. Return to the dashboard. If Apple separately requires web access to your Reminders keys,
   approve that request on your device and use **Check Apple approval**. Device verification
   and Reminders-data approval are separate steps.
6. Confirm the session is ready, then use a reminder MCP tool. Scanning starts automatically on
   that call; no manual catalogue scan is required.

The local application session expires after at most 24 hours. Reads do not extend it. Apple can
reject it sooner; reconnect when required. Disconnect deletes the encrypted session record,
catalogue and checkpoints. Expired records are cleared on next access, not by a timed purge.

## Use the dashboard

Sign in to your private workspace, then select **Connect Apple account**. The status checklist
shows whether Apple is connected, Reminders access is ready, lists have been found and the
initial list scan is complete.

- **Start list scan** finds your lists. **Pause scan** stops the current browser request;
  **Continue list scan** resumes from saved progress. Keep the page open during manual scans.
- **Check for updates** reads changes after the saved checkpoint once the initial scan is complete.
- **Preview reminders** lets you choose a list and show its open reminders, with an option to
  include completed reminders. **Show more reminders** reads another bounded page.
- **Testing & details** contains response details, list lookup and full-scan restart tools.
- **Disconnect Apple account** asks for confirmation, then deletes the saved Apple session and
  catalogue. **Sign out** ends your workspace login; it does not disconnect Apple.

On ChatGPT Sites, MCP calls resume scans and check for updates without requiring this page to
stay open. The dashboard does not imply that a recurring background runner is available.

## Scanning and pagination

The catalogue is a forward CloudKit change stream. Empty pages can be normal, and Apple does not
report a total page count. Each successful page saves an encrypted checkpoint and authoritative
list snapshots. MCP calls start from no checkpoint for an initial scan, or the saved checkpoint
for incremental changes. Completing a reminder is reflected by the next live open-only query;
this is not a persisted reminder-content cache.

Each MCP catalogue pass processes at most **25 pages within a 20-second budget**; an already-started
Apple request retains its own timeout. If more work remains, the tool returns retryable
`SYNC_IN_PROGRESS`. Repeat the same tool without inventing a cursor to continue saved progress.
Each scan pass has a 1,000-page cap and detects repeated checkpoints. Protocol/token failures
require attention rather than an infinite retry. Apple throttling and retry delays are respected.

`get_reminders` fetches one page of up to 200 reminders. `get_all_open_reminders` has independent
20-page/time, 5,000-record and response-size bounds and a short-lived owner/session-bound
continuation. Results across lists are not an atomic snapshot. No reminder changes are performed.

Manual dashboard scans are optional and pause when the page is closed or a request is interrupted.
Completed pages remain saved. Without a configured scheduler, no Apple scans run between MCP calls.

For optional unattended scanning on a **standalone Worker**, add both of these to the ignored
production config, then deploy:

```toml
[triggers]
crons = ["* * * * *"]

# Add this setting to the existing [vars] table:
[vars]
CATALOGUE_BACKGROUND_RUNNER = "cron"
```

Merge the variable into your existing `[vars]` table; do not create a second table or replace the other settings. The minute trigger
resumes bounded initial/pending work; after catching up, server-side due dates limit catalogue
checks to hourly. Disconnection, absolute expiry, paused checks and error backoff stop work.
Declaring a handler or setting the flag without provisioning the trigger does not schedule anything.

## Cloudflare repository builds

Keep actual resource identifiers and runtime settings in Cloudflare, not in public Git source:

1. Configure `REMINDERS_D1_DATABASE_ID` as a protected **build** environment variable. Set
   `REMINDERS_WORKER_NAME` if your Worker name differs from `icloud-reminders-mcp-server`.
2. Configure runtime plaintext settings from the table in the Worker dashboard, and install
   `ENCRYPTION_KEYS_JSON` as a runtime secret. Build variables are not runtime variables.
3. Use `npm run install:ci` to install, and `npm run deploy:cloudflare` as the deployment command.
   Initialize a new D1 database by executing `schema.sql` before its first deployment. The generated config uses
   `keep_vars = true` and omits `[vars]` in this path so dashboard configuration is retained.
4. If using Cron, manage its configuration deliberately: the repository build path does not
   invent a trigger or reproduce a private local configuration. Set the build variable `REMINDERS_ENABLE_CRON=true` to include the minute trigger, and set
   runtime `CATALOGUE_BACKGROUND_RUNNER=cron` separately; otherwise use manual config deployments.

No GitHub workflow in this repository deploys production or receives Apple credentials.

## Development and project structure

```text
src/
  index.ts           Standalone Cloudflare Worker entrypoint with Access verification
  worker.ts          Shared application Worker and Sites entrypoint
  app/               Private dashboard and isolated browser login client
  components/        Shared UI components
  hooks/             React hooks
  lib/               Shared utilities and connector helpers
  types/             Application and Worker type declarations
  api/               Authenticated API routing
  mcp/               Read-only MCP tools
  auth/              Apple authentication and catalogue synchronization
  crypto/            Protocol cryptography and encrypted storage envelopes
  icloud/            CloudKit transport and record normalization
  persistence/       Native D1 session storage
  platform/          Sites and Cloudflare authentication adapters
  reminders/         Reminder document codec
  transport/         Bounded Apple HTTP and WebSocket transports
scripts/
  build/             Vite plugins, framework build runner and artifact checks
  deploy/            Cloudflare deployment preparation and encryption-key generator
  dev/               Opt-in local iCloud runner and connector preview helpers
  lib/               Shared execution-profile and environment helpers
  release/           Clean public exports and third-party notices
  setup/             Dependency installation and local environment setup
tests/               Behavioural protocol, persistence and authorization tests
  fixtures/          Invented reference vectors; never real Apple transcripts
  helpers/           Shared synthetic test helpers
  integration/       Built Worker, standalone Access and local transport acceptance checks
wrangler.toml        Public standalone Worker configuration template
schema.sql           Current D1 schema for a new deployment
provenance/           Pinned upstream sources and preserved third-party notices
docs/                Architecture and release guidance
.github/             Synthetic CI and dependency-update configuration
```

Copy `wrangler.toml` to ignored `wrangler.production.toml` for your own deployment settings.
Deployment preparation produces ignored `wrangler.generated.toml`. The minimal
`wrangler.build.toml` isolates framework builds from production settings. Vite generates
`dist/server/wrangler.json` internally; that generated file is not an editable source configuration.

The source contains one application table, `apple_session_state`. The Worker uses native D1
prepared statements. The Sites build derives its platform SQL package from `schema.sql`; it does
not keep a separate schema history. The schema file initializes a fresh database; future changes
to an existing database need an explicit upgrade plan rather than replaying setup as an upgrade.

Run the checks before contributing:

```bash
npm run typecheck
npm test
npm run build
npm run test:worker
npm run test:local
npm run verify:artifact
npm run public-config:check
npm run build:check
```

The standalone bundle check is a dry run: it does not upload or deploy. It leaves a standalone
build in `dist/`; run `npm run build` again before running the Sites/local live launcher.
See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request expectations.

## Security and licensing

See [SECURITY.md](SECURITY.md) for responsible reporting, trust boundaries and deployment duties.
The owner of the Worker and its encryption key can decrypt stored session credentials. Encryption
at rest does not protect against a compromised server, browser login script or operator account.
Use restrictive access, protect the encryption key, and keep dependencies current.

Original project contributions use the [MIT License](LICENSE). Preserve upstream notices in
[provenance/NOTICE.md](provenance/NOTICE.md) and `provenance/licenses/`. The Sites build adapter and
vendored UI assets have their own preserved notices. MIT licensing does not establish rights in
Apple protocols, trademarks or account data. Apple, iCloud and Reminders are trademarks of Apple Inc.;
this project is not affiliated with Apple.
