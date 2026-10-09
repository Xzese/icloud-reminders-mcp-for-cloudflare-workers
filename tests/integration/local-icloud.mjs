import { Miniflare, Log, LogLevel } from "miniflare";
import assert from "node:assert/strict";
import http from "node:http";
import NodeWebSocket, { WebSocketServer } from "ws";
import { localAppleHeaders, summarizeAppleResponse, summarizeAppleFailure } from "../../scripts/dev/local-icloud-observation.mjs";
import { createLocalPushRelay } from "../../scripts/dev/local-icloud-push.mjs";
const origin = "http://127.0.0.1:5173";
const echoServer = http.createServer();
const echo = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65_536 });
const pushObservations = [];
const handshakes = [];
echoServer.on("upgrade", (request, socket, head) => {
  if (request.url === "/reject") { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return; }
  handshakes.push({ origin: request.headers.origin, userAgent: request.headers["user-agent"], workerMarker: request.headers["cf-worker"], compression: request.headers["sec-websocket-extensions"] });
  echo.handleUpgrade(request, socket, head, peer => { peer.on("message", (bytes, binary) => peer.send(bytes, { binary })); });
});
await new Promise(resolve => echoServer.listen(0, "127.0.0.1", resolve));
const echoOrigin = `ws://127.0.0.1:${echoServer.address().port}`;
let dials = 0;
const push = createLocalPushRelay({ observe: async summary => pushObservations.push(summary), connect: (url, options) => {
  dials++;
  assert.equal(options.maxPayload, 65_536); assert.equal(options.handshakeTimeout, 15_000);
  assert.equal(options.followRedirects, false); assert.equal(options.perMessageDeflate, false);
  return new NodeWebSocket(echoOrigin + (url.endsWith("/cc") ? "/reject" : "/echo"), options);
} });
const worker = new Miniflare({ host: "127.0.0.1", port: 0, log: new Log(LogLevel.ERROR), workers: [
  { name: "gateway-test", modules: true, scriptPath: new URL("../../scripts/dev/local-icloud-gateway.mjs", import.meta.url).pathname, compatibilityDate: "2026-05-15", bindings: { LOCAL_ORIGIN: origin, LOCAL_OWNER: "isolated-owner", LOCAL_ACCESS: "test-access" }, serviceBindings: { APP: "test-app" } },
  { name: "test-app", modules: true, script: `export default { async fetch(request) { return Response.json({user:request.headers.get('oai-authenticated-user-id'), email:request.headers.get('oai-authenticated-user-email'), cookie:request.headers.get('cookie'), forwarded:request.headers.get('x-forwarded-host')}); } }` },
  { name: "test-push", modules: true, outboundService: request => push.fetch(request), script: `export default { async fetch(request) {
    const failure = new URL(request.url).pathname === '/reject';
    const reply = await fetch('https://websocket.push.apple.com/v2/'+(failure?'cc':'aa'), {headers:{Upgrade:'websocket', Origin:'https://idmsa.apple.com', 'User-Agent':'synthetic-browser'}, redirect:'manual'});
    if (failure) return Response.json({status:reply.status, socket:!!reply.webSocket});
    if(reply.status!==101 || !reply.webSocket) throw new Error('Synthetic upgrade failed');
    const socket=reply.webSocket; socket.binaryType='arraybuffer'; socket.accept();
    const message=await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(new Error('Synthetic echo timed out')),3000);socket.addEventListener('message',event=>{clearTimeout(timer);resolve(event.data);},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Synthetic peer failed'));},{once:true});socket.send(new Uint8Array([1,2,3]).buffer);});
    socket.close(1000,'Synthetic test finished'); return Response.json({status:reply.status,binary:message instanceof ArrayBuffer,bytes:[...new Uint8Array(message)]});
  } }` },
] });
try {
  // Use HTTP rather than Node fetch, which replaces sec-fetch-mode with cors.
  const server = await worker.ready;
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(new URL(path, server), { method: options.method ?? "GET", headers: { host: new URL(origin).host, ...options.headers } }, reply => {
      const chunks = [];
      reply.on("data", chunk => chunks.push(chunk));
      reply.on("error", reject);
      reply.on("end", () => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(reply.headers)) if (values !== undefined) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
        resolve(new Response(Buffer.concat(chunks), { status: reply.statusCode, headers }));
      });
    });
    req.on("error", reject); req.end();
  });
  assert.equal((await request("/api/connection", { headers: { "oai-authenticated-user-id": "hosted-owner" } })).status, 401);
  assert.equal((await worker.dispatchFetch("http://evil.example/local/setup")).status, 403);
  assert.equal((await request("/", { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await request("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403);
  assert.equal((await request("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" } })).status, 403);
  assert.equal((await request("/local/setup")).headers.get("location"), "/");
  const open = await request("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  assert.equal(open.status, 200);
  assert.match(open.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const cookie = open.headers.get("set-cookie").split(";")[0];
  const headers = { cookie, origin, "oai-authenticated-user-id": "hosted-owner", "oai-authenticated-user-email": "private@example.invalid", "x-forwarded-host": "evil.example" };
  assert.deepEqual(await (await request("/api/connection", { headers })).json(), { user: "isolated-owner", email: "local-test@example.invalid", cookie: null, forwarded: null });
  assert.equal((await request("/mcp", { method: "POST", headers: { cookie } })).status, 403);
  assert.equal((await request("/api/auth/socket", { headers: { cookie, upgrade: "websocket", origin: "https://evil.example" } })).status, 403);
  assert.equal((await request("/api/connection", { headers: { cookie, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await request("/api/connection", { headers: { cookie: `${cookie}; ${cookie}`, origin } })).status, 401);
  const privateValue = "private-content-cookie-token-account-identifier";
  const summary = summarizeAppleResponse(new URL("https://p12-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private/records/query?dsid=" + privateValue), 200, { zones: [{ zoneID: { zoneName: "Reminders", ownerRecordName: privateValue }, syncToken: privateValue, moreComing: true, records: [{ recordType: "List", recordName: privateValue, fields: { Title: { value: privateValue } } }, { recordType: privateValue }] }] });
  assert.equal(summary.records, 2); assert.deepEqual(summary.recordTypes, { List: 1, other: 1 });
  assert.ok(!JSON.stringify(summary).includes(privateValue));
  const services = summarizeAppleResponse(new URL("https://setup.icloud.com/setup/ws/1/accountLogin"), 200, { dsInfo: { dsid: privateValue }, webservices: { ckdatabasews: { url: "https://p12-ckdatabasews.icloud.com/?token=" + privateValue }, untrusted: { url: "https://evil.example/" } } });
  assert.deepEqual(services.services, { ckdatabasews: { origin: "https://p12-ckdatabasews.icloud.com", disabled: false } });
  assert.ok(!JSON.stringify(services).includes(privateValue));
  const rejected = summarizeAppleResponse(new URL("https://p12-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private/records/query"), 400, { serverErrorCode: "BAD_REQUEST", reason: `Invalid query field ${privateValue}`, records: [{ recordType: "Reminder", fields: { AttachmentIDs: { type: "UNKNOWN_LIST", value: [] }, AlarmIDs: { type: "STRING_LIST", value: [privateValue] } } }] });
  assert.equal(rejected.responseErrorCode, "BAD_REQUEST"); assert.deepEqual(rejected.errorTerms, ["invalid", "query", "field"]);
  assert.equal(rejected.relationshipFieldTypes["AttachmentIDs:UNKNOWN_LIST:empty-array"], 1);
  assert.equal(rejected.relationshipFieldTypes["AlarmIDs:STRING_LIST:array"], 1);
  assert.ok(!JSON.stringify(rejected).includes(privateValue));
  const failed = summarizeAppleFailure(new URL("https://p12-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private/records/query?dsid=" + privateValue), { stage: "body", status: 200, bytesRead: 1_048_577, elapsedMs: 300, timeout: false, aborted: false, error: { code: "LOCAL_RESPONSE_BYTE_BUDGET", message: privateValue, cause: privateValue } });
  assert.equal(failed.failure, "response-byte-budget");
  assert.equal(failed.bytesRead, 1_048_577);
  assert.ok(!JSON.stringify(failed).includes(privateValue));
  const appleHeaders = localAppleHeaders({ "CF-Worker": "worker.example.com", cookie: "synthetic-cookie=one", "X-Apple-ID-Session-Id": "synthetic-session", origin: "https://www.icloud.com", "user-agent": "synthetic-browser" });
  assert.equal(appleHeaders.has("cf-worker"), false);
  assert.equal(appleHeaders.get("cookie"), "synthetic-cookie=one");
  assert.equal(appleHeaders.get("x-apple-id-session-id"), "synthetic-session");
  assert.equal(appleHeaders.get("origin"), "https://www.icloud.com");
  assert.equal(appleHeaders.get("user-agent"), "synthetic-browser");
  const invalid = new Request("https://evil.example/v2/aa", { headers: { upgrade: "websocket", origin: "https://idmsa.apple.com" } });
  assert.equal((await push.fetch(invalid)).status, 403); assert.equal(dials, 0);
  const sensitiveNonce = "aabbccddeeff";
  const query = new Request("https://websocket.push.apple.com/v2/" + sensitiveNonce + "?token=secret", { headers: { upgrade: "websocket", origin: "https://idmsa.apple.com" } });
  assert.equal((await push.fetch(query)).status, 403); assert.equal(dials, 0);
  const pushWorker = await worker.getWorker("test-push");
  assert.deepEqual(await (await pushWorker.fetch("http://local-test/echo")).json(), { status: 101, binary: true, bytes: [1, 2, 3] });
  assert.deepEqual(await (await pushWorker.fetch("http://local-test/reject")).json(), { status: 403, socket: false });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(push.activeCount, 0);
  assert.deepEqual(handshakes, [{ origin: "https://idmsa.apple.com", userAgent: "synthetic-browser", workerMarker: undefined, compression: undefined }]);
  assert.deepEqual(pushObservations.map(s => s.status), [101, 403]);
  assert.ok(pushObservations.every(s => s.path === "/v2/[redacted]"));
  assert.ok(!JSON.stringify(pushObservations).includes(sensitiveNonce));
  console.log("Local access isolation, redaction, binary outbound WebSocket relay, and rejected handshake cleanup passed. No Apple requests made.");
} finally {
  push.close(); await worker.dispose();
  for (const peer of echo.clients) peer.terminate();
  await new Promise(resolve => echo.close(resolve));
  await new Promise(resolve => echoServer.close(resolve));
}
