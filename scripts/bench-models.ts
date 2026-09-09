/**
 * bench-models.ts — decide the model on real data, not on benchmarks.
 *
 * Runs the ACTUAL production summarisation prompt against REAL transcripts from
 * the DB, across several models, and reports what matters on this hardware:
 *
 *   prefill rate  — how fast it READS the transcript. For summarisation this is
 *                   the whole cost (60k in, ~500 out), and it is where a model
 *                   that spills to CPU gets punished.
 *   eval rate     — generation speed. Dominates TRANSLATION (60k out), barely
 *                   matters for summaries.
 *   peak VRAM     — whether it fitted, or quietly offloaded.
 *
 * It also writes every output to disk so the titles can be compared side by
 * side. Speed decides feasibility; the titles decide the choice.
 *
 * USAGE
 *   bun --env-file=.env run scripts/bench-models.ts \
 *     --models gemma4:12b,qwen3:30b-a3b-instruct-2507-q4_K_M,gpt-oss:latest \
 *     --out /tmp/bench
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { SUMMARY_SCHEMA, systemPrompt, userPrompt } from "../src/lib/summarize-prompt";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const MODELS = (flag("models") ?? "gemma4:12b").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = flag("out") ?? "/tmp/bench";
const NUM_CTX = Number(flag("ctx") ?? 32768);
const HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

async function vramUsedMiB(): Promise<number> {
  try {
    const p = Bun.spawn(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]);
    return Number((await new Response(p.stdout).text()).trim().split("\n")[0]) || 0;
  } catch { return 0; }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // One short, one median, one very long — the long one is what decides whether
  // chunking is needed at all.
  const rows = (await db.execute(sql`
    SELECT t.recording_id AS id, r.meeting_name AS name, t.text,
           length(t.text) AS chars
    FROM transcripts t JOIN recordings r ON r.id = t.recording_id
    WHERE t.language = 'de' AND length(t.text) > 2000
    ORDER BY length(t.text)
  `)) as unknown as { id: string; name: string | null; text: string; chars: number }[];

  if (!rows.length) { console.error("no transcripts in the DB"); process.exit(1); }
  const pick = [rows[0]!, rows[Math.floor(rows.length / 2)]!, rows[rows.length - 1]!];
  console.log(`corpus: ${rows.length} transcripts, ${rows[0]!.chars}..${rows[rows.length-1]!.chars} chars`);
  console.log(`sampling: ${pick.map((p) => p.chars).join(", ")} chars\n`);

  for (const model of MODELS) {
    console.log(`\n${"=".repeat(70)}\n${model}\n${"=".repeat(70)}`);
    for (const rec of pick) {
      const approxIn = Math.ceil(rec.text.length / 3);
      const before = await vramUsedMiB();
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${HOST}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model, stream: false, keep_alive: "0",
            format: SUMMARY_SCHEMA,
            options: { temperature: 0.2, num_ctx: NUM_CTX },
            messages: [
              { role: "system", content: systemPrompt("de") },
              { role: "user", content: userPrompt(rec.text, rec.name) },
            ],
          }),
        });
      } catch (e) {
        console.log(`  ${rec.chars} chars -> FAILED: ${(e as Error).message}`);
        continue;
      }
      if (!res.ok) { console.log(`  ${rec.chars} chars -> HTTP ${res.status}: ${(await res.text()).slice(0,200)}`); continue; }

      const b = (await res.json()) as any;
      const peak = Math.max(before, await vramUsedMiB());
      const wall = (Date.now() - started) / 1000;
      const prefillRate = b.prompt_eval_count && b.prompt_eval_duration
        ? (b.prompt_eval_count / (b.prompt_eval_duration / 1e9)) : 0;
      const evalRate = b.eval_count && b.eval_duration
        ? (b.eval_count / (b.eval_duration / 1e9)) : 0;

      let parsed: any = null;
      try { parsed = JSON.parse(b.message?.content ?? ""); } catch {}

      console.log(
        `  ${String(rec.chars).padStart(7)} chars (~${approxIn} tok)  ` +
        `wall ${wall.toFixed(1)}s  prefill ${prefillRate.toFixed(0)} tok/s  ` +
        `gen ${evalRate.toFixed(0)} tok/s  peak ${peak} MiB` +
        (parsed ? "" : "  <- DID NOT RETURN VALID JSON")
      );
      if (parsed?.title) console.log(`      title: ${parsed.title}`);

      writeFileSync(
        join(OUT, `${model.replace(/[:/]/g, "_")}__${rec.chars}.json`),
        JSON.stringify({ model, recordingId: rec.id, chars: rec.chars, wall, prefillRate, evalRate, peak, output: parsed ?? b.message?.content }, null, 2)
      );
    }
  }

  console.log(`\noutputs written to ${OUT} — read the titles side by side before choosing.`);
  console.log("Speed decides feasibility; the titles decide the model.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
