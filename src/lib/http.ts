import { env } from "./env";

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  body: string;
  error?: string;
}

// A realistic browser UA — some CDNs/WAFs (Cloudflare) block non-browser agents.
// The definitive allow is an IP allowlist on the sites (they're first-party), but a
// browser UA avoids UA-based rules too.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** GET a URL with a timeout, returning status + body (never throws). */
export async function fetchUrl(url: string, opts: { method?: string; timeoutMs?: number } = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? env.tuning.httpTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml" },
    });
    const body = opts.method === "HEAD" ? "" : await res.text();
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      ok: res.ok,
      latencyMs: Date.now() - started,
      body,
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
