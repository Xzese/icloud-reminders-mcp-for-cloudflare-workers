import { randomBytes } from "node:crypto";
// Pipe directly into a secret store. Never commit or paste this output into chat.
const id = process.argv[2] ?? "primary";
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Use a short encryption key identifier.");
process.stdout.write(JSON.stringify({ [id]: randomBytes(32).toString("base64") }) + "\n");
