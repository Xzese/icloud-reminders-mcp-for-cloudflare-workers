# Fixed session retention and compatible rollout

The approved policy is an absolute **30-day** application window:

```text
SESSION_RETENTION_MS = 2_592_000_000
expiresAt = originalVerifiedAt + SESSION_RETENTION_MS
```

Migration, reads, writes and token exchange never change `verifiedAt` or slide the deadline. Apple
cookie expiries remain Apple's values. Apple may revoke authentication, require device verification,
updated terms or Reminders data approval earlier. Synthetic acceptance is not evidence of 30 days
of continuous Apple acceptance.

## Storage and authorisation

Readers strictly support login-assurance version 2 (exactly `verifiedAt + 86_400_000`) and version 3.
Version 3 preserves `policy`, `factor`, both original consent fields and verification time, and adds
`retentionPolicy: "absolute-30d-v1"` plus `retentionSource`. Interactive sign-in uses
`interactive-consent`; owner migration uses `owner-authorised-migration` and stores `migratedAt`,
`previousExpiresAt` and `migrationId` inside the encrypted session. This is separate owner retention
approval, not new Apple authentication or consent. Unsupported fields/versions fail validation.

The outer AES-GCM envelope and associated-data version remain unchanged. Owner/account binding,
generation, client identity, Apple tokens/cookies/attributes, CloudKit/zone information, PCS checkpoint,
list summaries, direct snapshot and valid pagination state are preserved. The dedicated migration
increments row version, uses a fresh nonce, and reloads the committed session. Ordinary operation
commits cannot change login assurance or replace account/client identity.

Migration is disabled by default. The private runtime setting
`APPLE_SESSION_RETENTION_MIGRATION_JSON` has exactly this shape, populated **only through the
authorised runtime/operator environment**:

```json
{
  "migrationId": "<unique-owner-approval-id>",
  "owner": "<existing REMINDERS_OWNER_ID>",
  "account": "apple-reminders",
  "generation": 1
}
```

The generation above is only an example. Inspect the retained row's actual generation safely.
Do not accept approval, owner, generation scope or arbitrary expiry from a public migration body.
Normal authenticated session loaders, including status and MCP, apply this approval before legacy
expiry cleanup. There is no public migration/reconnect endpoint or credential form requirement.

Only structurally valid retained READY or DEVICE_APPROVAL_PENDING sessions in the approved scope
qualify, even if their old local deadline passed. The new deadline must still be in the future.
Active setup/operation leases return a retryable conflict without expiry deletion. CAS predicates
cover owner/account/generation/version/state/envelope and leases; stale migration cannot replace
disconnect, reconnect or another cookie/operation save. Repeat migration is idempotent.
Missing encryption keys are configuration errors, not permission to delete an envelope.
Disconnected, rejected or absent credentials are never recreated from a backup.

## Deployment order

1. Build and retain a compatibility release with both readers and renewal metadata support.
   Leave migration, renewal and version-3 interactive writers disabled initially. Run `npm run
   typecheck`, `npm test`, `npm run public-config:check`, `npm run build`, `npm run test:worker`,
   `npm run verify:artifact`, and standalone `npm run build:check`.
2. Follow `AGENTS.md` for the exact existing Site/Worker. Preserve its project, D1 namespace,
   `APP_ORIGIN`, owner/access policy and key ring. For Sites, reuse ignored `.sites-runtime/hosting.json`,
   reconcile native source in `.sites-runtime/sites-source`, run `npm run sites:prepare`, and publish
   that generated checkout through the Sites workflow. Do not register a replacement Site or reset D1.
3. Stop incompatible previews, drain old requests and prevent new requests until the migration
   configuration is ready. Confirm old readers cannot access the database. An old strict reader
   can delete version-3 records.
4. Inspect safe retained metadata without invoking an expiry-enforcing session loader. Use an
   authorised read-only storage inspection with in-memory decryption; record generation/version,
   original verification/deadline, state and counts, never credentials. Even a compatible reader
   with migration disabled still expires version-2 sessions at their original 24-hour deadline.
   Do not call connection status, MCP or a reminder route first when that deadline already passed.
5. Configure the exact production owner/account/generation migration approval before allowing
   traffic to compatible readers. Read authorised connection status to trigger migration. Keep
   renewal and new interactive writers disabled for this phase. Do not open the credential form,
   call reconnect or send an Apple challenge. Migration itself must make zero Apple requests.
6. Verify original verification, generation, owner/account/client, cookies and snapshots are preserved
   in memory; expose only safe before/after timestamps and booleans/counts. The deadline must equal
   original verification plus `2_592_000_000`, not migration time plus 30 days.
7. Remove `APPLE_SESSION_RETENTION_MIGRATION_JSON`. Restart a compatible instance and confirm the
   same session/deadline restore. Keep a compatible rollback artifact.
8. Separately enable `APPLE_SESSION_RETENTION_WRITES=absolute-30d-v1` for future interactive sign-ins.
   The credential page derives its retention terms from this server policy.
9. Only after renewal acceptance passes, enable `APPLE_SESSION_RENEWAL_ENABLED=saved-tokens-v1`.
   Its default engineering interval is six hours (`APPLE_SESSION_CHECK_INTERVAL_MS=21600000`).
   Then non-destructively read status, current lists and reminders in an existing list; reload the
   dashboard and check a second instance. Report Apple-required action separately from migration.

For the reported example, `2026-10-09T19:25:12.131Z` becomes
`2026-11-08T19:25:12.131Z`. Stored millisecond timestamps, not this example, are authoritative.
UTC arithmetic remains correct over the UK daylight-saving change.

