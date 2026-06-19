import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type CreateServerOptions } from "../src/server.js";

interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses[Math.min(requests.length - 1, responses.length - 1)] ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function connect(options: CreateServerOptions) {
  const server = createServer(options);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function resultText(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

const userResource = {
  object: "user",
  url: "https://api.wanikani.com/v2/user",
  data_updated_at: "2026-06-01T00:00:00.000000Z",
  data: {
    username: "crabigator",
    level: 12,
    profile_url: "https://www.wanikani.com/users/crabigator",
    started_at: "2024-01-01T00:00:00.000000Z",
    subscription: { active: true, type: "lifetime", max_level_granted: 60, period_ends_at: null },
  },
};

const subjectsCollection = {
  object: "collection",
  url: "https://api.wanikani.com/v2/subjects?levels=5",
  pages: { per_page: 1000, next_url: null, previous_url: null },
  total_count: 2,
  data_updated_at: "2026-06-01T00:00:00.000000Z",
  data: [
    {
      id: 440,
      object: "kanji",
      url: "https://api.wanikani.com/v2/subjects/440",
      data_updated_at: "2026-06-01T00:00:00.000000Z",
      data: {
        level: 5,
        slug: "本",
        characters: "本",
        meanings: [{ meaning: "Book", primary: true, accepted_answer: true }],
        readings: [
          { reading: "ほん", primary: true, accepted_answer: true, type: "onyomi" },
          { reading: "もと", primary: false, accepted_answer: false, type: "kunyomi" },
        ],
        component_subject_ids: [19],
        document_url: "https://www.wanikani.com/kanji/本",
        meaning_mnemonic: "A very long mnemonic that brief mode should drop.",
      },
    },
    {
      id: 2467,
      object: "vocabulary",
      url: "https://api.wanikani.com/v2/subjects/2467",
      data_updated_at: "2026-06-01T00:00:00.000000Z",
      data: {
        level: 5,
        slug: "本",
        characters: "本",
        meanings: [{ meaning: "Book", primary: true, accepted_answer: true }],
        readings: [{ reading: "ほん", primary: true, accepted_answer: true }],
        parts_of_speech: ["noun"],
        document_url: "https://www.wanikani.com/vocabulary/本",
        meaning_mnemonic: "Another long mnemonic.",
      },
    },
  ],
};

describe("tool registration", () => {
  it("lists every tool with a real input schema", async () => {
    const { fetchImpl } = mockFetch([{ body: {} }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "create_review",
      "create_study_material",
      "get_subject",
      "get_summary",
      "get_user",
      "list_assignments",
      "list_level_progressions",
      "list_resets",
      "list_review_statistics",
      "list_spaced_repetition_systems",
      "list_study_materials",
      "list_subjects",
      "list_voice_actors",
      "start_assignment",
      "update_study_material",
      "update_user_preferences",
    ]);

    // Guards against schema-conversion regressions producing empty {} schemas.
    const listSubjects = tools.find((tool) => tool.name === "list_subjects");
    expect(listSubjects?.inputSchema.type).toBe("object");
    expect(Object.keys(listSubjects?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["levels", "types", "limit", "detail"]),
    );
    const createReview = tools.find((tool) => tool.name === "create_review");
    expect(Object.keys(createReview?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["assignment_id", "subject_id", "incorrect_meaning_answers"]),
    );
  });
});

describe("authentication", () => {
  it("sends the bearer token and API revision header", async () => {
    const { fetchImpl, requests } = mockFetch([{ body: userResource }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({ name: "get_user", arguments: {} })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(resultText(result)).username).toBe("crabigator");
    expect(requests[0]?.url.toString()).toBe("https://api.wanikani.com/v2/user");
    expect(requests[0]?.headers.authorization).toBe("Bearer test-token");
    expect(requests[0]?.headers["wanikani-revision"]).toBe("20170710");
  });

  it("returns a helpful error when no token is available", async () => {
    const { fetchImpl, requests } = mockFetch([{ body: userResource }]);
    const client = await connect({ fetchImpl });
    const result = (await client.callTool({ name: "get_user", arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("personal_access_tokens");
    expect(requests).toHaveLength(0);
  });
});

describe("list_subjects", () => {
  it("builds comma-separated query filters and returns brief subjects with pagination info", async () => {
    const { fetchImpl, requests } = mockFetch([{ body: subjectsCollection }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({
      name: "list_subjects",
      arguments: { levels: [5], types: ["kanji", "vocabulary"], limit: 1 },
    })) as CallToolResult;

    const url = requests[0]?.url;
    expect(url?.pathname).toBe("/v2/subjects");
    expect(url?.searchParams.get("levels")).toBe("5");
    expect(url?.searchParams.get("types")).toBe("kanji,vocabulary");
    expect(url?.searchParams.has("limit")).toBe(false);

    const parsed = JSON.parse(resultText(result));
    expect(parsed.total_count).toBe(2);
    expect(parsed.returned_count).toBe(1);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_after_id).toBe(440);
    expect(parsed.data[0]).toMatchObject({
      id: 440,
      type: "kanji",
      characters: "本",
      meanings: ["Book"],
      readings: ["ほん (onyomi)", "もと (kunyomi)"],
    });
    expect(parsed.data[0].meaning_mnemonic).toBeUndefined();
  });

  it("returns full subject data when detail=full", async () => {
    const { fetchImpl } = mockFetch([{ body: subjectsCollection }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({
      name: "list_subjects",
      arguments: { detail: "full" },
    })) as CallToolResult;
    const parsed = JSON.parse(resultText(result));
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_after_id).toBeNull();
    expect(parsed.data[0].meaning_mnemonic).toContain("mnemonic");
  });
});

describe("get_summary", () => {
  it("counts only the lessons and reviews that are available right now", async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const summary = {
      object: "report",
      url: "https://api.wanikani.com/v2/summary",
      data_updated_at: past,
      data: {
        lessons: [
          { available_at: past, subject_ids: [1, 2, 3] },
          { available_at: future, subject_ids: [4] },
        ],
        next_reviews_at: past,
        reviews: [
          { available_at: past, subject_ids: [10, 11] },
          { available_at: future, subject_ids: [12, 13, 14] },
        ],
      },
    };
    const { fetchImpl } = mockFetch([{ body: summary }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({ name: "get_summary", arguments: {} })) as CallToolResult;
    const parsed = JSON.parse(resultText(result));
    expect(parsed.available_lesson_count).toBe(3);
    expect(parsed.available_review_count).toBe(2);
    expect(parsed.lessons).toHaveLength(2);
    expect(parsed.next_reviews_at).toBe(past);
  });
});

describe("list_assignments", () => {
  it("only sends presence-only filters when true", async () => {
    const collection = { ...subjectsCollection, data: [], total_count: 0 };
    const { fetchImpl, requests } = mockFetch([{ body: collection }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    await client.callTool({
      name: "list_assignments",
      arguments: { srs_stages: [1, 2], burned: false, immediately_available_for_review: false },
    });
    const url = requests[0]?.url;
    expect(url?.pathname).toBe("/v2/assignments");
    expect(url?.searchParams.get("srs_stages")).toBe("1,2");
    expect(url?.searchParams.get("burned")).toBe("false");
    expect(url?.searchParams.has("immediately_available_for_review")).toBe(false);
  });
});

describe("create_review", () => {
  it("rejects calls with both or neither of assignment_id and subject_id", async () => {
    const { fetchImpl, requests } = mockFetch([{ body: {} }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });

    const both = (await client.callTool({
      name: "create_review",
      arguments: { assignment_id: 1, subject_id: 2, incorrect_meaning_answers: 0, incorrect_reading_answers: 0 },
    })) as CallToolResult;
    expect(both.isError).toBe(true);

    const neither = (await client.callTool({
      name: "create_review",
      arguments: { incorrect_meaning_answers: 0, incorrect_reading_answers: 0 },
    })) as CallToolResult;
    expect(neither.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("posts the wrapped review body", async () => {
    const reviewResponse = {
      id: 0,
      object: "review",
      url: "https://api.wanikani.com/v2/reviews/0",
      data_updated_at: "2026-06-01T00:00:00.000000Z",
      data: { assignment_id: 1422, starting_srs_stage: 4, ending_srs_stage: 5 },
      resources_updated: { assignment: { id: 1422 }, review_statistic: { id: 342 } },
    };
    const { fetchImpl, requests } = mockFetch([{ body: reviewResponse }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({
      name: "create_review",
      arguments: { assignment_id: 1422, incorrect_meaning_answers: 0, incorrect_reading_answers: 1 },
    })) as CallToolResult;

    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.pathname).toBe("/v2/reviews");
    expect(requests[0]?.body).toEqual({
      review: { assignment_id: 1422, incorrect_meaning_answers: 0, incorrect_reading_answers: 1 },
    });
    const parsed = JSON.parse(resultText(result));
    expect(parsed.review.ending_srs_stage).toBe(5);
    expect(parsed.resources_updated.assignment.id).toBe(1422);
  });
});

describe("start_assignment", () => {
  it("puts the wrapped assignment body to the start endpoint", async () => {
    const assignment = {
      id: 80463006,
      object: "assignment",
      url: "https://api.wanikani.com/v2/assignments/80463006",
      data_updated_at: "2026-06-01T00:00:00.000000Z",
      data: { subject_id: 8761, srs_stage: 1, started_at: "2026-06-01T00:00:00.000000Z" },
    };
    const { fetchImpl, requests } = mockFetch([{ body: assignment }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({
      name: "start_assignment",
      arguments: { assignment_id: 80463006 },
    })) as CallToolResult;

    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url.pathname).toBe("/v2/assignments/80463006/start");
    expect(requests[0]?.body).toEqual({ assignment: {} });
    expect(JSON.parse(resultText(result)).srs_stage).toBe(1);
  });
});

describe("error handling", () => {
  it("surfaces WaniKani API errors as tool errors", async () => {
    const { fetchImpl } = mockFetch([{ status: 401, body: { error: "Unauthorized. Nice try.", code: 401 } }]);
    const client = await connect({ fallbackToken: "bad-token", fetchImpl });
    const result = (await client.callTool({ name: "get_user", arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Unauthorized. Nice try.");
  });

  it("explains rate limiting on 429", async () => {
    const { fetchImpl } = mockFetch([{ status: 429, body: { error: "Rate Limit Exceeded", code: 429 } }]);
    const client = await connect({ fallbackToken: "test-token", fetchImpl });
    const result = (await client.callTool({ name: "get_summary", arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("rate limit");
  });
});
