import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/exams?site=oapractice&q=D4&status=active&limit=100
// Public list endpoint for discovery / bulk pulls by the YouTube system.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const site = url.searchParams.get("site") ?? undefined;
  const q = url.searchParams.get("q") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

  const exams = await prisma.exam.findMany({
    where: {
      ...(site ? { site: { key: site } } : {}),
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ examCode: { contains: q, mode: "insensitive" } }, { examName: { contains: q, mode: "insensitive" } }] } : {}),
    },
    include: { site: true, _count: { select: { links: true } } },
    orderBy: [{ siteId: "asc" }, { examCode: "asc" }],
    take: limit,
  });

  return NextResponse.json({
    count: exams.length,
    exams: exams.map((e) => ({
      site: e.site.key,
      examCode: e.examCode,
      examName: e.examName,
      status: e.status,
      links: e._count.links,
      apiUrl: `/api/exams/${e.site.key}/${encodeURIComponent(e.examCode)}`,
    })),
  });
}
