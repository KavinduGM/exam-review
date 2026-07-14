import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const UpdateSite = z.object({
  name: z.string().min(1).max(120).optional(),
  baseUrl: z.string().url().optional(),
  sitemapUrl: z.string().url().optional().or(z.literal("")),
  defaultSets: z.coerce.number().int().min(1).max(20).optional(),
  defaultParts: z.coerce.number().int().min(1).max(20).optional(),
  defaultTimedSets: z.coerce.number().int().min(0).max(20).optional(),
  active: z.boolean().optional(),
});

// PATCH /api/sites/{id} — edit a site (protected)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const siteId = Number(id);
  if (!Number.isFinite(siteId)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });

  const parsed = UpdateSite.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const d = parsed.data;
  const site = await prisma.site.update({
    where: { id: siteId },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.baseUrl !== undefined ? { baseUrl: d.baseUrl.replace(/\/+$/, "") } : {}),
      ...(d.sitemapUrl !== undefined ? { sitemapUrl: d.sitemapUrl || null } : {}),
      ...(d.defaultSets !== undefined ? { defaultSets: d.defaultSets } : {}),
      ...(d.defaultParts !== undefined ? { defaultParts: d.defaultParts } : {}),
      ...(d.defaultTimedSets !== undefined ? { defaultTimedSets: d.defaultTimedSets } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
    },
  });
  return NextResponse.json({ ok: true, site });
}

// DELETE /api/sites/{id} — remove a site and all its exams/links (protected)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const siteId = Number(id);
  if (!Number.isFinite(siteId)) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  await prisma.site.delete({ where: { id: siteId } });
  return NextResponse.json({ ok: true });
}
