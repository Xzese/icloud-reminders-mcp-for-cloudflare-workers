# Create and edit reminders

This feature is being developed on `feature/reminder-create-edit`. The first implementation
will add bounded `create_reminder` and `update_reminder` MCP tools using Apple's modern
CloudKit Reminders service. The existing read tools and private owner authentication remain
the basis for selecting lists and reminders.

Writes will require an explicit deployment setting and a ready Apple session. Updates will
use the current CloudKit record change tag rather than overwriting a newer edit. Creates will
use a caller-supplied request UUID so retrying an uncertain request cannot create a second item.
The implementation will preserve fields outside the requested change and reject unsupported
record shapes. Deletion, list management and advanced recurrence/attachment editing are out of
scope for this branch.

CI and local acceptance tests will use synthetic Apple responses. Live account investigations
will inspect read-only protocol metadata; they will not edit existing personal reminders.
Supported fields, configuration and any live acceptance limitations will be recorded here
before the pull request is ready for review.
