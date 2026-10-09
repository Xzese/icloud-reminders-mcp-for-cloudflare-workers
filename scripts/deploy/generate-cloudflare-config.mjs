import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
const checking = process.argv.includes("--check");
const built = JSON.parse(await readFile("dist/server/wrangler.json", "utf8"));
if (!built.main || !built.compatibility_flags?.includes("nodejs_compat")) throw new Error("Build the standalone Worker first.");
let configured;
try { configured = parse(await readFile(checking ? "wrangler.toml" : "wrangler.production.toml", "utf8")); }
catch (error) {
  if (checking || error.code !== "ENOENT") throw error;
  const databaseId = process.env.REMINDERS_D1_DATABASE_ID;
  if (!databaseId) throw new Error("Copy wrangler.toml to wrangler.production.toml, or supply REMINDERS_D1_DATABASE_ID for a repository build.");
  configured = { name: process.env.REMINDERS_WORKER_NAME ?? "icloud-reminders-mcp-server", keep_vars: true, d1_databases: [{ binding: "DB", database_id: databaseId, database_name: "icloud-reminders" }] };
}
const db = configured.d1_databases?.find(binding => binding.binding === "DB");
if (!db) throw new Error("The DB D1 binding is required.");
if (checking) db.database_id = "00000000-0000-4000-8000-000000000000";
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(db.database_id)) throw new Error("Replace the public D1 placeholder with the database UUID from your account.");
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(configured.name ?? "")) throw new Error("Configure a valid Worker name.");
const output = { ...built, ...configured, main: "dist/server/index.js", assets: { ...built.assets, ...configured.assets, directory: "dist/client", binding: "ASSETS", run_worker_first: true }, d1_databases: [{ ...db }], preview_urls: false };
if (!configured.vars) delete output.vars;
// Retired catalogue schedules must not survive generated configurations.
delete output.triggers;
delete output.services;
delete output.r2_buckets;
await writeFile("wrangler.generated.toml", stringify(output) + "\n", { mode: 0o600 });
console.log(checking ? "Prepared non-deploying bundle-check configuration." : "Prepared ignored Cloudflare deployment configuration.");
