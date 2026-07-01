#!/bin/sh
# Role-based entrypoint so ONE image serves every deploy shape:
#   PROCESS_ROLE=web     -> migrate schema, then run the Next.js server (default)
#   PROCESS_ROLE=worker  -> run the BullMQ worker (scheduler + jobs)
#   PROCESS_ROLE=all     -> single-container: migrate, run worker in background + web
#
# Compose sets web=web and worker=worker. A single Dokploy Application can use
# PROCESS_ROLE=all with an external DATABASE_URL/REDIS_URL.
set -e

ROLE="${PROCESS_ROLE:-web}"

migrate() {
  echo "[entrypoint] syncing database schema (prisma db push)..."
  npx prisma db push --skip-generate --accept-data-loss
}

case "$ROLE" in
  web)
    migrate
    echo "[entrypoint] starting web..."
    exec npm run start
    ;;
  worker)
    echo "[entrypoint] starting worker..."
    exec npm run worker
    ;;
  all)
    migrate
    echo "[entrypoint] starting worker (background) + web (foreground)..."
    npm run worker &
    exec npm run start
    ;;
  *)
    echo "[entrypoint] unknown PROCESS_ROLE '$ROLE' (expected web|worker|all)" >&2
    exit 1
    ;;
esac
