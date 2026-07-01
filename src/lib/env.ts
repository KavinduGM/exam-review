// Centralized, typed access to environment configuration.
// Read once, reused everywhere. Missing optional values degrade gracefully.

function str(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface SourceDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  enabled: boolean;
}

function sourceDb(prefix: string, defaultDb: string): SourceDbConfig {
  const host = str(`${prefix}_HOST`);
  return {
    host,
    port: num(`${prefix}_PORT`, 3306),
    user: str(`${prefix}_USER`, "auditor_ro"),
    password: str(`${prefix}_PASSWORD`),
    database: str(`${prefix}_DATABASE`, defaultDb),
    enabled: host.trim().length > 0,
  };
}

export const env = {
  databaseUrl: str("DATABASE_URL"),
  redisUrl: str("REDIS_URL", "redis://localhost:6379"),

  sources: {
    timed: sourceDb("SRC_TIMED", "onlineexam_db"),
    practiceNew: sourceDb("SRC_PRACTICE_NEW", "exam_db"),
    practiceOld: sourceDb("SRC_PRACTICE_OLD", "answers_db"),
  },

  anthropic: {
    apiKey: str("ANTHROPIC_API_KEY"),
    triageModel: str("ANTHROPIC_TRIAGE_MODEL", "claude-haiku-4-5-20251001"),
    reviewModel: str("ANTHROPIC_REVIEW_MODEL", "claude-sonnet-4-6"),
    enabled: str("ANTHROPIC_API_KEY").trim().length > 0,
  },

  resend: {
    apiKey: str("RESEND_API_KEY"),
    from: str("ALERT_FROM", "alerts@example.com"),
    to: str("ALERT_TO")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: str("RESEND_API_KEY").trim().length > 0,
  },

  auth: {
    adminEmail: str("ADMIN_EMAIL"),
    adminPassword: str("ADMIN_PASSWORD"),
    secret: str("AUTH_SECRET", "dev-insecure-secret-change-me"),
  },

  cron: {
    uptime: str("UPTIME_CRON", "*/10 * * * *"),
    collect: str("COLLECT_CRON", "0 3 * * 1"),
    audit: str("AUDIT_CRON", "0 4 * * 1"),
  },

  tuning: {
    httpConcurrency: num("HTTP_CONCURRENCY", 8),
    playwrightConcurrency: num("PLAYWRIGHT_CONCURRENCY", 2),
    httpTimeoutMs: num("HTTP_TIMEOUT_MS", 20000),
    auditSamplePct: num("AUDIT_SAMPLE_PCT", 10),
    screenshotDir: str("SCREENSHOT_DIR", "./data/screenshots"),
  },

  publicApiBase: str("PUBLIC_API_BASE", "http://localhost:3000"),
};
