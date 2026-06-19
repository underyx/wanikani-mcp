import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless OAuth helpers. All OAuth state (client registrations, authorization
 * codes, access/refresh tokens) is carried inside self-contained, encrypted,
 * authenticated tokens so the serverless functions need no shared storage.
 */

export const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 180; // 180 days
export const CODE_TTL = 600; // 10 minutes

export type TokenType = "wkmcp_cid" | "wkmcp_code" | "wkmcp_at" | "wkmcp_rt";

function key(): Buffer {
  const secret = process.env.OAUTH_SIGNING_SECRET;
  if (!secret) throw new Error("OAUTH_SIGNING_SECRET is not set");
  return createHash("sha256").update(secret).digest();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Encrypt a payload into a `${type}_<base64url>` token, optionally with an expiry. */
export function seal(type: TokenType, payload: Record<string, unknown>, ttlSeconds?: number): string {
  const body = ttlSeconds ? { ...payload, exp: nowSeconds() + ttlSeconds } : { ...payload };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(body), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${type}_${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

/** Decrypt and validate a token of the expected type. Returns null on any failure or expiry. */
export function open<T = Record<string, unknown>>(type: TokenType, token: string): T | null {
  const prefix = `${type}_`;
  if (!token.startsWith(prefix)) return null;
  try {
    const raw = Buffer.from(token.slice(prefix.length), "base64url");
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const body = JSON.parse(plaintext.toString("utf8")) as { exp?: number } & T;
    if (typeof body.exp === "number" && body.exp < nowSeconds()) return null;
    return body;
  } catch {
    return null;
  }
}

/** Verify an RFC 7636 PKCE S256 challenge against a code verifier. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const expected = createHash("sha256").update(codeVerifier).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(codeChallenge, "base64url");
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Public origin of the deployment, honoring Vercel's forwarding headers. */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? (url.protocol === "http:" ? "http" : "https");
  return `${proto}://${host}`;
}

export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    return true;
  }
  return false;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
