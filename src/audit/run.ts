import { Prisma, type Exam, type Link, type Site } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { mapLimit } from "@/lib/http";
import { checkLink } from "@/monitor/check";
import { reconcileIncident } from "@/monitor/incidents";
import { capture, closeBrowser } from "./screenshot";
import { reviewScreenshot } from "./review";
import { sendWeeklyDigest } from "@/notify/resend";
import type { ProgressFn } from "@/lib/progress";

type LinkWithExam = Link & { exam: Exam & { site: Site } };

export interface AuditSummary {
  runId: number;
  checked: number;
  down: number;
  degraded: number;
  aiReviewed: number;
  aiFlagged: number;
}

/** Weekly tiered audit: Tier-1 on all links, Tier-2 (screenshot + AI) on flagged + a sample. */
export async function runWeeklyAudit(onProgress?: ProgressFn): Promise<AuditSummary> {
  const run = await prisma.checkRun.create({ data: { type: "AUDIT" } });
  const links = (await prisma.link.findMany({
    where: { active: true, exam: { status: { not: "stale" } } },
    include: { exam: { include: { site: true } } },
  })) as LinkWithExam[];

  logger.info({ count: links.length }, "weekly audit: Tier-1 starting");

  // ── Tier 1: cheap HTTP + content + data-integrity on everything ──────────
  let t1done = 0;
  const tier1 = await mapLimit(links, env.tuning.httpConcurrency, async (link) => {
    const outcome = await checkLink(link, link.exam, { keepBody: false });
    const result = await prisma.checkResult.create({
      data: {
        linkId: link.id,
        runId: run.id,
        httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs,
        ok: outcome.ok,
        contentOk: outcome.contentOk,
        dataOk: outcome.dataOk,
        error: outcome.error,
      },
    });
    const status = outcome.ok ? "up" : outcome.contentOk === false || outcome.dataOk === false ? "degraded" : "down";
    await prisma.link.update({ where: { id: link.id }, data: { lastStatus: status, lastCheckAt: new Date() } });
    await reconcileIncident(link, link.exam, outcome);
    t1done++;
    if (t1done % 20 === 0 || t1done === links.length) {
      onProgress?.({ phase: "audit", stage: "checks", checked: t1done, total: links.length });
    }
    return { link, outcome, resultId: result.id, status };
  });

  const down = tier1.filter((t) => t.status === "down").length;
  const degraded = tier1.filter((t) => t.status === "degraded").length;

  // ── Tier 2: screenshot + AI review on flagged + random healthy sample ────
  const flagged = tier1.filter((t) => !t.outcome.ok);
  const healthy = tier1.filter((t) => t.outcome.ok);
  const sampleCount = Math.ceil((healthy.length * env.tuning.auditSamplePct) / 100);
  const sample = shuffle(healthy).slice(0, sampleCount);
  const tier2Targets = [...flagged, ...sample];

  logger.info({ flagged: flagged.length, sample: sample.length }, "weekly audit: Tier-2 starting");

  let aiReviewed = 0;
  let aiFlagged = 0;
  let t2done = 0;

  await mapLimit(tier2Targets, env.tuning.playwrightConcurrency, async (t) => {
    const shot = await capture(t.link.url, `link-${t.link.id}-run-${run.id}`);
    const verdict = shot.pngBase64
      ? await reviewScreenshot(t.link.type, shot.pngBase64, {
          flagged: !t.outcome.ok,
          hint: t.outcome.error ?? (shot.consoleErrors.length ? `console errors: ${shot.consoleErrors.join("; ")}` : undefined),
        })
      : null;

    if (verdict) {
      aiReviewed++;
      if (!verdict.healthy) aiFlagged++;
    }

    await prisma.checkResult.update({
      where: { id: t.resultId },
      data: {
        screenshot: shot.path,
        aiVerdict: verdict ? (verdict as unknown as Prisma.InputJsonValue) : undefined,
      },
    });

    if (verdict && !verdict.healthy) {
      await prisma.link.update({ where: { id: t.link.id }, data: { lastStatus: "degraded" } });
    }

    t2done++;
    onProgress?.({ phase: "audit", stage: "ai-review", reviewed: t2done, total: tier2Targets.length, flagged: aiFlagged });
  });

  await closeBrowser();

  const summary: AuditSummary = { runId: run.id, checked: links.length, down, degraded, aiReviewed, aiFlagged };
  await prisma.checkRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue } });

  await sendWeeklyDigest(buildDigest(tier1, summary), { checked: links.length, down, degraded });

  logger.info(summary, "weekly audit complete");
  return summary;
}

function buildDigest(
  tier1: { link: LinkWithExam; outcome: { error?: string }; status: string }[],
  summary: AuditSummary,
): string {
  const problems = tier1.filter((t) => t.status !== "up");
  const rows = problems
    .slice(0, 200)
    .map(
      (t) =>
        `<tr><td>${esc(t.link.exam.site.name)}</td><td>${esc(t.link.exam.examName)}</td><td>${esc(
          t.link.type,
        )}${t.link.setNo ? ` s${t.link.setNo}${t.link.part ? `p${t.link.part}` : ""}` : ""}</td><td>${esc(
          t.status,
        )}</td><td>${esc(t.outcome.error ?? "")}</td><td><a href="${esc(t.link.url)}">link</a></td></tr>`,
    )
    .join("");

  return `<h2>Weekly audit summary</h2>
    <ul>
      <li>Links checked: <b>${summary.checked}</b></li>
      <li>Down: <b>${summary.down}</b> · Degraded: <b>${summary.degraded}</b></li>
      <li>AI-reviewed: <b>${summary.aiReviewed}</b> · AI-flagged: <b>${summary.aiFlagged}</b></li>
    </ul>
    <h3>Problems (${problems.length})</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Site</th><th>Exam</th><th>Link</th><th>Status</th><th>Detail</th><th>URL</th></tr>${rows}
    </table>`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
}
