import { env } from "./env";

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  body: string;
  contentType?: string;
  retryAfterSec?: number;
  error?: string;
}

// A realistic browser UA — some CDNs/WAFs (Cloudflare) block non-browser agents.
// The definitive allow is an IP allowlist on the sites (they're first-party), but a
// browser UA avoids UA-based rules too.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Per-host politeness ──────────────────────────────────────────────────────
// Some hosts (LiteSpeed/Hostinger shared hosting, WP plugins, WAFs) rate-limit
// bursts with HTTP 429. Cap in-flight requests per host, and once a host 429s,
// drop it to strictly-serial requests with a gap for a cooldown window — staying
// under the limiter beats retrying after tripping it.
const PER_HOST_CONCURRENCY = 3;
const PENALTY_WINDOW_MS = 10 * 60_000; // stay polite for 10 min after a 429
const PENALTY_GAP_MS = 3_000; // min spacing between requests on slow/penalized hosts

interface HostState {
  active: number;
  queue: (() => void)[];
  last429: number;
  lastStart: number;
}
const hostSlots = new Map<string, HostState>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function stateFor(host: string): HostState {
  let s = hostSlots.get(host);
  if (!s) {
    s = { active: 0, queue: [], last429: 0, lastStart: 0 };
    hostSlots.set(host, s);
  }
  return s;
}

const SLOW_HOSTS = new Set(env.tuning.slowHosts);

function isSlow(host: string, s: HostState): boolean {
  return SLOW_HOSTS.has(host.toLowerCase().replace(/^www\./, "")) || Date.now() - s.last429 < PENALTY_WINDOW_MS;
}

function limitFor(host: string, s: HostState): number {
  return isSlow(host, s) ? 1 : PER_HOST_CONCURRENCY;
}

async function acquireHost(host: string): Promise<void> {
  const s = stateFor(host);
  // Loop: the limit can shrink (a 429 arrives) between wake-ups.
  while (s.active >= limitFor(host, s)) {
    await new Promise<void>((resolve) => s.queue.push(resolve));
  }
  s.active++;
  // Slow/penalized hosts additionally get spaced-out requests.
  if (isSlow(host, s)) {
    const wait = s.lastStart + PENALTY_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }
  s.lastStart = Date.now();
}

function releaseHost(host: string): void {
  const s = stateFor(host);
  s.active = Math.max(0, s.active - 1);
  const next = s.queue.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnce(url: string, opts: { method?: string; timeoutMs?: number; readBody?: boolean }): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? env.tuning.httpTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml,image/*" },
    });
    const shouldRead = opts.readBody !== false && opts.method !== "HEAD";
    const body = shouldRead ? await res.text() : "";
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      ok: res.ok,
      latencyMs: Date.now() - started,
      body,
      contentType: res.headers.get("content-type") ?? undefined,
      retryAfterSec: Number(res.headers.get("retry-after")) || undefined,
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      status: 0,
      ok: false,
      latencyMs: Date.now() - started,
      body: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL with a timeout, per-host concurrency cap, and one polite retry on
 *  429/503 (honoring Retry-After, capped at 10s). Never throws. */
export async function fetchUrl(
  url: string,
  opts: { method?: string; timeoutMs?: number; readBody?: boolean } = {},
): Promise<FetchResult> {
  const host = hostOf(url);
  const s = stateFor(host);
  await acquireHost(host);
  try {
    let res = await fetchOnce(url, opts);
    if (res.status === 429 || res.status === 503) {
      s.last429 = Date.now(); // penalize the host: serial + spaced for the window
      const waitMs = Math.min((res.retryAfterSec ?? 5) * 1000, 30_000);
      await sleep(waitMs);
      s.lastStart = Date.now();
      res = await fetchOnce(url, opts);
      if (res.status === 429 || res.status === 503) s.last429 = Date.now();
    }
    return res;
  } finally {
    releaseHost(host);
  }
}

/** Run async tasks with a fixed concurrency limit. Order of results matches input. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
