import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareSitesSource } from "../scripts/deploy/prepare-sites-source.mjs";
import { checkPublic, publicFiles, root } from "../scripts/release/check-public-config.mjs";

const git = (directory: string, ...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "reminders-public-source-"));
  for (const file of await publicFiles(root)) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }
  // The same suite can run from Sites' generated, project-bound checkout.
  const template = JSON.parse(await readFile(path.join(directory, ".openai/hosting.json"), "utf8"));
  delete template.project_id;
  await writeFile(path.join(directory, ".openai/hosting.json"), JSON.stringify(template));
  const destination = path.join(directory, ".sites-runtime/sites-source");
  await mkdir(path.join(destination, ".openai"), { recursive: true });
  await writeFile(path.join(directory, ".sites-runtime/hosting.json"), JSON.stringify({ project_id: "synthetic-site" }));
  await copyFile(path.join(directory, ".gitignore"), path.join(destination, ".gitignore"));
  await writeFile(path.join(destination, ".openai/hosting.json"), JSON.stringify({ project_id: "synthetic-site", d1: "DB", capabilities: ["mcp"] }));
  await writeFile(path.join(destination, "obsolete.ts"), "export const oldSource = true;\n");
  git(destination, "init", "--quiet", "--initial-branch=main");
  git(destination, "add", ".");
  git(destination, "-c", "user.name=Synthetic test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Synthetic old source");
  await writeFile(path.join(directory, ".dev.vars"), "local-only\n");
  await writeFile(path.join(destination, ".dev.vars"), "existing-private-state\n");
  return { directory, destination };
}

test("the public checkout prepares Site source without copying secrets or private history", async () => {
  const { directory, destination } = await fixture();
  try {
    await mkdir(path.join(directory, "node_modules"));
    const prepared = await prepareSitesSource(directory);
    assert.equal(prepared.published, false);
    assert.equal(prepared.checkout_path, await realpath(destination));
    assert.equal(await readFile(path.join(destination, "README.md"), "utf8"), await readFile(path.join(directory, "README.md"), "utf8"));
    assert.equal(JSON.parse(await readFile(path.join(destination, ".openai/hosting.json"), "utf8")).project_id, "synthetic-site");
    assert.equal(JSON.parse(await readFile(path.join(directory, ".openai/hosting.json"), "utf8")).project_id, undefined);
    assert.equal(await readFile(path.join(destination, ".dev.vars"), "utf8"), "existing-private-state\n");
    await assert.rejects(lstat(path.join(destination, ".sites-runtime/hosting.json")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(destination, "obsolete.ts")), { code: "ENOENT" });
    assert.equal(git(destination, "rev-list", "--all", "--count"), "1");
    assert.equal(await realpath(path.join(destination, "node_modules")), await realpath(path.join(directory, "node_modules")));
    git(directory, "init", "--quiet", "--initial-branch=main");
    await checkPublic(directory);
    git(directory, "add", "--force", ".dev.vars");
    await assert.rejects(checkPublic(directory), /Private\/generated files are tracked/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("deployment preparation preserves source when the Site differs or edits are unsaved", async () => {
  const { directory, destination } = await fixture();
  try {
    await writeFile(path.join(directory, ".sites-runtime/hosting.json"), JSON.stringify({ project_id: "another-synthetic-site" }));
    await assert.rejects(prepareSitesSource(directory), /different Site/);
    assert.equal(git(destination, "status", "--porcelain"), "");
    await writeFile(path.join(directory, ".sites-runtime/hosting.json"), JSON.stringify({ project_id: "synthetic-site" }));
    await writeFile(path.join(destination, "obsolete.ts"), "keep this edit\n");
    await assert.rejects(prepareSitesSource(directory), /unsaved edits/);
    assert.equal(await readFile(path.join(destination, "obsolete.ts"), "utf8"), "keep this edit\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("deployment preparation cannot follow a tracked source symlink into private files", async () => {
  const { directory, destination } = await fixture();
  try {
    const outside = path.join(directory, "work/private-target");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "worker.ts"), "keep private\n");
    await symlink(outside, path.join(destination, "src"), "dir");
    git(destination, "add", "src");
    git(destination, "-c", "user.name=Synthetic test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Synthetic source link");
    await assert.rejects(prepareSitesSource(directory), /must not contain symlinks/);
    assert.equal(await readFile(path.join(outside, "worker.ts"), "utf8"), "keep private\n");
    assert.equal(git(destination, "status", "--porcelain"), "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
