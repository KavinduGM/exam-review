// Deterministic link construction from DB facts, used as a fallback/enrichment
// when a landing page doesn't expose a link (blocked page, missing CTA, or an
// exam discovered purely from the DB). Extraction from the real page is always
// preferred; these fill the gaps.

import { TIMED_HOST } from "@/config/sites";

/** questions.{domain} (NEW) or answers.{domain} (OLD) + the fixed "C" folder. */
export function constructPracticeUrl(baseUrl: string, source: "NEW" | "OLD", code: string): string | null {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./i, "");
    const sub = source === "OLD" ? "answers" : "questions";
    return `https://${sub}.${host}/practice-questions/C/?ec=${encodeURIComponent(code)}&set=1&part=1`;
  } catch {
    return null;
  }
}

/** onlineexamtest.com/exam_sets/{slug}/set-1 */
export function constructTimedUrl(slug: string): string {
  return timedSetUrl(slug, 1);
}

/** onlineexamtest.com/exam_sets/{slug}/set-{n} */
export function timedSetUrl(slug: string, set: number): string {
  return `https://${TIMED_HOST}/exam_sets/${slug}/set-${set}`;
}

/** Normalize a URL to host+path (no www, no trailing slash, lowercased) for matching. */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./i, "")}${x.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.replace(/\/+$/, "").toLowerCase();
  }
}

/** Registrable-ish host of a URL (no www), for same-site checks. */
export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}
