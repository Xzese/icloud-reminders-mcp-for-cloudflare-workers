import { readdir, rm } from "node:fs/promises";
import path from "node:path";
// The framework may copy local Wrangler dotenv files into server output.
// Local credentials are never deployment artifacts, in either hosting mode.
export async function sanitizeBuild(directory = "dist") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (/^(?:\.dev\.vars|\.env)(?:\.|$)/.test(entry.name)) await rm(target, { recursive: true, force: true });
    else if (entry.isDirectory()) await sanitizeBuild(target);
    else if (entry.isSymbolicLink()) throw new Error("Deployment output must not contain symlinks.");
  }
}
if (process.argv[1]?.endsWith("/sanitize-build.mjs")) await sanitizeBuild();
