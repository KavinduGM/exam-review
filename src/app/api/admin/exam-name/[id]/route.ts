import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { effectiveName } from "@/lib/examName";

export const dynamic = "force-dynamic";

const Body = z.object({
  // "" or null clears the override and falls back to the collected name.
  displayName: z.string().max(300).nullable(),
});

// PATCH /api/admin/exam-name/{id}
// Admin-only (under /api/admin, so the dashboard session gate applies). Sets or
// clears the manual name override. The collector never writes displayName, so an
// edit here survives every re-collect.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const examId = Number(id);
  if (!Number.isFinite(examId)) return NextResponse.json({ error: "bad exam id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  const trimmed = parsed.data.displayName?.trim() ?? "";
  const exists = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "exam not found" }, { status: 404 });

  const exam = await prisma.exam.update({
    where: { id: examId },
    data: { displayName: trimmed === "" ? null : trimmed },
    select: { id: true, examCode: true, examName: true, displayName: true },
  });

  return NextResponse.json({
    id: exam.id,
    examCode: exam.examCode,
    collectedName: exam.examName,
    displayName: exam.displayName,
    effectiveName: effectiveName(exam),
    overridden: exam.displayName !== null,
  });
}
