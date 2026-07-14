import type { Exam, Link, Site } from "@prisma/client";
import { fetchUrl } from "@/lib/http";

type FlowItem = { link: Link & { exam: Exam & { site: Site } }; status: string };

export interface FlowResult {
  examId: number;
  examCode: string;
  examName: string;
  siteKey: string;
  variant: string; // questions / answers
  totalParts: number;
  upParts: number;
  firstBroken: string | null; // e.g. "Set 2 Part 3", or null
  homeUrl: string;
  homeOk: boolean;
  ok: boolean;
}

/**
 * Structural practice-flow review. For each exam + subdomain, walk the expected
 * Set→Part sequence and confirm every step is healthy, then confirm the final
 * home page (end of flow) loads. Can't follow the real post-CAPTCHA redirect, so
 * it verifies the expected next URLs + home rather than the server's redirect.
 */
export async function reviewPracticeFlows(items: FlowItem[]): Promise<FlowResult[]> {
  // Group the PRACTICE links by exam + subdomain variant.
  const groups = new Map<string, FlowItem[]>();
  for (const it of items) {
    if (it.link.type !== "PRACTICE") continue;
    const key = `${it.link.examId}:${it.link.variant}`;
    const arr = groups.get(key);
    if (arr) arr.push(it);
    else groups.set(key, [it]);
  }

  const homeCache = new Map<string, boolean>();
  const results: FlowResult[] = [];

  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.link.setNo - b.link.setNo || a.link.part - b.link.part);
    const exam = sorted[0].link.exam;

    let upParts = 0;
    let firstBroken: string | null = null;
    for (const it of sorted) {
      if (it.status === "up") upParts++;
      else if (!firstBroken) firstBroken = `Set ${it.link.setNo} Part ${it.link.part}`;
    }

    // End-of-flow: the practice subdomain's home page must load (no 404).
    let homeUrl = "";
    let homeOk = false;
    try {
      homeUrl = new URL(sorted[0].link.url).origin + "/";
      if (homeCache.has(homeUrl)) {
        homeOk = homeCache.get(homeUrl)!;
      } else {
        const res = await fetchUrl(homeUrl);
        homeOk = res.ok;
        homeCache.set(homeUrl, homeOk);
      }
    } catch {
      /* leave homeOk false */
    }

    results.push({
      examId: exam.id,
      examCode: exam.examCode,
      examName: exam.examName,
      siteKey: exam.site.key,
      variant: sorted[0].link.variant || "questions",
      totalParts: sorted.length,
      upParts,
      firstBroken,
      homeUrl,
      homeOk,
      ok: firstBroken === null && homeOk,
    });
  }

  return results;
}
