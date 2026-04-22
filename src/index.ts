import { Hono } from "hono";
import { cors } from "hono/cors";
import * as z  from "zod";
import { zValidator } from "@hono/zod-validator";
import { serve } from "inngest/hono";
import { inngest } from "./inngest/client";
import { sweep, processRecording } from "./inngest/functions/ingest";
import { db, recordings, transcripts } from "./lib/db";
import { eq } from "drizzle-orm";

const app = new Hono();

// --- Middleware ---

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

// --- Routes ---

app.get("/", (c) => {
  return c.json({ status: "ok" });
});

const transcriptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
  status: z
    .enum(["pending", "downloading", "transcribing", "completed", "failed"])
    .optional(),
});

app.get(
  "/transcripts",
  zValidator("query", transcriptsQuerySchema),
  async (c) => {
    const { limit, offset, status } = c.req.valid("query");

    let query = db.select().from(recordings);

    if (status) {
      query = query.where(eq(recordings.status, status)) as typeof query;
    }

    const data = await query.limit(limit).offset(offset);

    return c.json({ data });
  }
);

const transcriptParamSchema = z.object({
  id: z.string().min(1),
});

app.get(
  "/transcripts/:id",
  zValidator("param", transcriptParamSchema),
  async (c) => {
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

    return c.json({ recording, transcript: transcript ?? null });
  }
);

// BBB record IDs look like: {sha1hex}-{unix_ms}, e.g. 27e7027d8fcc7a4abacade362494209066c8073b-1770364951714
const BBB_RECORD_ID = /^[a-f0-9]+-\d+$/;

function parseBbbUrl(raw: string): { id: string; videoUrl: string } | null {
  const parsed = new URL(raw);
  const segment = parsed.pathname.split("/").find((p) => BBB_RECORD_ID.test(p));
  if (!segment) return null;
  return { id: segment, videoUrl: raw };
}

const ingestBodySchema = z.object({
  url: z.url(),
  name: z.string().optional(),
});

app.post(
  "/ingest",
  zValidator("json", ingestBodySchema),
  async (c) => {
    if (process.env.MANUAL_INGEST_ENABLED !== "true") {
      return c.json({ error: "Manual ingest is disabled" }, 403);
    }

    const { url, name } = c.req.valid("json");

    const bbb = parseBbbUrl(url);
    if (!bbb) {
      return c.json({ error: "Could not extract a BBB record ID from the URL" }, 422);
    }

    const { id, videoUrl } = bbb;

    const [existing] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    if (existing) {
      return c.json({ id, status: existing.status, alreadyQueued: true });
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
  }
);

// --- Inngest ---

const inngestHandler = serve({
  client: inngest,
  functions: [sweep, processRecording],
});

app.use("/api/inngest", async (c) => {
  return inngestHandler(c);
});

export default app;
