import type { Site } from "@prisma/client";
import * as cheerio from "cheerio";
import { fetchUrl } from "@/lib/http";
import { logger } from "@/lib/logger";
import { listTimedBackLinks } from "@/sources";
import { discoverSitemap, extractSitemap } from "./sitemap";

// These exam-prep sites have NO sitemap (confirmed: /sitemap.xml 404, no robots
// directive). Landing pages are instead listed on an /exams index page, and the
// timed DB stores each landing URL in back_link. So discovery layers several
// strategies and the collector extract-tests every candidate.

function mainHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function sameSite(url: string, host: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return h === host;
  } catch {
    return false;
  }
}

/** Same-domain page links from an HTML document (resolved to absolute). */
function sameDomainLinks(pageUrl: string, html: string, host: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, pageUrl);
      abs.hash = "";
      if (sameSite(abs.toString(), host)) out.add(abs.toString());
    } catch {
      /* ignore */
    }
  });
  return [...out];
}

/** Find index pages that list exams: the homepage, /exams, and any homepage link
 *  whose href/text mentions "exam". */
async function findIndexPages(baseUrl: string, host: string): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const indexes = new Set<string>([base + "/", base + "/exams"]);

  const home = await fetchUrl(base + "/");
  if (home.ok && home.body) {
    const $ = cheerio.load(home.body);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().toLowerCase();
      if (!href) return;
      if (/exam/i.test(href) || text.includes("exam")) {
        try {
          const abs = new URL(href, base + "/");
          if (sameSite(abs.toString(), host)) indexes.add(abs.toString());
        } catch {
          /* ignore */
        }
      }
    });
  }
  return [...indexes];
}

/**
 * Gather candidate landing-page URLs for a site using all available strategies.
 * The collector then fetches each and keeps only real exam landing pages.
 */
export async function discoverCandidateUrls(site: Site): Promise<string[]> {
  const host = mainHost(site.baseUrl);
  const candidates = new Set<string>();

  // 1) Sitemap, if the site happens to have one (or an explicit URL is set).
  const sm = site.sitemapUrl || (await discoverSitemap(site.baseUrl));
  if (sm) {
    const urls = await extractSitemap(sm);
    urls.forEach((u) => candidates.add(u));
    logger.info({ site: site.key, count: urls.length }, "discovery: sitemap");
  }

  // 2) Index-page crawl (homepage + /exams + exam-mentioning links).
  const indexes = await findIndexPages(site.baseUrl, host);
  for (const idx of indexes) {
    const res = await fetchUrl(idx);
    if (res.ok && res.body) sameDomainLinks(idx, res.body, host).forEach((u) => candidates.add(u));
  }
  logger.info({ site: site.key, indexes: indexes.length }, "discovery: index crawl");

  // 3) Timed DB back_links that belong to this site.
  const backLinks = (await listTimedBackLinks()).filter((b) => sameSite(b, host));
  backLinks.forEach((u) => candidates.add(u));
  if (backLinks.length) logger.info({ site: site.key, count: backLinks.length }, "discovery: timed back_links");

  return [...candidates];
}

const ASSET_RE = /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|xml|ico|woff2?|ttf|zip|mp4)(\?|$)/i;

/** Every same-domain page of a site (sitemap + homepage links). For SIMPLE (uptime) sites. */
export async function discoverAllPages(site: { baseUrl: string; sitemapUrl: string | null }): Promise<string[]> {
  const host = mainHost(site.baseUrl);
  const pages = new Set<string>();

  const sm = site.sitemapUrl || (await discoverSitemap(site.baseUrl));
  if (sm) {
    for (const u of await extractSitemap(sm)) if (sameSite(u, host) && !ASSET_RE.test(u)) pages.add(u.replace(/#.*$/, ""));
  }

  const home = await fetchUrl(site.baseUrl.replace(/\/+$/, "") + "/");
  if (home.ok && home.body) for (const u of sameDomainLinks(site.baseUrl, home.body, host)) if (!ASSET_RE.test(u)) pages.add(u);

  // Always include the homepage itself.
  pages.add(site.baseUrl.replace(/\/+$/, "") + "/");
  return [...pages];
}
