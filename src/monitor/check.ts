import type { Exam, Link } from "@prisma/client";
import { fetchUrl } from "@/lib/http";
import { practiceQuestionCount, timedQuestionCount } from "@/sources";

// Strings that indicate a broken page even when HTTP says 200 — the classic
// "server/DB hiccup makes the page look down" case. Tune as needed.
const ERROR_MARKERS = [
  "fatal error",
  "parse error",
  "uncaught",
  "sqlstate",
  "mysqli",
  "database connection",
  "too many connections",
  "call to undefined",
  "warning: ",
  "notice: undefined",
  "500 internal server error",
  "503 service",
  "service unavailable",
  "no questions found",
  "no questions available",
  "page not found",
];

// Light, type-specific "this looks alive" heuristics. These are deliberately
// generic; once the real page templates are in hand, set precise CSS/text
// markers per link in Link.expectedMarkers to harden these checks.
const POSITIVE_HINTS: Record<string, string[]> = {
  PRACTICE: ["question", "option", "answer"],
  TIMED: ["question", "exam", "submit"],
  LANDING: ["practice", "exam", "contact"],
  CONTACT: ["contact", "message", "email"],
};

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

function checkContent(type: string, html: string, expectedMarkers: unknown): boolean | null {
  if (!html) return null;
  const lower = html.toLowerCase();

  // Any explicit error marker => unhealthy.
  if (ERROR_MARKERS.some((m) => lower.includes(m))) return false;

  // Custom markers configured on the link take precedence.
  const markers = parseMarkers(expectedMarkers);
  if (markers.length > 0) {
    return markers.every((m) => lower.includes(m.toLowerCase()));
  }

  // Otherwise require at least one type-specific positive hint.
  const hints = POSITIVE_HINTS[type] ?? [];
  if (hints.length === 0) return true;
  return hints.some((h) => lower.includes(h));
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
