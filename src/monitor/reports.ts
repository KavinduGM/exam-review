import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { fetchUrl } from "@/lib/http";
import { checkLink } from "./check";
import { sendReportEscalation, type EscalationItem } from "@/notify/resend";

/**
 * Re-check every OPEN/ESCALATED external link report (runs after each uptime
 * sweep). Recovered -> POST the description system's webhook (per-report
 * callbackUrl, else DESCRIPTION_WEBHOOK_URL) and mark RECOVERED. Still down past
 * REPORT_ESCALATION_HOURS -> email the admin once and mark ESCALATED (recovery
 * is still watched afterward).
 */
export async function processOpenReports(): Promise<{ checked: number; recovered: number; escalated: number }> {
  const reports = await prisma.linkReport.findMany({
    where: { status: { in: ["OPEN", "ESCALATED"] } },
    include: { link: { include: { exam: { include: { site: true } } } } },
  });
  if (reports.length === 0) return { checked: 0, recovered: 0, escalated: 0 };

  let recovered = 0;
  const toEscalate: EscalationItem[] = [];
  const now = Date.now();

  for (const r of reports) {
    let up: boolean;
    let error: string | undefined;

    if (r.link) {
      const outcome = await checkLink(r.link, r.link.exam);
      up = outcome.ok;
      error = outcome.error;
    } else {
      const res = await fetchUrl(r.url);
      up = res.ok && res.status < 400;
      error = res.error ?? (up ? undefined : `HTTP ${res.status}`);
    }

    if (up) {
      const delivery = await sendRecoveryWebhook(r);
      if (delivery === "failed") {
        // Leave OPEN — the link is up, so next sweep retries the callback.
        await prisma.linkReport.update({
          where: { id: r.id },
          data: { lastCheckedAt: new Date(), lastError: "recovered, but webhook delivery failed — will retry" },
        });
        continue;
      }
      recovered++;
      await prisma.linkReport.update({
        where: { id: r.id },
        data: {
          status: "RECOVERED",
          recoveredAt: new Date(),
          lastCheckedAt: new Date(),
          lastError: null,
          ...(delivery === "sent" ? { callbackSentAt: new Date() } : {}),
        },
      });
      continue;
    }

    // Still down.
    const hoursDown = (now - +r.reportedAt) / 3_600_000;
    const shouldEscalate = !r.escalatedAt && hoursDown >= env.reports.escalationHours;
    await prisma.linkReport.update({
      where: { id: r.id },
      data: {
        lastCheckedAt: new Date(),
        lastError: error ?? null,
        ...(shouldEscalate ? { status: "ESCALATED", escalatedAt: new Date() } : {}),
      },
    });
    if (shouldEscalate) {
      toEscalate.push({
        url: r.url,
        site: r.link?.exam.site.name ?? "unknown site",
        exam: r.link?.exam.examName ?? "unregistered link",
        reportedAt: r.reportedAt,
        hoursDown: Math.round(hoursDown),
        error: error ?? "",
      });
    }
  }

  if (toEscalate.length > 0) await sendReportEscalation(toEscalate);

  const summary = { checked: reports.length, recovered, escalated: toEscalate.length };
  logger.info(summary, "external link reports processed");
  return summary;
}

/** POST the recovery event to the description system. */
async function sendRecoveryWebhook(r: {
  id: number;
  url: string;
  callbackUrl: string | null;
  reportedAt: Date;
  context: unknown;
  link: { exam: { examCode: string; examName: string; site: { key: string } } } | null;
}): Promise<"sent" | "none" | "failed"> {
  const target = r.callbackUrl || env.reports.webhookUrl;
  if (!target) return "none";

  const payload = {
    event: "link.recovered",
    reportId: r.id,
    url: r.url,
    site: r.link?.exam.site.key ?? null,
    examCode: r.link?.exam.examCode ?? null,
    examName: r.link?.exam.examName ?? null,
    context: r.context ?? null,
    reportedAt: r.reportedAt,
    recoveredAt: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(target, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(env.reports.webhookKey ? { "x-api-key": env.reports.webhookKey } : {}),
      },
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn({ reportId: r.id, target, status: res.status }, "recovery webhook non-2xx");
      return "failed";
    }
    logger.info({ reportId: r.id, target }, "recovery webhook delivered");
    return "sent";
  } catch (err) {
    logger.warn({ err, reportId: r.id, target }, "recovery webhook failed");
    return "failed";
  }
}
