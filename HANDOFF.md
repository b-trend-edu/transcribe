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
`67067c7`, which had moved 13 commits in between. Verified 2026-09-10: `bun test` 46/46 across the five non-DB suites (20 new), `tsc --noEmit` clean, `drizzle-kit generate` produced `0002_insights` (new table + FK only), and `index.ts` module-loads with `insights/generate` + `insights/scan` registered. `scripts/publish-chapters.ts` typechecks; its dry run needs the live DB and share (Felix).
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
1. Deploy the branch. CI builds images only for pushes to `main` and `v*` tags, so tag the branch head (`git tag v<next>-chapters.1 chapters-summary && git push origin v<next>-chapters.1`), set `IMAGE_TAG` in Coolify, add `INSIGHTS_BATCH=0` (keeps the hourly scan idle during the test) and optionally `OLLAMA_CHAPTERS_MODEL`, redeploy. The container runs `src/migrate.ts` on start, so `0002_insights` applies itself — check the log. `OLLAMA_HOST` is already set for summarize/translate.
2. `ollama pull gemma4:12b`, or set `OLLAMA_CHAPTERS_MODEL` to the bake-off winner (`bun run bench-models`).
3. `POST /insights/<recordId>/regenerate` for exactly 3 recordings (short / medium / 6 h), then `GET /insights/<recordId>` to review (`chapters` incl. `gist`, or `skipReason`). `GET …/chapters.json` is the player shape.
4. Rate criteria 1–3 and 5 (plan §7). Watch `nvidia-smi`: never two models at once.
5. **Delivery.** `bun --env-file=.env run scripts/publish-chapters.ts` (dry run), then with `--commit`: writes `<recordId>/chapters.json` into the recording root, where `use-chapters.ts` reads it — same shape and safety as publish-summaries (`f4ba406` settled plan §8: a file on the share, not an API). Run it where publish-summaries runs. Check: `curl -sI https://vroom.b-trend.digital/presentation/<recordId>/chapters.json | head -1` → 200, then seekbar separators + "Kapitel" in the player. The HTTP routes stay for review.
6. Rollout: drop `INSIGHTS_BATCH=0` (default 10 per hour at `:45`; only recordings with no `insights` row), re-run publish-chapters after each batch.

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
- `scripts/publish-chapters.ts` — DB → `<recordId>/chapters.json` on the share (`bun run publish-chapters`)

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
