FROM oven/bun:1.4.5-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build:companion

FROM oven/bun:1.4.5-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown bun:bun /data
ENV DATA_DIR=/data DIST_DIR=/app/dist PORT=8080 HOST=0.0.0.0
VOLUME /data
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/server/main.ts"]
