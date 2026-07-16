import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { descriptionKeyOk } from "@/lib/apikey";

export const dynamic = "force-dynamic";

// GET /api/reports/{id}  (x-api-key: DESCRIPTION_API_KEY)
// Poll a report's status: OPEN (still down), RECOVERED (safe to re-attach),
// ESCALATED (still down past deadline; admin notified — keep waiting or drop).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!descriptionKeyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const reportId = Number(id);
  if (!Number.isFinite(reportId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const r = await prisma.linkReport.findUnique({
    where: { id: reportId },
    include: { link: { include: { exam: { include: { site: true } } } } },
  });
  if (!r) return NextResponse.json({ error: "report not found" }, { status: 404 });

  return NextResponse.json({
    reportId: r.id,
    url: r.url,
    status: r.status,
    safeToAttach: r.status === "RECOVERED",
    site: r.link?.exam.site.key ?? null,
    examCode: r.link?.exam.examCode ?? null,
    linkCurrentStatus: r.link?.lastStatus ?? null,
    reportedAt: r.reportedAt,
    lastCheckedAt: r.lastCheckedAt,
    recoveredAt: r.recoveredAt,
    escalatedAt: r.escalatedAt,
    lastError: r.lastError,
  });
}
