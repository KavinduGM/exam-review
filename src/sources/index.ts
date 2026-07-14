// Read-only cross-validation against the client's three MySQL databases.
// Everything here degrades gracefully: if a source DB isn't configured, the
// lookups return null and the collector falls back to site defaults / probing.

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { query } from "./mysql";

export interface PracticeExamInfo {
  dbExamId: number;
  examCode: string;
  examName: string;
  setsCount: number;
  source: "NEW" | "OLD";
}

export interface TimedExamInfo {
  dbExamId: number;
  slug: string;
  examName: string;
  backLink: string | null;
  contactLink: string | null;
  setsCount: number;
}

// ── Practice (exam_db = NEW questions.*, answers_db = OLD answers.*) ──────────
// Both share the same schema shape: exams(id, exam_code, exam_name) +
// questions(exam_id, ques_set). Sets per exam = COUNT(DISTINCT ques_set).

async function lookupPractice(
  cfg: typeof env.sources.practiceNew,
  source: "NEW" | "OLD",
  examCode: string,
): Promise<PracticeExamInfo | null> {
  if (!cfg.enabled) return null;
  try {
    const exams = await query<{ id: number; exam_code: string; exam_name: string }>(
      cfg,
      "SELECT id, exam_code, exam_name FROM exams WHERE exam_code = ? LIMIT 1",
      [examCode],
    );
    if (exams.length === 0) return null;
    const exam = exams[0];
    const counts = await query<{ sets: number }>(
      cfg,
      "SELECT COUNT(DISTINCT ques_set) AS sets FROM questions WHERE exam_id = ?",
      [exam.id],
    );
    return {
      dbExamId: exam.id,
      examCode: exam.exam_code,
      examName: exam.exam_name,
      setsCount: Number(counts[0]?.sets ?? 0),
      source,
    };
  } catch (err) {
    logger.warn({ err, examCode, source }, "practice DB lookup failed");
    return null;
  }
}

/** Find a practice exam by code, preferring the NEW DB then falling back to OLD. */
export async function findPracticeExam(examCode: string): Promise<PracticeExamInfo | null> {
  return (
    (await lookupPractice(env.sources.practiceNew, "NEW", examCode)) ??
    (await lookupPractice(env.sources.practiceOld, "OLD", examCode))
  );
}

/** Number of questions actually stored for a given exam + set (data-integrity check). */
export async function practiceQuestionCount(
  source: "NEW" | "OLD",
  dbExamId: number,
  quesSet: number,
): Promise<number | null> {
  const cfg = source === "NEW" ? env.sources.practiceNew : env.sources.practiceOld;
  if (!cfg.enabled) return null;
  try {
    const rows = await query<{ n: number }>(
      cfg,
      "SELECT COUNT(*) AS n FROM questions WHERE exam_id = ? AND ques_set = ?",
      [dbExamId, quesSet],
    );
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    logger.warn({ err, dbExamId, quesSet }, "practice question count failed");
    return null;
  }
}

// ── Timed (onlineexam_db) ────────────────────────────────────────────────────
// exams(id, exam_name, slug, back_link, contact_link) +
// questions(exam_id, set_no). Sets per exam = COUNT(DISTINCT set_no).

