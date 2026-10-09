# Repository workflow

The repository root is the canonical development and public-source checkout. Keep the checked-in
`.openai/hosting.json` and `wrangler.toml` free of operator-specific identifiers and secrets.
Run `npm run public-config:check` before committing or publishing source. Local environment files,
Apple session state, generated output and deployment history belong only in ignored paths.

## ChatGPT Sites

Before registering a Site, read ignored `.sites-runtime/hosting.json` when it exists and reuse its
exact `project_id`. Do not create a replacement Site when an existing binding is present. Preserve
its access policy, runtime secrets and Apple session.

Sites requires a project-bound source manifest. Open/reconcile its source with the native Sites
workflow in ignored `.sites-runtime/sites-source`, then run `npm run sites:prepare` from the
repository root. Build, save source, package and publish from that generated checkout using the
Sites skill. Obtain credentials through native tools and keep them in memory/stdin, never files.
Make application edits in the canonical root and regenerate the deployment copy afterward.
Do not push the generated checkout or its Git history to a public source repository.

## Verification

Use `npm run typecheck`, `npm test`, `npm run public-config:check`, `npm run build`,
`npm run test:worker` and `npm run verify:artifact`. Use `npm run build:check` for the standalone
Cloudflare bundle. Keep real Apple credentials and reminder contents out of test fixtures.
