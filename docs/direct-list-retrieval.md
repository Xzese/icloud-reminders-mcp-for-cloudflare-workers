# Direct list retrieval: evidence and operating limits

## Decision

Direct discovery is **experimental and disabled by default**. Select it explicitly with
`REMINDERS_LIST_DISCOVERY=direct`; omit the setting or use `legacy` for the existing scanner.
No production deployment or live Apple test was performed for this change. The primary objective
of verified complete live-account list retrieval remains open.

The implementation was developed from the latest `main`, independently of the open reminder-write
PR. It adds no mutation tools and does not change write permissions or the 24-hour session lifetime.

## Protocol investigation

The [pinned reference implementation](https://github.com/fineyh/icloud-reminders-desktop/blob/3dbbbed9eef3d2f3a6d13be28475c2d4585504a0/src/backend/reminders_api.py)
was retrieved and inspected. Its `_ck_query` sends `query: {recordType: "Lists"}` and
`zoneID: {zoneName: "Reminders"}` to the production private Reminders `records/query` endpoint.
`_fetch_cloudkit` and `fetch_list_names` consume returned records directly. A comment in its write
path distinguishes plural `Lists` queries from singular `List` records. It does not follow query
continuations, establish returned-type/owner boundaries, validate catalogue completeness, or prove
whether groups, empty/old lists or shared lists are covered. Its title-keyed mapping can also merge
lists with identical names. It is evidence for the request format, not an acceptance test.

Our dedicated `queryListsPage` uses the existing authenticated allowlisted transport and validated
private Reminders zone. Generic `queryPage` retains its matching query/record-type contract.
Synthetic tests confirm plural requests, singular responses, opaque continuation handling,
normalization, owner/zone rejection, empty lists, groups, tombstones and logical deletion.
`queryAllLists` deduplicates identical summaries, rejects conflicting identifiers and returns
explicitly incomplete results on record failures, continuation cycles and processing limits.
Neither method invokes the legacy change scanner.

No field projection is used: live support for special-query `desiredKeys` is unknown. Requests do
not explicitly request reminder content or list membership; Apple may include extra list fields,
which are discarded from summaries and never persisted. Only exact authorization lookups retain
the already-supported summary projection. Shared-database discovery is outside this method.

## Read and persistence contracts

Direct refresh follows at most 25 query pages within 20 seconds, with 200 records per page, 1,000
list IDs and a 1 MiB summary budget reserving 4 KiB for response metadata. The transport separately
bounds each request/response and applies its own timeout. An incomplete refresh returns an
actionable `UNSUPPORTED_FEATURE` error from the service; it never publishes an empty or partial
catalogue and never silently starts historical scanning. There is no public resumable list cursor;
accounts exceeding these limits must retry or explicitly use legacy recovery.

Only a complete retrieval replaces the authoritative encrypted snapshot, so successful refreshes
reflect additions, renames and removals. The dashboard displays saved summaries and retrieval time;
15-second polling does not contact Apple. Normal direct MCP list reads fetch live data, with no TTL
cache. Raw Apple fields and traces are excluded from MCP output. List names/IDs remain encrypted.

Known-list reads always make a current exact lookup, with format, type, deletion/group, owner and
zone checks, before querying `reminderList`. They work without a saved catalogue, while discovery
is pending, and after a historical checkpoint expires. Cached IDs never prove authorization.
Open-only filtering remains the default; completed items are optional. Compound records and query
continuations retain existing handling. Reminder contents remain live and are not persisted.

All-open direct reads discover a complete list set once, filter groups/deleted lists and save that
operation's selection. Resumption preserves selection and per-list position even after an unrelated
list refresh. Existing single-use encrypted continuation rotation, expiry, partial-failure retry,
response/page/time limits and owner/session fences remain. A separate legacy recovery collection
prevents historical work from overwriting newer direct snapshots. Added envelope fields are optional;
existing version-1 sessions and old continuations remain readable without a D1 migration or reset.

Direct mode suppresses the background historical scanner. Explicit legacy diagnostics remain
available, and configured local/cron legacy runners retain checkpoints/backoff. Sites does not
provision a recurring trigger. Authentication, Access/Sites identity, origin checks, AES-256-GCM,
generation/version fencing, read leases, absolute expiry and disconnect invalidation are unchanged.

## Measured synthetic comparison

A comparison ran the base `main` service and revised service against the same synthetic fixtures,
using the real SQLite D1 adapter and encrypted session fixtures from `tests/persistence.test.ts`.
Both started with a validated saved zone owner. Responses were immediate in-memory mocks with no
Apple/network latency. Each elapsed value is one sample, including local service/storage work;
these values do not predict account latency or establish a production speedup ratio.

| Scenario | Base main | Revised direct mode |
| --- | --- | --- |
| First list retrieval, synthetic 27-page history | 27 change calls + 1 exact lookup | 1 `Lists` query; 0 change calls |
| MCP invocations before first list response | 2, with 1 `SYNC_IN_PROGRESS` | 1, with 0 `SYNC_IN_PROGRESS` |
| First list retrieval elapsed | 52.671 ms | 12.712 ms |
| Known-list read, synthetic 3-page pending history | 3 change calls + 1 reminder query | 1 authorization lookup + 1 reminder query |
| Known-list read elapsed | 4.083 ms | 2.657 ms |

These samples ran on 2026-10-09 with Node 26.8.1. The base was `fec8808` (latest fetched `main`).
A cold zone owner can require one additional `zones/list` call in either mode. Unchanged direct
list collections still require bounded live queries; known-list pages repeat live authorization.
A caught-up legacy reminder read can also use two CloudKit requests, so request savings primarily
remove historical catch-up and repeated catalogue dependencies rather than guaranteeing fewer
requests in every case.

The Worker harness separately reports real workerd MCP measurements for a stale-checkpoint known
read, two-page direct discovery and all-open error/resumption. It asserts zero `/changes/zone`
calls on direct/known paths and no `Lists` rediscovery on resumption. Its durations include local
Worker/storage overhead and mocked network responses; raw timing values are emitted on each run. The final production-bundle run measured:

- Stale-checkpoint known-list read: 17.311 ms; 1 zone discovery + 1 lookup + 1 reminder query.
- Direct selectable lists: 5.390 ms; 2 paginated `Lists` queries.
- Direct all-open initial call: 11.879 ms; 2 list queries + 1 failed reminder query (explicit incomplete result).
- All-open resume: 10.442 ms; 2 reminder queries, no list discovery or change calls.

## Validation and remaining operator action

Automated validation includes typecheck, unit/protocol/persistence tests, lint, Sites build,
production-bundle Worker acceptance, local transport integration, artifact verification, public
configuration checks, standalone build/dry-run and standalone Access acceptance. All fixtures use
synthetic data. A separate isolated browser preview verified the direct refresh button, saved
retrieval timestamp, list selection and reminder preview; display polling did not repeat the
synthetic Lists query. The preview used synthetic encrypted sessions and mocked Apple responses. Lint passes with 13 warnings and no errors. No security check is bypassed.

Before making direct discovery the default, an operator must explicitly authorize a bounded,
read-only Apple account test. Compare paginated results against the account's Apple UI using
uniquely identifiable old lists, empty lists, groups, new lists, renamed lists and deleted lists.
Determine separately whether shared lists in the private zone are complete and whether shared
zones require discovery. Verify that the first request needs no prior `changes/zone` calls and
that continuations return the full ID set. Record only sanitized counts, flags and timings in public
evidence; never credentials, names, reminder contents or opaque tokens. Keep captures/session state
in ignored private paths. Do not reset sessions or deploy as part of validation.

If Apple rejects the query, report the classified error and preserve the previous snapshot. An
operator may explicitly select `legacy` and use diagnostic restart for an expired checkpoint.
Known-list reads remain independent of discovery in both modes. Do not enable direct mode by
default based only on this synthetic evidence.
