import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { POST as registerPost } from "../api/oauth/register.js";
import { GET as authorizeGet, POST as authorizePost } from "../api/oauth/authorize.js";
import { POST as tokenPost } from "../api/oauth/token.js";
import { GET as asMetadata } from "../api/oauth/authorization-server.js";
import { GET as prMetadata } from "../api/oauth/protected-resource.js";
import { POST as mcpPost } from "../api/mcp.js";

const ORIGIN = "https://wanikani-mcp.test";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

beforeAll(() => {
  process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-not-for-production";
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function registerClient(): Promise<string> {
  const response = await registerPost(
    req("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  expect(body.client_id.startsWith("wkmcp_cid_")).toBe(true);
  return body.client_id;
}

function stubWaniKani() {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ object: "user", data: { username: "crabigator", level: 7 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth metadata", () => {
  it("advertises the authorization server endpoints", async () => {
    const body = (await asMetadata(req("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("advertises the protected resource", async () => {
    const body = (await prMetadata(req("/.well-known/oauth-protected-resource")).json()) as Record<string, unknown>;
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
  });
});

describe("authorization code flow", () => {
  it("runs register -> authorize -> token and yields a usable access token", async () => {
    const calls = stubWaniKani();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();

    // GET /authorize renders the login form.
    const authorizeUrl =
      `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=xyz&scope=wanikani`;
    const formResponse = await authorizeGet(req(authorizeUrl));
    expect(formResponse.status).toBe(200);
    const formHtml = await formResponse.text();
    expect(formHtml).toContain("wanikani_token");
    expect(formHtml).toContain(challenge);

    // POST /authorize with the WaniKani token -> 302 redirect carrying the code.
    const form = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      scope: "wanikani",
      wanikani_token: "real-wk-token",
    });
    const redirectResponse = await authorizePost(
      req("/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    );
    expect(redirectResponse.status).toBe(302);
    // The token was verified against WaniKani during authorize.
    expect(calls.some((c) => c.url === "https://api.wanikani.com/v2/user" && c.auth === "Bearer real-wk-token")).toBe(
      true,
    );
    const location = new URL(redirectResponse.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code")!;
    expect(code.startsWith("wkmcp_code_")).toBe(true);

    // POST /token exchanges the code for tokens.
    const tokenResponse = await tokenPost(
      req("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token.startsWith("wkmcp_at_")).toBe(true);
    expect(tokens.refresh_token.startsWith("wkmcp_rt_")).toBe(true);

    // The access token, used on /mcp, forwards the original WaniKani token.
    const mcpResponse = await mcpPost(
      req("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_user", arguments: {} },
        }),
      }),
    );
    expect(mcpResponse.status).toBe(200);
    const mcpBody = (await mcpResponse.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(mcpBody.result.isError).toBeFalsy();
    expect(JSON.parse(mcpBody.result.content[0]!.text).username).toBe("crabigator");
    expect(calls.some((c) => c.url === "https://api.wanikani.com/v2/user" && c.auth === "Bearer real-wk-token")).toBe(
      true,
    );

    // The refresh token mints a fresh access token.
    const refreshResponse = await tokenPost(
      req("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }).toString(),
      }),
    );
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as { access_token: string };
    expect(refreshed.access_token.startsWith("wkmcp_at_")).toBe(true);
  });

  it("rejects a token exchange with a wrong PKCE verifier", async () => {
    stubWaniKani();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const form = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      wanikani_token: "real-wk-token",
    });
    const redirect = await authorizePost(
      req("/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    );
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;

    const tokenResponse = await tokenPost(
      req("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: "the-wrong-verifier",
        }).toString(),
      }),
    );
    expect(tokenResponse.status).toBe(400);
    expect(((await tokenResponse.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("re-renders the form with an error when WaniKani rejects the token", async () => {
    const stub = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unauthorized. Nice try.", code: 401 }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", stub);
    const clientId = await registerClient();
    const { challenge } = pkce();
    const response = await authorizePost(
      req("/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s",
          wanikani_token: "bad-token",
        }).toString(),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("rejected");
  });

  it("rejects an authorize request whose redirect_uri was not registered", async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const response = await authorizeGet(
      req(
        `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent("https://evil.example/callback")}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("redirect_uri");
  });
});

describe("dynamic client registration", () => {
  it("rejects non-https redirect URIs", async () => {
    const response = await registerPost(
      req("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("accepts http://localhost for local tooling", async () => {
    const response = await registerPost(
      req("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:6274/oauth/callback"] }),
      }),
    );
    expect(response.status).toBe(201);
  });
});
