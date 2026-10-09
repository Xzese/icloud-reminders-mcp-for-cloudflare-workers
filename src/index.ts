import sitesWorker from "./worker";
import { cloudflareAccessFetch, type CloudflareAccessEnv } from "./platform/cloudflare-access.ts";

export default {
  fetch(request: Request, env: Cloudflare.Env & CloudflareAccessEnv, ctx: Parameters<typeof sitesWorker.fetch>[2]) {
    return cloudflareAccessFetch(request, env, (authenticatedRequest) => sitesWorker.fetch(authenticatedRequest, env, ctx));
  },
};
