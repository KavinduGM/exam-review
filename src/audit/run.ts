import { Prisma, type Exam, type Link, type Site } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { mapLimit } from "@/lib/http";
import { checkLink } from "@/monitor/check";
import { reconcileIncident } from "@/monitor/incidents";
import { capture, closeBrowser } from "./screenshot";
import { reviewScreenshot } from "./review";
import { checkImages, type BrokenImage } from "./images";
import { reviewPracticeFlows, type FlowResult } from "./flow";
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
  aiCostUsd: number;
  flowsChecked: number;
  flowsBroken: number;
}

/** Weekly tiered audit: Tier-1 on all links, Tier-2 (screenshot + AI) on flagged + a sample. */
export async function runWeeklyAudit(onProgress?: ProgressFn): Promise<AuditSummary> {
  const run = await prisma.checkRun.create({ data: { type: "AUDIT" } });
  const links = (await prisma.link.findMany({
    where: { active: true, exam: { status: { not: "stale" } } },
    include: { exam: { include: { site: true } } },
  })) as LinkWithExam[];

  logger.info({ count: links.length }, "weekly audit: Tier-1 starting");

  // ── Tier 1: cheap HTTP + content + data-integrity (+ image integrity) ────
  let t1done = 0;
  const tier1 = await mapLimit(links, env.tuning.httpConcurrency, async (link) => {
    const wantImages = env.tuning.checkImages && link.type === "LANDING";
    const raw = await checkLink(link, link.exam, { keepBody: wantImages });

    // Verify every <img> on landing/article pages actually loads.
    let brokenImages: BrokenImage[] = [];
    if (wantImages && raw.ok && raw.body) {
      const img = await checkImages(link.url, raw.body, { max: 40 });
      brokenImages = img.broken;
    }
    const imgErr =
      brokenImages.length > 0
        ? `broken image(s): ${brokenImages.slice(0, 3).map((b) => `${b.src} (${b.reason})`).join(", ")}${
            brokenImages.length > 3 ? ` +${brokenImages.length - 3} more` : ""
          }`
        : undefined;

    // Fold a broken image into the outcome as "degraded" (page loads, banner lost).
    // Keep only slim fields — never retain the page body in the tier1 array.
    const outcome = {
      httpStatus: raw.httpStatus,
      latencyMs: raw.latencyMs,
      ok: raw.ok && !imgErr,
      contentOk: imgErr ? false : raw.contentOk,
      dataOk: raw.dataOk,
      error: raw.error ?? imgErr,
    };

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
    return { link, outcome, resultId: result.id, status, brokenImages };
  });

  const down = tier1.filter((t) => t.status === "down").length;
  const degraded = tier1.filter((t) => t.status === "degraded").length;

  // ── Tier 2: screenshot + AI review — flagged + ALL landings + random sample ──
  const flagged = tier1.filter((t) => !t.outcome.ok);
  // Full AI review of every landing only for EXAM sites (SIMPLE/blog pages get the
  // cheap image check + the random sample, to keep screenshot cost bounded).
  const isReviewedLanding = (t: (typeof tier1)[number]) =>
    env.tuning.reviewAllLandings && t.link.type === "LANDING" && t.link.exam.site.type === "EXAM";
  const landings = tier1.filter((t) => t.outcome.ok && isReviewedLanding(t));
  const healthyOther = tier1.filter((t) => t.outcome.ok && !isReviewedLanding(t));
  const sampleCount = Math.ceil((healthyOther.length * env.tuning.auditSamplePct) / 100);
  const sample = shuffle(healthyOther).slice(0, sampleCount);

  // Union + dedupe by result id (a flagged landing shouldn't be reviewed twice).
  const byId = new Map<number, (typeof tier1)[number]>();
  for (const t of [...flagged, ...landings, ...sample]) byId.set(t.resultId, t);
  const tier2Targets = [...byId.values()];

  logger.info(
    { flagged: flagged.length, landings: landings.length, sample: sample.length, total: tier2Targets.length },
    "weekly audit: Tier-2 starting",
  );

  let aiReviewed = 0;
  let aiFlagged = 0;
  let t2done = 0;

  let aiCostUsd = 0;

  await mapLimit(tier2Targets, env.tuning.playwrightConcurrency, async (t) => {
    const shot = await capture(t.link.url, `link-${t.link.id}-run-${run.id}`);
    const review = shot.pngBase64
      ? await reviewScreenshot(t.link.type, shot.pngBase64, {
          flagged: !t.outcome.ok,
          hint: t.outcome.error ?? (shot.consoleErrors.length ? `console errors: ${shot.consoleErrors.join("; ")}` : undefined),
        })
      : null;
    const verdict = review?.verdict ?? null;
    const usage = review?.usage ?? null;

    if (verdict) {
      aiReviewed++;
      if (!verdict.healthy) aiFlagged++;
    }
    if (usage) aiCostUsd += usage.costUsd;

    await prisma.checkResult.update({
      where: { id: t.resultId },
      data: {
        screenshot: shot.path,
        aiVerdict: verdict ? (verdict as unknown as Prisma.InputJsonValue) : undefined,
        aiModel: usage?.model,
        aiInputTokens: usage?.inputTokens,
        aiOutputTokens: usage?.outputTokens,
        aiCostUsd: usage?.costUsd,
      },
    });

    if (verdict && !verdict.healthy) {
      await prisma.link.update({ where: { id: t.link.id }, data: { lastStatus: "degraded" } });
    }

    t2done++;
    onProgress?.({ phase: "audit", stage: "ai-review", reviewed: t2done, total: tier2Targets.length, flagged: aiFlagged });
  });

  logger.info({ aiReviewed, aiFlagged, aiCostUsd: aiCostUsd.toFixed(4) }, "weekly audit: AI review cost");

  await closeBrowser();

  // Practice-flow structural review: Set→Part sequence + end-of-flow home page.
  const flows = await reviewPracticeFlows(tier1.map((t) => ({ link: t.link, status: t.status })));
  const brokenFlows = flows.filter((f) => !f.ok);
  logger.info({ checked: flows.length, broken: brokenFlows.length }, "weekly audit: practice-flow review");

  const summary: AuditSummary = {
    runId: run.id,
    checked: links.length,
    down,
    degraded,
    aiReviewed,
    aiFlagged,
    aiCostUsd: Number(aiCostUsd.toFixed(4)),
    flowsChecked: flows.length,
    flowsBroken: brokenFlows.length,
  };
  const stored = { ...summary, brokenFlows: brokenFlows.slice(0, 100) };
  await prisma.checkRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: stored as unknown as Prisma.InputJsonValue } });

  await sendWeeklyDigest(buildDigest(tier1, summary, brokenFlows), { checked: links.length, down, degraded });

  logger.info(summary, "weekly audit complete");
  return summary;
}

