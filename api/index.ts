const BODY = {
  name: "wanikani-mcp",
  description: "MCP server for the WaniKani API",
  mcp_endpoint: "/mcp",
  transport: "streamable-http",
  authentication:
    "Send your WaniKani personal access token as 'Authorization: Bearer <token>' on requests to /mcp.",
  source: "https://github.com/underyx/wanikani-mcp",
};

export function GET(): Response {
  return new Response(JSON.stringify(BODY, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
