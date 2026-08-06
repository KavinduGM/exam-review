import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { mapLimit } from "@/lib/http";
import { env } from "@/lib/env";
import { checkLink } from "@/monitor/check";
import { reconcileIncident } from "@/monitor/incidents";

export const dynamic = "force-dynamic";

// POST /api/admin/recheck/{examId}
// Admin-only. Re-check every active link of one exam RIGHT NOW and update its
// status + incidents. Useful because the full sweep runs daily: after fixing a
// URL (or when a status looks stale) you get an immediate, accurate answer.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const examId = Number(id);
  if (!Number.isFinite(examId)) return NextResponse.json({ error: "bad exam id" }, { status: 400 });

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { site: true, links: { where: { active: true } } },
  });
  if (!exam) return NextResponse.json({ error: "exam not found" }, { status: 404 });

  let up = 0;
  let degraded = 0;
  let down = 0;

  await mapLimit(exam.links, Math.min(env.tuning.httpConcurrency, 4), async (link) => {
    const outcome = await checkLink(link, exam);
    if (outcome.status === "up") up++;
    else if (outcome.status === "degraded") degraded++;
    else down++;

    await prisma.link.update({ where: { id: link.id }, data: { lastStatus: outcome.status, lastCheckAt: new Date() } });
    await reconcileIncident(link, exam, outcome);
  });

  return NextResponse.json({ examId, examCode: exam.examCode, checked: exam.links.length, up, degraded, down });
}
