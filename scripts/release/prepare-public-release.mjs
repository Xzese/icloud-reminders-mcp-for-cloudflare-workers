import { mkdir, readFile, writeFile, copyFile, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { root, publicFiles, checkPublic } from "./check-public-config.mjs";
const args = process.argv.slice(2);
if (args.length > 1) throw new Error("Usage: npm run release:prepare -- [new-output-directory]");
const destination = path.resolve(args[0] ?? path.join(root, "release", "icloud-reminders-mcp-for-cloudflare-workers"));
if (destination === root || root.startsWith(destination + path.sep)) throw new Error("Use a separate empty directory, not a parent of the source checkout.");
try { await stat(destination); throw new Error("Output directory already exists; choose a new empty path. Existing releases are never overwritten."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await checkPublic(root);
const files = await publicFiles(root);
await mkdir(destination, { recursive: true, mode: 0o700 });
for (const file of files) {
  const target = path.join(destination, file);
  await mkdir(path.dirname(target), { recursive: true });
  if (file === ".openai/hosting.json") {
    const hosting = JSON.parse(await readFile(path.join(root, file), "utf8"));
    // Whitelist logical template fields; registration supplies the new Site ID.
    const template = { d1: hosting.d1, r2: null, capabilities: ["mcp"] };
    await writeFile(target, JSON.stringify(template, null, 2) + "\n");
  } else {
    const source = path.join(root, file);
    await copyFile(source, target);
    await chmod(target, (await stat(source)).mode & 0o777);
  }
}
const result = await checkPublic(destination, true);
console.log(JSON.stringify({ destination, ...result, historyIncluded: false, published: false }));