## Codex deployment handoff

Source preparation and local acceptance do not deploy or migrate the production Site. The existing
local connection has been migrated and its November 8 deadline restored across compatible restarts.
Live read-only acceptance succeeded without another sign-in; token exchange has synthetic acceptance
but was not needed or forced against the live account. Continuous 30-day Apple acceptance is unobserved.

Use the published `feat/direct-list-retrieval` source branch as the canonical application checkout.
Recover the existing Site through its native workflow, preserving its exact project ID, access policy,
runtime secrets, D1 binding and Apple session. This checkout does not have an ignored Site binding or
native Site source checkout, so `npm run sites:prepare` correctly refuses to proceed. Do not fill that
gap by registering another Site, inventing a project ID or copying local owner/key/session values into
production.

Save the existing binding in ignored `.sites-runtime/hosting.json` and open/reconcile the project's
native source in ignored `.sites-runtime/sites-source`. Then run `npm run public-config:check` and
`npm run sites:prepare` from the canonical root. Build, save source, package and publish from that
generated checkout using the Sites skill. Obtain credentials through native tools in memory/stdin;
never put them in files or chat. Do not push the generated checkout or its private Git history.

Follow the deployment order above using the production row's actual owner and generation, not the
local acceptance values. Before publishing, preserve a compatibility rollback artifact and prevent
incompatible readers from touching the production database. After migration, remove its scoped
approval, check compatible cold restoration, separately enable the writer and renewal gates, then
verify status, current lists and a bounded read from an existing list without reminder mutations.
Report production publication, production migration and live Apple acceptance separately.

## Existing local live session

The local operator command reuses `.sites-runtime/local-icloud/keys.json` and the exact existing
`isolated-local-icloud` D1 namespace. It refuses active readers/leases, absent/disconnected credentials,
ambiguous database selection, mismatched binding and hard expiry. It does not initialize/reset D1,
generate keys, write credentials to files or contact Apple.

Stop the existing local Worker and drain its operations first. With the compatible Sites-mode bundle
built by `npm run build`:

```sh
npm run session:retention:local
npm run session:retention:local -- --apply-owner-approval
```

The first command inspects safe metadata only. The second uses this owner's explicit authorisation
for a one-time, internally dispatched status migration, removes the in-memory setting, and verifies
compatible cold restoration. It prints only timestamps, row fences, counts and preservation booleans.
No password, verification code or new checkbox is required.

Start the updated local dashboard with separately enabled writers and renewal:

```sh
APPLE_SESSION_RETENTION_WRITES=absolute-30d-v1 APPLE_SESSION_RENEWAL_ENABLED=saved-tokens-v1 npm run dev:icloud
```

Restarting preserves the encrypted session; the local front-door browser cookie is separate and may
be replaced by opening the dashboard. Do not treat that local browser cookie's lifetime as Apple or
application session expiry.

## Renewal and failure boundaries

Validation posts JSON null to the pinned `/setup/ws/1/validate`. HTTP 200 alone is insufficient:
trusted state, rejection indicators, account identity and allowlisted service URLs must pass.
A recoverable web-auth rejection may perform one saved-session/trust-token accountLogin exchange
per top-level request. Missing/expired cookies are not proof that all tokens are invalid. Expired
cookies are never sent; upstream deletions and new cookie attributes are respected.

Checks are request-driven, never status- or saved-snapshot-poll driven, and serialized in D1. A recent successful
authorised operation avoids an unnecessary proactive validation. Validation time and successful
operation time are distinct; exchange time is separate again. Failure counts, required action and
next retry are encrypted and survive Worker restarts. Retry-After is not shortened to our backoff.
Temporary/network/rate-limit/protocol/permission errors retain credentials. Confirmed account token
rejection safely invalidates; missing recovery tokens and device verification stop automatic recovery
without deleting the retained record; terms are never accepted
automatically. An account mismatch blocks access and cannot replace saved identity.

Renewal uses a bounded phase before the reminder lease. Its time counts toward the complete request
deadline. Local hard expiry blocks both operations and renewal, and disconnect wins against stale
saves. Clients are rebuilt from committed credentials/services. Reads may recover once only when
callbacks have not consumed/acknowledged pagination progress. Preparation may repeat exact lookups
and caller change-tag checks; dispatch and confirmation are never replayed. Uncertain mutations remain
`WRITE_OUTCOME_UNKNOWN`, preserving create idempotency and reconciliation rules.

Completed PCS attempt expiry does not expire a READY account. Explicit Apple web-access requirements
transition a valid account into the existing approval workflow without password sign-in. An expired
pending approval needs an explicit manual new bounded attempt; polling never restarts one indefinitely.

## Rollback and evidence

Never roll back to a version-2-only reader. Disable renewal if necessary, but preserve approved version-3
deadlines and compatible readers. Do not truncate retention or restore a credential snapshot over a later
disconnect, revocation or reconnect.

Fixed-clock SQLite tests cover strict schemas, migration/preservation, old-deadline recovery, hard expiry,
leases/CAS/disconnect races, idempotence, UTC arithmetic, renewal outcomes/cooldowns/identity, no write
replay and cursor acknowledgement. Exact built workerd/D1 tests cover authenticated migration, compatible
cold start without approval, MCP contracts, token exchange/service reconstruction and persisted Retry-After.
All use synthetic credentials and records. These checks do not repeatedly challenge or revoke the live
owner's account. Live access and long-duration behaviour must be reported separately.
