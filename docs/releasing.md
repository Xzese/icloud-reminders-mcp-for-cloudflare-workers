# Publishing the public repository

Develop and publish from the repository root. No separate maintained source export is needed.
The tracked configuration contains only public templates; operator-specific configuration and
state stay in ignored files. Run the README's build and test checks and:

```bash
npm run public-config:check
gitleaks git . --log-opts=--all --redact
```

The configuration check rejects private identifiers, common credential patterns and tracked
private/generated files. Review scanner findings and Git history before publishing. These checks
are not an exhaustive security audit or a cryptographic audit. Never force-add ignored keys,
local environment files, session databases, private deployment copies or old private Git history.
The Gitleaks configuration retains all default rules and excepts only five exact invented
idempotency UUIDs in the synthetic write acceptance fixture. Do not add broad fixture, path,
commit or UUID exemptions to hide a real credential finding.

Use the title **iCloud Reminders MCP Server for Cloudflare Workers** and a repository name such as
`icloud-reminders-mcp-for-cloudflare-workers`. The repository is MIT-licensed; preserve the
reference and vendored notices. Enable GitHub private vulnerability reporting after publication,
enable branch protection/required CI checks, and keep production secrets out of GitHub Actions.
Dependabot groups weekly minor/patch updates by ecosystem (npm and GitHub Actions). Its workflow
enables squash auto-merge for those routine bot PRs using API metadata without executing PR code.
Auto-merge waits for all four required CI checks, an up-to-date branch and resolved conversations.
Major upgrades and contributor PRs still need an explicit merge choice. Merged head branches are
deleted automatically. Keep auto-merge and branch protection enabled; do not bypass failing checks.

## Updating a private ChatGPT Site

Keep the exact Site identifier in ignored `.sites-runtime/hosting.json`. The native Sites workflow
opens its private source in `.sites-runtime/sites-source`. After it is reconciled and clean, run:

```bash
npm run sites:prepare
```

This generates the deployment source from the current public files, adds the saved Site binding,
removes stale tracked source files and excludes local secrets/session state. It refuses a different
Site, unsaved deployment-source changes or symlinked source paths. It does not register, push or
publish a Site. The Sites-capable session then builds and publishes that generated checkout using
the normal native workflow. Keep editing the main checkout, not the generated copy.

Changing the public repository's history or remote does not change the private Site's source
history, access policy, D1 database or saved Apple session. The private deployment history is
retained only under ignored `.sites-runtime/sites-source/.git` and is never public source.

## Optional source export

`npm run release:prepare` can still produce a source-only copy in
`release/icloud-reminders-mcp-for-cloudflare-workers/`, or take a new output directory argument.
It refuses to overwrite existing output and excludes Git history, environment files, session state,
build output, diagnostics and generated deployment configuration. This is optional packaging,
not a second development checkout.

Document the release as experimental, with reads enabled and reminder mutations disabled by default.
Document the separate write gate and outstanding live-write validation. Unit/synthetic workerd checks do not validate
an operator's live Access policy, Managed OAuth/ChatGPT connection or Apple account authentication.
Every deployment must complete those acceptance checks with its own authorized owner. Publishing
source does not make the operator's live Site, D1 database or encrypted Apple session public.

The first public release uses `schema.sql` as its current database definition. It contains only
the application session table. Historical prototype tables, migration journals and ORM tooling
are not part of the source. Sites' SQL initialization package is generated from this same file.
