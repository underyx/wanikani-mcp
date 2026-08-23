import { GET as index } from "../api/index.js";
import { POST as mcp } from "../api/mcp.js";
import { GET as authorize } from "../api/oauth/authorize.js";
import { POST as token } from "../api/oauth/token.js";
import { POST as register } from "../api/oauth/register.js";
import { GET as protectedResource } from "../api/oauth/protected-resource.js";
import { GET as authorizationServer } from "../api/oauth/authorization-server.js";

/**
 * Cloudflare Workers entry point.
 *
 * The `api/` handlers are plain Web-standard `Request` -> `Response` functions
 * and each one dispatches on `request.method` itself, so this is only the
 * routing table that `vercel.json`'s rewrites used to provide.
 */

type Handler = (request: Request) => Response | Promise<Response>;

const ROUTES = new Map<string, Handler>([
  ["/", () => index()],
  ["/mcp", mcp],
  ["/register", register],
  ["/authorize", authorize],
  ["/token", token],
  // Clients look for the metadata both at the root and beneath the resource path.
  ["/.well-known/oauth-protected-resource", protectedResource],
  ["/.well-known/oauth-protected-resource/mcp", protectedResource],
  ["/.well-known/oauth-authorization-server", authorizationServer],
  ["/.well-known/oauth-authorization-server/mcp", authorizationServer],
]);

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    // Secrets arrive as a binding object; the handlers read them from
    // process.env, which is how they run under Node on the CLI and in tests.
    Object.assign(process.env, env);

    const handler = ROUTES.get(new URL(request.url).pathname);
    if (!handler) return new Response("Not found", { status: 404 });
    return handler(request);
  },
};
