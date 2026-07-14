import { Prisma, type Site } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchUrl, mapLimit } from "@/lib/http";
import { env } from "@/lib/env";
import { discoverCandidateUrls, discoverAllPages } from "./discover";
import { extractExamFromLanding, type ExtractedExam } from "./extract";
import { enumerateLinks, type GeneratedLink } from "./enumerate";
import { constructPracticeUrl, constructTimedUrl, timedSetUrl, normalizeUrl, hostOf } from "./construct";
import { loadTimedIndex, loadPracticeIndex, type TimedIndexEntry, type PracticeIndexEntry } from "@/sources";
import type { ProgressFn } from "@/lib/progress";

const SKIP_PATTERNS = [
  /\/(wp-content|wp-includes|wp-json|feed|tag|category|author|page\/\d+)\//i,
  /\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf|xml|ico)(\?|$)/i,
  /\/(privacy|terms|about|blog|contact)\/?($|\?)/i,
];
function isCandidate(url: string): boolean {
  return !SKIP_PATTERNS.some((re) => re.test(url));
}

// ── DB inventory (loaded once per run) ───────────────────────────────────────
interface DbIndex {
  connected: boolean;
  timedAll: TimedIndexEntry[];
  timedByBackLink: Map<string, TimedIndexEntry>;
  timedBySlug: Map<string, TimedIndexEntry>;
  practiceAll: PracticeIndexEntry[];
  practiceByCode: Map<string, PracticeIndexEntry>;
}

async function buildDbIndex(): Promise<DbIndex> {
  const [timedAll, practiceAll] = await Promise.all([loadTimedIndex(), loadPracticeIndex()]);
  const timedByBackLink = new Map<string, TimedIndexEntry>();
  const timedBySlug = new Map<string, TimedIndexEntry>();
  for (const t of timedAll) {
    if (t.backLink) timedByBackLink.set(normalizeUrl(t.backLink), t);
    if (t.slug) timedBySlug.set(t.slug, t);
  }
  const practiceByCode = new Map<string, PracticeIndexEntry>();
  for (const p of practiceAll) if (p.source === "OLD") practiceByCode.set(p.examCode, p);
  for (const p of practiceAll) if (p.source === "NEW") practiceByCode.set(p.examCode, p);
  const connected = timedAll.length > 0 || practiceAll.length > 0;
  logger.info({ timed: timedAll.length, practice: practiceAll.length, connected }, "DB index built");
  return { connected, timedAll, timedByBackLink, timedBySlug, practiceAll, practiceByCode };
}

export interface CollectSiteResult {
  siteKey: string;
  siteType: string;
  urlsScanned: number;
  examsFound: number;
  linksUpserted: number;
  dbConnected: boolean;
  dbSeeded: number;
  timedExpected: number;
  timedCollected: number;
  practiceValidated: number;
  errors: string[];
}

function emptyResult(site: Site, dbConnected: boolean): CollectSiteResult {
  return {
    siteKey: site.key,
    siteType: site.type,
    urlsScanned: 0,
    examsFound: 0,
    linksUpserted: 0,
    dbConnected,
    dbSeeded: 0,
    timedExpected: 0,
    timedCollected: 0,
    practiceValidated: 0,
    errors: [],
  };
}

/** Dispatch collection by site type. */
export async function collectSite(site: Site, runId?: number, index?: DbIndex): Promise<CollectSiteResult> {
  const dbIndex = index ?? (await buildDbIndex());
  void runId;
  if (site.type === "SIMPLE") return collectSimpleSite(site, dbIndex);
  if (site.type === "TIMED_HOST") return collectTimedHostSite(site, dbIndex);
  return collectExamSite(site, dbIndex);
}