export async function findTimedExamBySlug(slug: string): Promise<TimedExamInfo | null> {
  const cfg = env.sources.timed;
  if (!cfg.enabled) return null;
  try {
    const rows = await query<{
      exam_id: number;
      exam_name: string;
      slug: string;
      back_link: string | null;
      contact_link: string | null;
    }>(
      cfg,
      "SELECT exam_id, exam_name, slug, back_link, contact_link FROM exams WHERE slug = ? LIMIT 1",
      [slug],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const counts = await query<{ sets: number }>(
      cfg,
      "SELECT COUNT(DISTINCT set_no) AS sets FROM questions WHERE exam_id = ?",
      [r.exam_id],
    );
    return {
      dbExamId: r.exam_id,
      slug: r.slug,
      examName: r.exam_name,
      backLink: r.back_link,
      contactLink: r.contact_link,
      setsCount: Number(counts[0]?.sets ?? 0),
    };
  } catch (err) {
    logger.warn({ err, slug }, "timed DB lookup failed");
    return null;
  }
}

/** Every non-empty back_link (landing URL) stored in the timed DB — a strong
 *  discovery source when sites have no sitemap. */
export async function listTimedBackLinks(): Promise<string[]> {
  const cfg = env.sources.timed;
  if (!cfg.enabled) return [];
  try {
    const rows = await query<{ back_link: string | null }>(
      cfg,
      "SELECT DISTINCT back_link FROM exams WHERE back_link IS NOT NULL AND back_link <> ''",
    );
    return rows.map((r) => r.back_link).filter((b): b is string => Boolean(b));
  } catch (err) {
    logger.warn({ err }, "listing timed back_links failed");
    return [];
  }
}

// ── Full inventories (loaded once per collection run) ────────────────────────
// These power DB-first discovery, link construction, and coverage reporting.

export interface TimedIndexEntry {
  dbExamId: number;
  slug: string;
  examName: string;
  backLink: string | null;
  contactLink: string | null;
  setsCount: number;
}

export async function loadTimedIndex(): Promise<TimedIndexEntry[]> {
  const cfg = env.sources.timed;
  if (!cfg.enabled) return [];
  try {
    const rows = await query<{ exam_id: number; exam_name: string; slug: string; back_link: string | null; contact_link: string | null }>(
      cfg,
      "SELECT exam_id, exam_name, slug, back_link, contact_link FROM exams",
    );
    const counts = await query<{ exam_id: number; sets: number }>(
      cfg,
      "SELECT exam_id, COUNT(DISTINCT set_no) AS sets FROM questions GROUP BY exam_id",
    );
    const cmap = new Map(counts.map((c) => [c.exam_id, Number(c.sets)]));
    return rows
      .filter((r) => r.slug)
      .map((r) => ({
        dbExamId: r.exam_id,
        slug: r.slug,
        examName: r.exam_name,
        backLink: r.back_link,
        contactLink: r.contact_link,
        setsCount: cmap.get(r.exam_id) ?? 0,
      }));
  } catch (err) {
    logger.warn({ err }, "loadTimedIndex failed");
    return [];
  }
}

export interface PracticeIndexEntry {
  dbExamId: number;
  examCode: string;
  examName: string;
  setsCount: number;
  source: "NEW" | "OLD";
}

async function loadPracticeFrom(cfg: typeof env.sources.practiceNew, source: "NEW" | "OLD"): Promise<PracticeIndexEntry[]> {
  if (!cfg.enabled) return [];
  try {
    const rows = await query<{ id: number; exam_code: string; exam_name: string }>(cfg, "SELECT id, exam_code, exam_name FROM exams");
    const counts = await query<{ exam_id: number; sets: number }>(
      cfg,
      "SELECT exam_id, COUNT(DISTINCT ques_set) AS sets FROM questions GROUP BY exam_id",
    );
    const cmap = new Map(counts.map((c) => [c.exam_id, Number(c.sets)]));
    return rows.map((r) => ({ dbExamId: r.id, examCode: r.exam_code, examName: r.exam_name, setsCount: cmap.get(r.id) ?? 0, source }));
  } catch (err) {
    logger.warn({ err, source }, "loadPracticeIndex failed");
    return [];
  }
}

export async function loadPracticeIndex(): Promise<PracticeIndexEntry[]> {
  const [neu, old] = await Promise.all([
    loadPracticeFrom(env.sources.practiceNew, "NEW"),
    loadPracticeFrom(env.sources.practiceOld, "OLD"),
  ]);
  return [...neu, ...old];
}

export async function timedQuestionCount(dbExamId: number, setNo: number): Promise<number | null> {
  const cfg = env.sources.timed;
  if (!cfg.enabled) return null;
  try {
    const rows = await query<{ n: number }>(
      cfg,
      "SELECT COUNT(*) AS n FROM questions WHERE exam_id = ? AND set_no = ?",
      [dbExamId, setNo],
    );
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    logger.warn({ err, dbExamId, setNo }, "timed question count failed");
    return null;
  }
}
