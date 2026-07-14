# Web Site Auditor

A **Link Registry + Auditor** for the exam-prep sites (oapractice, oaguides,
nursingexamsupport, stateexamsprep — and any added later).

It does four things:

1. **Collects** every exam's links into a database, queryable by exam code — the
   source of truth for the YouTube-description generator.
2. **Monitors** every link's uptime automatically (no more adding links by hand).
3. **Reviews** pages with a tiered check: cheap HTTP + content + data-integrity on
   everything, and Claude visual review on anything that looks broken plus a sample.
4. **Alerts** by email (Resend) on outages, with a weekly digest.

## How it works

- **Extraction-first.** The collector opens every landing page and extracts the
  *real* practice / timed / contact links from the page itself. This handles all the
  per-site quirks automatically (questions. vs answers. subdomain, `/code` vs
  `/exams/CODE` vs `/Name` paths, the `C` folder, and odd timed slugs like
  `data-management-foundations---d426`). Verified live: `oapractice.com/d426` →
  correct practice/timed/contact URLs, 22 links per exam.
- **Discovery (these sites have no sitemap).** Landing pages are found via a layered
  strategy: the `/exams` index page + homepage crawl, the timed DB's `back_link`
  column, and `sitemap.xml` if one ever exists. Every candidate is extract-tested,
  so non-exam pages are ignored. Adding a sitemap URL later "just works" too.
- **DB cross-validation.** When read-only access to the client MySQL DBs is
  configured, the system uses them as the authoritative source for set counts and
  for data-integrity checks (e.g. a page returns 200 but the DB has 0 questions for
  that set → flagged). Without DB access it falls back to site defaults.
- **Parts are pagination.** Practice "parts" don't exist in the DB — they're the
  front-end splitting a set's questions into 3 chunks. Set count comes from the DB;
  part count is a per-site default (3).

## Architecture

| Process | Command | Role |
|---|---|---|
| `web` | `npm run start` | Next.js dashboard + public API |
| `worker` | `npm run worker` | Scheduled jobs: collect / uptime / audit, via BullMQ |
| `db` | Postgres | Our master registry (separate from client sites) |
| `redis` | Redis | Job queue / scheduler |

```
src/
  collector/   sitemap extraction, landing-page parsing, link enumeration, upsert
  sources/     read-only MySQL connectors (timed / new practice / old practice)
  monitor/     HTTP + content + data-integrity checks, incidents
  audit/       Playwright screenshots + Claude visual review
  notify/      Resend email alerts + weekly digest
  queue/       BullMQ queue + cron scheduler
  app/         Next.js dashboard + API routes
```

## Public API (for the YouTube system)

```
GET /api/exams/{site}/{code}     # all links for one exam, grouped
GET /api/exams?site=oapractice   # list/search exams
```

Example:

```bash
curl https://monitor.yourdomain.com/api/exams/oapractice/D426
```

```jsonc
{
  "site": "oapractice",
  "examCode": "D426",
  "examName": "Data Management Foundations",
  "landing": "https://oapractice.com/d426",
  "practice": [{ "set": 1, "part": 1, "url": "https://questions.oapractice.com/practice-questions/C/?ec=D426&set=1&part=1", "status": "up" }, ...],
  "timed": [{ "set": 1, "url": "https://onlineexamtest.com/exam_sets/data-management-foundations---d426/set-1", "status": "up" }, ...],
  "contact": "https://oapractice.com/contact"
}
```

These two endpoints are public (no auth); everything else requires the admin login.

**Description API (for the YouTube generator):** `GET /api/description/{site}/{code}` returns the 4 entry links (study guide, practice, timed, contact) as JSON + a ready-to-paste block, keyed per channel. Protected by `DESCRIPTION_API_KEY` (`x-api-key` header, `Authorization: Bearer`, or `?key=`).

A full machine-readable spec for all read endpoints is in [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1) — import it into your description generator instead of wiring the endpoint by hand.

## Local development

```bash
cp .env.example .env          # fill in values (DB access + keys optional to start)
docker compose up -d db redis # Postgres + Redis
npm install
npx prisma db push            # create the master schema
npm run db:seed               # seed the 4 sites
npm run collect               # one-off collection (proves extraction works)
npm run dev                   # dashboard at http://localhost:3000
npm run worker                # in a second terminal: scheduled jobs + manual runs
```

## Deploy on the Hostinger VPS (Dokploy)

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full walkthrough. In short:

1. Create the read-only MySQL user on each client DB — [`docs/READONLY_DB.md`](docs/READONLY_DB.md).
2. Deploy this repo's `docker-compose.yml` as a Dokploy Compose app (gives you
   `web`, `worker`, Postgres, Redis), **or** deploy `web` and `worker` as two apps
   off the same image.
3. Put the auditor in the **same Dokploy network** as the client DBs and set the
   `SRC_*` env vars to their internal hosts.
4. Set the keys (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, …) as Dokploy secrets.
5. Point `monitor.yourdomain.com` at the `web` service.

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the annotated list (source DBs, AI models, Resend, auth, cron schedules, and
tuning knobs like concurrency and the audit sample percentage).

## Tuning the content checks

Generic "page is healthy" heuristics ship in `src/monitor/check.ts`. Once the real
practice/timed page templates are confirmed, set precise markers per link via
`Link.expectedMarkers` (a JSON array of required substrings) to harden detection.

## Adding a new site

Add it to `src/config/sites.ts` (or insert a `Site` row), then run **Collect** from
the dashboard. The next run discovers all of that site's exams and links.