// ── EXAM sites (the 4 exam-prep sites) ───────────────────────────────────────
async function collectExamSite(site: Site, dbIndex: DbIndex): Promise<CollectSiteResult> {
  const log = logger.child({ site: site.key });
  const result = emptyResult(site, dbIndex.connected);

  const urls = (await discoverCandidateUrls(site)).filter(isCandidate);
  result.urlsScanned = urls.length;
  log.info({ count: urls.length }, "candidate URLs discovered");

  const seenExamIds: number[] = [];
  const seenLandings = new Set<string>();

  await mapLimit(urls, env.tuning.httpConcurrency, async (url) => {
    const res = await fetchUrl(url);
    if (!res.ok || !res.body) return;
    const extracted = extractExamFromLanding(url, res.body);
    if (!extracted) return;
    try {
      const r = await upsertExam(site, extracted, dbIndex);
      seenExamIds.push(r.examId);
      seenLandings.add(normalizeUrl(url));
      result.examsFound++;
      result.linksUpserted += r.linkCount;
      if (r.timedVerified) result.timedCollected++;
      if (r.practiceVerified) result.practiceValidated++;
    } catch (err) {
      result.errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // DB-seed timed exams the crawl missed for this site.
  const host = hostOf(site.baseUrl);
  const timedForSite = dbIndex.timedAll.filter((t) => t.backLink && hostOf(t.backLink) === host);
  result.timedExpected = timedForSite.length;
  for (const t of timedForSite) {
    if (!t.backLink || seenLandings.has(normalizeUrl(t.backLink))) continue;
    try {
      const r = await seedExamFromTimed(site, t, dbIndex);
      seenExamIds.push(r.examId);
      seenLandings.add(normalizeUrl(t.backLink));
      result.examsFound++;
      result.dbSeeded++;
      result.linksUpserted += r.linkCount;
      if (r.timedVerified) result.timedCollected++;
      if (r.practiceVerified) result.practiceValidated++;
    } catch (err) {
      result.errors.push(`seed ${t.backLink}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await markStale(site, seenExamIds);
  log.info(result, "exam site collection complete");
  return result;
}

// ── SIMPLE sites (uptime of every page, e.g. a blog) ─────────────────────────
async function collectSimpleSite(site: Site, dbIndex: DbIndex): Promise<CollectSiteResult> {
  const log = logger.child({ site: site.key });
  const result = emptyResult(site, dbIndex.connected);

  const pages = await discoverAllPages(site);
  result.urlsScanned = pages.length;
  log.info({ count: pages.length }, "pages discovered (simple site)");

  const seen: number[] = [];
  await mapLimit(pages, env.tuning.httpConcurrency, async (url) => {
    try {
      const examId = await writeExam({
        site,
        examCode: pageCode(url),
        examName: pageName(url),
        landingUrl: url,
        practiceUrl: null,
        practiceSource: "NONE",
        timedUrl: null,
        timedSlug: null,
        contactUrl: null,
        setsCount: 0,
        partsCount: 0,
        timedSetsCount: 0,
        practiceDbExamId: null,
        timedDbExamId: null,
        notes: [],
      });
      await syncLinksList(examId, [{ type: "LANDING", setNo: 0, part: 0, url }]);
      seen.push(examId);
      result.examsFound++;
      result.linksUpserted++;
    } catch (err) {
      result.errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  await markStale(site, seen);
  log.info(result, "simple site collection complete");
  return result;
}

// ── TIMED_HOST (onlineexamtest.com: exams from the timed DB) ──────────────────
async function collectTimedHostSite(site: Site, dbIndex: DbIndex): Promise<CollectSiteResult> {
  const log = logger.child({ site: site.key });
  const result = emptyResult(site, dbIndex.connected);

  let entries: { slug: string; examName: string; setsCount: number; dbExamId: number | null }[] = dbIndex.timedAll.map((t) => ({
    slug: t.slug,
    examName: t.examName,
    setsCount: t.setsCount,
    dbExamId: t.dbExamId,
  }));

  // Fallback when the timed DB isn't connected: crawl exam_sets links off the site.
  if (entries.length === 0) {
    entries = await crawlTimedHost(site);
    log.info({ count: entries.length }, "timed host: DB not connected, crawled exam_sets");
  }

  result.urlsScanned = entries.length;
  result.timedExpected = entries.length;

  const seen: number[] = [];
  for (const t of entries) {
    const sets = t.setsCount > 0 ? t.setsCount : site.defaultTimedSets;
    const links: GeneratedLink[] = [];
    for (let i = 1; i <= sets; i++) links.push({ type: "TIMED", setNo: i, part: 0, url: timedSetUrl(t.slug, i) });
    try {
      const examId = await writeExam({
        site,
        examCode: t.slug,
        examName: t.examName || t.slug,
        landingUrl: timedSetUrl(t.slug, 1),
        practiceUrl: null,
        practiceSource: "NONE",
        timedUrl: timedSetUrl(t.slug, 1),
        timedSlug: t.slug,
        contactUrl: null,
        setsCount: 0,
        partsCount: 0,
        timedSetsCount: sets,
        practiceDbExamId: null,
        timedDbExamId: t.dbExamId,
        notes: [],
      });
      await syncLinksList(examId, links);
      seen.push(examId);
      result.examsFound++;
      result.timedCollected++;
      result.linksUpserted += links.length;
    } catch (err) {
      result.errors.push(`${t.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await markStale(site, seen);
  log.info(result, "timed host collection complete");
  return result;
}

async function crawlTimedHost(site: Site): Promise<{ slug: string; examName: string; setsCount: number; dbExamId: number | null }[]> {
  const pages = await discoverAllPages(site);
  const slugs = new Set<string>();
  for (const u of pages) {
    const m = u.match(/\/exam_sets\/([^/?#]+)/i);
    if (m) slugs.add(decodeURIComponent(m[1]));
  }
  return [...slugs].map((slug) => ({ slug, examName: slug, setsCount: 0, dbExamId: null }));
}

// ── EXAM-site upsert (extract + DB enrich + construct) ───────────────────────
interface UpsertResult {
  examId: number;
  linkCount: number;
  practiceVerified: boolean;
  timedVerified: boolean;
}

async function upsertExam(site: Site, ex: ExtractedExam, dbIndex: DbIndex): Promise<UpsertResult> {
  const practiceInfo = ex.examCode ? dbIndex.practiceByCode.get(ex.examCode) : undefined;
  const timedInfo =
    (ex.timedSlug ? dbIndex.timedBySlug.get(ex.timedSlug) : undefined) ?? dbIndex.timedByBackLink.get(normalizeUrl(ex.landingUrl));

  let practiceUrl = ex.practiceUrl;
  let practiceSource = ex.practiceSource;
  const constructed: string[] = [];
  if (!practiceUrl && practiceInfo) {
    practiceSource = practiceInfo.source;
    practiceUrl = constructPracticeUrl(site.baseUrl, practiceInfo.source, ex.examCode ?? practiceInfo.examCode);
    if (practiceUrl) constructed.push("practice");
  }
  let timedUrl = ex.timedUrl;
  let timedSlug = ex.timedSlug;
  if (!timedUrl && timedInfo) {
    timedSlug = timedInfo.slug;
    timedUrl = constructTimedUrl(timedInfo.slug);
    constructed.push("timed");
  }
  const contactUrl = ex.contactUrl ?? timedInfo?.contactLink ?? null;

  const setsCount = practiceInfo?.setsCount && practiceInfo.setsCount > 0 ? practiceInfo.setsCount : site.defaultSets;
  const timedSetsCount = timedInfo?.setsCount && timedInfo.setsCount > 0 ? timedInfo.setsCount : site.defaultTimedSets;
  const partsCount = site.defaultParts;

  const examCode = ex.examCode ?? timedSlug ?? new URL(ex.landingUrl).pathname.replace(/\W+/g, "-");
  const examName = timedInfo?.examName || practiceInfo?.examName || ex.title || examCode;

  const notes: string[] = [];
  if (dbIndex.connected) {
    if (ex.examCode && !practiceInfo) notes.push("not in practice DB");
    if (ex.timedSlug && !timedInfo) notes.push("timed slug not in DB");
    if (timedInfo?.backLink && normalizeUrl(timedInfo.backLink) !== normalizeUrl(ex.landingUrl))
      notes.push(`timed back_link differs: ${timedInfo.backLink}`);
    if (constructed.length) notes.push(`built from DB: ${constructed.join(", ")}`);
  }

  const examId = await writeExam({
    site,
    examCode,
    examName,
    landingUrl: ex.landingUrl,
    practiceUrl,
    practiceSource,
    timedUrl,
    timedSlug,
    contactUrl,
    setsCount,
    partsCount,
    timedSetsCount,
    practiceDbExamId: practiceInfo?.dbExamId ?? null,
    timedDbExamId: timedInfo?.dbExamId ?? null,
    notes,
  });

  const linkCount = await syncLinks(examId, {
    landingUrl: ex.landingUrl,
    practiceUrl,
    timedUrl,
    contactUrl,
    setsCount,
    partsCount,
    timedSetsCount,
  });

  return { examId, linkCount, practiceVerified: Boolean(practiceInfo), timedVerified: Boolean(timedInfo) };
}

async function seedExamFromTimed(site: Site, t: TimedIndexEntry, dbIndex: DbIndex): Promise<UpsertResult> {
  const landingUrl = t.backLink as string;
  const res = await fetchUrl(landingUrl);
  if (res.ok && res.body) {
    const extracted = extractExamFromLanding(landingUrl, res.body);
    if (extracted) return upsertExam(site, extracted, dbIndex);
  }
  const code = deriveCode(landingUrl, t.slug, dbIndex.practiceByCode);
  const practice = code ? dbIndex.practiceByCode.get(code) : undefined;
  const synthetic: ExtractedExam = {
    landingUrl,
    title: t.examName,
    examCode: code,
    practiceUrl: code && practice ? constructPracticeUrl(site.baseUrl, practice.source, code) : null,
    practiceSource: practice?.source ?? "NONE",
    timedUrl: constructTimedUrl(t.slug),
    timedSlug: t.slug,
    contactUrl: t.contactLink,
  };
  return upsertExam(site, synthetic, dbIndex);
}

function deriveCode(landingUrl: string, slug: string, byCode: Map<string, PracticeIndexEntry>): string | null {
  const candidates: string[] = [];
  try {
    const seg = decodeURIComponent(new URL(landingUrl).pathname.split("/").filter(Boolean).pop() ?? "");
    if (seg) candidates.push(seg, seg.toUpperCase(), seg.toLowerCase());
  } catch {
    /* ignore */
  }
  const m = slug.match(/-([a-z]\d{2,4})$/i);
  if (m) candidates.push(m[1].toUpperCase(), m[1].toLowerCase());
  for (const c of candidates) if (byCode.has(c)) return c;
  return null;
}

// ── DB writes ────────────────────────────────────────────────────────────────
interface ExamWrite {
  site: Site;
  examCode: string;
  examName: string;
  landingUrl: string;
  practiceUrl: string | null;
  practiceSource: "NEW" | "OLD" | "NONE";
  timedUrl: string | null;
  timedSlug: string | null;
  contactUrl: string | null;
  setsCount: number;
  partsCount: number;
  timedSetsCount: number;
  practiceDbExamId: number | null;
  timedDbExamId: number | null;
  notes: string[];
}

async function writeExam(w: ExamWrite): Promise<number> {
  const data = {
    examName: w.examName,
    landingUrl: w.landingUrl,
    practiceBaseUrl: w.practiceUrl,
    practiceSource: w.practiceSource,
    timedBaseUrl: w.timedUrl,
    timedSlug: w.timedSlug,
    contactUrl: w.contactUrl,
    setsCount: w.setsCount,
    partsCount: w.partsCount,
    timedSetsCount: w.timedSetsCount,
    practiceDbExamId: w.practiceDbExamId,
    timedDbExamId: w.timedDbExamId,
    notes: w.notes.length ? w.notes.join("; ") : null,
    status: "active",
    lastSeenAt: new Date(),
  };
  const exam = await prisma.exam.upsert({
    where: { siteId_examCode: { siteId: w.site.id, examCode: w.examCode } },
    create: { siteId: w.site.id, examCode: w.examCode, ...data },
    update: data,
  });
  return exam.id;
}

async function syncLinks(
  examId: number,
  input: {
    landingUrl: string;
    practiceUrl: string | null;
    timedUrl: string | null;
    contactUrl: string | null;
    setsCount: number;
    partsCount: number;
    timedSetsCount: number;
  },
): Promise<number> {
  return syncLinksList(examId, enumerateLinks(input));
}

/** Upsert the given link set for an exam and deactivate links no longer present. */
async function syncLinksList(examId: number, generated: GeneratedLink[]): Promise<number> {
  const currentKeys = new Set<string>();
  for (const g of generated) {
    currentKeys.add(`${g.type}:${g.setNo}:${g.part}`);
    await prisma.link.upsert({
      where: { examId_type_setNo_part: { examId, type: g.type, setNo: g.setNo, part: g.part } },
      create: { examId, type: g.type, setNo: g.setNo, part: g.part, url: g.url, active: true },
      update: { url: g.url, active: true },
    });
  }
  const existing = await prisma.link.findMany({ where: { examId }, select: { id: true, type: true, setNo: true, part: true } });
  const toDeactivate = existing.filter((l) => !currentKeys.has(`${l.type}:${l.setNo}:${l.part}`)).map((l) => l.id);
  if (toDeactivate.length) await prisma.link.updateMany({ where: { id: { in: toDeactivate } }, data: { active: false } });
  return generated.length;
}

async function markStale(site: Site, seenIds: number[]): Promise<void> {
  if (seenIds.length > 0) {
    await prisma.exam.updateMany({ where: { siteId: site.id, id: { notIn: seenIds } }, data: { status: "stale" } });
  }
}

function pageCode(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    return (p === "" ? "home" : p.replace(/^\/+/, "").replace(/\W+/g, "-")).slice(0, 180) || "home";
  } catch {
    return url.replace(/\W+/g, "-").slice(0, 180);
  }
}

function pageName(url: string): string {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    return p === "" ? "Home" : decodeURIComponent(p.split("/").filter(Boolean).pop() ?? p);
  } catch {
    return url;
  }
}

/** Collect every active site. Records a COLLECT run with a coverage summary. */
export async function collectAllSites(onProgress?: ProgressFn): Promise<CollectSiteResult[]> {
  const run = await prisma.checkRun.create({ data: { type: "COLLECT" } });
  const dbIndex = await buildDbIndex();
  const sites = await prisma.site.findMany({ where: { active: true } });
  const results: CollectSiteResult[] = [];
  let examsTotal = 0;

  for (let i = 0; i < sites.length; i++) {
    const r = await collectSite(sites[i], run.id, dbIndex);
    results.push(r);
    examsTotal += r.examsFound;
    onProgress?.({
      phase: "collect",
      site: sites[i].key,
      siteIndex: i + 1,
      siteCount: sites.length,
      examsFound: examsTotal,
      linksUpserted: results.reduce((n, x) => n + x.linksUpserted, 0),
    });
  }

  const summary = {
    dbConnected: dbIndex.connected,
    dbTimedExams: dbIndex.timedAll.length,
    dbPracticeExams: dbIndex.practiceAll.length,
    totalExams: examsTotal,
    perSite: results,
  };
  await prisma.checkRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue },
  });
  return results;
}
