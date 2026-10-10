# Security Policy

## Supported version

Security fixes are applied to the latest version on the default branch. This is an experimental
integration with reads and reminder mutations available to a connected authenticated owner. Synthetic test coverage is not
an independent cryptographic audit or a production security guarantee.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers/security/advisories/new).
Do not open a public issue for a suspected vulnerability. Do not include passwords, verification
codes, cookies, account identifiers, reminder contents, signed URLs or private encryption keys.
Use invented data in reproduction steps.

Include the affected route or MCP tool, expected boundary, impact, deployment mode and a minimal
reproduction. If private reporting is not available, request a private reporting channel from the
maintainer without disclosing the vulnerability publicly. This policy does not promise a response SLA.

## Deployment responsibility

This repository contains source code, not a hosted public Reminders service. Every operator is
responsible for their own private Site or Worker, D1 database, authentication policy, encryption
key ring, authorized owner, monitoring, dependency updates and controlled-account approval.
Deployments are single-owner. Multi-tenant use and shared MCP connections are not supported.

ChatGPT Sites supplies its trusted Site-scoped identity at dispatch. A standalone Worker must use
`src/index.ts` and independently verify Cloudflare Access JWTs, including signature, issuer,
audience and expiry. Restrict Access to the intended owner, protect every reachable hostname and
path, and keep `APP_ORIGIN` exact. Origin checks alone are not authentication. Sites service access
does not confer the owner's identity or permission to read their Apple session.

## System and trust boundaries

Protected assets include Apple session cookies/tokens, account identifiers, reminder contents,
encryption keys, encrypted list summaries and reminder pagination state. Requests, WebSocket messages, CloudKit
responses, opaque cursors and decrypted protocol documents remain untrusted inputs.

The Apple password is processed by a dedicated browser script. The Worker receives authentication
proofs and session material; application APIs must not accept passwords or password-derived keys.
The browser page is served by this project, not Apple. A malicious operator or compromised script
can capture browser input. The Worker operator and its secret store are trusted: AES-GCM storage
does not prevent them from decrypting sessions. Apple's remembered-browser trust can outlast the
application's fixed local retention window (30 days under the approved policy).

## Security invariants

- Authenticate the real owner before protected data or state access. Never trust client-supplied
  identity headers, automatically claim the first visitor, or accept an unverified Access token.
- Bind encrypted sessions to owner, account, generation and schema; reject cross-owner decryption
  and stale-generation results. Keep lease/version fencing during login, reads and disconnect.
- Enforce trusted-device verification and separate Reminders-data consent. Do not silently switch
  to SMS, voice or legacy authentication. Reject missing, mismatched or replayed protocol proofs.
- Keep the absolute session lifetime bounded. Reads must not extend it. Disconnect must clear
  stored session state; expiry must reject reads and clear expired records on access.
- Keep strict legacy 24-hour assurance validation separate from the 30-day retention version.
  Only a server-approved configured-owner/account/generation migration may extend a retained
  legacy record, before old expiry cleanup. Preserve verification, factor and original consent.
  Bind the new deadline to original verification, not migration time. Never restore a disconnected
  envelope, change Apple cookie expiry, or rotate away its required decryption key.
- Fence migration and saved-token renewal against active setup/operation leases and disconnect.
  Re-encrypt with a fresh nonce and increment row version without changing session generation.
  Ordinary commits must preserve the complete login-assurance object and account/client identity.
- Validate trusted-session evidence, account identity and allowlisted services before saving
  renewed credentials. No password, verification bypass or automatic Apple terms acceptance is
  allowed. Honor Retry-After and persist cooldowns. Only confirmed account authentication rejection
  invalidates credentials; resource permission, transient and unknown-protocol failures do not.
- Complete renewal before acquiring mutation preparation leases. Record dispatch before transport,
  retain the final write-lease check, and never recover/replay a submitted mutation or an acknowledged
  pagination callback. A safe preparation retry must repeat exact lookups and change-tag checks.
- Authorize known list IDs with a current exact private-zone lookup; encrypted saved summaries
  alone are never proof of access. Reject wrong zone/owner, deleted lists and groups before content
  reads. Direct discovery is the sole path and must report unsupported or incomplete results
  without a historical fallback.
- Commit direct list snapshots only after complete, bounded discovery. Strip recognized retired
  historical fields without resetting valid Apple sessions. All-open continuations retain their original list selection,
  remain single-use and expire with the session or after ten minutes.
- Allow reminder mutations only for the bound authenticated owner with a current ready Apple
  session. Exact private-zone list and reminder lookups must precede a write.
  Use only bounded single-record create/update operations, deterministic create IDs and exact
  record change tags. Deletion may only set Apple’s Deleted marker through a normal tagged update.
  Never force an edit, replace a record, hard-delete one or automatically replay
  a submitted write. Preserve omitted fields and unmodified resolution tokens. Refuse unsupported
  linked-record date edits rather than updating only part of a recurrence or alarm. State changes
  must refuse recurring, alarmed or nested reminders and remain single-record updates. Do not claim
  parent detection or subtask cascade support; those workflows are outside this interface.
- Return uncertain outcomes honestly. An in-flight Apple write cannot be undone by local
  disconnect fencing. A timeout, malformed confirmation or lost fence after submission must
  require reconciliation instead of reporting a confirmed failure or success.
- Use bounded reads, pagination, transport sizes, decompression,
  continuation-cycle detection and upstream backoff rather than indefinite retries.
- Prevent cross-origin state changes and authentication WebSocket access. Preserve the isolated
  credential page's nonce CSP and no-referrer policy; do not add analytics or third-party scripts.
- Never log credentials, proof material, cookies, raw Apple errors, reminder contents, opaque
  cursors or signed asset URLs. Public MCP outputs must exclude raw diagnostic records/traces.
- Keep production secrets, live session state and real account captures out of public artifacts.

## Reportable findings and known limitations

Authentication bypass, owner/session isolation failures, credential disclosure, forged or replayed
proof acceptance, stale-session access after disconnect, unsafe parsing/decompression, unauthorized
upstream access, unauthorized mutation access, stale-version overwrites, unintended duplicate creates and
other unintended reminder writes are reportable. Assess realistic reachability and
impact for the affected deployment; no blanket exclusions or accepted-risk suppressions are defined.

Apple's undocumented endpoints and cryptographic assumptions may change. Pinned synthetic vectors
share an upstream reference and therefore do not independently validate Apple or the cryptography.
Deployment-specific Access/Managed OAuth configuration and live Apple acceptance must be checked by
the operator. Apple may revoke a session before its local deadline. Expired records are removed on
next access, not by a guaranteed timed purge. This project does not revoke Apple's remembered-browser
trust when deleting its local encrypted record.

The experimental write codec follows pinned pyicloud text-document and resolution-token
algorithms. It has not been independently audited. Bounded live tests for creation, editing,
completion, reopening and soft deletion have passed with API read-back;
that result does not establish all linked-record workflows or deployment security.
Changing a text field replaces that document's formatting; untouched documents remain intact.
Synthetic checks establish local safeguards and response handling, not Apple's current acceptance.
Operators must validate a dedicated test reminder before using write access on personal items.
