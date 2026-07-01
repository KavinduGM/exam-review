# Deploying on the Hostinger VPS with Dokploy

## Prerequisites

- The repo pushed to a Git provider Dokploy can pull (GitHub/GitLab), or uploaded.
- Read-only DB users created — see [READONLY_DB.md](READONLY_DB.md).
- A subdomain for the dashboard, e.g. `monitor.yourdomain.com`.
- Keys ready: `ANTHROPIC_API_KEY`, `RESEND_API_KEY` (+ a Resend-verified sending
  domain), and the alert recipient email(s).

## Option A — Compose app (simplest)

1. In Dokploy: **Create → Compose**, point it at this repo (it uses
   `docker-compose.yml`).
2. Add an **Environment** with the contents of `.env.example`, filled in. The
   compose file already wires `DATABASE_URL`/`REDIS_URL` to the bundled `db`/`redis`.
3. Make sure this app shares the **network/project** with the client DB services so
   the `SRC_*_HOST` internal names resolve.
4. Deploy. The `web` service runs `prisma db push` on boot to create the schema,
   then serves on port 3000. The `worker` service runs the scheduler + jobs.
5. Add a **Domain** in Dokploy mapping `monitor.yourdomain.com` → `web:3000` (with
   HTTPS).

## Option B — Two apps off one image (managed Postgres/Redis)

If you'd rather not bundle Postgres/Redis in compose (e.g. you already run managed
ones in Dokploy). The same image runs either role via the `PROCESS_ROLE` env var —
no custom start commands needed.

1. Create a Dokploy **Postgres** service and a **Redis** service. Note their
   internal hosts and build a `DATABASE_URL` / `REDIS_URL`.
2. Create a Dokploy **Application** from this repo (Dockerfile build).
   Env: `PROCESS_ROLE=web`, `DATABASE_URL`, `REDIS_URL`, all `SRC_*`, keys, auth,
   cron. Map the domain to it. (`web` role auto-runs `prisma db push` on boot.)
3. Create a second **Application** from the same repo with `PROCESS_ROLE=worker`
   and the same env. No domain needed.

## Option C — Single Application (simplest, one container)

For the least moving parts: one Dokploy **Application** that runs web **and** worker
in the same container, against a managed Postgres + Redis.

1. Create Dokploy **Postgres** + **Redis** services.
2. Create one **Application** from this repo (Dockerfile). Env: `PROCESS_ROLE=all`,
   `DATABASE_URL`, `REDIS_URL`, `SRC_*`, keys, auth, cron. Map the domain.
3. That's it — the entrypoint migrates the schema, starts the worker in the
   background, and serves the dashboard. (Trade-off: if the worker crashes it won't
   restart independently; Compose/Option B keep them separate.)

## The image's PROCESS_ROLE

| Value | What the container does |
|-------|-------------------------|
| `web` (default) | `prisma db push`, then the Next.js server on port 3000 |
| `worker` | the BullMQ worker (scheduler + collect/uptime/audit jobs) |
| `all` | migrate + worker (background) + web (foreground), one container |

## First run

1. Open `https://monitor.yourdomain.com` → log in with `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`.
2. Click **Collect links**. Watch the worker logs — it discovers exams from each
   sitemap and populates the registry.
3. Verify the public API: `curl https://monitor.yourdomain.com/api/exams/oapractice/D426`.
4. Click **Run uptime** to do a first health sweep.
5. The scheduler then runs automatically per the cron settings
   (`UPTIME_CRON`, `COLLECT_CRON`, `AUDIT_CRON`).

## Switching from `db push` to migrations (recommended once stable)

`db push` is fine to bootstrap. For change tracking later:

```bash
npx prisma migrate dev --name init    # generate the first migration (against a dev DB)
# then in production the web start command becomes:
#   npx prisma migrate deploy && npm run start
```

## Resource notes (KVM2)

- `PLAYWRIGHT_CONCURRENCY=2` keeps Chromium memory in check. Raise cautiously.
- `HTTP_CONCURRENCY=8` is comfortable; raise if collection/sweeps feel slow.
- `AUDIT_SAMPLE_PCT=10` controls weekly AI cost — higher = more thorough, pricier.
