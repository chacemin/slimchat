# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.4.5

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    SLIMCHAT_HOST=0.0.0.0 \
    SLIMCHAT_PORT=8787 \
    SLIMCHAT_DATA_DIR=/app/data

RUN groupadd --system slimchat \
 && useradd --system --no-create-home --gid slimchat --home-dir /app --shell /usr/sbin/nologin slimchat

COPY --from=build /app/package.json /app/bun.lock /app/bunfig.toml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/.env.example ./.env.example
COPY LICENSE README.md ./

RUN mkdir -p /app/data /app/data/files /app/data/secrets /app/data/logs \
 && chown -R slimchat:slimchat /app/data \
 && chmod 755 /app/scripts/docker-entrypoint.sh

USER slimchat
VOLUME ["/app/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["bun", "server/index.ts"]
