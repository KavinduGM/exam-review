import { Prisma, type Site } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchUrl, mapLimit } from "@/lib/http";
import { env } from "@/lib/env";
import { discoverCandidateUrls, discoverAllPages } from "./discover";
import { extractExamFromLanding, type ExtractedExam, type PracticeFormat } from "./extract";
import { enumerateLinks, type GeneratedLink, type PracticeBase, type EnumerateInput } from "./enumerate";
import { constructPracticeUrl, constructTimedUrl, timedSetUrl, normalizeUrl, hostOf } from "./construct";
import { loadTimedIndex, loadPracticeIndex, type TimedIndexEntry, type PracticeIndexEntry } from "@/sources";
import { ensureGroups } from "@/lib/groups";
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
  timedByCode: Map<string, TimedIndexEntry>; // UPPER code -> entry (slug-format-proof)
  practiceAll: PracticeIndexEntry[];
  practiceByCode: Map<string, PracticeIndexEntry>; // merged (NEW wins) — for code derivation
  practiceNewByCode: Map<string, PracticeIndexEntry>; // questions.  (exam_db)
  practiceOldByCode: Map<string, PracticeIndexEntry>; // answers.    (answers_db)
  // Canonical exam names from the timed (exam-manager) DB.
  nameByLanding: Map<string, string>; // normalized back_link -> exam_name
  nameByCode: Map<string, string>; // UPPER code (from slug) -> exam_name
}

