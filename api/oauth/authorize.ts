import { CODE_TTL, escapeHtml, open, publicOrigin, seal } from "../../src/oauth.js";
import { WaniKaniClient, WaniKaniError } from "../../src/wanikani.js";

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
}

function readParams(source: URLSearchParams): AuthorizeParams {
  return {
    client_id: source.get("client_id") ?? "",
    redirect_uri: source.get("redirect_uri") ?? "",
    response_type: source.get("response_type") ?? "",
    code_challenge: source.get("code_challenge") ?? "",
    code_challenge_method: source.get("code_challenge_method") ?? "",
    state: source.get("state") ?? "",
    scope: source.get("scope") ?? "",
  };
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function errorPage(message: string, status = 400): Response {
  return htmlResponse(
    page(`<h1>Can't connect</h1><p class="error">${escapeHtml(message)}</p>`),
    status,
  );
}

/** Validate the request and the registered redirect URI. Returns an error message or null. */
function validate(params: AuthorizeParams): string | null {
  const client = open<{ ru: string[] }>("wkmcp_cid", params.client_id);
  if (!client) return "Unknown or invalid client_id. Re-add the connector and try again.";
  if (!params.redirect_uri || !client.ru.includes(params.redirect_uri)) {
    return "redirect_uri does not match this client's registration.";
  }
  if (params.response_type !== "code") return "Only response_type=code is supported.";
  if (params.code_challenge_method !== "S256") return "Only PKCE code_challenge_method=S256 is supported.";
  if (!params.code_challenge) return "A PKCE code_challenge is required.";
  return null;
}

function page(inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect WaniKani</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 28rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  label { display: block; font-weight: 600; margin: 1.25rem 0 .4rem; }
  input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; box-sizing: border-box;
         border: 1px solid #8884; border-radius: .5rem; background: #fff1; }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem; font-size: 1rem; font-weight: 600;
         border: 0; border-radius: .5rem; background: #ec5d8b; color: #fff; cursor: pointer; }
  button:hover { background: #e23b73; }
  .hint { font-size: .9rem; color: #8a8a8a; }
  .error { color: #d23; font-weight: 600; }
  a { color: #ec5d8b; }
  code { background: #8881; padding: .1rem .3rem; border-radius: .3rem; }
</style>
</head>
<body>
${inner}
</body>
</html>`;
}

function formPage(params: AuthorizeParams, origin: string, errorMessage?: string): Response {
  const hidden = (
    [
      ["client_id", params.client_id],
      ["redirect_uri", params.redirect_uri],
      ["response_type", params.response_type],
      ["code_challenge", params.code_challenge],
      ["code_challenge_method", params.code_challenge_method],
      ["state", params.state],
      ["scope", params.scope],
    ] as const
  )
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("\n");

  return htmlResponse(
    page(`
<h1>Connect your WaniKani account</h1>
<p class="hint">Paste a WaniKani personal access token to let this app read your progress and (if the token allows) submit reviews. The token is sent only to WaniKani and is never stored on this server.</p>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
<form method="post" action="${origin}/authorize">
${hidden}
<label for="token">WaniKani API token</label>
<input type="password" id="token" name="wanikani_token" autocomplete="off" spellcheck="false" required
       placeholder="00000000-0000-0000-0000-000000000000">
<p class="hint">Create one at <a href="https://www.wanikani.com/settings/personal_access_tokens" target="_blank" rel="noopener">wanikani.com/settings/personal_access_tokens</a>. A read-only token is enough unless you want to start lessons or submit reviews.</p>
<button type="submit">Connect</button>
</form>`),
  );
}

async function handleGet(request: Request): Promise<Response> {
  const params = readParams(new URL(request.url).searchParams);
  const problem = validate(params);
  if (problem) return errorPage(problem);
  return formPage(params, publicOrigin(request));
}

async function handlePost(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const params = readParams(form);
  const token = (form.get("wanikani_token") ?? "").trim();

  const problem = validate(params);
  if (problem) return errorPage(problem);

  if (!token) {
    return formPage(params, publicOrigin(request), "Please enter your WaniKani API token.");
  }

  // Verify the token works before issuing a code, so a bad token fails here
  // rather than on every later tool call.
  try {
    await new WaniKaniClient({ token }).get("/user");
  } catch (error) {
    const message =
      error instanceof WaniKaniError && error.status === 401
        ? "That WaniKani token was rejected. Double-check it and try again."
        : "Couldn't verify the token with WaniKani. Please try again.";
    return formPage(params, publicOrigin(request), message);
  }

  const code = seal(
    "wkmcp_code",
    { wk: token, cc: params.code_challenge, ru: params.redirect_uri, cid: params.client_id },
    CODE_TTL,
  );

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return new Response(null, { status: 302, headers: { Location: redirect.toString(), "Cache-Control": "no-store" } });
}

async function handler(request: Request): Promise<Response> {
  if (request.method === "POST") return handlePost(request);
  if (request.method === "GET") return handleGet(request);
  return errorPage("Method not allowed.", 405);
}

export { handler as GET, handler as POST };
