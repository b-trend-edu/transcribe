FROM oven/bun:latest

# Install Python, ffmpeg, and Whisper CLI
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg \
    && pip3 install --break-system-packages openai-whisper \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Pre-download Whisper model to avoid first-run delay
RUN whisper --model base /dev/null 2>/dev/null || true

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

EXPOSE 3000
CMD ["sh", "-c", "bun run src/migrate.ts && exec bun run src/index.ts"]
