import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "./lib/connector-context";
import type { ConnectorBinding } from "./lib/connector-contract.mjs";
import { applicationRoute } from "./api/router";
import type { RuntimeEnv } from "./platform/sites";
import credentialJS from "virtual:apple-credential-script";

export default {
  async fetch(request: Request, env: Cloudflare.Env & RuntimeEnv, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const appResponse = await applicationRoute(request, env, credentialJS);
    if (appResponse) return appResponse;
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    const response = await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    const socketOrigin = new URL(request.url); socketOrigin.protocol = socketOrigin.protocol === "https:" ? "wss:" : "ws:";
    headers.set("Content-Security-Policy", `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'${import.meta.env.DEV ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${socketOrigin.origin}${import.meta.env.DEV ? " ws://localhost:*" : ""}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com`);
    const secured = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    if (headers.get("content-type")?.includes("text/html")) return new HTMLRewriter().on("script", { element(element) { element.setAttribute("nonce", nonce); } }).transform(secured);
    return secured;
  },
};
