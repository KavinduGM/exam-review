import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { descriptionKeyOk } from "@/lib/apikey";
import { fetchUrl } from "@/lib/http";
import { checkLink } from "@/monitor/check";
import { reconcileIncident } from "@/monitor/incidents";

export const dynamic = "force-dynamic";

const ReportBody = z.object({
  url: z.string().url(),
  site: z.string().optional(),
  examCode: z.string().optional(),
  context: z.unknown().optional(), // e.g. { videoId, descriptionId }
  callbackUrl: z.string().url().optional(),
});

// POST /api/reports  (x-api-key: DESCRIPTION_API_KEY)
// The description system reports a link it believes is broken. We re-check it
// LIVE right now and answer with the verdict:
//   - up      -> not tracked; safe to attach (their reviewer likely hit a blip)
//   - down/degraded -> tracked; we watch it every sweep, POST the recovery
//     webhook when it comes back, and email the admin if it stays down past
//     REPORT_ESCALATION_HOURS.
export async function POST(req: Request) {
  if (!env.descriptionApiKey) return NextResponse.json({ error: "DESCRIPTION_API_KEY not configured" }, { status: 503 });
  if (!descriptionKeyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ReportBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const body = parsed.data;

  // Find the link in the registry (exact URL, tolerating a trailing-slash diff).
  const link = await prisma.link.findFirst({
    where: { OR: [{ url: body.url }, { url: body.url.replace(/\/+$/, "") }, { url: body.url + "/" }] },
    include: { exam: { include: { site: true } } },
  });

  // Immediate live check.
  let status: "up" | "degraded" | "down";
  let httpStatus: number | null = null;
  let error: string | undefined;

  if (link) {
    const outcome = await checkLink(link, link.exam);
    status = outcome.ok ? "up" : outcome.contentOk === false || outcome.dataOk === false ? "degraded" : "down";
    httpStatus = outcome.httpStatus;
    error = outcome.error;
    await prisma.link.update({ where: { id: link.id }, data: { lastStatus: status, lastCheckAt: new Date() } });
    await reconcileIncident(link, link.exam, outcome);
  } else {
    const res = await fetchUrl(body.url);
    status = res.ok && res.status < 400 ? "up" : "down";
    httpStatus = res.status;
    error = res.error ?? (res.ok ? undefined : `HTTP ${res.status}`);
  }

  if (status === "up") {
    return NextResponse.json({
      tracked: false,
      known: Boolean(link),
      status,
      httpStatus,
      message: "Link is up right now — safe to attach. (No tracking created.)",
      checkedAt: new Date().toISOString(),
    });
  }

  const report = await prisma.linkReport.create({
    data: {
      linkId: link?.id ?? null,
      url: body.url,
      context: (body.context as Prisma.InputJsonValue) ?? undefined,
      callbackUrl: body.callbackUrl ?? null,
      lastCheckedAt: new Date(),
      lastError: error ?? null,
    },
  });

  const willCallback = Boolean(body.callbackUrl || env.reports.webhookUrl);
  return NextResponse.json(
    {
      tracked: true,
      reportId: report.id,
      known: Boolean(link),
      site: link?.exam.site.key ?? body.site ?? null,
      examCode: link?.exam.examCode ?? body.examCode ?? null,
      status,
      httpStatus,
      error: error ?? null,
      recovery: willCallback
        ? "we will POST your webhook when this link is back up"
        : `no webhook configured — poll GET /api/reports/${report.id}`,
      escalation: `admin is emailed if still down after ${env.reports.escalationHours}h`,
      checkedAt: new Date().toISOString(),
    },
    { status: 202 },
  );
}

// GET /api/reports?status=OPEN|RECOVERED|ESCALATED  (same key) — list recent reports.
export async function GET(req: Request) {
  if (!descriptionKeyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status")?.toUpperCase();
  const reports = await prisma.linkReport.findMany({
    where: status && ["OPEN", "RECOVERED", "ESCALATED"].includes(status) ? { status: status as "OPEN" } : {},
    orderBy: { reportedAt: "desc" },
    take: 100,
    include: { link: { include: { exam: { include: { site: true } } } } },
  });
  return NextResponse.json({
    count: reports.length,
    reports: reports.map((r) => ({
      reportId: r.id,
      url: r.url,
      status: r.status,
      site: r.link?.exam.site.key ?? null,
      examCode: r.link?.exam.examCode ?? null,
      reportedAt: r.reportedAt,
      lastCheckedAt: r.lastCheckedAt,
      recoveredAt: r.recoveredAt,
      escalatedAt: r.escalatedAt,
      lastError: r.lastError,
    })),
  });
}
