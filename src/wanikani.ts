const BASE_URL = "https://api.wanikani.com/v2";
const API_REVISION = "20170710";

export class WaniKaniError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WaniKaniError";
  }
}

export type QueryValue = string | number | boolean | Array<string | number> | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface WaniKaniClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal WaniKani API v2 client. Builds requests against a fixed set of
 * paths, forwards the caller's personal access token, and surfaces API
 * errors (including rate limits) as WaniKaniError.
 */
export class WaniKaniClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WaniKaniClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  /**
   * Follow an absolute pagination URL previously returned by the API
   * (pages.next_url). Only WaniKani API URLs are accepted.
   */
  async getUrl<T = unknown>(url: string): Promise<T> {
    if (!url.startsWith(`${BASE_URL}/`)) {
      throw new WaniKaniError(400, `Refusing to fetch non-WaniKani URL: ${url}`);
    }
    return this.request<T>("GET", url.slice(BASE_URL.length), {});
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      const serialized = Array.isArray(value) ? value.join(",") : String(value);
      url.searchParams.set(key, serialized);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Wanikani-Revision": API_REVISION,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 429) {
      const reset = response.headers.get("Ratelimit-Reset");
      const resetHint = reset
        ? ` Limit resets at ${new Date(Number(reset) * 1000).toISOString()}.`
        : "";
      throw new WaniKaniError(
        429,
        `WaniKani rate limit exceeded (60 requests/minute).${resetHint}`,
      );
    }

    if (!response.ok) {
      let message = `WaniKani API error (HTTP ${response.status})`;
      try {
        const data = (await response.json()) as { error?: string; code?: number };
        if (data.error) message = `${message}: ${data.error}`;
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      throw new WaniKaniError(response.status, message);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}
