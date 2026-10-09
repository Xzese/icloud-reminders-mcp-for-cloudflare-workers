import { build, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

// Build the credential document's one script separately. It has no framework,
// dashboard, connector, analytics or dynamically loaded code.
export function appleCredential(): Plugin {
  let script: Promise<string> | undefined;
  return {
    name: "apple-credential-document",
    resolveId(id) { if (id === "virtual:apple-credential-script") return "\0apple-credential-script"; },
    async load(id) {
      if (id !== "\0apple-credential-script") return;
      script ??= (async () => {
        const result = await build({ configFile: false, logLevel: "error", build: {
          write: false, sourcemap: false, target: "es2022", minify: true,
          lib: { entry: fileURLToPath(new URL("../../src/auth/credential-entry.ts", import.meta.url)), name: "AppleCredential", formats: ["iife"] },
        } });
        const outputs = Array.isArray(result) ? result : [result];
        const chunks = outputs.flatMap(output => "output" in output ? output.output : []);
        if (chunks.length !== 1 || chunks[0].type !== "chunk") throw new Error("Credential entry must be a single standalone script.");
        const modules = Object.keys(chunks[0].modules);
        if (modules.some(name => /node_modules\/(?:react|next|vinext|lucide-react|@base-ui)\//.test(name))) throw new Error("Credential entry must not include framework or dashboard modules.");
        return chunks[0].code;
      })();
      return `export default ${JSON.stringify(await script)};`;
    },
  };
}
