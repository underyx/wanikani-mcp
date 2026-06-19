import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../src/server.js";

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

async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Stateless server: there is no SSE event stream to resume and no session to
  // delete, so anything but POST gets a 405 (clients treat that as "no SSE offered").
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
  }

  // Per-request token passthrough: the caller's WaniKani token rides in the
  // Authorization header and is only ever forwarded to api.wanikani.com.
  // WANIKANI_API_TOKEN can be set on the deployment as a fallback for
  // single-user setups whose MCP client can't send headers.
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();

  // Stateless mode: a fresh server + transport per request.
  const server = createServer({ fallbackToken: process.env.WANIKANI_API_TOKEN });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(
    request,
    bearer ? { authInfo: { token: bearer, clientId: "wanikani-mcp", scopes: [] } } : undefined,
  );
  return withCors(response);
}

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS };
