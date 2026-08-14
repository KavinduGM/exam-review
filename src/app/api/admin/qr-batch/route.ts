import { NextResponse } from "next/server";
import { z } from "zod";
import QRCode from "qrcode";
import JSZip from "jszip";

export const dynamic = "force-dynamic";

const Body = z.object({
  // One entry per QR. `name` is optional — we derive a sensible filename from
  // the URL when it's absent.
  items: z
    .array(
      z.object({
        url: z.string().trim().regex(/^https?:\/\/\S+$/i, "must be an http(s) URL"),
        name: z.string().trim().max(120).optional(),
      }),
    )
    .min(1)
    .max(500),
  size: z.number().int().min(128).max(2048).optional(),
  format: z.enum(["png", "svg"]).optional(),
});

/** Filename-safe token. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
}

/**
 * Derive a filename from a URL when the caller didn't supply one:
 * prefer an ?ec= exam code, else the last meaningful path segment.
 */
function nameFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const ec = u.searchParams.get("ec");
    if (ec) return `QR_${sanitize(ec.toUpperCase())}`;
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return `QR_${sanitize(decodeURIComponent(seg))}`;
    return `QR_${sanitize(u.hostname)}`;
  } catch {
    return "QR_link";
  }
}

// POST /api/admin/qr-batch
// Admin-only (under /api/admin → dashboard session required).
// Body: { items: [{ url, name? }], size?, format? }
// Returns a ZIP of QR images — one per URL. This is the "paste some links and
// get their QR codes" path, for exams added since your last export.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const { items, size = 512, format = "png" } = parsed.data;

  const zip = new JSZip();
  const opts = { margin: 2, errorCorrectionLevel: "M" as const };
  const used = new Set<string>();

  for (const item of items) {
    let base = item.name ? sanitize(item.name) : nameFromUrl(item.url);
    if (!base) base = "QR_link";
    // Two links can legitimately want the same name — keep both.
    let filename = `${base}.${format}`;
    let n = 2;
    while (used.has(filename)) filename = `${base}_${n++}.${format}`;
    used.add(filename);

    if (format === "svg") {
      zip.file(filename, await QRCode.toString(item.url, { ...opts, type: "svg", width: size }));
    } else {
      zip.file(filename, await QRCode.toBuffer(item.url, { ...opts, type: "png", width: size }));
    }
  }

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="QR_codes_${items.length}.zip"`,
      "cache-control": "no-store",
    },
  });
}
