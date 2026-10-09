// Development-only WSS transport for the unchanged workerd Apple bridge.
import NodeWebSocket from "ws";
import { Response, WebSocketPair, coupleWebSocket } from "miniflare";

export function createLocalPushRelay({ observe = async () => {}, connect = (url, options) => new NodeWebSocket(url, options) } = {}) {
  const active = new Set();
  return {
    get activeCount() { return active.size; },
    close() { for (const socket of active) socket.terminate(); },
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket" || url.protocol !== "https:" ||
        !["websocket.push.apple.com", "websocket.sandbox.push.apple.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash ||
        !/^\/v2\/(?:[0-9a-f]{2}){1,2048}$/.test(url.pathname) || request.headers.get("origin") !== "https://idmsa.apple.com") {
        return new Response("Unsupported local verification endpoint.", { status: 403 });
      }
      if (request.signal.aborted || active.size >= 4) return new Response("Local verification connection unavailable.", { status: 503 });
      url.protocol = "wss:";
      const socket = connect(url.href, {
        headers: { Origin: "https://idmsa.apple.com", "User-Agent": request.headers.get("user-agent") ?? "" },
        followRedirects: false, perMessageDeflate: false, maxPayload: 65_536, handshakeTimeout: 15_000,
      });
      active.add(socket);
      const [worker, peer] = Object.values(new WebSocketPair());
      let status = 502; let ended = false; let received = 0;
      const stop = () => { try { socket.terminate(); } catch { /* Never expose a nonce URL or raw error. */ } };
      const timer = setTimeout(stop, 180_000); timer.unref();
      const clean = () => {
        if (ended) return; ended = true;
        clearTimeout(timer); request.signal.removeEventListener("abort", stop); active.delete(socket);
      };
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) stop();
      socket.once("close", clean);
      socket.on("error", () => {}); // Node errors must never print sensitive connection URLs.
      socket.once("unexpected-response", (_request, reply) => { status = reply.statusCode ?? 502; reply.resume(); stop(); });
      socket.on("message", (bytes, binary) => { if (!binary || bytes.length > 65_536 || ++received > 64) stop(); });
      try {
        await coupleWebSocket(socket, peer);
        if (ended || request.signal.aborted) throw new Error("cancelled");
        await observe({ at: new Date().toISOString(), host: url.hostname, path: "/v2/[redacted]", status: 101, transport: "websocket" });
        return new Response(null, { status: 101, webSocket: worker });
      } catch {
        stop(); clean();
        await observe({ at: new Date().toISOString(), host: url.hostname, path: "/v2/[redacted]", status, transport: "websocket" });
        return new Response("Local verification upgrade failed.", { status: status >= 400 && status <= 599 ? status : 502 });
      }
    },
  };
}
