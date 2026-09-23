/**
 * Translate a German caption track to English, cue by cue.
 *
 * WHY CUE-WISE AND NOT WHOLE-TEXT
 *   Translating the flattened transcript would give a readable English document
 *   and a useless subtitle track. Translating cues in place keeps every
 *   timestamp, so the result drops straight into the player's caption menu next
 *   to the German one.
 *
 * TWO ENGINES
 *   de<->en goes through a dedicated OPUS-MT model (lib/mt.ts): one step, well
 *   under a minute per recording. Through gemma4 the same recording was ~120
 *   batch calls and ~2 hours on the shared GPU — weeks for the backlog. The LLM
 *   path remains for pairs with no baked model, and via TRANSLATE_ENGINE=llm.
 *
 * ALIGNMENT IS THE CORRECTNESS PROPERTY
 *   A translated track whose cues drifted is worse than no track: it looks right
 *   until someone follows along. Every batch is checked for an exact cue count,
 *   and a mismatch falls back to translating that batch one cue at a time rather
 *   than accepting a plausible-looking misalignment.
 */
import { and, eq, sql } from "drizzle-orm";
import { inngest } from "../client";
import { db, transcripts } from "../../lib/db";
import { uploadCaptionTrack } from "../../lib/bbb";
import { mtAvailable, mtModelTag, translateCues } from "../../lib/mt";
import { TRANSLATE_MODEL, WARM, assertModel, chat, unload } from "../../lib/ollama";
import {
  cuesSchema,
  TRANSLATE_PROMPT_VERSION,
  TRANSLATE_SYSTEM,
  type CuesOut,
  translateUser,
} from "../../lib/translate-prompt";
import { batchCues, cuesToText, parseVtt, serialiseVtt, type Cue } from "../../lib/vtt";

/** Human label for a language code, e.g. "en" -> "English"; falls back to the code. */
function languageLabel(lang: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 40960);
/** Chars of cue text per request. Small enough to leave room for the reply,
 *  large enough that a 4-hour recording is ~100 requests rather than ~4000.
 *  Raised from 2500: a bigger batch is more speech in one view, which is what
 *  lets the model resolve a pronoun to the noun three cues earlier. */
const BATCH_CHARS = Number(process.env.TRANSLATE_BATCH_CHARS ?? 6000);
/** Neighbouring cues sent as reference either side of a batch. They are never
 *  translated; they exist so the first and last cues of a batch are not read
 *  blind, which is where pronoun and terminology errors concentrated. */
const CONTEXT_CUES = Number(process.env.TRANSLATE_CONTEXT_CUES ?? 8);

const MODEL_TAG = `translated:${TRANSLATE_MODEL}:${TRANSLATE_PROMPT_VERSION}`;

async function translateBatch(
  texts: string[],
  from: string,
  to: string,
  contextBefore: string[] = [],
  contextAfter: string[] = [],
): Promise<string[]> {
  const out = await chat<CuesOut>({
    model: TRANSLATE_MODEL,
    system: TRANSLATE_SYSTEM(from, to),
    user: translateUser(texts, contextBefore, contextAfter),
    // Length-exact: the model cannot return a different number of cues than it
    // was given, so alignment holds without the per-cue fallback.
    schema: cuesSchema(texts.length) as unknown as Record<string, unknown>,
    numCtx: NUM_CTX,
    // WARM matters most here: a recording is ~100 batch calls, and reloading a
    // 19 GB model for each would cost ~12 minutes per recording in loading
    // alone. unload() at the end of the run gives the VRAM back.
    keepAlive: WARM,
  });
  if (!Array.isArray(out?.cues)) throw new Error("translation reply had no cues array");
  return out.cues;
}

/** Exact count or nothing. Falls back to one cue per request, which cannot
 *  misalign, rather than accepting a batch that lost or gained a line. */
