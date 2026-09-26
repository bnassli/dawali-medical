# Dawali Medical — production image (R6a, ADR-036). Build: docker compose -f deploy/docker-compose.yml build
FROM node:24-bookworm-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && mkdir -p /app/var/files \
 && chown -R node:node /app/var /app/.next

ENV NODE_ENV=production \
    FILE_STORAGE_DIR=/app/var/files \
    PORT=3000
USER node
EXPOSE 3000
# Migrations and the idempotent seed run before every start (safe to repeat).
CMD ["sh", "deploy/entrypoint.sh"]
