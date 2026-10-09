import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "../lib/execution-profile.mjs";
import { sanitizeBuild } from "./sanitize-build.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";

// Dependency PRs should ship current notices in the same build, without a
// separate generated-file PR. Installed metadata also covers nested versions.
if (command === "build") {
  const notices = spawnSync(process.execPath, [
    fileURLToPath(new URL("../release/generate-notices.mjs", import.meta.url)),
  ], { stdio: "inherit" });
  if (notices.error) throw notices.error;
  if (notices.status !== 0) process.exit(notices.status ?? 1);
}

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0) await sanitizeBuild();
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../../node_modules/vite/bin/vite.js"
  : "../../node_modules/vinext/dist/cli.js", import.meta.url);
if (command === "build") {
  // The framework CLI calls process.exit on success. Run it in a child so the
  // parent can remove copied local credential files before returning success.
  const result = spawnSync(process.execPath, [fileURLToPath(cli), command, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0) await sanitizeBuild();
  process.exit(result.status ?? 1);
}
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
