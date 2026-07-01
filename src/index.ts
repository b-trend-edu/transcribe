import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { Scalar } from "@scalar/hono-api-reference";
import { serve } from "inngest/hono";
import { inngest } from "./inngest/client";
import { sweep, scanRecordings, processRecording } from "./inngest/functions/ingest";
import { db, recordings, transcripts } from "./lib/db";
import pinoLogger from "./lib/logger";
import { eq, count } from "drizzle-orm";

const app = new OpenAPIHono();


app.use(honoLogger((str) => pinoLogger.info(str)));

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (origin && /^https:\/\/.*\.b-trend\.digital$/.test(origin)) {
        return origin;
      }
      return null;
    },
  })
);

app.get("/", (c) => c.json({ status: "ok" }));

// --- Schemas ---

const StatusEnum = z.enum([
  "pending",
  "downloading",
  "transcribing",
  "completed",
  "failed",
]);

const RecordingSchema = z
  .object({
    id: z.string().openapi({ example: "abc123-1234567890" }),
    meetingId: z.string(),
    meetingName: z.string().nullable(),
    startTime: z.number().int().nullable(),
    endTime: z.number().int().nullable(),
    videoUrl: z.string(),
    status: StatusEnum.nullable(),
    error: z.string().nullable(),
    createdAt: z.number().int().nullable(),
    updatedAt: z.number().int().nullable(),
  })
  .openapi("Recording");

const TranscriptSchema = z
  .object({
    id: z.number().int(),
    recordingId: z.string(),
    text: z.string(),
    vtt: z.string().nullable(),
    language: z.string().nullable(),
    durationSeconds: z.number().nullable(),
    model: z.string().nullable(),
    createdAt: z.number().int().nullable(),
  })
  .openapi("Transcript");

const ErrorSchema = z.object({ error: z.string() });

// --- Route Definitions ---

const listTranscriptsRoute = createRoute({
  method: "get",
  path: "/transcripts",
  tags: ["Transcripts"],
  summary: "List recordings",
  request: {
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .openapi({ description: "Page size (1-100)", example: 20 }),
      offset: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .openapi({ description: "Page offset", example: 0 }),
      status: StatusEnum.optional().openapi({
        description: "Filter by processing status",
      }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(RecordingSchema),
            pagination: z.object({
              total: z.number().int(),
              limit: z.number().int(),
              offset: z.number().int(),
              hasMore: z.boolean(),
            }),
          }),
        },
      },
      description: "List of recordings",
    },
  },
});

const getTranscriptRoute = createRoute({
  method: "get",
  path: "/transcripts/{id}",
  tags: ["Transcripts"],
  summary: "Get a recording with its transcript",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({
        param: { name: "id", in: "path" },
        example: "abc123-1234567890",
      }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            recording: RecordingSchema,
            transcript: TranscriptSchema.nullable(),
          }),
        },
      },
      description: "Recording with transcript",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const deleteTranscriptRoute = createRoute({
  method: "delete",
  path: "/transcripts/{id}",
  tags: ["Transcripts"],
  summary: "Delete a recording and its transcript",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({
        param: { name: "id", in: "path" },
        example: "abc123-1234567890",
      }),
    }),
  },
  responses: {
    204: {
      description: "Deleted successfully",
    },
    404: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Not found",
    },
  },
});

const ingestRoute = createRoute({
  method: "post",
  path: "/ingest",
  tags: ["Ingest"],
  summary: "Manually queue a BBB recording for transcription",
  description: "Requires `MANUAL_INGEST_ENABLED=true`.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url().openapi({
              example:
                "https://bbb.example.com/playback/presentation/2.3/abc123-1234567890",
            }),
            name: z.string().optional().openapi({ example: "Team Meeting" }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            status: z.string(),
            alreadyQueued: z.boolean(),
          }),
        },
      },
      description: "Recording queued",
    },
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            status: z.string(),
            alreadyQueued: z.boolean(),
          }),
        },
      },
      description: "Recording already queued",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Manual ingest is disabled",
    },
    422: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Could not extract a BBB record ID from the URL",
    },
  },
});

// --- Handlers ---

app.openapi(listTranscriptsRoute, async (c) => {
  const { limit, offset, status } = c.req.valid("query");

  const where = status ? eq(recordings.status, status) : undefined;

  const [[{ total }], data] = await Promise.all([
    where
      ? db.select({ total: count() }).from(recordings).where(where)
      : db.select({ total: count() }).from(recordings),
    where
      ? db.select().from(recordings).where(where).limit(limit).offset(offset)
      : db.select().from(recordings).limit(limit).offset(offset),
  ]);

  return c.json({
    data,
    pagination: { total, limit, offset, hasMore: offset + data.length < total },
  }, 200);
});

app.openapi(getTranscriptRoute, async (c) => {
  const { id } = c.req.valid("param");

  const [recording] = await db
    .select()
    .from(recordings)
    .where(eq(recordings.id, id))
    .limit(1);

  if (!recording) {
    return c.json({ error: "Not found" }, 404);
  }

  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.recordingId, id))
    .limit(1);

  return c.json({ recording, transcript: transcript ?? null }, 200);
});

app.openapi(deleteTranscriptRoute, async (c) => {
  const { id } = c.req.valid("param");

  const [recording] = await db
    .select()
    .from(recordings)
    .where(eq(recordings.id, id))
    .limit(1);

  if (!recording) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.delete(transcripts).where(eq(transcripts.recordingId, id));
  await db.delete(recordings).where(eq(recordings.id, id));

  return c.body(null, 204);
});

// BBB record IDs look like: {sha1hex}-{unix_ms}
const BBB_RECORD_ID = /^[a-f0-9]+-\d+$/;

function parseBbbUrl(raw: string): { id: string; videoUrl: string } | null {
  const parsed = new URL(raw);
  const segment = parsed.pathname.split("/").find((p) => BBB_RECORD_ID.test(p));
  if (!segment) return null;
  return { id: segment, videoUrl: raw };
}

app.openapi(ingestRoute, async (c) => {
  if (process.env.MANUAL_INGEST_ENABLED !== "true") {
    return c.json({ error: "Manual ingest is disabled" }, 403);
  }

  const { url, name } = c.req.valid("json");

  const bbb = parseBbbUrl(url);
  if (!bbb) {
    return c.json({ error: "Could not extract a BBB record ID from the URL" }, 422);
  }

  const { id, videoUrl } = bbb;

  const [existing] = await db
    .select()
    .from(recordings)
    .where(eq(recordings.id, id))
    .limit(1);

  if (existing) {
    return c.json({ id, status: existing.status ?? "pending", alreadyQueued: true }, 200);
  }

  await db.insert(recordings).values({
    id,
    meetingId: id,
    meetingName: name ?? id,
    videoUrl,
    status: "pending",
  });

  await inngest.send({
    name: "bbb/ingest.process",
    data: { recordingId: id, videoUrl },
  });

  return c.json({ id, status: "pending", alreadyQueued: false }, 201);
});

// --- OpenAPI & Scalar ---

app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    title: "Transcribe API",
    version: "1.0.0",
    description: "API for managing BBB recording transcriptions",
  },
});

app.get("/scalar", Scalar({ url: "/doc", pageTitle: "Transcribe API" }));

// --- Inngest ---

const inngestHandler = serve({
  client: inngest,
  functions: [sweep, scanRecordings, processRecording],
});

app.use("/api/inngest", async (c) => inngestHandler(c));

export default app;
