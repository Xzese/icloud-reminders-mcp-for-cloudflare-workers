# Create, edit, complete and delete reminders

The experimental reminder mutation MCP tools use Apple's modern private
CloudKit Reminders database. Writes are disabled by default. They require the authenticated
deployment owner, a ready unexpired Apple session and the separate runtime setting:

```text
LIVE_APPLE_WRITES_APPROVED=controlled-reminder-writes-v2
```

This v2 approval enables creation, editing, completion, reopening and soft deletion. The older
`controlled-create-edit-v1` value remains limited to creation and editing. The two existing
login approvals must also be enabled. Use private runtime configuration;
leave public templates empty. For the isolated local Worker, explicitly launch
`npm run dev:icloud -- --enable-writes` after building. The dashboard shows whether write
access is enabled; it does not silently grant access or offer a general-purpose record editor.

## Supported fields

| Field | Behaviour |
| --- | --- |
| `title` | Nonblank plain text, up to 2,048 UTF-16 code units. |
| `notes` | Plain text, up to 16,000 UTF-16 code units; `""` clears notes. |
| `priority` | `0` (none), `1` (high), `5` (medium), `9` (low). |
| `flagged` | Boolean. |
| `dueDate` | Valid ISO date-time with an explicit offset; `null` clears it. |
| `timeZone` | Valid IANA identifier; `null` clears it. |
| `allDay` | Boolean; `true` requires a due date and time zone. |

Creation defaults to empty notes, no priority or flag, no due date and an open reminder.
Updates affect only the specified fields plus Apple's modification metadata and associated
resolution tokens. Clearing a due date also clears its time zone and all-day marker unless
explicitly supplied; incompatible all-day settings are rejected.
An existing undated reminder can carry Apple's all-day marker; unrelated edits preserve it.

The separate `complete_reminder`, `reopen_reminder` and `delete_reminder` tools accept an exact
`listId`, `reminderId` and current `recordChangeTag`. Completion sets `Completed=1` and a current
completion timestamp. Reopening sets `Completed=0` and clears that timestamp. Deletion sets
`Deleted=1` through a normal version-checked update; it does not hard-delete the CloudKit record.
No restore tool is provided. These tools preserve title, notes, dates and other omitted fields.

State changes refuse recurring, alarmed and nested reminders. Each action sends exactly one
version-checked record update, matching pyicloud's basic write approach. It does not enumerate
or update children, detect parent reminders, or implement subtask cascades. Parent/subtask workflows
are unsupported; use Apple's app for them. Completing or deleting a parent through this interface
must not be assumed to perform the same child workflow as Apple's app. Moving lists,
subtask editing, list management, attachments, alarms, recurrence and tags are outside this interface. Date/time-zone/all-day changes on reminders
with alarms or recurrence are refused because those features require linked-record updates.
Unchanged linked fields remain untouched. Editing title or notes replaces that text document
with plain text, including its formatting; an omitted document remains intact.

## MCP examples

First call `connection_status`, then `get_reminder_lists`. Use the returned exact list ID.
Generate one UUID for each distinct create attempt and retain it until the outcome is resolved.
These IDs and text are invented examples:

```json
{
  "listId": "List/00000000-0000-4000-8000-000000000001",
  "idempotencyKey": "00000000-0000-4000-8000-000000000002",
  "title": "Test reminder",
  "notes": "Created through the controlled MCP tool",
  "priority": 0,
  "flagged": false
}
```

The returned normalized `record` includes its ID and `recordChangeTag`. To edit an existing
open reminder, obtain its current tag through `get_reminders` and call `update_reminder`:

```json
{
  "listId": "List/00000000-0000-4000-8000-000000000001",
  "reminderId": "Reminder/00000000-0000-4000-8000-000000000002",
  "recordChangeTag": "<tag-from-the-latest-read>",
  "changes": { "title": "Updated test reminder" }
}
```

All mutation tools accept an optional `expectedGeneration` to bind a request to a previously read
Apple session. The internal `POST /api/mutations` API requires it, plus the same owner and
same-origin checks used by other state-changing API requests. Unknown fields are rejected.
No raw CloudKit records, signed asset URLs, proof material or write payloads appear in MCP outputs.
Use `get_reminder` with the exact list and reminder IDs to read completed or soft-deleted items
and their current tag without scanning history. It returns `record=null, missing=true` if Apple
reports the exact item absent. `get_reminders(includeCompleted=true)` can also page through history;
use a smaller `limit` such as 20 or 50 when full compound pages exceed the 1 MiB response budget.
The state tools use the same target/version arguments as `update_reminder`, without `changes`.
A completed reminder cannot be completed again; an open reminder cannot be reopened. Both are
conflicts, and a deleted reminder cannot be changed or reused as a create replay.

## Concurrency and recovery

Each request holds the existing owner/session operation lease, looks up the exact current
list and target record in the authenticated private Reminders zone, then rechecks the lease
immediately before submitting one bounded atomic operation. Updates use `update` with the
exact change tag; there is no force-update, record replacement or automatic retry.

- `CONFLICT`: no edit was confirmed. Read the current reminder and review the intended change
  before constructing a new update with its new tag. An existing create ID with different
  content or state is also a conflict.
- `WRITE_OUTCOME_UNKNOWN`: Apple may have saved the change. The result includes the target
  `reminderId` and, for creation, its `idempotencyKey`, with `retryable: false`. Read that list
  and reconcile the known ID before another change. Never generate a new creation key to retry
  this attempt.
