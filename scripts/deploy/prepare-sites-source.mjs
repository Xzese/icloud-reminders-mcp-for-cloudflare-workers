import { chmod, copyFile, lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPublic, publicFiles, root } from "../release/check-public-config.mjs";

// The public checkout is the only source of application edits. Sites' native
// workflow owns the ignored deployment checkout and its private Git history.
export async function prepareSitesSource(directory = root) {
  directory = await realpath(directory);
  const runtime = path.join(directory, ".sites-runtime");
  const destination = path.join(runtime, "sites-source");
  for (const target of [runtime, destination, path.join(destination, ".git")]) {
    const metadata = await lstat(target).catch(error => {
      if (error.code === "ENOENT") throw new Error("Open your Site's source in .sites-runtime/sites-source through the Sites workflow first.");
      throw error;
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Sites deployment paths must be real directories.");
  }
  const binding = JSON.parse(await readFile(path.join(runtime, "hosting.json"), "utf8"));
  if (typeof binding.project_id !== "string" || !binding.project_id.trim()) throw new Error("Save the Site's returned project_id in ignored .sites-runtime/hosting.json first.");
  const existing = JSON.parse(await readFile(path.join(destination, ".openai/hosting.json"), "utf8"));
  if (existing.project_id !== binding.project_id) throw new Error("The deployment checkout belongs to a different Site. No files were changed.");
  const git = args => execFileSync("git", args, { cwd: destination, encoding: "utf8" }).trim();
  if (await realpath(git(["rev-parse", "--show-toplevel"])) !== destination) throw new Error("The Site deployment checkout must own its Git repository.");
  if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("The Site deployment checkout has unsaved edits. Save or reconcile them through Sites before preparing another copy.");

  await checkPublic(directory);
  const files = await publicFiles(directory);
  const expected = new Set(files);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: destination, encoding: "utf8" }).split("\0").filter(Boolean);
  // Validate every destination before writing, including paths inherited from
  // older source versions. Never follow a symlink into a private local file.
  const safePath = async file => {
    const target = path.resolve(destination, file);
    if (!target.startsWith(destination + path.sep) || file.split("/").includes(".git")) throw new Error("Unsafe deployment source path.");
    let current = destination;
    for (const part of path.relative(destination, target).split(path.sep)) {
      current = path.join(current, part);
      const entry = await lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (entry?.isSymbolicLink()) throw new Error("Deployment source must not contain symlinks.");
    }
    return target;
  };
  for (const file of new Set([...files, ...tracked])) await safePath(file);
  const dependencies = path.join(directory, "node_modules");
  const stagedDependencies = path.join(destination, "node_modules");
  const installed = await lstat(dependencies).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const staged = await lstat(stagedDependencies).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (installed && staged?.isSymbolicLink() && await realpath(stagedDependencies) !== await realpath(dependencies)) throw new Error("The deployment dependency link points to another checkout.");
  for (const file of tracked) if (!expected.has(file)) await unlink(path.join(destination, file));
  for (const file of files) {
    const source = path.join(directory, file);
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (file === ".openai/hosting.json") {
      const template = JSON.parse(await readFile(source, "utf8"));
      await writeFile(target, JSON.stringify({ ...template, project_id: binding.project_id }, null, 2) + "\n");
    } else {
      await copyFile(source, target);
      await chmod(target, (await lstat(source)).mode & 0o777);
    }
  }
  if (installed && !staged) await symlink(dependencies, stagedDependencies, "dir");
  return { checkout_path: destination, files: files.length, privateBindingIncluded: true, published: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareSitesSource()));
}
