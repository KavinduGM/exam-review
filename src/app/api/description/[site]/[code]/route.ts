import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { descriptionKeyOk as keyOk } from "@/lib/apikey";
import { exactCodeWhere, fuzzyCodeWhere } from "@/lib/examLookup";
import { DESCRIPTION_LABELS, buildDescriptionBlock, type DescriptionLinks } from "@/config/description";

export const dynamic = "force-dynamic";

// GET /api/description/{site}/{code}
// The YouTube-description links for one exam on one channel/site. API-key protected.
// {site} is the Site.key (oapractice / oaguides / nursingexamsupport / stateexamsprep).
export async function GET(req: Request, ctx: { params: Promise<{ site: string; code: string }> }) {
  if (!env.descriptionApiKey) {
    return NextResponse.json({ error: "DESCRIPTION_API_KEY is not configured on the server" }, { status: 503 });
  }
  if (!keyOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { site, code } = await ctx.params;
  const examCode = decodeURIComponent(code);

  const include = {
    site: true,
    links: { where: { active: true }, select: { type: true, url: true, lastStatus: true } },
  } as const;
  const exam =
    (await prisma.exam.findFirst({ where: { ...exactCodeWhere(examCode), site: { key: site } }, include })) ??
    (await prisma.exam.findFirst({ where: { ...fuzzyCodeWhere(examCode), site: { key: site } }, include }));
  if (!exam) {
    return NextResponse.json({ error: "exam not found", site, code: examCode }, { status: 404 });
  }

  // Entry links come straight off the exam (the site's primary practice/timed).
  const links: DescriptionLinks = {
    studyGuide: exam.landingUrl,
    practiceQuestions: exam.practiceBaseUrl,
    timedExams: exam.timedBaseUrl,
    contact: exam.contactUrl,
  };

  // Attach current health of each entry link (so a caller can skip a down link).
  const statusOf = (url: string | null) => (url ? (exam.links.find((l) => l.url === url)?.lastStatus ?? null) : null);
  const status: Record<keyof DescriptionLinks, string | null> = {
    studyGuide: statusOf(links.studyGuide),
    practiceQuestions: statusOf(links.practiceQuestions),
    timedExams: statusOf(links.timedExams),
    contact: statusOf(links.contact),
  };
  const allUp = Object.values(status).every((s) => s === null || s === "up");

  return NextResponse.json({
    site: exam.site.key,
    siteName: exam.site.name,
    examCode: exam.examCode,
    examName: exam.examName,
    nameResolved: exam.nameResolved,
    links,
    status,
    allUp,
    labels: DESCRIPTION_LABELS,
    descriptionBlock: buildDescriptionBlock(links),
  });
}
