import { prisma } from "./prisma";
import { logger } from "./logger";
import { SITE_SEEDS, DEFAULT_PARTS, DEFAULT_SETS, DEFAULT_TIMED_SETS } from "@/config/sites";

/** Ensure the configured sites exist in the master DB. Safe to run repeatedly. */
export async function ensureSitesSeeded(): Promise<void> {
  for (const s of SITE_SEEDS) {
    await prisma.site.upsert({
      where: { key: s.key },
      update: { name: s.name, baseUrl: s.baseUrl, sitemapUrl: s.sitemapUrl ?? null },
      create: {
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
  logger.info({ count: SITE_SEEDS.length }, "sites seeded");
}
