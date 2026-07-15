import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { mapLimit } from "@/lib/http";
import { checkLink } from "./check";
import { reconcileIncident } from "./incidents";
import { sendDownAlert, sendRecoveryAlert, type DownItem } from "@/notify/resend";
import type { ProgressFn } from "@/lib/progress";

export interface SweepSummary {
  runId: number;
  checked: number;
  down: number;
  degraded: number;
  opened: number;
  resolved: number;
}

/** Run an uptime sweep over every active link. */
export async function runUptimeSweep(onProgress?: ProgressFn): Promise<SweepSummary> {
  const run = await prisma.checkRun.create({ data: { type: "UPTIME" } });

  // Housekeeping: incidents whose link was deactivated (e.g. replaced by a
  // variant-keyed link) would otherwise stay OPEN forever — close them.
  await prisma.incident.updateMany({
    where: { status: "OPEN", link: { active: false } },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });

  const links = await prisma.link.findMany({
    where: { active: true, exam: { status: { not: "stale" } } },
    include: { exam: { include: { site: true } } },
  });

  logger.info({ count: links.length }, "uptime sweep starting");

  const opened: DownItem[] = [];
  const resolved: DownItem[] = [];
  let down = 0;
  let degraded = 0;
  let done = 0;

  await mapLimit(links, env.tuning.httpConcurrency, async (link) => {
    const outcome = await checkLink(link, link.exam);

    const status = outcome.ok ? "up" : outcome.contentOk === false || outcome.dataOk === false ? "degraded" : "down";
    if (status === "down") down++;
    if (status === "degraded") degraded++;

    await prisma.checkResult.create({
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

    await prisma.link.update({
      where: { id: link.id },
      data: { lastStatus: status, lastCheckAt: new Date() },
    });

    const t = await reconcileIncident(link, link.exam, outcome);
    if (t.opened) opened.push(t.opened);
    if (t.resolved) resolved.push(t.resolved);

    done++;
    if (done % 20 === 0 || done === links.length) {
      onProgress?.({ phase: "uptime", checked: done, total: links.length, down, degraded });
    }
  });

  const summary: SweepSummary = {
    runId: run.id,
    checked: links.length,
    down,
    degraded,
    opened: opened.length,
    resolved: resolved.length,
  };

  await prisma.checkRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue },
  });

  // Alert only on transitions, so we don't re-notify every sweep.
  await sendDownAlert(opened);
  await sendRecoveryAlert(resolved);

  logger.info(summary, "uptime sweep complete");
  return summary;
}
