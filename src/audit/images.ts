import * as cheerio from "cheerio";
import { fetchUrl, mapLimit } from "@/lib/http";

export interface BrokenImage {
  src: string;
  status: number;
  reason: string;
}

export interface ImageCheckResult {
  total: number;
  broken: BrokenImage[];
}

/**
 * Verify every <img> on a page actually loads. Catches "lost" CTA banner images
 * that leave a broken-image placeholder even though the page returns HTTP 200.
 * Uses HEAD (falling back to a bodyless GET) and requires an image/* content-type.
 */
export async function checkImages(pageUrl: string, html: string, opts: { max?: number } = {}): Promise<ImageCheckResult> {
  const $ = cheerio.load(html);
  const srcs = new Set<string>();

  $("img").each((_, el) => {
    const raw =
      $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("data-original");
    if (!raw || raw.startsWith("data:")) return; // inline data URIs always render
    try {
      srcs.add(new URL(raw, pageUrl).toString());
    } catch {
      /* ignore unparseable src */
    }
  });

  const list = [...srcs].slice(0, opts.max ?? 40);
  const broken: BrokenImage[] = [];

  await mapLimit(list, 6, async (src) => {
    let res = await fetchUrl(src, { method: "HEAD", readBody: false });
    // Some servers reject HEAD requests — retry with a bodyless GET.
    if (res.status === 0 || res.status === 405 || res.status === 501) {
      res = await fetchUrl(src, { method: "GET", readBody: false });
    }
    if (res.status === 0) {
      broken.push({ src, status: 0, reason: res.error ?? "request failed" });
    } else if (res.status >= 400) {
      broken.push({ src, status: res.status, reason: `HTTP ${res.status}` });
    } else if (res.contentType && !/^image\//i.test(res.contentType) && !/^application\/octet-stream/i.test(res.contentType)) {
      // 200 but not an image (e.g. an HTML "not found" page served in its place).
      broken.push({ src, status: res.status, reason: `not an image (${res.contentType.split(";")[0]})` });
    }
  });

  return { total: list.length, broken };
}
