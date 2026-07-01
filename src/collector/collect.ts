import { Prisma, type Site } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchUrl, mapLimit } from "@/lib/http";
import { env } from "@/lib/env";
import { discoverCandidateUrls } from "./discover";
import { extractExamFromLanding, type ExtractedExam } from "./extract";
import { enumerateLinks } from "./enumerate";
import { findPracticeExam, findTimedExamBySlug } from "@/sources";

// Sitemap URLs that are obviously not exam landing pages — skip the fetch.
const SKIP_PATTERNS = [
  /\/(wp-content|wp-includes|wp-json|feed|tag|category|author|page\/\d+)\//i,
  /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|xml|ico)(\?|$)/i,
  /\/(privacy|terms|about|blog|contact)\/?($|\?)/i,
];

function isCandidate(url: string): boolean {
  return !SKIP_PATTERNS.some((re) => re.test(url));
}

export interface CollectSiteResult {
  siteKey: string;
  urlsScanned: number;
  examsFound: number;
  linksUpserted: number;
  errors: string[];
}

/** Collect one site: discover landing pages, extract links, cross-validate, upsert. */
export async function collectSite(site: Site, runId?: number): Promise<CollectSiteResult> {
  const log = logger.child({ site: site.key });
  const result: CollectSiteResult = {
    siteKey: site.key,
    urlsScanned: 0,
    examsFound: 0,
    linksUpserted: 0,
    errors: [],
  };

  const urls = (await discoverCandidateUrls(site)).filter(isCandidate);
  result.urlsScanned = urls.length;
  log.info({ count: urls.length }, "candidate URLs discovered");

  const seenExamIds: number[] = [];

  await mapLimit(urls, env.tuning.httpConcurrency, async (url) => {
    const res = await fetchUrl(url);
    if (!res.ok || !res.body) return;

    const extracted = extractExamFromLanding(url, res.body);
    if (!extracted) return;

    try {
      const { examId, linkCount } = await upsertExam(site, extracted);
      seenExamIds.push(examId);
      result.examsFound++;
      result.linksUpserted += linkCount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${url}: ${msg}`);
      log.warn({ err, url }, "upsert failed");
    }
  });

  // Mark exams we didn't see this run as stale (likely removed from the site).
  if (seenExamIds.length > 0) {
    await prisma.exam.updateMany({
      where: { siteId: site.id, id: { notIn: seenExamIds } },
      data: { status: "stale" },
    });
  }

  void runId; // run association is handled by the caller's summary
  log.info(result, "site collection complete");
  return result;
}

async function upsertExam(site: Site, ex: ExtractedExam): Promise<{ examId: number; linkCount: number }> {
  // Cross-validate with source DBs for authoritative counts (best-effort).
  const practiceInfo = ex.examCode ? await findPracticeExam(ex.examCode) : null;
  const timedInfo = ex.timedSlug ? await findTimedExamBySlug(ex.timedSlug) : null;

  const setsCount = practiceInfo?.setsCount && practiceInfo.setsCount > 0 ? practiceInfo.setsCount : site.defaultSets;
  const timedSetsCount =
    timedInfo?.setsCount && timedInfo.setsCount > 0 ? timedInfo.setsCount : site.defaultTimedSets;
  const partsCount = site.defaultParts;

  // A stable code even when there's no practice link (timed-only exams).
  const examCode = ex.examCode ?? ex.timedSlug ?? new URL(ex.landingUrl).pathname.replace(/\W+/g, "-");
  const examName = timedInfo?.examName || practiceInfo?.examName || ex.title || examCode;

  const notes: string[] = [];
  if (practiceInfo && timedInfo) {
    // Surface a count mismatch between practice DB and site default expectations.
    if (practiceInfo.setsCount && practiceInfo.setsCount !== site.defaultSets)
      notes.push(`practice sets=${practiceInfo.setsCount} (default ${site.defaultSets})`);
  }
  if (ex.examCode && !practiceInfo) notes.push("practice DB has no row for this exam_code");
  if (ex.timedSlug && !timedInfo) notes.push("timed DB has no row for this slug");
  if (timedInfo?.backLink && normalize(timedInfo.backLink) !== normalize(ex.landingUrl))
    notes.push(`timed back_link mismatch: ${timedInfo.backLink}`);

  const exam = await prisma.exam.upsert({
    where: { siteId_examCode: { siteId: site.id, examCode } },
    create: {
      siteId: site.id,
      examCode,
      examName,
      landingUrl: ex.landingUrl,
      practiceBaseUrl: ex.practiceUrl,
      practiceSource: ex.practiceSource,
      timedBaseUrl: ex.timedUrl,
      timedSlug: ex.timedSlug,
      contactUrl: ex.contactUrl ?? timedInfo?.contactLink ?? null,
      setsCount,
      partsCount,
      timedSetsCount,
      practiceDbExamId: practiceInfo?.dbExamId ?? null,
      timedDbExamId: timedInfo?.dbExamId ?? null,
      notes: notes.length ? notes.join("; ") : null,
      status: "active",
      lastSeenAt: new Date(),
    },
    update: {
      examName,
      landingUrl: ex.landingUrl,
      practiceBaseUrl: ex.practiceUrl,
      practiceSource: ex.practiceSource,
      timedBaseUrl: ex.timedUrl,
      timedSlug: ex.timedSlug,
      contactUrl: ex.contactUrl ?? timedInfo?.contactLink ?? null,
      setsCount,
      partsCount,
      timedSetsCount,
      practiceDbExamId: practiceInfo?.dbExamId ?? null,
      timedDbExamId: timedInfo?.dbExamId ?? null,
      notes: notes.length ? notes.join("; ") : null,
      status: "active",
      lastSeenAt: new Date(),
    },
  });

  const generated = enumerateLinks({
    landingUrl: ex.landingUrl,
    practiceUrl: ex.practiceUrl,
    timedUrl: ex.timedUrl,
    contactUrl: ex.contactUrl ?? timedInfo?.contactLink ?? null,
    setsCount,
    partsCount,
    timedSetsCount,
  });

  const currentKeys = new Set<string>();
  for (const g of generated) {
    const key = `${g.type}:${g.setNo ?? ""}:${g.part ?? ""}`;
    currentKeys.add(key);
    await prisma.link.upsert({
      where: {
        examId_type_setNo_part: { examId: exam.id, type: g.type, setNo: g.setNo, part: g.part },
      },
      create: { examId: exam.id, type: g.type, setNo: g.setNo, part: g.part, url: g.url, active: true },
      update: { url: g.url, active: true },
    });
  }

  // Deactivate links that no longer apply (e.g. set count shrank).
  const existing = await prisma.link.findMany({ where: { examId: exam.id }, select: { id: true, type: true, setNo: true, part: true } });
  const toDeactivate = existing
    .filter((l) => !currentKeys.has(`${l.type}:${l.setNo ?? ""}:${l.part ?? ""}`))
    .map((l) => l.id);
  if (toDeactivate.length) {
    await prisma.link.updateMany({ where: { id: { in: toDeactivate } }, data: { active: false } });
  }

  return { examId: exam.id, linkCount: generated.length };
}

function normalize(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** Collect every active site. Records a COLLECT run with a summary. */
export async function collectAllSites(): Promise<CollectSiteResult[]> {
  const run = await prisma.checkRun.create({ data: { type: "COLLECT" } });
  const sites = await prisma.site.findMany({ where: { active: true } });
  const results: CollectSiteResult[] = [];
  for (const site of sites) {
    results.push(await collectSite(site, run.id));
  }
  await prisma.checkRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), summary: results as unknown as Prisma.InputJsonValue },
  });
  return results;
}
