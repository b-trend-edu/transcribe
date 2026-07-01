# =============================================================================
# WhisperX (Python + PyTorch/CUDA + pyannote diarization) + Bun app, one image
# =============================================================================
# Base: CUDA 12.8 runtime WITH cuDNN 9 (the plain "-cudnn-" tag == cuDNN 9).
#   - torch/torchaudio 2.8.x cu128 wheels are built for CUDA 12.8 + cuDNN 9
#   - ctranslate2 >= 4.5.0 (faster-whisper backend) needs cuDNN 9 + CUDA >= 12.3
# Ubuntu 22.04 ships system Python 3.10 (satisfies whisperx: >=3.10,<3.14).
# amd64 only: torch 2.8 cu128 wheels have no arm64 build.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# ---- System deps: python, pip, ffmpeg (audio decode), curl+unzip (bun) ------
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-dev \
        ffmpeg \
        curl ca-certificates unzip git \
    && rm -rf /var/lib/apt/lists/*

# ---- Model / weight cache: single root, persisted via a named volume --------
# HF_HOME        -> pyannote diarization + wav2vec2 align + faster-whisper ASR
# TORCH_HOME     -> torchaudio pipeline assets
# XDG_CACHE_HOME -> catch-all (~/.cache) fallback
ENV HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface/hub \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/models/cache
RUN mkdir -p /models/huggingface/hub /models/torch /models/cache

# ---- PyTorch (CUDA 12.8 build) + WhisperX -----------------------------------
# Install torch FIRST from the cu128 index so we pin the CUDA 12.8 / cuDNN 9
# build (never a CPU or mismatched-CUDA wheel), then whisperx on top.
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install \
        --index-url https://download.pytorch.org/whl/cu128 \
        torch==2.8.0 torchaudio==2.8.0 \
    && python3 -m pip install "whisperx==3.8.6"

# Force ctranslate2 (faster-whisper) to load the SAME cuDNN 9 that torch bundles,
# avoiding the classic "libcudnn_ops.so.9" mismatch / segfault. Path matches the
# Ubuntu-22.04 system Python 3.10 site-packages; update it if you change Python.
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.10/dist-packages/nvidia/cudnn/lib:${LD_LIBRARY_PATH}

# ---- (Optional) pre-bake the Whisper large-v3 ASR weights into the image ----
# A *fresh/empty* named volume mounted at /models is seeded from these baked
# files on first start; an already-populated volume keeps its own contents.
# Only the (ungated) ASR model is pre-fetched here; diarization/align weights are
# token-gated / language-specific and are fetched at runtime with HF_TOKEN.
# device=cpu -> no GPU is required during `docker build` (nvidia runtime is off).
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu', compute_type='int8')" || true

# ---- Bun runtime (official install script) ----------------------------------
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
RUN curl -fsSL https://bun.com/install | bash \
    && bun --version

# ---- App --------------------------------------------------------------------
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

EXPOSE 3000

# Run DB migrations, then start the server (exec => bun is PID 1 and gets signals)
CMD ["sh", "-c", "bun run src/migrate.ts && exec bun run src/index.ts"]
