import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  corsPreflight,
  jsonResponse,
  open,
  seal,
  verifyPkceS256,
} from "../../src/oauth.js";

// RFC 6749 / OAuth 2.1 token endpoint. Public client (no client authentication);
// security rests on PKCE plus the encrypted, self-validating code/refresh tokens.

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (contentType.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") params.set(k, v);
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

function issueTokens(wkToken: string, scope: string | null): Response {
  return jsonResponse({
    access_token: seal("wkmcp_at", { wk: wkToken }, ACCESS_TOKEN_TTL),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: seal("wkmcp_rt", { wk: wkToken }, REFRESH_TOKEN_TTL),
    ...(scope ? { scope } : {}),
  });
}

async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method !== "POST") {
    return jsonResponse({ error: "invalid_request", error_description: "Use POST" }, 405);
  }

  const form = await readForm(request);
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";

    const payload = open<{ wk: string; cc: string; ru: string; cid: string }>("wkmcp_code", code);
    if (!payload) {
      return jsonResponse({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400);
    }
    if (redirectUri !== payload.ru) {
      return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    if (clientId && clientId !== payload.cid) {
      return jsonResponse({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
    }
    if (!codeVerifier || !verifyPkceS256(codeVerifier, payload.cc)) {
      return jsonResponse({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
    return issueTokens(payload.wk, form.get("scope"));
  }

  if (grantType === "refresh_token") {
    const payload = open<{ wk: string }>("wkmcp_rt", form.get("refresh_token") ?? "");
    if (!payload) {
      return jsonResponse({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, 400);
    }
    return issueTokens(payload.wk, form.get("scope"));
  }

  return jsonResponse(
    { error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token" },
    400,
  );
}

export { handler as POST, handler as OPTIONS };
