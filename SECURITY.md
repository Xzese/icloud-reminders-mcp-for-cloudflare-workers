# Security Policy

## Supported version

Security fixes are applied to the latest version on the default branch. This is an experimental,
read-only integration; synthetic test coverage is not an independent cryptographic audit or a
production security guarantee.

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
application's local 24-hour session limit.

## Security invariants

- Authenticate the real owner before protected data or state access. Never trust client-supplied
  identity headers, automatically claim the first visitor, or accept an unverified Access token.
- Bind encrypted sessions to owner, account, generation and schema; reject cross-owner decryption
  and stale-generation results. Keep lease/version fencing during login, reads and disconnect.
- Enforce trusted-device verification and separate Reminders-data consent. Do not silently switch
  to SMS, voice or legacy authentication. Reject missing, mismatched or replayed protocol proofs.
- Keep the absolute session lifetime bounded. Reads must not extend it. Disconnect must clear
  stored session state; expiry must reject reads and clear expired records on access.
- Authorize known list IDs with a current exact private-zone lookup; encrypted saved summaries
  alone are never proof of access. Reject wrong zone/owner, deleted lists and groups before content
  reads. Direct discovery is the sole path and must report unsupported or incomplete results
  without a historical fallback.
- Commit direct list snapshots only after complete, bounded discovery. Strip recognized retired
  historical fields without resetting valid Apple sessions. All-open continuations retain their original list selection,
  remain single-use and expire with the session or after ten minutes.
- Keep reminder writes disabled. Use bounded reads, pagination, transport sizes, decompression,
  continuation-cycle detection and upstream backoff rather than indefinite retries.
- Prevent cross-origin state changes and authentication WebSocket access. Preserve the isolated
  credential page's nonce CSP and no-referrer policy; do not add analytics or third-party scripts.
- Never log credentials, proof material, cookies, raw Apple errors, reminder contents, opaque
  cursors or signed asset URLs. Public MCP outputs must exclude raw diagnostic records/traces.
- Keep production secrets, live session state and real account captures out of public artifacts.

## Reportable findings and known limitations

Authentication bypass, owner/session isolation failures, credential disclosure, forged or replayed
proof acceptance, stale-session access after disconnect, unsafe parsing/decompression, unauthorized
upstream access and unintended reminder writes are reportable. Assess realistic reachability and
impact for the affected deployment; no blanket exclusions or accepted-risk suppressions are defined.

Apple's undocumented endpoints and cryptographic assumptions may change. Pinned synthetic vectors
share an upstream reference and therefore do not independently validate Apple or the cryptography.
Deployment-specific Access/Managed OAuth configuration and live Apple acceptance must be checked by
the operator. Apple may revoke a session before its local deadline. Expired records are removed on
next access, not by a guaranteed timed purge. This project does not revoke Apple's remembered-browser
trust when deleting its local encrypted record.
