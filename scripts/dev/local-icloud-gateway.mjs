// Development-only front door. Never imported by the Site or its production bundle.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const denied = () => new Response("Use the local test on this computer.", { status: 403 });
    const navigation = request.method === "GET" && url.pathname === "/" && !origin &&
      (!request.headers.has("sec-fetch-mode") || request.headers.get("sec-fetch-mode") === "navigate") &&
      (!request.headers.has("sec-fetch-dest") || request.headers.get("sec-fetch-dest") === "document");
    if (url.origin !== env.LOCAL_ORIGIN || (origin && origin !== env.LOCAL_ORIGIN) || (request.headers.get("sec-fetch-site") === "cross-site" && !navigation)) return denied();
    const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
    if (url.pathname === "/local/setup" && request.method === "GET") {
      return new Response(null, { status: 302, headers: { ...headers, location: "/" } });
    }
    const cookies = (request.headers.get("cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith("local-icloud="));
    const authorized = cookies.length === 1 && cookies[0] === `local-icloud=${env.LOCAL_ACCESS}`;
    if (!authorized && !navigation) return new Response("Open the local Worker in this browser first.", { status: 401, headers });
    if ((request.method !== "GET" && request.method !== "HEAD") || request.headers.get("upgrade")) {
      if (origin !== env.LOCAL_ORIGIN) return denied();
    }
    const forwarded = new Headers(request.headers);
    for (const name of [...forwarded.keys()]) if (name.startsWith("oai-") || name.startsWith("x-forwarded-")) forwarded.delete(name);
    forwarded.delete("cookie");
    // This is a distinct local principal, never the hosted Site's owner identity.
    forwarded.set("oai-authenticated-user-id", env.LOCAL_OWNER);
    forwarded.set("oai-authenticated-user-email", "local-test@example.invalid");
    const response = await env.APP.fetch(new Request(request, { headers: forwarded }));
    if (authorized || !navigation) return response;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.append("set-cookie", `local-icloud=${env.LOCAL_ACCESS}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  },
};
