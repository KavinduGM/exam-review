import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CHANNEL_TO_SITE } from "@/config/channels";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

// GET /api/landings/{channel}
// Every active exam for a channel (OAP/OAG/NURSING/STATE) with its landing URL
// and a ready-to-use QR URL — the source list for a QR-generator UI. Public.
//   ?status=up|degraded|down   filter by the landing link's last status
export async function GET(req: Request, ctx: { params: Promise<{ channel: string }> }) {
  const { channel } = await ctx.params;
  const site = CHANNEL_TO_SITE[channel.toUpperCase()];
  if (!site) {
    return NextResponse.json({ error: `unknown channel "${channel}"`, validChannels: Object.keys(CHANNEL_TO_SITE) }, { status: 400 });
  }

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status")?.toLowerCase();
  // Absolute base for the qrUrl so the list is usable as-is by an external app.
  const base = env.publicApiBase || url.origin;

  const exams = await prisma.exam.findMany({
    where: { site: { key: site }, status: { not: "stale" } },
    select: {
      examCode: true,
      examName: true,
      nameResolved: true,
      landingUrl: true,
      links: { where: { type: "LANDING", active: true }, select: { lastStatus: true }, take: 1 },
    },
    orderBy: { examCode: "asc" },
  });

  const rows = exams
    .map((e) => ({
      channel: channel.toUpperCase(),
      examCode: e.examCode,
      examName: e.examName,
      nameResolved: e.nameResolved,
      landingUrl: e.landingUrl,
      landingStatus: e.links[0]?.lastStatus ?? null,
      qrUrl: `${base}/api/qr/${site}/${encodeURIComponent(e.examCode)}`, // append ?format=svg / ?download=1
    }))
    .filter((r) => (statusFilter ? r.landingStatus === statusFilter : true));

  return NextResponse.json({ channel: channel.toUpperCase(), site, count: rows.length, exams: rows });
}
