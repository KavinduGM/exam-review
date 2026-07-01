import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/exams/{site}/{code}
// Public endpoint: returns every link for one exam, grouped for easy embedding
// into YouTube descriptions. {site} is the Site.key (e.g. "oapractice").
export async function GET(_req: Request, ctx: { params: Promise<{ site: string; code: string }> }) {
  const { site, code } = await ctx.params;
  const examCode = decodeURIComponent(code);

  const exam = await prisma.exam.findFirst({
    where: { examCode, site: { key: site } },
    include: { site: true, links: { where: { active: true }, orderBy: [{ type: "asc" }, { setNo: "asc" }, { part: "asc" }] } },
  });

  if (!exam) {
    return NextResponse.json({ error: "exam not found", site, code: examCode }, { status: 404 });
  }

  const byType = (t: string) => exam.links.filter((l) => l.type === t);

  return NextResponse.json({
    site: exam.site.key,
    siteName: exam.site.name,
    examCode: exam.examCode,
    examName: exam.examName,
    status: exam.status,
    landingUrl: exam.landingUrl,
    contactUrl: exam.contactUrl,
    counts: { sets: exam.setsCount, parts: exam.partsCount, timedSets: exam.timedSetsCount },
    landing: byType("LANDING").map((l) => l.url)[0] ?? null,
    practice: byType("PRACTICE").map((l) => ({ set: l.setNo, part: l.part, url: l.url, status: l.lastStatus })),
    timed: byType("TIMED").map((l) => ({ set: l.setNo, url: l.url, status: l.lastStatus })),
    contact: byType("CONTACT").map((l) => l.url)[0] ?? null,
    lastSeenAt: exam.lastSeenAt,
  });
}
