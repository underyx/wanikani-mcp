# wanikani-mcp

An [MCP](https://modelcontextprotocol.io) server for the [WaniKani API](https://docs.api.wanikani.com/20170710/), so your AI tools can check your lessons and reviews, look up kanji and vocabulary, analyze your progress, and even submit reviews for you.

It runs in two ways:

- **Remote (streamable HTTP)** — deployed on Vercel; your WaniKani token is sent per-request via the `Authorization` header and only ever forwarded to `api.wanikani.com`.
- **Local (stdio)** — run with `npx`, token comes from the `WANIKANI_API_TOKEN` environment variable.

You'll need a WaniKani personal access token from [wanikani.com/settings/personal_access_tokens](https://www.wanikani.com/settings/personal_access_tokens). A read-only token is enough for everything except `start_assignment`, `create_review`, study material edits, and preference updates.

## Connect

### Claude Code

```bash
claude mcp add --transport http wanikani https://wanikani-mcp.vercel.app/mcp \
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
      "url": "https://wanikani-mcp.vercel.app/mcp",
      "headers": { "Authorization": "Bearer YOUR_WANIKANI_TOKEN" }
    }
  }
}
```

### claude.ai custom connectors

claude.ai connectors can't send a static `Authorization` header. If you want to use this from claude.ai, deploy your own copy (below) and set the `WANIKANI_API_TOKEN` environment variable on the deployment instead — but note that this makes the deployment usable by anyone who discovers its URL, since there is no other authentication in front of it.

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

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Funderyx%2Fwanikani-mcp)

Or fork this repo and use the included GitHub Actions workflow (`.github/workflows/deploy.yml`), which deploys to Vercel on every push to `main`. It needs three repository secrets:

| Secret | Where it comes from |
| --- | --- |
| `VERCEL_TOKEN` | [vercel.com/account/tokens](https://vercel.com/account/tokens) |
| `VERCEL_ORG_ID` | `.vercel/project.json` after running `vercel link` locally |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` after running `vercel link` locally |

No environment variables are required on the deployment itself; set `WANIKANI_API_TOKEN` only if you want a single-user deployment that works without per-request auth headers.

## Development

```bash
npm install
npm test          # vitest, no network needed
npm run typecheck
npx vercel dev    # serve the HTTP endpoint locally at http://localhost:3000/mcp
```

The server is plain TypeScript on the official MCP SDK: `src/server.ts` defines the tools, `src/wanikani.ts` is a minimal WaniKani API client, `api/mcp.ts` is the Vercel function (stateless streamable HTTP), and `src/stdio.ts` is the stdio entry point.

## License

[MIT](LICENSE)
