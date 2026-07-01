import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { mapLimit } from "@/lib/http";
import { checkLink } from "./check";
import { reconcileIncident } from "./incidents";
import { sendDownAlert, sendRecoveryAlert, type DownItem } from "@/notify/resend";

export interface SweepSummary {
  runId: number;
  checked: number;
  down: number;
  degraded: number;
  opened: number;
  resolved: number;
}

/** Run an uptime sweep over every active link. */
export async function runUptimeSweep(): Promise<SweepSummary> {
  const run = await prisma.checkRun.create({ data: { type: "UPTIME" } });
  const links = await prisma.link.findMany({
    where: { active: true, exam: { status: { not: "stale" } } },
    include: { exam: { include: { site: true } } },
  });

  logger.info({ count: links.length }, "uptime sweep starting");

  const opened: DownItem[] = [];
  const resolved: DownItem[] = [];
  let down = 0;
  let degraded = 0;

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
