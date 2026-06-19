import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../api/mcp.js";
import { GET as getIndex } from "../api/index.js";

function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://wanikani-mcp.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

describe("HTTP MCP endpoint", () => {
  it("responds to initialize without requiring a token", async () => {
    const response = await POST(rpcRequest(initializeBody));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      result: { serverInfo: { name: string }; capabilities: { tools?: object } };
    };
    expect(body.result.serverInfo.name).toBe("wanikani-mcp");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists tools over HTTP", async () => {
    const response = await POST(rpcRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain("get_summary");
    expect(names).toContain("create_review");
  });

  it("handles CORS preflight", async () => {
    const response = await POST(
      new Request("https://wanikani-mcp.test/mcp", { method: "OPTIONS" }) as Request,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("rejects GET with 405 instead of opening an SSE stream", async () => {
    const response = await GET(
      new Request("https://wanikani-mcp.test/mcp", {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });
});

describe("token passthrough over HTTP", () => {
  const userResource = {
    object: "user",
    url: "https://api.wanikani.com/v2/user",
    data_updated_at: "2026-06-01T00:00:00.000000Z",
    data: { username: "crabigator", level: 12 },
  };

  function stubWaniKani() {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(userResource), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", stub);
    return calls;
  }

  function callGetUser(headers: Record<string, string> = {}) {
    return POST(
      rpcRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_user", arguments: {} } },
        headers,
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the caller's Authorization bearer token to api.wanikani.com", async () => {
    vi.stubEnv("WANIKANI_API_TOKEN", "");
    const calls = stubWaniKani();
    const response = await callGetUser({ Authorization: "Bearer caller-token" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]!.text).username).toBe("crabigator");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.wanikani.com/v2/user");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer caller-token");
    expect(calls[0]!.headers.get("wanikani-revision")).toBe("20170710");
  });

  it("returns a no-token error when neither header nor env token is present", async () => {
    vi.stubEnv("WANIKANI_API_TOKEN", "");
    const calls = stubWaniKani();
    const response = await callGetUser();
    const body = (await response.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("personal_access_tokens");
    expect(calls).toHaveLength(0);
  });

  it("falls back to WANIKANI_API_TOKEN when no Authorization header is sent", async () => {
    vi.stubEnv("WANIKANI_API_TOKEN", "env-token");
    const calls = stubWaniKani();
    const response = await callGetUser();
    const body = (await response.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer env-token");
  });
});

describe("index endpoint", () => {
  it("describes the server", async () => {
    const response = getIndex();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mcp_endpoint: string };
    expect(body.mcp_endpoint).toBe("/mcp");
  });
});
