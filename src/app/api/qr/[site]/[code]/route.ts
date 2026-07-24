import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { exactCodeWhere, fuzzyCodeWhere } from "@/lib/examLookup";

export const dynamic = "force-dynamic";

// GET /api/qr/{site}/{code}
// A QR code encoding one exam's landing-page URL. Public (it's a public URL).
//   ?format=png|svg   (default png)
//   ?size=<px>        (default 512, clamped 128..2048; ignored for svg scaling)
//   ?download=1       (force a file download instead of inline)
export async function GET(req: Request, ctx: { params: Promise<{ site: string; code: string }> }) {
  const { site, code } = await ctx.params;
  const examCode = decodeURIComponent(code);
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "png").toLowerCase();
  const size = Math.min(2048, Math.max(128, Number(url.searchParams.get("size")) || 512));
  const download = url.searchParams.get("download") === "1";

  const select = { examCode: true, landingUrl: true } as const;
  const exam =
    (await prisma.exam.findFirst({ where: { ...exactCodeWhere(examCode), site: { key: site } }, select })) ??
    (await prisma.exam.findFirst({ where: { ...fuzzyCodeWhere(examCode), site: { key: site } }, select }));

  if (!exam) return NextResponse.json({ error: "exam not found", site, code: examCode }, { status: 404 });
  if (!exam.landingUrl) return NextResponse.json({ error: "exam has no landing URL", site, code: examCode }, { status: 422 });

  const opts = { margin: 2, errorCorrectionLevel: "M" as const };
  const filenameBase = `${site}-${exam.examCode}-qr`;
  // Long cache: a landing URL rarely changes, and the QR is deterministic.
  const cache = "public, max-age=86400, stale-while-revalidate=604800";

  if (format === "svg") {
    const svg = await QRCode.toString(exam.landingUrl, { ...opts, type: "svg", width: size });
    return new NextResponse(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": cache,
        ...(download ? { "content-disposition": `attachment; filename="${filenameBase}.svg"` } : {}),
      },
    });
  }

  const png = await QRCode.toBuffer(exam.landingUrl, { ...opts, type: "png", width: size });
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "content-type": "image/png",
      "cache-control": cache,
      ...(download ? { "content-disposition": `attachment; filename="${filenameBase}.png"` } : {}),
    },
  });
}
