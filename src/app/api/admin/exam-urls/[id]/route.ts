import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { effectiveEntryLinks } from "@/lib/examUrls";
import { syncEntryLinks } from "@/collector/collect";

export const dynamic = "force-dynamic";

// "" / null clears an override (revert to the collected URL); otherwise it must
// be a real http(s) URL so we can't store something unmonitorable.
const urlField = z
  .string()
  .trim()
  .nullable()
  .refine((v) => v === null || v === "" || /^https?:\/\/\S+$/i.test(v), { message: "must be an http(s) URL" });

const Body = z.object({
  landingUrl: urlField.optional(),
  practiceUrl: urlField.optional(),
  timedUrl: urlField.optional(),
  contactUrl: urlField.optional(),
});

// PATCH /api/admin/exam-urls/{id}
// Admin-only (under /api/admin → dashboard session required). Sets or clears the
// manual URL corrections. The collector never writes these, so they survive every
// re-collect; the monitored links are re-synced immediately so the corrected URL
// is what gets checked from now on.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const examId = Number(id);
  if (!Number.isFinite(examId)) return NextResponse.json({ error: "bad exam id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const b = parsed.data;
  const norm = (v: string | null | undefined) => (v === undefined ? undefined : v && v.trim() ? v.trim() : null);

  const exists = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "exam not found" }, { status: 404 });

  const exam = await prisma.exam.update({
    where: { id: examId },
    data: {
      landingUrlOverride: norm(b.landingUrl),
      practiceUrlOverride: norm(b.practiceUrl),
      timedUrlOverride: norm(b.timedUrl),
      contactUrlOverride: norm(b.contactUrl),
    },
  });

  // Re-point the monitored links at the corrected URLs right away, instead of
  // waiting for the next nightly collect.
  const resynced = await syncEntryLinks(exam);

  return NextResponse.json({
    id: exam.id,
    examCode: exam.examCode,
    collected: {
      landingUrl: exam.landingUrl,
      practiceUrl: exam.practiceBaseUrl,
      timedUrl: exam.timedBaseUrl,
      contactUrl: exam.contactUrl,
    },
    overrides: {
      landingUrl: exam.landingUrlOverride,
      practiceUrl: exam.practiceUrlOverride,
      timedUrl: exam.timedUrlOverride,
      contactUrl: exam.contactUrlOverride,
    },
    effective: effectiveEntryLinks(exam),
    linksResynced: resynced,
  });
}
