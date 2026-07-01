import { XMLParser } from "fast-xml-parser";
import { fetchUrl } from "@/lib/http";
import { logger } from "@/lib/logger";

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Extract every page URL reachable from a sitemap URL.
 * Handles <sitemapindex> (nested sitemaps) recursively and <urlset> leaves.
 * This is the "add a URL, get the sitemap extracted" feature.
 */
export async function extractSitemap(sitemapUrl: string, depth = 0): Promise<string[]> {
  if (depth > 4) return []; // guard against cyclic / pathological nesting
  const res = await fetchUrl(sitemapUrl);
  if (!res.ok || !res.body) {
    logger.warn({ sitemapUrl, status: res.status }, "sitemap fetch failed");
    return [];
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(res.body) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, sitemapUrl }, "sitemap parse failed");
    return [];
  }

  // Sitemap index -> recurse into each child sitemap.
  const index = doc.sitemapindex as { sitemap?: unknown } | undefined;
  if (index?.sitemap) {
    const children = asArray<{ loc?: string }>(index.sitemap as { loc?: string }[]);
    const nested = await Promise.all(
      children.map((c) => (c.loc ? extractSitemap(c.loc, depth + 1) : Promise.resolve([]))),
    );
    return dedupe(nested.flat());
  }

  // Leaf urlset.
  const urlset = doc.urlset as { url?: unknown } | undefined;
  if (urlset?.url) {
    const urls = asArray<{ loc?: string }>(urlset.url as { loc?: string }[]);
    return dedupe(urls.map((u) => u.loc).filter((l): l is string => Boolean(l)));
  }

  return [];
}

/**
 * Discover a site's sitemap from its base URL when one isn't explicitly given.
 * Tries common locations and robots.txt.
 */
export async function discoverSitemap(baseUrl: string): Promise<string | null> {
  const base = baseUrl.replace(/\/+$/, "");

  // 1) robots.txt "Sitemap:" directives.
  const robots = await fetchUrl(`${base}/robots.txt`);
  if (robots.ok && robots.body) {
    const match = robots.body.match(/^\s*sitemap:\s*(\S+)/im);
    if (match) return match[1].trim();
  }

  // 2) Common conventional locations.
  for (const path of ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap-index.xml"]) {
    const res = await fetchUrl(`${base}${path}`, { method: "HEAD" });
    if (res.ok) return `${base}${path}`;
  }

  return null;
}

/** Get all page URLs for a site, using an explicit sitemap or discovering one. */
export async function getSiteUrls(baseUrl: string, sitemapUrl?: string | null): Promise<string[]> {
  const sm = sitemapUrl || (await discoverSitemap(baseUrl));
  if (!sm) {
    logger.warn({ baseUrl }, "no sitemap found");
    return [];
  }
  return extractSitemap(sm);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
