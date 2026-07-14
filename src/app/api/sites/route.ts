import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const CreateSite = z.object({
  key: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, "key must be lowercase letters, numbers, or dashes"),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url("baseUrl must be a valid URL"),
  sitemapUrl: z.string().url().optional().or(z.literal("")),
  defaultSets: z.coerce.number().int().min(1).max(20).optional(),
  defaultParts: z.coerce.number().int().min(1).max(20).optional(),
  defaultTimedSets: z.coerce.number().int().min(0).max(20).optional(),
});

// GET /api/sites — list (protected)
export async function GET() {
  const sites = await prisma.site.findMany({
    include: { _count: { select: { exams: true } } },
    orderBy: { key: "asc" },
  });
  return NextResponse.json({ sites });
}

// POST /api/sites — add a new website (protected)
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = CreateSite.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const d = parsed.data;
  try {
    const site = await prisma.site.create({
      data: {
        key: d.key,
        name: d.name,
        baseUrl: d.baseUrl.replace(/\/+$/, ""),
        sitemapUrl: d.sitemapUrl ? d.sitemapUrl : null,
        defaultSets: d.defaultSets ?? 5,
        defaultParts: d.defaultParts ?? 3,
        defaultTimedSets: d.defaultTimedSets ?? 5,
      },
    });
    return NextResponse.json({ ok: true, site });
  } catch (err) {
    const msg = err instanceof Error && err.message.includes("Unique") ? `key "${d.key}" already exists` : "could not create site";
    return NextResponse.json({ ok: false, error: msg }, { status: 409 });
  }
}