- An identical create replay finds the same still-open reminder and returns `replayed: true`
  without another modify request. An altered or completed item is not treated as a replay.

Timeouts, redirects, server errors, malformed confirmations and a lost session fence after
submission are uncertain outcomes. Writes do not follow redirects. Disconnect prevents a
pending preparation from submitting once its lease is lost, but cannot undo an Apple operation
already in flight. A successful mutation invalidates unfinished all-open read continuations.
Neither reads nor writes extend the absolute local session deadline. No new tables, mutation
receipt cache or additional Cloudflare resources are introduced.

### MCP contracts and idempotency

Each tool publishes input parameter descriptions and a typed output schema for successful
`structuredContent`. The server validates successful results against that schema. Matching JSON
text preserves the same information for clients that consume only text, including connection status.
Application failures use `isError: true` and a sanitized error object with the same JSON text fallback;
the success output schema does not describe error results.

All mutation tools declare `readOnlyHint: false`, `idempotentHint: true` and `openWorldHint: true`.
Creation declares `destructiveHint: false`; editing and state changes declare it true because
they can overwrite or remove existing state. Read tools declare `readOnlyHint: true` and
`destructiveHint: false`; idempotency hints have no meaning for read-only tools.

Idempotency means identical arguments cause no additional reminder change, not that every repeat
returns success. Creation reconciles the stable UUID; existing-item mutations refuse the original
version after it advances. Retain the exact IDs, inputs, version tag and session generation.
A fresh tag is a new request and must not be substituted automatically. After an uncertain result,
use `get_reminder` to reconcile the exact item before deciding what to do next. These hints do not
replace server permission checks or a client's user authorization for changes.

See the MCP [tool contracts](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
and [annotation definitions](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).

## Local live acceptance

1. Use a uniquely named, unshared iCloud list such as **MCP Test**. The test targets only its
   own labelled synthetic item. Allow the list to appear in iCloud.
2. Run `npm run install:ci` and `npm run build`. Stop any earlier local Worker, then launch
   `npm run dev:icloud -- --enable-writes`. This explicitly opts the isolated local Worker
   into the v2 mutation gate; it does not alter hosted settings.
3. Open `http://127.0.0.1:5173/`, finish Apple sign-in/device approval if required, and wait
   for **Ready** and a finished catalogue scan.
4. Explicitly run the one-item test:

   ```bash
   npm run test:icloud-write -- --confirm --list-name 'MCP Test'
   ```

   It prints the synthetic ID and key before writing. It creates one item, checks matching-key
   replay, reads it, edits the title while preserving notes/priority/flag, rejects a stale edit,
   completes it, verifies the completion date and absence from open results, rejects stale deletion,
   reopens it and verifies the cleared completion date, then deletes it, verifies the exact stored deletion marker (or reported absence), and checks
   absence from a complete open query. Only that generated test ID is modified.
   Each phase has a three-minute budget; reads are limited to five pages and requests to 40 seconds.
   No write is automatically retried. Personal contents, account/list IDs, cookies, tags and raw
   Apple responses are not printed. A failed or uncertain step stops before further mutations.
5. Stop the Worker and restart without `--enable-writes`. A successful test removes its item
   from the normal list; if it stops earlier, inspect the retained ID in Apple's app before cleanup.

To finish a **known, previously created and edited** item from this script, use its retained key:

```bash
npm run test:icloud-write -- --confirm --list-name 'MCP Test' --finish-existing --idempotency-key UUID
```

This mode requires a supplied UUID and verifies the exact synthetic title, notes, priority and
flag before completion. It never creates a replacement or chooses a personal reminder. If the
item has already been completed, altered or deleted, it stops; inspect its current state first.

`WRITE_OUTCOME_UNKNOWN` may mean Apple saved the operation. Reconcile the printed exact ID
before another request; do not create a fresh key. To reconcile uncertain creation, the same
key can be supplied without `--finish-existing`, but changed/completed/deleted content returns
`CONFLICT` and stops. `SYNC_IN_PROGRESS` means scanning must finish before another test.

## Protocol reference and acceptance

The payload and text codec follow MIT-licensed pyicloud at revision
`e2e44ab875d47dab4475096021da60030f26c35e`:
[create/update/soft-delete implementation](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_writes.py),
[text documents and resolution tokens](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_protocol.py).
The general request contract is described in Apple's
[Modify Records reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ModifyRecords.html).
Unlike the upstream broad update path, this implementation sends only changed fields and
preserves unmodified resolution tokens. It does not merge CRDT edits with another client's document.

Synthetic unit and built-Worker acceptance checks cover safeguards and uncertain responses.
A controlled live create/edit run passed on 9 October 2026, including duplicate prevention,
content preservation and stale-version refusal. A subsequent live run completed, reopened and
soft-deleted the same synthetic reminder. Exact Apple read-back confirmed completion timestamps,
clearing the timestamp on reopening and the deletion marker; complete open-list queries confirmed
the completed and deleted item was absent. Stale-version deletion was rejected. These checks used
the isolated local Worker and Apple API responses; Apple's app was not visually inspected.
These results do not independently audit the codec or establish every linked-record workflow.

Validate a dedicated test reminder before using write access on personal items. Disable writes
when testing is finished until you accept the results. Keep credentials and verification codes
on the dedicated connection page, never in MCP arguments or chat.
