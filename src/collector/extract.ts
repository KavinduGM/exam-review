import * as cheerio from "cheerio";
import { TIMED_HOST } from "@/config/sites";

export interface ExtractedExam {
  landingUrl: string;
  title: string;
  examCode: string | null;
  practiceUrl: string | null; // the real href on the page (set=1&part=1)
  practiceSource: "NEW" | "OLD" | "NONE";
  timedUrl: string | null; // .../exam_sets/{slug}/set-1
  timedSlug: string | null;
  contactUrl: string | null;
}

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

  const practiceUrl = hrefs.find((h) => /\/practice-questions\//i.test(h)) ?? null;
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
      examCode = u.searchParams.get("ec");
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
    practiceSource,
    timedUrl,
    timedSlug,
    contactUrl,
  };
}
