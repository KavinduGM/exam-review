import type { Exam, Link } from "@prisma/client";
import { fetchUrl } from "@/lib/http";
import { practiceQuestionCount, timedQuestionCount } from "@/sources";

// HARD error signatures: server/PHP/DB failure text that legitimate exam content
// won't contain. Deliberately precise — a generic word like "uncaught" or
// "warning:" appears in real question explanations ("errors that go uncaught…")
// and caused false-positive "degraded" flags.
const HARD_ERROR_MARKERS = [
  "fatal error",
  "parse error",
  "uncaught exception",
  "uncaught error",
  "uncaught typeerror",
  "sqlstate",
  "mysqli",
  "database connection",
  "too many connections",
  "call to undefined",
  "warning: include",
  "warning: require",
  "warning: undefined",
  "notice: undefined",
  "500 internal server error",
  "503 service",
  "service unavailable",
];

// SOFT empty-state markers: only count as a failure when the page ALSO lacks a
// strong positive signal (e.g. the empty-state template text is present in the
// markup, but real questions are rendered too).
const SOFT_EMPTY_MARKERS = ["no questions found", "no questions available", "page not found", "nothing found"];

// Light, type-specific "this looks alive" heuristics. These are deliberately
// generic; once the real page templates are in hand, set precise CSS/text
// markers per link in Link.expectedMarkers to harden these checks.
const POSITIVE_HINTS: Record<string, string[]> = {
  PRACTICE: ["question", "option", "answer"],
  TIMED: ["question", "exam", "submit"],
  LANDING: ["practice", "exam", "contact"],
  CONTACT: ["contact", "message", "email"],
};

/** Strip scripts/styles/comments so error scanning sees (roughly) rendered text,
 *  not JS bundles that legitimately contain strings like "Uncaught TypeError". */
function stripNonVisible(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** Strong evidence real content rendered (used to override soft empty markers). */
function hasStrongPositive(type: string, visibleLower: string): boolean {
  if (type === "PRACTICE") return /question\s*\d/.test(visibleLower) || visibleLower.includes("show answer");
  if (type === "TIMED") return /question\s*\d/.test(visibleLower) || visibleLower.includes("start") || visibleLower.includes("submit");
  const hints = POSITIVE_HINTS[type] ?? [];
  return hints.some((h) => visibleLower.includes(h));
}

export interface CheckOutcome {
  httpStatus: number;
  latencyMs: number;
  ok: boolean; // overall health
  contentOk: boolean | null;
  dataOk: boolean | null;
  error?: string;
  body?: string; // returned for Tier-2 reuse
}

/** Run HTTP + content + (optional) data-integrity checks on a single link. */
export async function checkLink(link: Link, exam: Exam, opts: { keepBody?: boolean } = {}): Promise<CheckOutcome> {
  const res = await fetchUrl(link.url);
  const httpOk = res.ok && res.status >= 200 && res.status < 400;

  if (!httpOk) {
    return {
      httpStatus: res.status,
      latencyMs: res.latencyMs,
      ok: false,
      contentOk: null,
      dataOk: null,
      error: res.error ?? `HTTP ${res.status}`,
    };
  }

  const contentOk = checkContent(link.type, res.body, link.expectedMarkers);
  const dataOk = await checkData(link, exam);

  // dataOk === false is a hard failure (page up but data missing). contentOk
  // === false is treated as degraded, not fully down.
  const ok = dataOk !== false && contentOk !== false;

  return {
    httpStatus: res.status,
    latencyMs: res.latencyMs,
    ok,
    contentOk,
    dataOk,
    error: ok ? undefined : contentOk === false ? "content markers missing/error text present" : "data-integrity mismatch",
    body: opts.keepBody ? res.body : undefined,
  };
}

/** Exported for tests. Judges page content from raw HTML. */
export function checkContent(type: string, html: string, expectedMarkers: unknown): boolean | null {
  if (!html) return null;
  const visible = stripNonVisible(html).toLowerCase();

  // Hard server/PHP/DB error text => unhealthy, full stop.
  if (HARD_ERROR_MARKERS.some((m) => visible.includes(m))) return false;

  // Soft empty-state text => unhealthy only when no real content rendered.
  if (SOFT_EMPTY_MARKERS.some((m) => visible.includes(m)) && !hasStrongPositive(type, visible)) return false;

  // Custom markers configured on the link take precedence.
  const markers = parseMarkers(expectedMarkers);
  if (markers.length > 0) {
    return markers.every((m) => visible.includes(m.toLowerCase()));
  }

  // Otherwise require at least one type-specific positive hint.
  const hints = POSITIVE_HINTS[type] ?? [];
  if (hints.length === 0) return true;
  return hints.some((h) => visible.includes(h));
}

function parseMarkers(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (value && typeof value === "object" && Array.isArray((value as { all?: unknown }).all)) {
    return ((value as { all: unknown[] }).all).filter((v): v is string => typeof v === "string");
  }
  return [];
}

/** Cross-check against the source DB: does the underlying data actually exist? */
async function checkData(link: Link, exam: Exam): Promise<boolean | null> {
  if (link.type === "PRACTICE" && exam.practiceDbExamId && link.setNo) {
    const source = exam.practiceSource === "OLD" ? "OLD" : "NEW";
    const n = await practiceQuestionCount(source, exam.practiceDbExamId, link.setNo);
    if (n === null) return null;
    return n > 0;
  }
  if (link.type === "TIMED" && exam.timedDbExamId && link.setNo) {
    const n = await timedQuestionCount(exam.timedDbExamId, link.setNo);
    if (n === null) return null;
    return n > 0;
  }
  return null; // not applicable
}
