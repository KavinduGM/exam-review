import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exactCodeWhere, fuzzyCodeWhere } from "@/lib/examLookup";

export const dynamic = "force-dynamic";

// GET /api/exam/{group}/{code}
// The grouped export for one exam: all links from every site in the brand group
// (OAP + OAG for "oa"), under one canonical name, with timed deduped. Public.
export async function GET(_req: Request, ctx: { params: Promise<{ group: string; code: string }> }) {
  const { group, code } = await ctx.params;
  const examCode = decodeURIComponent(code);

  const grp = await prisma.siteGroup.findUnique({ where: { key: group } });
  if (!grp) return NextResponse.json({ error: "group not found", group }, { status: 404 });

  const include = {
    site: true,
    links: { where: { active: true }, orderBy: [{ type: "asc" as const }, { variant: "asc" as const }, { setNo: "asc" as const }, { part: "asc" as const }] },
  };
  let exams = await prisma.exam.findMany({
    where: { ...exactCodeWhere(examCode), site: { groupId: grp.id } },
    include,
    orderBy: { siteId: "asc" },
  });
  if (exams.length === 0) {
    // Fallback: historical rows keyed by a long timed slug (…-c720).
    exams = await prisma.exam.findMany({
      where: { ...fuzzyCodeWhere(examCode), site: { groupId: grp.id } },
      include,
      orderBy: { siteId: "asc" },
    });
  }
  if (exams.length === 0) return NextResponse.json({ error: "exam not found", group, code: examCode }, { status: 404 });

  const named = exams.find((e) => e.nameResolved);
  const descriptive = named?.examName ?? exams[0].examName;
  const canonicalName = `${grp.namePrefix ? grp.namePrefix + " " : ""}${examCode}${named ? " - " + descriptive : ""}`;

  // Per-site blocks (study guide, contact, practice by subdomain).
  const sites = exams.map((e) => {
    const byType = (t: string) => e.links.filter((l) => l.type === t);
    return {
      site: e.site.key,
      siteName: e.site.name,
      studyGuide: byType("LANDING")[0]?.url ?? null,
      contact: byType("CONTACT")[0]?.url ?? null,
      practice: byType("PRACTICE").map((l) => ({
        set: l.setNo,
        part: l.part,
        subdomain: l.variant || "questions",
        url: l.url,
        status: l.lastStatus,
      })),
    };
  });

  // Timed is shared across the group's sites → dedupe by URL.
  const timedMap = new Map<string, { set: number; url: string; status: string | null }>();
  for (const e of exams) {
    for (const l of e.links.filter((l) => l.type === "TIMED")) {
      if (!timedMap.has(l.url)) timedMap.set(l.url, { set: l.setNo, url: l.url, status: l.lastStatus });
    }
  }
  const timed = [...timedMap.values()].sort((a, b) => a.set - b.set);

  return NextResponse.json({
    group: grp.key,
    examCode,
    name: canonicalName,
    nameResolved: Boolean(named),
    sites,
    timed,
  });
}
