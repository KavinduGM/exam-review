import { prisma } from "./prisma";
import { logger } from "./logger";
import { SITE_SEEDS, DEFAULT_PARTS, DEFAULT_SETS, DEFAULT_TIMED_SETS } from "@/config/sites";

/**
 * Seed the initial sites ONLY on a fresh DB. After that, sites are managed
 * entirely from the dashboard (add/edit/delete), so we never re-add a site the
 * user deleted or overwrite their edits.
 */
export async function ensureSitesSeeded(): Promise<void> {
  const existing = await prisma.site.count();
  if (existing > 0) return;
  for (const s of SITE_SEEDS) {
    await prisma.site.create({
      data: {
        key: s.key,
        name: s.name,
        baseUrl: s.baseUrl,
        sitemapUrl: s.sitemapUrl ?? null,
        defaultSets: s.defaultSets ?? DEFAULT_SETS,
        defaultParts: s.defaultParts ?? DEFAULT_PARTS,
        defaultTimedSets: s.defaultTimedSets ?? DEFAULT_TIMED_SETS,
      },
    });
  }
  logger.info({ count: SITE_SEEDS.length }, "initial sites seeded (fresh DB)");
}
