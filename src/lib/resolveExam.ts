import type { Exam, Site } from "@prisma/client";
import { prisma } from "./prisma";
import { groupKeyForSite } from "./groups";

export type MatchConfidence = "exact" | "strong" | "ambiguous" | "none";

export interface ResolvedExam {
  exam: (Exam & { site: Site }) | null;
  confidence: MatchConfidence;
  matchedVia: string; // human-readable explanation of how it matched
  candidates: { examCode: string; examName: string; site: string; score: number }[];
}

/** UPPERCASE alphanumerics only — "ATI TEAS" -> "ATITEAS", "NY-PCL" -> "NYPCL". */
function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Whitespace/normalized tokens of a name, for token-level name matching. */
function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/**
 * Score how well a stored exam matches the requested code. Higher = better.
 * Deliberately conservative: only high scores are auto-accepted; near-ties are
 * reported as ambiguous so the automation can flag them for review instead of
 * silently picking the wrong exam.
 */
function scoreExam(exam: Exam, wantRaw: string): { score: number; via: string } {
  const want = norm(wantRaw);
  const code = norm(exam.examCode);
  if (!want) return { score: 0, via: "" };

  // Exact code (ignoring case/separators).
  if (code === want) return { score: 100, via: "exact code" };

  // Multi-part variant: stored "C213I"/"C213II" for requested "C213".
  if (code.startsWith(want) && /^(I{1,3}|IV|V|VI{0,3}|IX|X)$/.test(code.slice(want.length))) {
    return { score: 80, via: `variant of ${exam.examCode}` };
  }

  // Requested code carries a vendor prefix the stored code omits: "ATITEAS" -> "TEAS".
  // Require the stored code to be a suffix of at least 3 chars.
  if (want.endsWith(code) && code.length >= 3) return { score: 72, via: `code "${exam.examCode}" is a suffix of "${wantRaw}"` };

  // Stored code carries a prefix the request omits: request "TEAS" vs stored "ATITEAS".
  if (code.endsWith(want) && want.length >= 3) return { score: 70, via: `request is a suffix of code "${exam.examCode}"` };

  // The requested token appears whole inside the exam name
  // ("TEAS" in "Test of Essential Academic Skills - TEAS").
  if (nameTokens(exam.examName).has(want)) return { score: 60, via: "matched a word in the exam name" };

  // The timed slug ends with the code ("…-c720" for "C720").
  if (exam.timedSlug && norm(exam.timedSlug).endsWith(want) && want.length >= 3) {
    return { score: 68, via: `timed slug ends with "${wantRaw}"` };
  }

  return { score: 0, via: "" };
}

/**
 * Resolve a requested exam code to a single exam within a site (falling back to
 * the site's brand group for shared exams, e.g. OAP<->OAG). Returns the best
 * match with a confidence level and, when unsure, the candidate list.
 */
export async function resolveExam(siteKey: string, wantCode: string): Promise<ResolvedExam> {
  const empty: ResolvedExam = { exam: null, confidence: "none", matchedVia: "no exam matched", candidates: [] };
  if (!wantCode) return empty;

  // Search this site first; if nothing strong, widen to the brand group.
  const site = await prisma.site.findUnique({ where: { key: siteKey } });
  if (!site) return empty;

  const scan = async (where: object) => {
    const exams = await prisma.exam.findMany({ where: { ...where, status: { not: "stale" } }, include: { site: true } });
    return exams
      .map((e) => ({ e, ...scoreExam(e, wantCode) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  };

  let ranked = await scan({ siteId: site.id });
  let scope = "site";
  if (ranked.length === 0 || ranked[0].score < 100) {
    const groupKey = groupKeyForSite(siteKey);
    const grp = await prisma.siteGroup.findUnique({ where: { key: groupKey } });
    if (grp) {
      const groupRanked = await scan({ site: { groupId: grp.id } });
      // Prefer same-site match if it ties the group's best.
      if (groupRanked.length && (ranked.length === 0 || groupRanked[0].score > ranked[0].score)) {
        ranked = groupRanked;
        scope = "group";
      }
    }
  }

  if (ranked.length === 0) return empty;

  const top = ranked[0];
  const candidates = ranked.slice(0, 5).map((r) => ({ examCode: r.e.examCode, examName: r.e.examName, site: r.e.site.key, score: r.score }));

  // Confidence: exact code = exact; a clear single strong winner = strong;
  // a near-tie between different exams = ambiguous.
  const runnerUp = ranked[1];
  const ambiguous = runnerUp && runnerUp.e.examCode !== top.e.examCode && top.score - runnerUp.score < 15;

  if (top.score >= 100) {
    return { exam: top.e, confidence: "exact", matchedVia: `${top.via}${scope === "group" ? " (via brand group)" : ""}`, candidates };
  }
  if (ambiguous) {
    return { exam: null, confidence: "ambiguous", matchedVia: `multiple exams score similarly for "${wantCode}"`, candidates };
  }
  return { exam: top.e, confidence: "strong", matchedVia: `${top.via}${scope === "group" ? " (via brand group)" : ""}`, candidates };
}
