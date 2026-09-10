# Handoff — transcribe: Kapitel aus BBB-Transkripten

_Last updated: 2026-09-10 · Branch: `chapters-summary`_

> Read with the plan **`docs/superpowers/plans/2026-08-17-transcript-chapters-summary.md`**.
> The plan holds reasoning, prompts, formulas and DoD; this file says what the
> code does right now and what to do next. Where they overlap, the plan wins on
> intent, this file on "what the code actually does".

## Goal
Per-recording **chapters** from the existing WhisperX transcripts, fully local
(Ollama on ai01), as the `chapters.json` the `bbb-player` already renders.
Map (LLM per ~400-cue chunk, answering with cue indices) → merge (deterministic
TypeScript). Lecture-level summaries (plan Phase 2) are deferred — see Blockers.

## Current Status
Phase 1 (chapters) was ported from `transcribe-insights.bundle` (branch
`feat/insights-chapters`, one commit on top of `ba819cb`) onto `main` at
`67067c7`, which had moved 13 commits in between. Verified 2026-09-10: `bun test` 46/46 across the five non-DB suites (20 new), `tsc --noEmit` clean, `drizzle-kit generate` produced `0002_insights` (new table + FK only), and `index.ts` module-loads with `insights/generate` + `insights/scan` registered.
Nothing that needs the GPU, a live Postgres or the BBB host has run — that is
Felix's side (Phase 1 DoD in the plan).

## What changed in the port (vs. the bundle)
`main` had grown its own Ollama client, a shared GPU lane, per-recording
summaries and one-transcript-row-per-language. The bundle was rebased onto those
instead of duplicating them:

| Bundle | Now | Why |
|---|---|---|
| own `src/lib/ollama.ts` (`format:"json"`, `extractJson`, retry) | **dropped** — `main`'s `chat()` with a JSON **schema** (constrained decoding), `WARM` + `unload()` | one client, and constrained decoding beats salvage-parsing |
| `src/lib/gpu.ts` + `ingest.ts` change | **dropped** — inline `{ scope:"account", key:'"gpu"', limit:1 }` like summarize/translate | `69d339f` already put transcription on that lane, with its own `TRANSCRIBE_CONCURRENCY` on top; the bundle's `scope:"env"` lane would have split it again |
| `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `INSIGHTS_LANGUAGE`, `.env.schema` edits | only **`OLLAMA_CHAPTERS_MODEL`** (default `gemma4:12b`), next to `OLLAMA_SUMMARY_MODEL` in `ollama.ts` | main's idiom; its Ollama vars are not in `.env.schema` either |
| skip `unexpected-language:<lang>` | **dropped**; the prompt uses the transcript's language | `67067c7`: 13 recordings are genuinely en/pt/uk, not misdetected |
| `insights.summary` + `lectureKey` columns, `summary.json` route | **dropped** | `summaries` already exists per (recording, language); the lecture-level reduce (plan §3.3) has to be designed against it, not beside it |
| `drizzle/0001_insights.sql` | regenerated as **`0002_insights`** via `drizzle-kit generate` | `0001` is taken by summaries/multilang; the bundle's SQL also carried a stale `transcripts.model` default |
| prompt inline in `insights.ts` | `src/lib/chapters-prompt.ts` | matches `summarize-prompt.ts` / `translate-prompt.ts` |
| `ollama.test.ts` | dropped (it tested `extractJson`) | — |

Also, because transcripts are now one row **per language**: `insights/generate`
picks the ASR original (`model` not `translated:*`), never a translated track;
`insights/scan` uses `selectDistinct`. `durationSeconds` falls back to the last
cue's end *before* the skip-gate, so a NULL duration (imported captions) is not
misread as `too-short`.

## Next Steps (Felix, server side — plan Phase 1 DoD)
1. `bun run src/migrate.ts` — applies `0002_insights`.
2. `ollama pull gemma4:12b`, or set `OLLAMA_CHAPTERS_MODEL` to the bake-off winner (`bun run bench-models`).
3. `POST /insights/<recordId>/regenerate` for exactly 3 recordings (short / medium / 6 h), then `GET /insights/<recordId>` to review (`chapters` incl. `gist`, or `skipReason`). `GET …/chapters.json` is the player shape.
4. Rate criteria 1–3 and 5 (plan §7). Watch `nvidia-smi`: never two models at once.
5. **Delivery.** `f4ba406` decided summaries go to the share (`<recordId>/meta/summary.json`) via `scripts/publish-summaries.ts`, not an API — that is plan §8 answered. The player reads chapters from `<recordId>/chapters.json` (recording root). Follow-up: a `scripts/publish-chapters.ts` mirroring publish-summaries. The HTTP routes stay for review and the hand-copied test.
6. Then let the scan run: `INSIGHTS_BATCH` (default 10) at `:45` hourly; it only touches recordings with no `insights` row.

## Blockers / Open
- **Phase 2 (lecture summary)**: still blocked on plan §2.5 (`recordings.meeting_id` holds the externalId OR the internal meetingID depending on which cron found the recording) — *and* now needs a design decision against the existing `summaries` table.
- Model choice: open until the bake-off.

## Key Files
- `src/lib/chapters.ts` — merge algorithm, formula, chunking (**the correctness-critical file**; 17 tests in `src/__tests__/chapters.test.ts`)
- `src/lib/chapters-prompt.ts` — Stufe-1 prompt, JSON schema, `CHAPTERS_PROMPT_VERSION`
- `src/lib/slides.ts` — `shapes.svg` → slide-change seconds (3 tests)
- `src/inngest/functions/insights.ts` — `insights/generate` + `insights/scan`
- `src/index.ts` — `GET /insights/:id/chapters.json`, `GET /insights/:id`, `POST /insights/:id/regenerate`
- `src/lib/db.ts` (`insights` table) + `drizzle/0002_insights.sql`

## Commands
```bash
# bun is NOT on the Windows PATH on this machine; it lives in WSL:
wsl -e bash -lc 'export PATH="$HOME/.bun/bin:$PATH"; cd "/mnt/c/Users/felix.schwips/OneDrive - b-trend-setting gUG/Dokumente/GitHub/transcribe" && bun test src/__tests__/chapters.test.ts src/__tests__/slides.test.ts'
# same wrapper for: bunx tsc --noEmit · bunx drizzle-kit generate --name <n> · bun run src/migrate.ts
# (api.test.ts needs a live DATABASE_URL; the rest do not.)

psql "$DATABASE_URL" -c "DELETE FROM insights WHERE prompt_version = 'chapters-v1';"   # after a prompt bump
psql "$DATABASE_URL" -c "DELETE FROM insights WHERE skip_reason LIKE 'error:%';"       # after a host-wide fix
```

## Context for the Next Agent
- Stack: Bun + Hono + Inngest + Drizzle + WhisperX + Ollama. Env is read via `process.env` per module — follow that, not `src/env.ts`.
- Modes: **ponytail** (smallest diff that works) + **superpowers** (evidence, not claims). No new dependencies.
- Decisions not to re-litigate: `gist` stored in the jsonb and stripped on the wire; regex over `<image>` for slides; `start:0` enforced by pulling the first boundary down (no invented intro); terminal failure → `skipReason=error:…`.
