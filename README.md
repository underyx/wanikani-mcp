# wanikani-mcp

An [MCP](https://modelcontextprotocol.io) server for the [WaniKani API](https://docs.api.wanikani.com/20170710/), so your AI tools can check your lessons and reviews, look up kanji and vocabulary, analyze your progress, and even submit reviews for you.

It runs in two ways:

- **Remote (streamable HTTP)** — deployed on Cloudflare Workers. Clients that can send headers (Claude Code, Cursor) pass your WaniKani token per-request in the `Authorization` header; clients that can't (claude.ai) log in through a built-in OAuth flow where you paste your token once. Either way the token is only ever forwarded to `api.wanikani.com`.
- **Local (stdio)** — run with `npx`, token comes from the `WANIKANI_API_TOKEN` environment variable.

You'll need a WaniKani personal access token from [wanikani.com/settings/personal_access_tokens](https://www.wanikani.com/settings/personal_access_tokens). A read-only token is enough for everything except `start_assignment`, `create_review`, study material edits, and preference updates.

## Connect

### Claude Code

```bash
claude mcp add --transport http wanikani https://wanikani-mcp.underyx.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_WANIKANI_TOKEN"
```

Or local over stdio:

```bash
claude mcp add wanikani --env WANIKANI_API_TOKEN=YOUR_WANIKANI_TOKEN \
  -- npx -y github:underyx/wanikani-mcp
```

### Cursor / other MCP clients

```json
{
  "mcpServers": {
    "wanikani": {
      "url": "https://wanikani-mcp.underyx.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_WANIKANI_TOKEN" }
    }
  }
}
```

### claude.ai custom connectors

Add a custom connector pointing at `https://wanikani-mcp.underyx.workers.dev/mcp` (Settings → Connectors → Add custom connector). claude.ai will open a **Connect** page served by this server; paste your WaniKani API token there once and you're done. The token is verified against WaniKani, then carried inside an encrypted OAuth access token — it is never stored on the server.

This works because the server implements a small OAuth 2.1 authorization server (dynamic client registration, PKCE, encrypted authorization codes and access/refresh tokens), so no static header is needed.

## Tools

| Tool | What it does |
| --- | --- |
| `get_user` | Profile, level, subscription, preferences |
| `get_summary` | Lessons and reviews available now and over the next 24h |
| `list_subjects` / `get_subject` | Radicals, kanji, vocabulary — filter by level, type, slug |
| `list_assignments` | Per-subject SRS progress; current lesson and review queues |
| `start_assignment` | Complete a lesson (move an item into the review queue) |
| `create_review` | Submit a review result, advancing/demoting its SRS stage |
| `list_review_statistics` | Accuracy stats per subject; find leeches |
| `list_level_progressions` | Level-up history and pace |
| `list_resets` | Account resets |
| `list_study_materials` / `create_study_material` / `update_study_material` | Your notes and custom synonyms |
| `update_user_preferences` | Lesson batch size, audio autoplay, review order |
| `list_spaced_repetition_systems` | SRS stage definitions and intervals |
| `list_voice_actors` | Pronunciation audio voice actors |

List tools return a trimmed page (`returned_count` of `total_count`) plus a `next_page_after_id` cursor, so large collections don't flood the model's context. `list_subjects` returns a compact form by default; pass `detail: "full"` for mnemonics, context sentences, and audio.

## Deploy your own

Runs on Cloudflare Workers. There is no database or KV namespace to provision — every piece of OAuth state (client registrations, authorization codes, access and refresh tokens) is carried inside encrypted, self-validating tokens, so the server stores nothing between requests.

```bash
npm install
npx wrangler login
npx wrangler secret put OAUTH_SIGNING_SECRET   # a long random string
npx wrangler deploy
```

`OAUTH_SIGNING_SECRET` (e.g. `openssl rand -hex 32`) is the key those tokens are encrypted with. Keep it stable — rotating it invalidates everyone's existing claude.ai login. Optionally set `WANIKANI_API_TOKEN` for a single-user deployment that works without any auth at all (anyone who reaches the URL then acts as that token).

The included GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys on every push to `main`. It needs two repository secrets:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token using the *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami`, or the Cloudflare dashboard URL |

## Development

```bash
npm install
npm test          # vitest, no network needed
npm run typecheck
npx wrangler dev  # serve the HTTP endpoint locally at http://localhost:8787/mcp
```

`wrangler dev` reads `OAUTH_SIGNING_SECRET` from a local `.dev.vars` file.

The server is plain TypeScript on the official MCP SDK: `src/server.ts` defines the tools, `src/wanikani.ts` is a minimal WaniKani API client, `api/mcp.ts` serves stateless streamable HTTP, `src/stdio.ts` is the stdio entry point, and `api/oauth/*` plus `src/oauth.ts` implement the stateless OAuth login used by claude.ai. Those handlers are all plain `Request` -> `Response` functions; `worker/index.ts` is only the routing table that maps paths onto them.

## License

[MIT](LICENSE)