function buildDigest(
  tier1: { link: LinkWithExam; outcome: { error?: string }; status: string }[],
  summary: AuditSummary,
  brokenFlows: FlowResult[] = [],
): string {
  const problems = tier1.filter((t) => t.status !== "up");
  const flowRows = brokenFlows
    .slice(0, 100)
    .map(
      (f) =>
        `<tr><td>${esc(f.siteKey)}</td><td>${esc(f.examCode)}</td><td>${esc(f.variant)}</td><td>${f.upParts}/${f.totalParts} parts up</td><td>${
          f.firstBroken ? "breaks at " + esc(f.firstBroken) : f.homeOk ? "" : "home page 404"
        }</td></tr>`,
    )
    .join("");
  const flowSection = brokenFlows.length
    ? `<h3>Practice flow issues (${brokenFlows.length})</h3>
       <table border="1" cellpadding="6" cellspacing="0">
         <tr><th>Site</th><th>Exam</th><th>Subdomain</th><th>Parts</th><th>Problem</th></tr>${flowRows}
       </table>`
    : `<p>Practice flows OK (${summary.flowsChecked} checked).</p>`;
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
      <li>AI-reviewed: <b>${summary.aiReviewed}</b> · AI-flagged: <b>${summary.aiFlagged}</b> · cost <b>$${summary.aiCostUsd.toFixed(2)}</b></li>
      <li>Practice flows: <b>${summary.flowsChecked}</b> checked · <b>${summary.flowsBroken}</b> broken</li>
    </ul>
    ${flowSection}
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
