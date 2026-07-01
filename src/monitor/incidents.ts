import type { Exam, Link } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CheckOutcome } from "./check";
import type { DownItem } from "@/notify/resend";

export interface IncidentTransition {
  opened?: DownItem; // a new incident was just opened
  resolved?: DownItem; // an open incident was just resolved
}

/**
 * Reconcile a link's check outcome with its incident state.
 * Opens a new incident on first failure, resolves it on recovery, and reports
 * the transition so the caller can batch alert emails.
 */
export async function reconcileIncident(
  link: Link,
  exam: Exam & { site: { name: string } },
  outcome: CheckOutcome,
): Promise<IncidentTransition> {
  const severity = outcome.ok ? null : outcome.contentOk === false || outcome.dataOk === false ? "degraded" : "down";
  const open = await prisma.incident.findFirst({
    where: { linkId: link.id, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });

  const item: DownItem = {
    exam: exam.examName,
    site: exam.site.name,
    type: link.type + (link.setNo ? ` set${link.setNo}${link.part ? `p${link.part}` : ""}` : ""),
    url: link.url,
    error: outcome.error ?? "",
  };

  // Healthy now.
  if (outcome.ok) {
    if (open) {
      await prisma.incident.update({
        where: { id: open.id },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      return { resolved: item };
    }
    return {};
  }

  // Unhealthy now.
  if (!open) {
    await prisma.incident.create({
      data: {
        linkId: link.id,
        examId: exam.id,
        status: "OPEN",
        severity: severity ?? "down",
        lastError: outcome.error ?? null,
        notifiedAt: new Date(),
      },
    });
    return { opened: item };
  }

  // Already open — just refresh the error/severity, no duplicate alert.
  await prisma.incident.update({
    where: { id: open.id },
    data: { severity: severity ?? open.severity, lastError: outcome.error ?? open.lastError },
  });
  return {};
}
