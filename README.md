# Transcribe

Automated transcription service for **BigBlueButton (BBB)** recordings. It
discovers new recordings, transcribes their audio with **WhisperX** (GPU, with
optional speaker diarization), stores the transcripts in Postgres, and can
publish the captions back onto the original BBB recording.

## How it works

The service runs a small [Hono](https://hono.dev) HTTP API plus a set of
background jobs orchestrated by [Inngest](https://www.inngest.com). The
processing pipeline is:

1. **Discovery** — two cron jobs find new recordings:
   - `sweep` (every 4h) calls the BBB `getRecordings` API.
   - `scanRecordings` (hourly) scans a locally-mounted BBB recordings directory
     directly off disk — useful when the service runs on the BBB host itself,
     avoiding the API and the 4h delay.

   Both insert `pending` rows into the `recordings` table (deduped on the BBB
   record ID) and fire a `bbb/ingest.process` event per new recording.

2. **Process** (`processRecording`, event-triggered, one per recording):
   - **Download** — resolves the recording's webcam media. If found under the
     mounted `RECORDINGS_DIR` it is used directly; otherwise the MP4 is
     downloaded over HTTP to a temp dir.
   - **Transcribe** — spawns the `whisperx` CLI (`--model`, `--device`,
     `--compute_type`, `--batch_size`, optional `--language` and `--diarize`),
     producing a WebVTT file.
   - **Store** — upserts a row into `transcripts` (plain `text` + raw `vtt` +
     detected `language` + `model`) and marks the recording `completed`.
   - **Publish captions** (optional, `PUBLISH_CAPTIONS=true`) — uploads the VTT
     back to BBB via `putRecordingTextTrack`.

   Temp audio/VTT files live under `/tmp/bbb-ingest` and are cleaned up after
   storage (and swept after 24h).

Transcripts are stored **entirely as Postgres rows** — no blob/object storage.
The source video is referenced by URL only.

### Tech stack

| Concern            | Choice                                             |
| ------------------ | -------------------------------------------------- |
| Runtime            | [Bun](https://bun.com)                             |
| HTTP framework     | Hono + `@hono/zod-openapi` (OpenAPI + Scalar docs) |
| Background jobs    | Inngest (cron + event functions)                   |
| Database           | Postgres via Drizzle ORM (`postgres-js`)           |
| ASR                | WhisperX (faster-whisper / CTranslate2 + PyTorch)  |
| Diarization        | pyannote (via WhisperX, optional)                  |
| Logging            | Pino                                               |

## API

Interactive docs are served at `/scalar`; the raw OpenAPI spec at `/doc`.

| Method   | Path                | Description                                                        |
| -------- | ------------------- | ----------------------------------------------------------------- |
| `GET`    | `/`                 | Health check (`{ status: "ok" }`).                                |
| `GET`    | `/transcripts`      | List recordings. Query: `limit` (1–100, default 20), `offset`, `status`. Returns `{ data, pagination }`. |
| `GET`    | `/transcripts/{id}` | Get one recording + its transcript.                               |
| `DELETE` | `/transcripts/{id}` | Delete a recording and its transcript.                            |
| `POST`   | `/ingest`           | Manually queue a BBB recording by URL. Requires `MANUAL_INGEST_ENABLED=true`. Body: `{ url, name? }`. |
| `*`      | `/api/inngest`      | Inngest function endpoint (registration + execution).             |

## Project structure

```
src/
  index.ts               # Hono app: routes, OpenAPI, Inngest handler mount
  migrate.ts             # Creates the inngest/transcribe DBs + runs Drizzle migrations
  env.ts / env.d.ts      # Typed env access (generated from .env.schema)
  inngest/
    client.ts            # Inngest client
    functions/ingest.ts  # sweep, scanRecordings, processRecording
  lib/
    bbb.ts               # BBB API (checksums, getRecordings, caption upload, metadata.xml)
    whisper.ts           # whisperx CLI wrapper + VTT parsing
    media.ts             # locally-mounted recording discovery
    db.ts                # Drizzle schema + client
    logger.ts            # Pino
drizzle/                 # SQL migrations
docker-compose.yaml      # Local dev (app + Inngest dev server)
docker-compose.prod.yaml # Production stack (app + Inngest + Postgres + Redis)
Dockerfile               # CUDA + WhisperX + Bun single image
```

## Configuration

All configuration is via environment variables. `.env.schema` is the source of
truth (types, defaults, required flags). Copy the values you need into a `.env`
file for local runs.

### Required

| Variable              | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `BBB_BASE_URL`        | BBB server base URL.                                    |
| `BBB_SHARED_SECRET`   | BBB API shared secret (for checksummed API calls).      |
| `DATABASE_URL`        | Postgres connection string for the `transcribe` DB.     |
| `INNGEST_EVENT_KEY`   | Inngest event key (hex, even length).                   |
| `INNGEST_SIGNING_KEY` | Inngest signing key (hex, even length).                 |
| `POSTGRES_PASSWORD`   | Password for the bundled Postgres container.            |

### Transcription (WhisperX)

| Variable                | Default     | Description                                                        |
| ----------------------- | ----------- | ----------------------------------------------------------------- |
| `WHISPER_MODEL`         | `large-v3`  | ASR model (`tiny`…`large-v3`).                                     |
| `WHISPER_LANGUAGE`      | *(auto)*    | Force a language (RFC 5646, e.g. `de`) instead of auto-detecting. |
| `WHISPERX_DEVICE`       | `cuda`      | `cuda` or `cpu` (cpu is much slower).                             |
| `WHISPERX_COMPUTE_TYPE` | `float16`   | `float16`/`float32`/`int8` (cpu needs `int8`/`float32`).          |
| `WHISPERX_BATCH_SIZE`   | `16`        | Batched inference size; lower on VRAM OOM.                        |
| `DIARIZE`               | `false`     | Enable pyannote speaker diarization (`[SPEAKER_xx]` in the VTT).  |
| `HF_TOKEN`              | —           | HuggingFace token for gated pyannote models (required if `DIARIZE=true`). |
| `MIN_SPEAKERS` / `MAX_SPEAKERS` | —   | Optional diarization speaker-count bounds.                        |

### Ingestion / output

| Variable                | Default       | Description                                                       |
| ----------------------- | ------------- | ---------------------------------------------------------------- |
| `RECORDINGS_DIR`        | *(unset)*     | In-container path to the mounted BBB recordings dir. When set, media is read from disk instead of downloaded. |
| `PUBLISH_CAPTIONS`      | `true`        | Upload the finished VTT back to the BBB recording.               |
| `MANUAL_INGEST_ENABLED` | `false`       | Enable the `POST /ingest` endpoint.                             |

## Local development

Run the app with hot reload against your own Postgres + Inngest:

```sh
bun install
cp .env.schema .env   # then fill in the required values
bun run dev           # http://localhost:3000  (docs at /scalar)
```

Or bring up the app plus a local Inngest dev server with Docker Compose:

```sh
docker compose up --build
# app:     http://localhost:3000
# inngest: http://localhost:8288
```

> Note: `docker-compose.yaml` runs the app in Inngest **dev mode**
> (`INNGEST_DEV=1`) and expects a `DATABASE_URL` pointing at a Postgres you
> provide. For a fully self-contained stack use the production compose file
> below.

### Database migrations

Migrations live in `drizzle/` and are applied by `src/migrate.ts`, which also
creates the `inngest` and `transcribe` databases if they don't exist. The
container runs it automatically on startup (see the Dockerfile `CMD`). To run it
manually:

```sh
bun run src/migrate.ts
```

## Production deployment

Production runs as a GPU container image built by CI and deployed via
`docker-compose.prod.yaml`, which brings up the full stack: **app + Inngest +
Postgres + Redis**.

### Requirements

- An **NVIDIA GPU** host with recent drivers and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  installed (the compose file requests `driver: nvidia` GPU access).
- `linux/amd64` — the torch 2.8 cu128 wheels are amd64-only.
- VRAM: `large-v3` + diarization needs roughly **10–13 GB**.

### Image build (CI)

`.github/workflows/build.yml` builds the CUDA + WhisperX + Bun image and pushes
it to GHCR (`ghcr.io/b-trend-edu/transcribe`) on **git tags matching `v*`**:

```sh
git tag v1.2.3
git push origin v1.2.3
```

The production compose file pulls this pre-built image (it does **not** build
from source); pin a specific build with `IMAGE_TAG`.

### Deploy

`docker-compose.prod.yaml` is written for a [Coolify](https://coolify.io)
deployment but works with plain `docker compose`. Provide the environment
variables (via Coolify's UI or an env file) and:

```sh
docker compose -f docker-compose.prod.yaml up -d
```

Key deployment-specific settings:

- **`RECORDINGS_HOST_DIR`** — host path to the BBB published recordings,
  bind-mounted read-only into the container at `/recordings`. Defaults to
  `/var/bigbluebutton/published/presentation`; some setups use
  `/var/bigbluebutton/presentation`. This lets the service transcribe media
  directly on the BBB host without downloading. Captions are still written back
  via the BBB API, not this mount.
- **`whisperx_models` volume** — persists the downloaded Whisper/align/pyannote
  weights across restarts and redeploys (mounted at `/models`). The Whisper
  `large-v3` ASR weights are pre-baked into the image; gated diarization/align
  weights are fetched at runtime using `HF_TOKEN`.
- **Postgres** hosts two databases: `inngest` (Inngest's own state) and
  `transcribe` (the app). Both are created automatically by `migrate.ts`.

### Health & observability

- App health: `GET /` → `{ "status": "ok" }`.
- Inngest dashboard/health: port `8288` inside the stack.
- Logs are structured JSON (Pino).

## Testing

```sh
bun test
```

> The `api.test.ts` suite exercises the HTTP layer and needs a reachable
> Postgres (`DATABASE_URL`); the `bbb`/`media`/`whisper` unit tests do not.
