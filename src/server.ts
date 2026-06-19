import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WaniKaniClient, WaniKaniError, type QueryValue } from "./wanikani.js";

export const SERVER_NAME = "wanikani-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Tools for the WaniKani Japanese-learning service (wanikani.com).

Key concepts:
- Subjects are the things being learned: radicals, kanji, vocabulary, and kana_vocabulary, organized into levels 1-60.
- Assignments track a user's progress on a subject through SRS stages. On the default SRS, stage 0 = in the lesson queue, 1-4 = Apprentice, 5-6 = Guru, 7 = Master, 8 = Enlightened, 9 = Burned (complete). "Passing" a subject means reaching stage 5 the first time.
- The summary shows which lessons and reviews are available right now and over the next 24 hours.
- Reviews are submitted (not read back): WaniKani no longer stores individual review history, so use review statistics and assignments to inspect past performance.

Every tool needs a WaniKani personal access token (https://www.wanikani.com/settings/personal_access_tokens). The WaniKani API is rate limited to 60 requests/minute.`;

export interface CreateServerOptions {
  /** Token used when the request doesn't carry its own token (e.g. stdio mode or env-configured deployments). */
  fallbackToken?: string;
  /** Override fetch, used in tests. */
  fetchImpl?: typeof fetch;
}

interface ToolExtra {
  authInfo?: { token?: string };
}

interface WkResource {
  id?: number;
  object: string;
  url?: string;
  data_updated_at?: string | null;
  data: Record<string, unknown>;
}

interface WkCollection {
  object: string;
  url?: string;
  total_count: number;
  data_updated_at?: string | null;
  pages: { per_page: number; next_url: string | null; previous_url: string | null };
  data: WkResource[];
}

const SUBJECT_TYPES = ["radical", "kanji", "vocabulary", "kana_vocabulary"] as const;

const NO_TOKEN_MESSAGE =
  "No WaniKani API token available. Provide one as an `Authorization: Bearer <token>` header on the MCP connection (remote) or set the WANIKANI_API_TOKEN environment variable (stdio / self-hosted). Tokens can be created at https://www.wanikani.com/settings/personal_access_tokens";

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function flattenResource(resource: WkResource): Record<string, unknown> {
  return { id: resource.id, type: resource.object, ...resource.data };
}

interface ShapedCollection {
  total_count: number;
  returned_count: number;
  has_more: boolean;
  next_page_after_id: number | null;
  data: unknown[];
}

/**
 * Trim a WaniKani collection page to `limit` items and add pagination hints,
 * so large collections don't flood the model's context.
 */
function shapeCollection(
  collection: WkCollection,
  limit: number,
  mapItem: (resource: WkResource) => unknown = flattenResource,
): ShapedCollection {
  const items = collection.data.slice(0, limit);
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  const hasMore = collection.data.length > items.length || collection.pages.next_url !== null;
  return {
    total_count: collection.total_count,
    returned_count: items.length,
    has_more: hasMore,
    next_page_after_id: hasMore && last?.id !== undefined ? last.id : null,
    data: items.map(mapItem),
  };
}

interface SubjectData {
  level?: number;
  slug?: string;
  characters?: string | null;
  meanings?: Array<{ meaning: string; primary: boolean; accepted_answer: boolean }>;
  readings?: Array<{ reading: string; primary: boolean; accepted_answer: boolean; type?: string }>;
  parts_of_speech?: string[];
  component_subject_ids?: number[];
  document_url?: string;
  hidden_at?: string | null;
}

function briefSubject(resource: WkResource): Record<string, unknown> {
  const data = resource.data as SubjectData;
  return {
    id: resource.id,
    type: resource.object,
    level: data.level,
    slug: data.slug,
    characters: data.characters,
    meanings: data.meanings?.map((m) => m.meaning),
    readings: data.readings?.map((r) => (r.type ? `${r.reading} (${r.type})` : r.reading)),
    parts_of_speech: data.parts_of_speech,
    component_subject_ids: data.component_subject_ids,
    document_url: data.document_url,
    ...(data.hidden_at ? { hidden_at: data.hidden_at } : {}),
  };
}

// Shared schema fragments
const idsParam = z.array(z.number().int()).optional().describe("Only return records with these IDs.");
const updatedAfterParam = z
  .string()
  .optional()
  .describe("Only return records updated after this ISO 8601 timestamp, e.g. 2026-01-01T00:00:00Z.");
const subjectTypesParam = z
  .array(z.enum(SUBJECT_TYPES))
  .optional()
  .describe("Filter by subject type.");
const subjectIdsParam = z.array(z.number().int()).optional().describe("Only return records for these subject IDs.");
const hiddenParam = z
  .boolean()
  .optional()
  .describe("Filter by whether the associated subject is hidden from lessons and reviews.");

const limitParam = (defaultLimit: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(
      `Maximum number of records to return (default ${defaultLimit}, max ${max}). When more records exist, the result includes next_page_after_id; pass it as page_after_id to fetch the next batch.`,
    );
const pageAfterIdParam = z
  .number()
  .int()
  .optional()
  .describe("Pagination cursor: only return records with IDs after this ID (use next_page_after_id from a previous result).");

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  type Handler<Args> = (client: WaniKaniClient, args: Args) => Promise<CallToolResult>;

  const run =
    <Args>(handler: Handler<Args>) =>
    async (args: Args, extra: ToolExtra): Promise<CallToolResult> => {
      const token = extra?.authInfo?.token || options.fallbackToken;
      if (!token) return errorResult(NO_TOKEN_MESSAGE);
      try {
        const client = new WaniKaniClient({ token, fetchImpl: options.fetchImpl });
        return await handler(client, args);
      } catch (error) {
        if (error instanceof WaniKaniError) return errorResult(error.message);
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`Unexpected error talking to the WaniKani API: ${message}`);
      }
    };

  // --- User ---

  server.registerTool(
    "get_user",
    {
      title: "Get user",
      description:
        "Get the WaniKani user's profile: username, current level, signup date, vacation status, subscription (free accounts only get content up to level 3), and app preferences.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    run(async (client) => {
      const user = await client.get<WkResource>("/user");
      return textResult(user.data);
    }),
  );

  server.registerTool(
    "update_user_preferences",
    {
      title: "Update user preferences",
      description:
        "Update the user's WaniKani app preferences (lesson batch size, audio autoplay, review ordering). Only preferences can be changed via the API.",
      inputSchema: {
        lessons_batch_size: z
          .number()
          .int()
          .min(3)
          .max(10)
          .optional()
          .describe("Number of subjects introduced per lesson batch before quizzing."),
        lessons_autoplay_audio: z.boolean().optional().describe("Autoplay vocabulary audio during lessons."),
        reviews_autoplay_audio: z.boolean().optional().describe("Autoplay vocabulary audio during reviews."),
        extra_study_autoplay_audio: z.boolean().optional().describe("Autoplay vocabulary audio during extra study."),
        reviews_display_srs_indicator: z
          .boolean()
          .optional()
          .describe("Show the SRS stage change indicator after answering during reviews."),
        reviews_presentation_order: z
          .enum(["shuffled", "lower_levels_first"])
          .optional()
          .describe("Order in which reviews are presented."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run(async (client, args: Record<string, unknown>) => {
      const preferences = Object.fromEntries(
        Object.entries(args).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(preferences).length === 0) {
        return errorResult("Provide at least one preference to update.");
      }
      const user = await client.put<WkResource>("/user", { user: { preferences } });
      return textResult(user.data);
    }),
  );

  // --- Summary ---

  server.registerTool(
    "get_summary",
    {
      title: "Get summary",
      description:
        "Get the lessons and reviews currently available, plus the reviews coming up over the next 24 hours grouped by hour. Best first call for 'what should I study right now?'.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    run(async (client) => {
      const summary = await client.get<WkResource>("/summary");
      const data = summary.data as {
        lessons?: Array<{ available_at: string; subject_ids: number[] }>;
        reviews?: Array<{ available_at: string; subject_ids: number[] }>;
        next_reviews_at?: string | null;
      };
      const now = Date.now();
      const availableLessons = (data.lessons ?? [])
        .filter((bucket) => Date.parse(bucket.available_at) <= now)
        .reduce((sum, bucket) => sum + bucket.subject_ids.length, 0);
      const availableReviews = (data.reviews ?? [])
        .filter((bucket) => Date.parse(bucket.available_at) <= now)
        .reduce((sum, bucket) => sum + bucket.subject_ids.length, 0);
      return textResult({
        available_lesson_count: availableLessons,
        available_review_count: availableReviews,
        ...data,
      });
    }),
  );

  // --- Subjects ---

  server.registerTool(
    "list_subjects",
    {
      title: "List subjects",
      description:
        "List WaniKani subjects (radicals, kanji, vocabulary, kana vocabulary), optionally filtered by level, type, slug, or ID. Returns a compact form by default; use detail='full' for mnemonics, hints, context sentences, and audio metadata.",
      inputSchema: {
        ids: idsParam,
        types: subjectTypesParam,
        slugs: z.array(z.string()).optional().describe('Filter by subject slug, e.g. ["大丈夫"].'),
        levels: z
          .array(z.number().int().min(1).max(60))
          .optional()
          .describe("Filter by WaniKani level (1-60)."),
        hidden: z.boolean().optional().describe("Filter by whether the subject is hidden."),
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(50, 1000),
        detail: z
          .enum(["brief", "full"])
          .optional()
          .describe("brief (default): id, characters, meanings, readings, level. full: every field including mnemonics and audio."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: {
      ids?: number[];
      types?: string[];
      slugs?: string[];
      levels?: number[];
      hidden?: boolean;
      updated_after?: string;
      page_after_id?: number;
      limit?: number;
      detail?: "brief" | "full";
    }) => {
      const query: Record<string, QueryValue> = {
        ids: args.ids,
        types: args.types,
        slugs: args.slugs,
        levels: args.levels,
        hidden: args.hidden,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      };
      const collection = await client.get<WkCollection>("/subjects", query);
      const mapItem = args.detail === "full" ? flattenResource : briefSubject;
      return textResult(shapeCollection(collection, args.limit ?? 50, mapItem));
    }),
  );

  server.registerTool(
    "get_subject",
    {
      title: "Get subject",
      description:
        "Get a single subject by ID with every detail: meanings, readings, mnemonics, hints, component/amalgamation subjects, context sentences, and audio.",
      inputSchema: {
        subject_id: z.number().int().describe("The subject's unique ID."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: { subject_id: number }) => {
      const subject = await client.get<WkResource>(`/subjects/${args.subject_id}`);
      return textResult(flattenResource(subject));
    }),
  );

  // --- Assignments ---

  server.registerTool(
    "list_assignments",
    {
      title: "List assignments",
      description:
        "List the user's assignments (per-subject SRS progress). Filter by level, SRS stage, subject type, availability, or lifecycle (unlocked/started/passed/burned). Use immediately_available_for_review=true to get the current review queue, or immediately_available_for_lessons=true for the lesson queue.",
      inputSchema: {
        ids: idsParam,
        subject_ids: subjectIdsParam,
        subject_types: subjectTypesParam,
        levels: z.array(z.number().int().min(1).max(60)).optional().describe("Filter by subject level (1-60)."),
        srs_stages: z
          .array(z.number().int().min(0).max(9))
          .optional()
          .describe("Filter by SRS stage (0 = lesson queue, 1-4 Apprentice, 5-6 Guru, 7 Master, 8 Enlightened, 9 Burned)."),
        immediately_available_for_lessons: z
          .boolean()
          .optional()
          .describe("Set true to return only assignments that are in the lesson queue right now."),
        immediately_available_for_review: z
          .boolean()
          .optional()
          .describe("Set true to return only assignments that are due for review right now."),
        in_review: z.boolean().optional().describe("Set true to return only assignments currently in the review state."),
        available_after: z.string().optional().describe("Only assignments whose next review is at or after this ISO 8601 time."),
        available_before: z.string().optional().describe("Only assignments whose next review is at or before this ISO 8601 time."),
        burned: z.boolean().optional().describe("Filter by whether the assignment has been burned."),
        started: z.boolean().optional().describe("Filter by whether the assignment has been started."),
        unlocked: z.boolean().optional().describe("Filter by whether the assignment has been unlocked."),
        hidden: hiddenParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: {
      ids?: number[];
      subject_ids?: number[];
      subject_types?: string[];
      levels?: number[];
      srs_stages?: number[];
      immediately_available_for_lessons?: boolean;
      immediately_available_for_review?: boolean;
      in_review?: boolean;
      available_after?: string;
      available_before?: string;
      burned?: boolean;
      started?: boolean;
      unlocked?: boolean;
      hidden?: boolean;
      updated_after?: string;
      page_after_id?: number;
      limit?: number;
    }) => {
      const query: Record<string, QueryValue> = {
        ids: args.ids,
        subject_ids: args.subject_ids,
        subject_types: args.subject_types,
        levels: args.levels,
        srs_stages: args.srs_stages,
        available_after: args.available_after,
        available_before: args.available_before,
        burned: args.burned,
        started: args.started,
        unlocked: args.unlocked,
        hidden: args.hidden,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      };
      // These three are presence-only filters upstream: only include them when true.
      if (args.immediately_available_for_lessons) query.immediately_available_for_lessons = true;
      if (args.immediately_available_for_review) query.immediately_available_for_review = true;
      if (args.in_review) query.in_review = true;
      const collection = await client.get<WkCollection>("/assignments", query);
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  server.registerTool(
    "start_assignment",
    {
      title: "Start assignment",
      description:
        "Mark an assignment as started, moving it from the lesson queue into the review queue (this is what completing a lesson does). The assignment must be unlocked, not yet started, and at SRS stage 0.",
      inputSchema: {
        assignment_id: z.number().int().describe("The assignment's unique ID (not the subject ID)."),
        started_at: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp for when the lesson was completed. Defaults to now; must not be before the assignment was unlocked."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    run(async (client, args: { assignment_id: number; started_at?: string }) => {
      const body = { assignment: args.started_at ? { started_at: args.started_at } : {} };
      const assignment = await client.put<WkResource>(`/assignments/${args.assignment_id}/start`, body);
      return textResult(flattenResource(assignment));
    }),
  );

  // --- Reviews ---

  server.registerTool(
    "create_review",
    {
      title: "Submit review",
      description:
        "Submit a completed review for a subject that is currently due, recording how many times the meaning and reading were answered incorrectly (0 each for a fully correct review). This advances or demotes the assignment's SRS stage. Identify the item by assignment_id or subject_id (exactly one). Radicals and kana vocabulary have no reading quiz, so use 0 incorrect reading answers for them. Note: this is for reviews only, not lesson quizzes (use start_assignment for lessons).",
      inputSchema: {
        assignment_id: z.number().int().optional().describe("The assignment ID being reviewed. Provide this or subject_id."),
        subject_id: z.number().int().optional().describe("The subject ID being reviewed. Provide this or assignment_id."),
        incorrect_meaning_answers: z
          .number()
          .int()
          .min(0)
          .describe("How many times the meaning was answered incorrectly (0 if correct on the first try)."),
        incorrect_reading_answers: z
          .number()
          .int()
          .min(0)
          .describe("How many times the reading was answered incorrectly. Must be 0 for radicals and kana vocabulary."),
        created_at: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp for when the review was completed. Defaults to now; must be in the past and after the assignment became available."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    run(async (client, args: {
      assignment_id?: number;
      subject_id?: number;
      incorrect_meaning_answers: number;
      incorrect_reading_answers: number;
      created_at?: string;
    }) => {
      if ((args.assignment_id === undefined) === (args.subject_id === undefined)) {
        return errorResult("Provide exactly one of assignment_id or subject_id.");
      }
      const review: Record<string, unknown> = {
        incorrect_meaning_answers: args.incorrect_meaning_answers,
        incorrect_reading_answers: args.incorrect_reading_answers,
      };
      if (args.assignment_id !== undefined) review.assignment_id = args.assignment_id;
      if (args.subject_id !== undefined) review.subject_id = args.subject_id;
      if (args.created_at !== undefined) review.created_at = args.created_at;
      const result = await client.post<WkResource & { resources_updated?: unknown }>("/reviews", { review });
      return textResult({
        review: result.data,
        resources_updated: result.resources_updated,
      });
    }),
  );

  server.registerTool(
    "list_review_statistics",
    {
      title: "List review statistics",
      description:
        "List per-subject review accuracy statistics: correct/incorrect counts and streaks for meaning and reading, plus overall percentage_correct. Use percentages_less_than to find leeches (items the user keeps getting wrong).",
      inputSchema: {
        ids: idsParam,
        subject_ids: subjectIdsParam,
        subject_types: subjectTypesParam,
        percentages_greater_than: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Only statistics with percentage_correct strictly greater than this value."),
        percentages_less_than: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Only statistics with percentage_correct strictly less than this value."),
        hidden: hiddenParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: {
      ids?: number[];
      subject_ids?: number[];
      subject_types?: string[];
      percentages_greater_than?: number;
      percentages_less_than?: number;
      hidden?: boolean;
      updated_after?: string;
      page_after_id?: number;
      limit?: number;
    }) => {
      const query: Record<string, QueryValue> = {
        ids: args.ids,
        subject_ids: args.subject_ids,
        subject_types: args.subject_types,
        percentages_greater_than: args.percentages_greater_than,
        percentages_less_than: args.percentages_less_than,
        hidden: args.hidden,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      };
      const collection = await client.get<WkCollection>("/review_statistics", query);
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  // --- Progress history ---

  server.registerTool(
    "list_level_progressions",
    {
      title: "List level progressions",
      description:
        "List the user's level progression history: when each level was unlocked, started, passed, and completed. Useful for level-up pace and time-on-level analysis.",
      inputSchema: {
        ids: idsParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: { ids?: number[]; updated_after?: string; page_after_id?: number; limit?: number }) => {
      const collection = await client.get<WkCollection>("/level_progressions", {
        ids: args.ids,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      });
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  server.registerTool(
    "list_resets",
    {
      title: "List resets",
      description: "List account resets the user has performed (level rollbacks), with original and target levels.",
      inputSchema: {
        ids: idsParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: { ids?: number[]; updated_after?: string; page_after_id?: number; limit?: number }) => {
      const collection = await client.get<WkCollection>("/resets", {
        ids: args.ids,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      });
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  // --- Study materials ---

  server.registerTool(
    "list_study_materials",
    {
      title: "List study materials",
      description:
        "List the user's own study materials: per-subject meaning notes, reading notes, and custom meaning synonyms (accepted as correct answers in reviews).",
      inputSchema: {
        ids: idsParam,
        subject_ids: subjectIdsParam,
        subject_types: subjectTypesParam,
        hidden: hiddenParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: {
      ids?: number[];
      subject_ids?: number[];
      subject_types?: string[];
      hidden?: boolean;
      updated_after?: string;
      page_after_id?: number;
      limit?: number;
    }) => {
      const collection = await client.get<WkCollection>("/study_materials", {
        ids: args.ids,
        subject_ids: args.subject_ids,
        subject_types: args.subject_types,
        hidden: args.hidden,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      });
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  server.registerTool(
    "create_study_material",
    {
      title: "Create study material",
      description:
        "Create a study material (meaning note, reading note, and/or custom meaning synonyms) for a subject. Only one study material can exist per subject; if one already exists, use update_study_material instead.",
      inputSchema: {
        subject_id: z.number().int().describe("The subject to attach the study material to."),
        meaning_note: z.string().optional().describe("Free-form note about the subject's meaning."),
        reading_note: z.string().optional().describe("Free-form note about the subject's reading."),
        meaning_synonyms: z
          .array(z.string())
          .optional()
          .describe("Custom meaning synonyms, accepted as correct answers during reviews."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    run(async (client, args: {
      subject_id: number;
      meaning_note?: string;
      reading_note?: string;
      meaning_synonyms?: string[];
    }) => {
      const studyMaterial: Record<string, unknown> = { subject_id: args.subject_id };
      if (args.meaning_note !== undefined) studyMaterial.meaning_note = args.meaning_note;
      if (args.reading_note !== undefined) studyMaterial.reading_note = args.reading_note;
      if (args.meaning_synonyms !== undefined) studyMaterial.meaning_synonyms = args.meaning_synonyms;
      const created = await client.post<WkResource>("/study_materials", { study_material: studyMaterial });
      return textResult(flattenResource(created));
    }),
  );

  server.registerTool(
    "update_study_material",
    {
      title: "Update study material",
      description:
        "Update an existing study material's meaning note, reading note, or meaning synonyms. meaning_synonyms replaces the whole list. Use list_study_materials with subject_ids to find the study material ID.",
      inputSchema: {
        study_material_id: z.number().int().describe("The study material's unique ID (not the subject ID)."),
        meaning_note: z.string().optional().describe("Free-form note about the subject's meaning."),
        reading_note: z.string().optional().describe("Free-form note about the subject's reading."),
        meaning_synonyms: z
          .array(z.string())
          .optional()
          .describe("Custom meaning synonyms; replaces the existing list entirely."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    run(async (client, args: {
      study_material_id: number;
      meaning_note?: string;
      reading_note?: string;
      meaning_synonyms?: string[];
    }) => {
      const studyMaterial: Record<string, unknown> = {};
      if (args.meaning_note !== undefined) studyMaterial.meaning_note = args.meaning_note;
      if (args.reading_note !== undefined) studyMaterial.reading_note = args.reading_note;
      if (args.meaning_synonyms !== undefined) studyMaterial.meaning_synonyms = args.meaning_synonyms;
      if (Object.keys(studyMaterial).length === 0) {
        return errorResult("Provide at least one of meaning_note, reading_note, or meaning_synonyms.");
      }
      const updated = await client.put<WkResource>(`/study_materials/${args.study_material_id}`, {
        study_material: studyMaterial,
      });
      return textResult(flattenResource(updated));
    }),
  );

  // --- Reference data ---

  server.registerTool(
    "list_spaced_repetition_systems",
    {
      title: "List spaced repetition systems",
      description:
        "List WaniKani's spaced repetition systems: the SRS stages, their review intervals, and which stage positions count as unlocking, starting, passing, and burning.",
      inputSchema: {
        ids: idsParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: { ids?: number[]; updated_after?: string; page_after_id?: number; limit?: number }) => {
      const collection = await client.get<WkCollection>("/spaced_repetition_systems", {
        ids: args.ids,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      });
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  server.registerTool(
    "list_voice_actors",
    {
      title: "List voice actors",
      description: "List the voice actors who recorded WaniKani's vocabulary pronunciation audio.",
      inputSchema: {
        ids: idsParam,
        updated_after: updatedAfterParam,
        page_after_id: pageAfterIdParam,
        limit: limitParam(100, 500),
      },
      annotations: { readOnlyHint: true },
    },
    run(async (client, args: { ids?: number[]; updated_after?: string; page_after_id?: number; limit?: number }) => {
      const collection = await client.get<WkCollection>("/voice_actors", {
        ids: args.ids,
        updated_after: args.updated_after,
        page_after_id: args.page_after_id,
      });
      return textResult(shapeCollection(collection, args.limit ?? 100));
    }),
  );

  return server;
}
