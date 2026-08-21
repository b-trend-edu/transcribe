#!/usr/bin/env bash
# Generates .env for the ai01 deployment. Secrets are created locally and never
# printed. Re-running will NOT overwrite an existing .env (rename it first).
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "ERROR: .env already exists. Move it aside before regenerating." >&2
  exit 1
fi

read -rp  "BBB base URL [https://bbb.otterdeploy.com]: " BBB_URL
BBB_URL="${BBB_URL:-https://bbb.otterdeploy.com}"
read -rsp "BBB shared secret (from 'sudo bbb-conf --secret' on the BBB host): " BBB_SECRET
echo
[ -n "$BBB_SECRET" ] || { echo "ERROR: shared secret is required." >&2; exit 1; }
read -rp  "Bind IP [127.0.0.1 = localhost only, or 10.1.10.11 for LAN]: " BIND
BIND="${BIND:-127.0.0.1}"
read -rp  "HuggingFace token for diarization (optional, Enter to skip): " HFTOK

umask 077
cat > .env <<EOF
# Generated $(date -Iseconds). Contains secrets — mode 0600, never commit.
IMAGE_TAG=latest

BBB_BASE_URL=${BBB_URL}
BBB_SHARED_SECRET=${BBB_SECRET}

# Localhost-only unless set to the LAN address. Never 0.0.0.0.
BIND_IP=${BIND}

# Generated fresh; not reused from any other environment.
INNGEST_EVENT_KEY=$(openssl rand -hex 32)
INNGEST_SIGNING_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)

WHISPER_MODEL=large-v3
WHISPER_LANGUAGE=de
WHISPERX_COMPUTE_TYPE=float16
# Sized for 16 GB VRAM (RTX 4070). Lower to 4 on OOM; raise only with headroom.
WHISPERX_BATCH_SIZE=8

# Diarization needs ~3-4 GB extra VRAM and a token that has accepted the
# pyannote licences. Leave false until plain transcription is proven working.
DIARIZE=false
HF_TOKEN=${HFTOK}

PUBLISH_CAPTIONS=true
MANUAL_INGEST_ENABLED=false
EOF
chmod 600 .env
echo "Wrote .env (mode 0600). Secrets were not echoed."
echo "Next: docker compose pull && docker compose up -d"
