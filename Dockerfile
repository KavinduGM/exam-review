# Single image for BOTH the web app and the worker.
# Base = the Playwright image (Chromium + all system deps for screenshots),
# pinned to the SAME version as the `playwright` npm package so browsers match.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# --- Dependencies -----------------------------------------------------------
# Copy the schema first so the `prisma generate` postinstall works.
# NODE_ENV is intentionally NOT "production" here: the build (next, typescript,
# prisma) and the worker (tsx, prisma CLI) all need devDependencies, so we install
# the full tree. --include=dev keeps them even if a prod NODE_ENV leaks in.
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --include=dev

# Ensure the Chromium build matching this Playwright version is present.
RUN npx playwright install chromium

# --- Build ------------------------------------------------------------------
COPY . .
# A throwaway DATABASE_URL keeps `prisma generate` / `next build` happy at build
# time (all pages are dynamic, so no real DB is contacted during the build).
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

# --- Runtime ----------------------------------------------------------------
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

RUN chmod +x /app/docker-entrypoint.sh
# Default role is "web"; the worker service overrides PROCESS_ROLE=worker.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