async function translateAligned(
  texts: string[], from: string, to: string, log: (m: string) => void,
  contextBefore: string[] = [], contextAfter: string[] = [],
): Promise<string[]> {
  // A failed request is NOT a misalignment, and must not be treated as one.
  //
  // Every batch was dying on a fetch timeout and dropping straight into the
  // per-cue path: ~40 separate requests where one would do, each of which could
  // time out in turn. That is how translation came to spend 40 minutes of every
  // hour producing nothing. Retry the batch once — the fallback exists for a
  // model that returns the wrong number of cues, which retrying cannot fix.
  const attempt = async () =>
    translateBatch(texts, from, to, contextBefore, contextAfter);

  let first = await attempt().catch((e) => {
    log(`batch failed (${(e as Error).message}), retrying once`);
    return null;
  });
  if (!first) {
    first = await attempt().catch((e) => {
      log(`batch failed again (${(e as Error).message}), falling back to per-cue`);
      return null;
    });
  }
  if (first && first.length === texts.length) return first;
  if (first) log(`batch returned ${first.length} cues for ${texts.length}, falling back to per-cue`);

  const one: string[] = [];
  for (const text of texts) {
    if (!text.trim()) { one.push(""); continue; }
    // The fallback gets context as well: translating a lone fragment with no
    // neighbours is exactly the blind case this whole change is about.
    const r = await translateBatch([text], from, to, contextBefore, contextAfter);
    one.push(r[0] ?? text);
  }
  return one;
}

export const translateRecording = inngest.createFunction(
  {
    id: "bbb/translate",
    concurrency: [
      { key: "event.data.recordingId", limit: 1 },
      { scope: "account", key: '"gpu"', limit: 1 },
    ],
    retries: 2,
    triggers: [{ event: "bbb/translate" }],
  },
  async ({ event, step, logger }) => {
    const recordingId = event.data.recordingId as string;
    const force = Boolean(event.data.force);

    // Translate INTO whichever of de/en is missing, from whatever exists. Most
    // recordings are German and need English; 11 are English and need German;
    // a couple are Portuguese or Ukrainian and need both. Hardcoding de -> en
    // left all of those untranslated.
    const source = await step.run("load-source-vtt", async () => {
      const rows = await db
        .select({
          vtt: transcripts.vtt,
          language: transcripts.language,
          duration: transcripts.durationSeconds,
        })
        .from(transcripts)
        .where(eq(transcripts.recordingId, recordingId));
      const have = new Set(rows.map((r) => r.language));
      const target = event.data.target ?? (have.has("de") ? "en" : "de");
      if (have.has(target) && !force) return { done: true as const, target };
      // Prefer a source the MT model can take. Two recordings carry both our
      // German transcript and an imported pt/uk track; picking the imported one
      // sent them down the LLM path — ~90 minutes each, holding the GPU lane
      // while hundreds of seconds-long MT jobs queued behind them.
      const candidates = rows.filter((r) => r.language !== target && r.vtt);
      const from = candidates.find((r) => mtAvailable(r.language, target)) ?? candidates[0] ?? null;
      return from ? { done: false as const, target, ...from } : null;
    });

    // Only a cue-timed source can produce a caption track. A transcript with
    // text but no VTT is not translatable into subtitles, and silently
    // producing a text-only English row would look like success.
    if (!source) {
      logger.info(`${recordingId}: no cue-timed source, cannot produce a caption track`);
      return { skipped: "no-vtt" };
    }
    if (source.done) return { skipped: "already-translated", target: source.target };
    const TARGET = source.target;
    const FROM = source.language ?? "de";

    const { header, cues } = parseVtt(source.vtt!);
    if (!cues.length) return { skipped: "no-cues" };

    // Dedicated MT model when one is baked in for this pair: the whole recording
    // in one step, well under a minute. The LLM loop below is the fallback.
    const useMt = mtAvailable(FROM, TARGET);
    const modelTag = useMt ? mtModelTag(FROM, TARGET) : MODEL_TAG;
    const translated: Cue[] = [...cues];

    if (useMt) {
      const texts = await step.run("translate-mt", async () => {
        const r = await translateCues(cues.map((c) => c.text.replace(/\n/g, " ")), FROM, TARGET);
        logger.info(`${recordingId}: ${cues.length} cues ${FROM}->${TARGET} on ${r.device} in ${r.seconds}s`);
        return r.texts;
      });
      texts.forEach((text, idx) => {
        translated[idx] = { ...cues[idx]!, text: text.trim() || cues[idx]!.text };
      });
    } else {
      await step.run("assert-model", () => assertModel(TRANSLATE_MODEL));

      const batches = batchCues(cues, BATCH_CHARS);
      logger.info(`${recordingId}: ${cues.length} cues in ${batches.length} batches`);

      // One step per batch: Inngest checkpoints each, so a retry on a multi-hour
      // recording resumes where it stopped instead of re-translating from cue 1.
      for (const [i, batch] of batches.entries()) {
        // Context comes from the ORIGINAL cues, not the translated ones: the
        // model is reading German to understand German, and a half-finished
        // English rendering would be worse reference than the source.
        const before = cues
          .slice(Math.max(0, batch.start - CONTEXT_CUES), batch.start)
          .map((c) => c.text.replace(/\n/g, " "));
        const after = cues
          .slice(batch.start + batch.cues.length, batch.start + batch.cues.length + CONTEXT_CUES)
          .map((c) => c.text.replace(/\n/g, " "));

        const texts = await step.run(`translate-${i}`, async () =>
          translateAligned(
            batch.cues.map((c) => c.text.replace(/\n/g, " ")),
            FROM,
            TARGET,
            (m) => logger.warn(`${recordingId} batch ${i}: ${m}`),
            before,
            after
          )
        );
        texts.forEach((text, j) => {
          const idx = batch.start + j;
          const original = cues[idx]!;
          translated[idx] = { ...original, text: text.trim() || original.text };
        });
      }
    }

    // Serialised once, outside the step, so the publish step below can send the
    // same bytes that were stored rather than rebuilding them.
    const vtt = serialiseVtt(header, translated);

    await step.run("store", async () => {
      await db
        .insert(transcripts)
        .values({
          recordingId,
          language: TARGET,
          text: cuesToText(translated),
          vtt,
          durationSeconds: source.duration,
          model: modelTag,
        })
        .onConflictDoUpdate({
          target: [transcripts.recordingId, transcripts.language],
          set: {
            text: cuesToText(translated),
            vtt,
            model: modelTag,
            createdAt: sql`extract(epoch from now())::integer`,
          },
        });
    });

    // Publish the track to BBB, exactly as transcription does for the German
    // one.
    //
    // Without this the English VTT only ever existed in our database: BBB kept
    // serving a single German track, so captions.json listed one language, the
    // player's transcript language selector never appeared (it needs two), and
    // the on-video captions had nothing to switch to. Translating without
    // publishing produces a row nobody can read.
    await step.run("publish-captions", async () => {
      if (process.env.PUBLISH_CAPTIONS === "false") return { skipped: "disabled" };
      const baseUrl = process.env.BBB_BASE_URL;
      const secret = process.env.BBB_SHARED_SECRET;
      if (!baseUrl || !secret) return { skipped: "no BBB credentials" };
      if (!vtt.trim()) return { skipped: "empty vtt" };

      try {
        const res = await uploadCaptionTrack(
          baseUrl,
          secret,
          recordingId,
          TARGET,
          languageLabel(TARGET),
          vtt
        );
        if (!res.success) {
          logger.warn(
            { recordingId, lang: TARGET, status: res.status, message: res.message },
            "caption upload rejected by BBB"
          );
          return { published: false };
        }
        logger.info(`${recordingId}: published ${TARGET} caption track`);
        return { published: true };
      } catch (err) {
        // Best effort: the transcript is already stored, so a BBB hiccup must
        // not throw away the translation work that produced it.
        logger.warn({ recordingId, err }, "caption upload failed");
        return { published: false };
      }
    });

    if (!useMt) {
      await step.run("unload-model", () => unload(TRANSLATE_MODEL).then(() => "released"));
    }

    return { recordingId, from: FROM, to: TARGET, cues: cues.length, engine: useMt ? "mt" : "llm" };
  }
);

