import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/server.js";
import { open, publicOrigin } from "../src/oauth.js";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** 401 with the metadata pointer that makes MCP clients start the OAuth login flow (RFC 9728). */
function unauthorized(request: Request, description: string): Response {
  const resourceMetadata = `${publicOrigin(request)}/.well-known/oauth-protected-resource`;
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}", error="invalid_token"`,
    },
  });
}

/**
 * Resolve the WaniKani token for this request. Accepts either an OAuth access
 * token issued by this server (claude.ai login flow) or a raw WaniKani token
 * sent directly in the header (Claude Code / Cursor). Returns the token, or
 * null when an OAuth token is present but invalid/expired.
 */
function resolveToken(bearer: string | undefined): { token?: string; invalidOAuth?: boolean } {
  if (bearer) {
    if (bearer.startsWith("wkmcp_")) {
      const payload = open<{ wk: string }>("wkmcp_at", bearer);
      return payload?.wk ? { token: payload.wk } : { invalidOAuth: true };
    }
    return { token: bearer };
  }
  if (process.env.WANIKANI_API_TOKEN) return { token: process.env.WANIKANI_API_TOKEN };
  return {};
}

async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Stateless server: there is no SSE event stream to resume and no session to
  // delete, so anything but POST gets a 405 (clients treat that as "no SSE offered").
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const { token, invalidOAuth } = resolveToken(bearer);
  if (invalidOAuth) {
    return unauthorized(request, "The access token is invalid or has expired. Please reconnect.");
  }
  if (!token) {
    return unauthorized(request, "Authentication required. Connect with your WaniKani API token.");
  }

  // Stateless mode: a fresh server + transport per request. The resolved
  // WaniKani token is only ever forwarded to api.wanikani.com.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(request, {
    authInfo: { token, clientId: "wanikani-mcp", scopes: [] },
  });
  return withCors(response);
}

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
