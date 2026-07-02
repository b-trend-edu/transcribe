# =============================================================================
# WhisperX (Python + PyTorch/CUDA + pyannote diarization) + Bun app, one image
# Multi-stage: a heavy "builder" compiles/installs everything into a venv, then
# a slim "runtime" copies only what's needed onto a minimal CUDA base.
# =============================================================================
# torch/torchaudio 2.8.x cu128 wheels are built for CUDA 12.8 + cuDNN 9 and
# BUNDLE their own copies of cuDNN 9 + cuBLAS (etc.) inside site-packages. So we
# only need a base CUDA *runtime driver* layer, not the full "-cudnn-runtime"
# image which would ship a second, redundant ~2 GB copy of those libs.
# Ubuntu 22.04 ships system Python 3.10 (satisfies whisperx: >=3.10,<3.14).
# amd64 only: torch 2.8 cu128 wheels have no arm64 build.

# -----------------------------------------------------------------------------
# Stage 1: builder — full toolchain, installs into /opt/venv, bakes model, prunes
# -----------------------------------------------------------------------------
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Build-time system deps (python + venv + headers, curl/unzip for bun, git).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev \
        curl ca-certificates unzip git \
    && rm -rf /var/lib/apt/lists/*

# Self-contained venv so the whole Python install copies cleanly to the runtime.
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:${PATH}

# Install torch FIRST from the cu128 index so we pin the CUDA 12.8 / cuDNN 9
# build (never a CPU or mismatched-CUDA wheel), then whisperx on top.
RUN pip install --upgrade pip \
    && pip install \
        --index-url https://download.pytorch.org/whl/cu128 \
        torch==2.8.0 torchaudio==2.8.0 \
    && pip install "whisperx==3.8.6"

# ---- Pre-bake the Whisper large-v3 ASR weights into /models -------------------
# A *fresh/empty* named volume mounted at /models is seeded from these baked
# files on first start; an already-populated volume keeps its own contents.
# Only the (ungated) ASR model is pre-fetched; diarization/align weights are
# token-gated / language-specific and are fetched at runtime with HF_TOKEN.
# device=cpu -> no GPU is required during `docker build`.
ENV HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface/hub \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/models/cache
RUN mkdir -p /models/huggingface/hub /models/torch /models/cache \
    && python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu', compute_type='int8')" || true

# ---- Prune the venv: strip caches, stubs, headers, static libs --------------
# These are never needed at runtime and account for 1-2 GB in the torch/nvidia
# wheels alone. cuDNN/cuBLAS *.so.* shared libs are deliberately kept.
# NOTE: do NOT delete package 'test'/'tests' dirs — numpy imports pd_NA from
# numpy/_core/tests/_natype.py at runtime (via numpy.testing), so removing them
# breaks the whole numpy -> scipy -> sklearn -> transformers -> whisperx chain.
RUN find /opt/venv -depth -type d -name '__pycache__' -exec rm -rf {} + \
    && find /opt/venv -type f \( -name '*.pyc' -o -name '*.pyi' -o -name '*.a' \) -delete \
    && find /opt/venv/lib -depth -type d -path '*/nvidia/*/include' -exec rm -rf {} +

# ---- Bun runtime (official install script) ----------------------------------
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
RUN curl -fsSL https://bun.com/install | bash \
    && bun --version

# ---- App deps + source ------------------------------------------------------
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# -----------------------------------------------------------------------------
# Stage 2: runtime — minimal CUDA base + only the artifacts we actually run
# -----------------------------------------------------------------------------
# "-base" ships libcudart + cuda-compat (and the nvidia-container-runtime hooks)
# but NOT cuDNN/cuBLAS — those come from the pip wheels copied in /opt/venv.
FROM nvidia/cuda:12.8.1-base-ubuntu22.04 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

# Runtime-only system deps: python interpreter, ffmpeg (audio decode),
# libgomp1 (OpenMP, needed by torch/ctranslate2), CA certs for HF downloads.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        ffmpeg \
        libgomp1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the Python venv, baked models, bun, and the app from the builder.
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /models /models
COPY --from=builder /usr/local/bun /usr/local/bun
COPY --from=builder /app /app

ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/opt/venv/bin:${BUN_INSTALL}/bin:${PATH}

# Model / weight cache: single root, persisted via a named volume.
ENV HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface/hub \
    TORCH_HOME=/models/torch \
    XDG_CACHE_HOME=/models/cache

# Force ctranslate2 (faster-whisper) to load the SAME cuDNN 9 that torch bundles,
# avoiding the classic "libcudnn_ops.so.9" mismatch / segfault. Because the base
# image has no cuDNN/cuBLAS in /usr, we point at the pip-bundled copies for BOTH.
ENV LD_LIBRARY_PATH=/opt/venv/lib/python3.10/site-packages/nvidia/cudnn/lib:/opt/venv/lib/python3.10/site-packages/nvidia/cublas/lib:${LD_LIBRARY_PATH}

WORKDIR /app
EXPOSE 3000

# Run DB migrations, then start the server (exec => bun is PID 1 and gets signals)
CMD ["sh", "-c", "bun run src/migrate.ts && exec bun run src/index.ts"]
