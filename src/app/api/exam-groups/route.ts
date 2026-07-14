import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/exam-groups — list brand groups with their sites and exam counts. Public.
// GET /api/exam-groups?group=oa — list every exam (code + canonical name) in a group.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const groupKey = url.searchParams.get("group");

  if (groupKey) {
    const grp = await prisma.siteGroup.findUnique({ where: { key: groupKey } });
    if (!grp) return NextResponse.json({ error: "group not found" }, { status: 404 });
    const exams = await prisma.exam.findMany({
      where: { site: { groupId: grp.id } },
      select: { examCode: true, examName: true, nameResolved: true },
    });
    // Distinct by code (OAP + OAG share a code).
    const byCode = new Map<string, { examCode: string; name: string; nameResolved: boolean }>();
    for (const e of exams) {
      const cur = byCode.get(e.examCode);
      if (!cur || (!cur.nameResolved && e.nameResolved)) {
        byCode.set(e.examCode, {
          examCode: e.examCode,
          name: `${grp.namePrefix ? grp.namePrefix + " " : ""}${e.examCode}${e.nameResolved ? " - " + e.examName : ""}`,
          nameResolved: e.nameResolved,
        });
      }
    }
    const list = [...byCode.values()].sort((a, b) => a.examCode.localeCompare(b.examCode));
    return NextResponse.json({ group: grp.key, count: list.length, exams: list, apiHint: `/api/exam/${grp.key}/{code}` });
  }

  const groups = await prisma.siteGroup.findMany({ include: { sites: { select: { key: true } } }, orderBy: { key: "asc" } });
  const withCounts = await Promise.all(
    groups.map(async (g) => {
      const codes = await prisma.exam.findMany({ where: { site: { groupId: g.id } }, select: { examCode: true } });
      return {
        group: g.key,
        name: g.name,
        namePrefix: g.namePrefix,
        sites: g.sites.map((s) => s.key),
        exams: new Set(codes.map((c) => c.examCode)).size,
      };
    }),
  );
  return NextResponse.json({ groups: withCounts });
}
