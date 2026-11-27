# Bot server: Telegram bot, image converters (sharp + ffmpeg) and the companion API.
# Companion downloads come from GitHub releases, so this image doesn't build them.
#
#   docker build -t telegram-vrchat .
#   docker run -d --name telegram-vrchat --env-file .env -p 8080:8080 -v telegram-vrchat-data:/data telegram-vrchat
#
# Put it behind an HTTPS reverse proxy (see docker-compose.yml) and set PUBLIC_URL to that address.
FROM oven/bun:1.4.5-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src

# Database and converted files live in /data; mount a volume there to keep them across updates.
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
VOLUME /data
EXPOSE 8080
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "src/server/main.ts"]
