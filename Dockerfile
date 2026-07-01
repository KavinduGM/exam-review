# Single image for both the web app and the worker.
# Based on the Playwright image so the worker has Chromium + system deps for screenshots.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies (postinstall runs `prisma generate`, so copy the schema first).
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# Copy the rest of the source and build the Next.js app.
COPY . .
# A throwaway DATABASE_URL keeps `prisma generate`/`next build` happy at build time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

EXPOSE 3000

# Default to the web server; the worker overrides this command (see docker-compose).
CMD ["npm", "run", "start"]
