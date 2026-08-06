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

/**
 * Strong evidence that real content rendered.
 *
 * Deliberately count-based: one stray "Question 1" in a template proves nothing,
 * but a page carrying several question blocks (or answer toggles) is a working
 * page. This is what lets us trust content over vocabulary — see the note on
 * error markers in checkContentVerdict.
 */
function hasStrongPositive(type: string, visibleLower: string): boolean {
  const questionBlocks = (visibleLower.match(/question\s*\d+\s*[:.)]/g) ?? []).length;
  const answerToggles = (visibleLower.match(/show answer/g) ?? []).length;

  if (type === "PRACTICE" || type === "TIMED") return questionBlocks >= 2 || answerToggles >= 1;
  const hints = POSITIVE_HINTS[type] ?? [];
  return hints.some((h) => visibleLower.includes(h));
}

export type LinkStatus = "up" | "degraded" | "down";

export interface CheckOutcome {
  httpStatus: number;
  latencyMs: number;
  ok: boolean; // overall health
  status: LinkStatus; // authoritative severity — callers must use this, not re-derive it
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
    // 429 = the MONITOR got rate-limited, not the page being down for users.
    // Surface it as degraded (contentOk=false) with a clear message so it doesn't
    // fire false "site down" alerts.
    const rateLimited = res.status === 429;
    return {
      httpStatus: res.status,
      latencyMs: res.latencyMs,
      ok: false,
      status: rateLimited ? "degraded" : "down",
      contentOk: rateLimited ? false : null,
      dataOk: null,
      error: rateLimited ? "HTTP 429 (rate limited — monitor throttled, page likely fine for users)" : (res.error ?? `HTTP ${res.status}`),
    };
  }

  const verdict = checkContentVerdict(link.type, res.body, link.expectedMarkers);
  const contentOk = verdict === null ? null : verdict === "ok";
  const dataOk = await checkData(link, exam);
  const ok = dataOk !== false && contentOk !== false;

  // A page that returns 200 but is an outright failure ("Could not load this
  // exam", a PHP/DB error, an empty shell) is USELESS to a visitor — that is
  // DOWN, not merely degraded. Missing markers on an otherwise real page, or a
  // data-integrity mismatch, stay degraded.
  const status: LinkStatus = ok ? "up" : verdict === "broken" ? "down" : "degraded";

  return {
    httpStatus: res.status,
    latencyMs: res.latencyMs,
    ok,
    status,
    contentOk,
    dataOk,
    error: ok
      ? undefined
      : verdict === "broken"
        ? "page loads but is broken (error page / no content)"
        : contentOk === false
          ? "content markers missing"
          : "data-integrity mismatch",
    body: opts.keepBody ? res.body : undefined,
  };
}

export type ContentVerdict = "ok" | "degraded" | "broken";

/** Minimum visible characters before a page can be considered "a real page". */
const MIN_REAL_PAGE_CHARS = 300;

/**
 * Judge page content from raw HTML.
 *   "broken"   — 200 but useless: server/DB error text, an explicit "could not
 *                load" message, an empty-state with nothing rendered, or a
 *                near-empty body. Callers treat this as DOWN.
 *   "degraded" — a real page, but the expected markers aren't there.
 *   "ok"       — looks healthy.
 * Exported for tests.
 */
export function checkContentVerdict(type: string, html: string, expectedMarkers: unknown): ContentVerdict | null {
  if (!html) return null;
  const visible = stripNonVisible(html).toLowerCase();
  const text = visible.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  // CONTENT BEATS VOCABULARY. These are exam-prep sites: an IT/security paper
  // legitimately discusses "service unavailable" (denial-of-service), "uncaught"
  // exceptions, SQL errors and the like. Scanning such a page for error words
  // flagged perfectly good pages as broken. So once we can see real content
  // rendered — several question blocks or answer toggles — the page works, no
  // matter what words the questions contain. Error markers only decide the
  // verdict when there is nothing rendered to look at.
  const strong = hasStrongPositive(type, visible);

  if (!strong) {
    // Hard server/PHP/DB error text => the page is broken, not just degraded.
    if (HARD_ERROR_MARKERS.some((m) => visible.includes(m))) return "broken";

    // Empty-state text with nothing actually rendered => broken (nothing to use).
    if (SOFT_EMPTY_MARKERS.some((m) => visible.includes(m))) return "broken";

    // A near-empty body is a broken page (e.g. a 76-byte error stub with HTTP 200).
    if (text.length < MIN_REAL_PAGE_CHARS) return "broken";
  }

  // Custom markers configured on the link take precedence.
  const markers = parseMarkers(expectedMarkers);
  if (markers.length > 0) {
    return markers.every((m) => visible.includes(m.toLowerCase())) ? "ok" : "degraded";
  }

  // Otherwise require at least one type-specific positive hint.
  const hints = POSITIVE_HINTS[type] ?? [];
  if (hints.length === 0) return "ok";
  return hints.some((h) => visible.includes(h)) ? "ok" : "degraded";
}

/** Boolean view of the verdict (true = healthy). Kept for tests/back-compat. */
export function checkContent(type: string, html: string, expectedMarkers: unknown): boolean | null {
  const v = checkContentVerdict(type, html, expectedMarkers);
  return v === null ? null : v === "ok";
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
  if (link.type === "PRACTICE" && link.setNo) {
    // Pick the source DB from THIS link's subdomain, not the exam's primary one:
    // a dual-subdomain exam lives in both DBs under DIFFERENT ids, so validating
    // an answers.* link against exam_db (or vice versa) produced false failures.
    const source: "NEW" | "OLD" = link.variant
      ? link.variant === "answers"
        ? "OLD"
        : "NEW"
      : exam.practiceSource === "OLD"
        ? "OLD"
        : "NEW";
    const dbExamId =
      (source === "OLD" ? exam.practiceOldDbExamId : exam.practiceNewDbExamId) ??
      // Fall back to the legacy single id only when it belongs to this source.
      (exam.practiceSource === source ? exam.practiceDbExamId : null);
    if (!dbExamId) return null; // unknown in this DB → not a failure, just unverifiable
    const n = await practiceQuestionCount(source, dbExamId, link.setNo);
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
