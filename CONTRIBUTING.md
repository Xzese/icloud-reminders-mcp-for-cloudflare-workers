# Contributing

Thank you for helping improve `icloud-reminders-mcp-server`.

## Development

Use Node.js 24 or later. Fork the repository, create a focused branch and install the locked dependencies:

```bash
npm run install:ci
node scripts/setup/create-local-env.mjs
npm run build
npm run db:setup:local
npm run dev
```

The local preview leaves live Apple login disabled. Tests use invented protocol fixtures. Do not
use a real Apple account in CI or add live credentials to fixtures. Run the opt-in live launcher
only on your own controlled account after reviewing its login and retention policy.

Keep real credentials and deployment identifiers out of commits. `wrangler.toml` and
`.openai/hosting.json` are public templates. Use ignored `wrangler.production.toml` for standalone
deployments; Sites registration supplies a new project's private identifier. Protect the D1 build
variable for repository builds. Generated configs, databases, diagnostics and encryption keys are
not source artifacts.

Before opening a pull request, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:worker
npm run test:local
npm run verify:artifact
npm run public-config:check
npm run build:check
```

The last command checks the standalone bundle without deploying it. Run `npm run build` again
before using the Sites/local live runner. Follow the README for each deployment's separate
identity and provisioning requirements.

MCP tool names, schemas, annotations, continuations and structured outputs are public interfaces.
Changes should be intentional, documented and covered by representative behavioural tests.
Preserve generation fencing, encrypted owner-bound storage, request bounds and fail-closed
protocol handling. Do not add reminder mutations or weaker authentication fallbacks incidentally.

Keep the current database definition in `schema.sql` and use native D1 prepared statements.
Local setup and tests execute that file; the Sites build packages the same SQL for initialization.
If changing a schema already in use, document how operators upgrade their existing databases.

Keep application code under `src/`, including the dashboard in `src/app/` and shared UI/helpers
in `src/components/`, `src/hooks/` and `src/lib/`. `@/` resolves to `src/`. Build plugins belong in
`scripts/build/`; group operational scripts under `scripts/setup/`, `scripts/dev/`,
`scripts/deploy/` and `scripts/release/`. Shared tool helpers belong in `scripts/lib/`.
Keep behavioural tests in `tests/`, built Worker acceptance runners in `tests/integration/`,
and synthetic vectors and their generator in `tests/fixtures/`.

## Pull requests

Keep changes narrow, explain the user impact and describe the checks you ran. Add tests for
behaviour changes using synthetic inputs. Do not include reminder contents, account identifiers,
passwords, tokens, signed asset links, private screenshots or generated deployment configuration.
Report suspected vulnerabilities privately as described in SECURITY.md rather than a public issue.

The four required CI checks cover lint/types/unit tests, the Sites Worker and local transport,
the standalone Cloudflare Worker, and public configuration/full-history secret scanning.
They use synthetic inputs and require no Apple or deployment secrets. Keep each check passing
and resolve review conversations before merging. You can select **Enable auto-merge** on a PR
to merge after those requirements pass; it is an explicit choice for each PR. Merged head branches
are deleted automatically. Dependabot proposes weekly updates for review and does not merge them
automatically.

Preserve upstream attribution and license notices when changing protocol or vendored code.
Fixture regeneration is optional: the checked-in vectors in `tests/fixtures/` are sufficient to run CI. To regenerate,
install the pinned Python packages listed in provenance/sources.json, check out its pinned pyicloud
revision, and pass that checkout explicitly to `python3 tests/fixtures/generate.py <checkout>`.
Never substitute a live capture for an invented fixture.

By contributing, you agree that your contribution is licensed under the MIT License.