/**
 * Backfill sweep. Newest first, on the assumption that recent courses are the
 * ones being viewed. With the MT engine a recording is under a minute, so the
 * batch can be large without crowding out transcription or summarisation.
 */
export const translateSweep = inngest.createFunction(
  { id: "bbb/translate.sweep", triggers: [{ cron: "15 * * * *" }] },
  async ({ step, logger }) => {
    const batch = Number(process.env.TRANSLATE_BATCH ?? 30);
    const pending = await step.run("find-missing", async () => {
      const rows = await db.execute(sql`
        SELECT src.recording_id AS id
        FROM transcripts src
        WHERE src.vtt IS NOT NULL
          AND length(src.text) >= 200
          AND (
            SELECT count(DISTINCT language) FROM transcripts t
            WHERE t.recording_id = src.recording_id AND t.language IN ('de','en')
          ) < 2
        GROUP BY src.recording_id, src.created_at
        ORDER BY src.created_at DESC
        LIMIT ${batch}
      `);
      return (rows as unknown as { id: string }[]).map((r) => r.id);
    });

    if (!pending.length) return { dispatched: 0 };
    logger.info(`translate sweep: dispatching ${pending.length}`);
    await step.sendEvent(
      "dispatch-translations",
      pending.map((recordingId) => ({ name: "bbb/translate", data: { recordingId } }))
    );
    return { dispatched: pending.length };
  }
);