/** Pull a course code out of a timed slug, e.g. "…-d216" -> "D216". */
function codeFromSlug(slug: string): string | null {
  const m = slug.match(/-([a-z]\d{2,4})(?:$|-)/i) ?? slug.match(/^([a-z]\d{2,4})$/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Robustly pull the course code from a timed slug regardless of where it sits —
 * the exam-manager DB stores it inconsistently: "…-c458" (end), "c458-…" (start),
 * "…---c458" (triple dash). Both slug variants of the same exam still yield the
 * same code, so we match timed exams by code, not by exact slug string.
 */
function timedCode(slug: string): string | null {
  const m = slug.match(/(?:^|-)([a-z]\d{2,4})(?:-|$)/i);
  return m ? m[1].toUpperCase() : null;
}

/** The clean code of a stored exam ("C458", "D471-I" -> "D471"). */
function baseCode(examCode: string): string {
  return examCode.split("-")[0].toUpperCase();
}

/** Pull a course code from a landing path like /c720 or /exams/D426 -> "C720". */
function codeFromLanding(landingUrl: string): string | null {
  try {
    const seg = decodeURIComponent(new URL(landingUrl).pathname.split("/").filter(Boolean).pop() ?? "");
    const m = seg.match(/^([a-z]{1,5}\d{2,4}[a-z]?)$/i); // must be a compact letters+digits token
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Detect a roman-numeral variant in a landing title, e.g. "WGU D471 OA Study
 *  Guide II – 2025" -> "II". Some sites publish several articles for one course
 *  code; without this they'd collapse onto one (site, code) row. */
function romanVariantFromTitle(title: string): string | null {
  const m = title.match(/\b(?:guide|part|vol(?:ume)?\.?)\s+(x?i{1,3}|x?iv|x?v|x?vi{1,3}|ix|x)\b/i);
  return m ? m[1].toUpperCase() : null;
}

async function buildDbIndex(): Promise<DbIndex> {
  const [timedAll, practiceAll] = await Promise.all([loadTimedIndex(), loadPracticeIndex()]);
  const timedByBackLink = new Map<string, TimedIndexEntry>();
  const timedBySlug = new Map<string, TimedIndexEntry>();
  const timedByCode = new Map<string, TimedIndexEntry>();
  for (const t of timedAll) {
    if (t.backLink) timedByBackLink.set(normalizeUrl(t.backLink), t);
    if (t.slug) timedBySlug.set(t.slug, t);
    const c = timedCode(t.slug);
    if (c && !timedByCode.has(c)) timedByCode.set(c, t);
  }
  const practiceNewByCode = new Map<string, PracticeIndexEntry>();
  const practiceOldByCode = new Map<string, PracticeIndexEntry>();
  for (const p of practiceAll) (p.source === "NEW" ? practiceNewByCode : practiceOldByCode).set(p.examCode, p);
  const practiceByCode = new Map<string, PracticeIndexEntry>([...practiceOldByCode, ...practiceNewByCode]);

  const nameByLanding = new Map<string, string>();
  const nameByCode = new Map<string, string>();
  for (const t of timedAll) {
    if (t.backLink && t.examName) nameByLanding.set(normalizeUrl(t.backLink), t.examName);
    const c = timedCode(t.slug); // robust: handles code at front/back/---
    if (c && t.examName) nameByCode.set(c, t.examName);
  }

  const connected = timedAll.length > 0 || practiceAll.length > 0;
  logger.info({ timed: timedAll.length, practiceNew: practiceNewByCode.size, practiceOld: practiceOldByCode.size, connected }, "DB index built");
  return { connected, timedAll, timedByBackLink, timedBySlug, timedByCode, practiceAll, practiceByCode, practiceNewByCode, practiceOldByCode, nameByLanding, nameByCode };
}

/** Confirm a constructed practice URL actually serves the exam (guards the 2nd
 *  subdomain so sites without an answers. host don't get false failures). */
async function practiceUrlWorks(url: string): Promise<boolean> {
  const res = await fetchUrl(url);
  if (!res.ok || res.body.length < 500) return false;
  return !/(page not found|404 not found|no questions (found|available))/i.test(res.body.slice(0, 4000));
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
  timedMissing: { slug: string; examName: string }[]; // DB timed exams for this site with no collected landing/timed link
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
    timedMissing: [],
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

  // Count UNIQUE exams — duplicate URL variants of one landing page must not
  // inflate the run summary (they upsert the same exam row).
  const seenExamIds = new Set<number>();
  const seenLandings = new Set<string>();
  const tally = (r: UpsertResult) => {
    if (seenExamIds.has(r.examId)) return;
    seenExamIds.add(r.examId);
    result.examsFound++;
    result.linksUpserted += r.linkCount;
    if (r.timedVerified) result.timedCollected++;
    if (r.practiceVerified) result.practiceValidated++;
  };

  await mapLimit(urls, env.tuning.httpConcurrency, async (url) => {
    const res = await fetchUrl(url);
    if (!res.ok || !res.body) return;
    const extracted = extractExamFromLanding(url, res.body);
    if (!extracted) return;
    try {
      const r = await upsertExam(site, extracted, dbIndex);
      tally(r);
      seenLandings.add(normalizeUrl(url));
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
      if (!seenExamIds.has(r.examId)) result.dbSeeded++;
      tally(r);
      seenLandings.add(normalizeUrl(t.backLink));
    } catch (err) {
      result.errors.push(`seed ${t.backLink}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await markStale(site, [...seenExamIds]);

  // Authoritative coverage: which of the DB's timed exams for this site actually
  // ended up with a live timed link? Match on MULTIPLE format-independent signals
  // so neither slug-format drift (c458-… vs …---c458) nor non-WGU codes (TEAS,
  // NYPCL — no digits) produce false "missing":
  //   1. landing page (DB back_link == collected exam's landingUrl) — primary,
  //   2. exact timed slug,
  //   3. WGU-style code (letter+digits) as a bonus.
  if (timedForSite.length > 0) {
    const collected = await prisma.exam.findMany({
      where: { siteId: site.id, status: { not: "stale" }, links: { some: { type: "TIMED", active: true } } },
      select: { examCode: true, timedSlug: true, landingUrl: true },
    });
    const collectedLandings = new Set(collected.map((e) => normalizeUrl(e.landingUrl)));
    const collectedSlugs = new Set(collected.map((e) => (e.timedSlug ?? "").toLowerCase()).filter(Boolean));
    const collectedCodes = new Set<string>();
    for (const e of collected) {
      collectedCodes.add(baseCode(e.examCode));
      const c = e.timedSlug ? timedCode(e.timedSlug) : null;
      if (c) collectedCodes.add(c);
    }
    const isCollected = (t: (typeof timedForSite)[number]) => {
      if (t.backLink && collectedLandings.has(normalizeUrl(t.backLink))) return true;
      if (collectedSlugs.has(t.slug.toLowerCase())) return true;
      const c = timedCode(t.slug);
      return Boolean(c && collectedCodes.has(c));
    };
    result.timedMissing = timedForSite.filter((t) => !isCollected(t)).map((t) => ({ slug: t.slug, examName: t.examName || t.slug }));
    result.timedCollected = result.timedExpected - result.timedMissing.length;
  }

  log.info({ ...result, timedMissing: result.timedMissing.length }, "exam site collection complete");
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
      await syncLinksList(examId, [{ type: "LANDING", setNo: 0, part: 0, variant: "", url }]);
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
    for (let i = 1; i <= sets; i++) links.push({ type: "TIMED", setNo: i, part: 0, variant: "", url: timedSetUrl(t.slug, i) });
    try {
      const examId = await writeExam({
        site,
        examCode: t.slug,
        examName: t.examName || t.slug,
        nameResolved: Boolean(t.examName),
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
  const code = ex.examCode;
  const practiceNew = code ? dbIndex.practiceNewByCode.get(code) : undefined; // questions.
  const practiceOld = code ? dbIndex.practiceOldByCode.get(code) : undefined; // answers.
  // Match the timed DB entry by exact slug, then back_link, then CODE — the DB's
  // slug format often differs from the real onlineexamtest URL (c458-… vs
  // …---c458), so code matching is the reliable fallback.
  const timedInfo =
    (ex.timedSlug ? dbIndex.timedBySlug.get(ex.timedSlug) : undefined) ??
    dbIndex.timedByBackLink.get(normalizeUrl(ex.landingUrl)) ??
    (ex.timedSlug ? dbIndex.timedByCode.get(timedCode(ex.timedSlug) ?? "") : undefined) ??
    (code ? dbIndex.timedByCode.get(code.toUpperCase()) : undefined);

  const partsCount = site.defaultParts;
  const practices: PracticeBase[] = [];
  const seenVar = new Set<string>();
  const addPractice = (variant: string, baseUrl: string | null, format: PracticeFormat, sets: number | undefined) => {
    if (!baseUrl || seenVar.has(variant)) return;
    practices.push({ variant, baseUrl, format, sets: sets && sets > 0 ? sets : site.defaultSets, parts: partsCount });
    seenVar.add(variant);
  };

  // 1) The real link the landing page exposed (exact format, right subdomain).
  //    Some exams use the older /classes/{code}/setN-partM.html path format.
  if (ex.practiceUrl && ex.practiceFormat) {
    const v = ex.practiceSource === "OLD" ? "answers" : "questions";
    addPractice(v, ex.practiceUrl, ex.practiceFormat, (v === "answers" ? practiceOld : practiceNew)?.setsCount);
  }
  // 2) questions. — valid whenever the code is in exam_db (shared, so always served).
  if (code && practiceNew && !seenVar.has("questions")) {
    addPractice("questions", constructPracticeUrl(site.baseUrl, "NEW", code), "query", practiceNew.setsCount);
  }
  // 3) answers. — only when the code is in answers_db AND this site actually has
  //    an answers. subdomain (probe the constructed URL to confirm).
  if (code && practiceOld && !seenVar.has("answers")) {
    const u = constructPracticeUrl(site.baseUrl, "OLD", code);
    if (u && (await practiceUrlWorks(u))) addPractice("answers", u, "query", practiceOld.setsCount);
  }

  let timedUrl = ex.timedUrl;
  let timedSlug = ex.timedSlug;
  const constructed: string[] = [];
  if (!timedUrl && timedInfo) {
    timedSlug = timedInfo.slug;
    timedUrl = constructTimedUrl(timedInfo.slug);
    constructed.push("timed");
  }
  const contactUrl = ex.contactUrl ?? timedInfo?.contactLink ?? null;
  const timedSetsCount = timedInfo?.setsCount && timedInfo.setsCount > 0 ? timedInfo.setsCount : site.defaultTimedSets;

  const practiceInfo = practiceNew ?? practiceOld;
  const setsCount = practiceInfo?.setsCount && practiceInfo.setsCount > 0 ? practiceInfo.setsCount : site.defaultSets;

  // Prefer a clean course code even when the page has no practice link (?ec=):
  // timed-only exams (e.g. C720) used to fall back to the long timed slug as
  // their code, breaking lookups like /api/exam/oa/C720. Derive from the landing
  // path (/c720) or the slug tail (…-c720) before resorting to the raw slug.
  const cleanCode = code ?? codeFromLanding(ex.landingUrl) ?? (timedSlug ? codeFromSlug(timedSlug) : null);

  // Disambiguate multi-article courses ("Study Guide I/II/III" share one ec code):
  // the stored examCode gets a -I/-II suffix; DB lookups above still use the bare code.
  const variant = cleanCode ? romanVariantFromTitle(ex.title) : null;
  const examCode = cleanCode
    ? (variant ? `${cleanCode}-${variant}` : cleanCode)
    : (timedSlug ?? new URL(ex.landingUrl).pathname.replace(/\W+/g, "-"));

  // Canonical name comes from the exam-manager (timed) DB. Exams not yet in it
  // keep a code placeholder and get a real name on a later (daily) crawl.
  const dbName =
    dbIndex.nameByLanding.get(normalizeUrl(ex.landingUrl)) ??
    timedInfo?.examName ??
    (code ? dbIndex.nameByCode.get(code.toUpperCase()) : undefined);
  const nameResolved = Boolean(dbName);
  // Multi-part articles (D471-I vs D471-II) must keep their own page titles —
  // the shared DB name for the bare code would make them indistinguishable.
  const examName = variant ? (ex.title || examCode) : (dbName || practiceInfo?.examName || ex.title || examCode);

  const notes: string[] = [];
  if (dbIndex.connected) {
    if (code && !practiceInfo) notes.push("not in practice DB");
    if (practices.length > 1) notes.push(`practice on ${practices.map((p) => p.variant).join(" + ")}`);
    if (ex.timedSlug && !timedInfo) notes.push("timed slug not in DB");
    if (constructed.length) notes.push(`built from DB: ${constructed.join(", ")}`);
  }
  if (variant) notes.push(`multi-part course: variant ${variant} (practice code ${code})`);

  const examId = await writeExam({
    site,
    examCode,
    examName,
    nameResolved,
    landingUrl: ex.landingUrl,
    practiceUrl: practices[0]?.baseUrl ?? null,
    practiceSource: ex.practiceSource,
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

  const linkCount = await syncLinks(examId, { landingUrl: ex.landingUrl, practices, timedUrl, contactUrl, timedSetsCount });
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
  const practiceUrl = code && practice ? constructPracticeUrl(site.baseUrl, practice.source, code) : null;
  const synthetic: ExtractedExam = {
    landingUrl,
    title: t.examName,
    examCode: code,
    practiceUrl,
    practiceFormat: practiceUrl ? "query" : null, // constructPracticeUrl builds the query format
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
  nameResolved?: boolean;
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
    nameResolved: w.nameResolved ?? false,
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

async function syncLinks(examId: number, input: EnumerateInput): Promise<number> {
  return syncLinksList(examId, enumerateLinks(input));
}

/** Upsert the given link set for an exam and deactivate links no longer present. */
async function syncLinksList(examId: number, generated: GeneratedLink[]): Promise<number> {
  const currentKeys = new Set<string>();
  for (const g of generated) {
    currentKeys.add(`${g.type}:${g.setNo}:${g.part}:${g.variant}`);
    await prisma.link.upsert({
      where: { examId_type_setNo_part_variant: { examId, type: g.type, setNo: g.setNo, part: g.part, variant: g.variant } },
      create: { examId, type: g.type, setNo: g.setNo, part: g.part, variant: g.variant, url: g.url, active: true },
      update: { url: g.url, active: true },
    });
  }
  const existing = await prisma.link.findMany({ where: { examId }, select: { id: true, type: true, setNo: true, part: true, variant: true } });
  const toDeactivate = existing.filter((l) => !currentKeys.has(`${l.type}:${l.setNo}:${l.part}:${l.variant}`)).map((l) => l.id);
  if (toDeactivate.length) await prisma.link.updateMany({ where: { id: { in: toDeactivate } }, data: { active: false } });
  return generated.length;
}

async function markStale(site: Site, seenIds: number[]): Promise<void> {
  if (seenIds.length > 0) {
    await prisma.exam.updateMany({ where: { siteId: site.id, id: { notIn: seenIds } }, data: { status: "stale" } });
  }
}

export interface PurgeResult {
  deleted: number;
  kept: { id: number; examCode: string; examName: string; site: string; reason: string }[];
}

/**
 * Delete stale exams that have been SUPERSEDED — i.e. an active exam on the same
 * site shares the same landing page (the clean-code row that replaced the old
 * slug-coded one). Stale exams WITHOUT an active replacement are kept and
 * reported, so a real exam can never be silently dropped. Links/incidents cascade.
 */
export async function purgeStaleExams(): Promise<PurgeResult> {
  const stale = await prisma.exam.findMany({ where: { status: "stale" }, include: { site: true } });
  const active = await prisma.exam.findMany({ where: { status: { not: "stale" } }, select: { siteId: true, examCode: true, landingUrl: true } });

  // Index active exams by site → normalized landing, and site → clean code.
  const activeLanding = new Set(active.map((e) => `${e.siteId}|${normalizeUrl(e.landingUrl)}`));
  const activeCode = new Set(active.map((e) => `${e.siteId}|${e.examCode.toUpperCase()}`));

  const toDelete: number[] = [];
  const kept: PurgeResult["kept"] = [];
  for (const e of stale) {
    const cleanCode = codeFromSlug(e.examCode) ?? codeFromLanding(e.landingUrl);
    const hasReplacement =
      activeLanding.has(`${e.siteId}|${normalizeUrl(e.landingUrl)}`) ||
      (cleanCode ? activeCode.has(`${e.siteId}|${cleanCode.toUpperCase()}`) : false);
    if (hasReplacement) toDelete.push(e.id);
    else kept.push({ id: e.id, examCode: e.examCode, examName: e.examName, site: e.site.key, reason: "no active replacement — review before removing" });
  }

  if (toDelete.length > 0) await prisma.exam.deleteMany({ where: { id: { in: toDelete } } });
  logger.info({ deleted: toDelete.length, kept: kept.length }, "purge stale exams");
  return { deleted: toDelete.length, kept };
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
  await ensureGroups();
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
