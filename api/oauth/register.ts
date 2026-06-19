import { corsPreflight, isAllowedRedirectUri, jsonResponse, seal } from "../../src/oauth.js";

// RFC 7591 — OAuth 2.0 Dynamic Client Registration.
// Public clients only: the returned client_id is a signed envelope of the
// registered redirect URIs, so no server-side storage is needed.
async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method !== "POST") {
    return jsonResponse({ error: "invalid_request", error_description: "Use POST" }, 405);
  }

  let body: { redirect_uris?: unknown };
  try {
    body = (await request.json()) as { redirect_uris?: unknown };
  } catch {
    return jsonResponse({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return jsonResponse(
      { error: "invalid_redirect_uri", error_description: "redirect_uris is required" },
      400,
    );
  }
  if (!redirectUris.every((uri): uri is string => typeof uri === "string" && isAllowedRedirectUri(uri))) {
    return jsonResponse(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https:// (or http://localhost) URLs",
      },
      400,
    );
  }

  const clientId = seal("wkmcp_cid", { ru: redirectUris });
  return jsonResponse(
    {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
}

export { handler as POST, handler as OPTIONS };
