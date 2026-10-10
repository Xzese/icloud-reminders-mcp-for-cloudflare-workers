import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { execFileSync } from "node:child_process";
export const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const skipped = new Set([".git", "node_modules", "dist", ".next", ".vinext", ".wrangler", ".sites-runtime", ".agents", ".codex", "coverage", "outputs", "work"]);
export function privateFile(file) {
  return file.split("/").some(part => skipped.has(part)) || file.split("/")[0] === "release" ||
    /(?:^|\/)(?:\.env|\.dev\.vars)(?:\.|$)/.test(file) && !file.endsWith(".example") ||
    /(?:^|\/)wrangler\.(?:production|generated)\./.test(file) ||
    /(?:^|\/)keys[^/]*\.json$|\.(?:pem|key|sqlite|sqlite3|db|log|jsonl|tar|gz|zip)$|\.tsbuildinfo$/.test(file) ||
    ["next-env.d.ts", "docs/artifact-manifest.json", "docs/release-check.json"].includes(file);
}
export async function publicFiles(directory = root, relative = "") {
  const out = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (privateFile(name) || entry.name === ".DS_Store") continue;
    if (entry.isSymbolicLink()) throw new Error(`Public source cannot include symlink: ${name}`);
    if (entry.isDirectory()) out.push(...await publicFiles(directory, name));
    else if (entry.isFile()) out.push(name);
    else throw new Error(`Public source cannot include special file: ${name}`);
  }
  return out.sort();
}
export async function checkPublic(directory = root) {
  const files = await publicFiles(directory);
  const hosting = JSON.parse(await readFile(path.join(directory, ".openai/hosting.json"), "utf8"));
  if (hosting.d1 !== "DB" || !hosting.capabilities?.includes("mcp")) throw new Error("Required Sites logical bindings are missing.");
  if (hosting.project_id) throw new Error("Store the private Site binding in ignored .sites-runtime/hosting.json, not the public manifest.");
  try {
    await lstat(path.join(directory, ".git"));
    const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: directory, encoding: "utf8" }).split("\0").filter(Boolean);
    const privateTracked = tracked.filter(file => privateFile(file) || file.split("/").includes(".DS_Store"));
    if (privateTracked.length) throw new Error(`Private/generated files are tracked by Git: ${privateTracked.join(", ")}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const worker = parse(await readFile(path.join(directory, "wrangler.toml"), "utf8"));
  for (const setting of ["APPLE_SESSION_RETENTION_WRITES", "APPLE_SESSION_RETENTION_MIGRATION_JSON", "APPLE_SESSION_RENEWAL_ENABLED"]) {
    if (worker.vars?.[setting] !== "") throw new Error("Public retention and renewal rollout settings must remain disabled and contain no owner approval.");
  }
  if (worker.d1_databases?.[0]?.database_id !== "replace-with-your-d1-database-id" || worker.vars?.REMINDERS_OWNER_ID !== "" || worker.vars?.LIVE_APPLE_CONNECTION_APPROVED !== "" || worker.vars?.APPLE_CRYPTO_REVIEW_APPROVED !== "" || "LIVE_APPLE_WRITES_APPROVED" in (worker.vars ?? {}) || "ENCRYPTION_KEYS_JSON" in (worker.vars ?? {})) throw new Error("Public Worker configuration must retain placeholders, empty owner/approval gates and no encryption secret.");
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/,
    /https:\/\/[^\s"'<>]+:[^\s"'<>]+@/,
    /appg(?:prj|dep|ver)_[a-f0-9]{20,}/,
    /https:\/\/[^\s"'<>]+\.chatgpt\.site/,
    /cvws\.icloud-content\.com\/[^\s"'<>]+\?/,
  ];
  for (const file of files) {
    if ((await lstat(path.join(directory, file))).size > 5_000_000) throw new Error(`Unexpected large source file: ${file}`);
    const content = await readFile(path.join(directory, file), "utf8");
    if (forbidden.some(pattern => pattern.test(content))) throw new Error(`Private deployment or credential pattern in public source: ${file}`);
  }
  for (const file of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "schema.sql"]) if (!files.includes(file)) throw new Error(`Missing release file: ${file}`);
  return { files: files.length, strict: true, checks: ["private-state-exclusion", "tracked-private-file-denial", "sanitized-deployment-config", "common-credential-patterns", "release-documents"] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkPublic(root)));
}
