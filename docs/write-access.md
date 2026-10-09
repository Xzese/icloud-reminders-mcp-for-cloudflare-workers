# Create and edit reminders

The experimental `create_reminder` and `update_reminder` MCP tools use Apple's modern private
CloudKit Reminders database. Writes are disabled by default. They require the authenticated
deployment owner, a ready unexpired Apple session and the separate runtime setting:

```text
LIVE_APPLE_WRITES_APPROVED=controlled-create-edit-v1
```

The two existing login approvals must also be enabled. Use private runtime configuration;
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

Completion, reopening, deletion, moving lists, subtasks, list management, attachments, alarms,
recurrence and tags are outside this interface. Date/time-zone/all-day changes on reminders
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

Both tools accept an optional `expectedGeneration` to bind a request to a previously read
Apple session. The internal `POST /api/mutations` API requires it, plus the same owner and
same-origin checks used by other state-changing API requests. Unknown fields are rejected.
No raw CloudKit records, signed asset URLs, proof material or write payloads appear in MCP outputs.

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

## Protocol reference and acceptance

The payload and text codec follow MIT-licensed pyicloud at revision
`e2e44ab875d47dab4475096021da60030f26c35e`:
[create/update implementation](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_writes.py),
[text documents and resolution tokens](https://github.com/timlaing/pyicloud/blob/e2e44ab875d47dab4475096021da60030f26c35e/pyicloud/services/reminders/_protocol.py).
The general request contract is described in Apple's
[Modify Records reference](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/ModifyRecords.html).
Unlike the upstream broad update path, this implementation sends only changed fields and
preserves unmodified resolution tokens. It does not merge CRDT edits with another client's document.

Synthetic unit and built-Worker acceptance checks cover the local safeguards and uncertain
response handling. Bounded read-only inspection confirmed document field types and version
presence on a live account. **No live create or edit has been validated.** This does not establish
Apple's current write acceptance or independently audit the codec.

Before enabling writes on personal items, use a dedicated test list: create one uniquely titled
reminder, verify it in Apple's app, edit only its title using a freshly read tag, and confirm its
notes and other fields remain intact. Check an identical create replay and a stale-tag refusal.
Remove the test item through Apple's app; this server does not expose deletion. Disable the write
setting after testing until you accept those results. Keep credentials and verification codes on
the dedicated connection page, never in MCP arguments or chat.
