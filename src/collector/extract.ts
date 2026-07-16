import * as cheerio from "cheerio";
import { TIMED_HOST } from "@/config/sites";

export interface ExtractedExam {
  landingUrl: string;
  title: string;
  examCode: string | null;
  practiceUrl: string | null; // the real href on the page
  practiceFormat: PracticeFormat | null; // how to enumerate set/part from practiceUrl
  practiceSource: "NEW" | "OLD" | "NONE";
  timedUrl: string | null; // .../exam_sets/{slug}/set-1
  timedSlug: string | null;
  contactUrl: string | null;
}

// Two practice-link shapes exist across the sites:
//   query: …/practice-questions/C/?ec=CODE&set=1&part=1   (newer exams)
//   path:  …/classes/{code}/set1-part1.html               (older static pages)
export type PracticeFormat = "query" | "path";

/**
 * Parse a landing page and pull out the real practice / timed / contact links.
 * We trust the page's own hrefs rather than reconstructing URLs by rule, so all
 * the per-site quirks (questions. vs answers., /code vs /exams/CODE, odd slugs)
 * are handled automatically.
 */
export function extractExamFromLanding(landingUrl: string, html: string): ExtractedExam | null {
  const $ = cheerio.load(html);
  const title = ($("h1").first().text() || $("title").first().text() || "").trim();

  const hrefs: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      hrefs.push(new URL(href, landingUrl).toString());
    } catch {
      /* ignore unparseable hrefs */
    }
  });

  // Practice link may be the query format (…/practice-questions/…?ec=) or the
  // older path format (…/classes/{code}/set1-part1.html). Prefer query when both
  // appear; fall back to path.
  const practiceQueryUrl = hrefs.find((h) => /\/practice-questions\//i.test(h)) ?? null;
  const practicePathUrl = hrefs.find((h) => /\/classes\/[^/]+\/set\d+-part\d+/i.test(h)) ?? null;
  const practiceUrl = practiceQueryUrl ?? practicePathUrl;
  const practiceFormat: PracticeFormat | null = practiceQueryUrl ? "query" : practicePathUrl ? "path" : null;

  const timedUrl =
    hrefs.find((h) => h.includes(TIMED_HOST) && /\/exam_sets\//i.test(h)) ?? null;
  const contactUrl = hrefs.find((h) => /\/contact\/?($|\?|#)/i.test(h)) ?? null;

  // Not an exam landing page if it links to neither practice nor timed.
  if (!practiceUrl && !timedUrl) return null;

  let examCode: string | null = null;
  let practiceSource: "NEW" | "OLD" | "NONE" = "NONE";
  if (practiceUrl) {
    try {
      const u = new URL(practiceUrl);
      // query format carries ?ec=CODE; path format carries the code as the
      // /classes/{code}/ segment.
      examCode = u.searchParams.get("ec") ?? (u.pathname.match(/\/classes\/([^/]+)\//i)?.[1]?.toUpperCase() ?? null);
      // answers.* = OLD DB, questions.* (and everything else) = NEW DB.
      practiceSource = /(^|\.)answers\./i.test(u.hostname) ? "OLD" : "NEW";
    } catch {
      /* ignore */
    }
  }

  let timedSlug: string | null = null;
  if (timedUrl) {
    const m = timedUrl.match(/\/exam_sets\/([^/]+)\//i) ?? timedUrl.match(/\/exam_sets\/([^/?#]+)/i);
    if (m) timedSlug = decodeURIComponent(m[1]);
  }

  return {
    landingUrl,
    title,
    examCode: examCode ? examCode.trim() : null,
    practiceUrl,
    practiceFormat,
    practiceSource,
    timedUrl,
    timedSlug,
    contactUrl,
  };
}
