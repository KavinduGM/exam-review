// One-off collection run for testing/bootstrapping.
//   npm run collect            -> collect all sites
//   npm run collect oapractice -> collect a single site by key
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { ensureSitesSeeded } from "@/lib/seed";
import { collectSite, collectAllSites } from "@/collector/collect";
import { closeAllPools } from "@/sources/mysql";

async function main() {
  await ensureSitesSeeded();
  const key = process.argv[2];

  if (key) {
    const site = await prisma.site.findUnique({ where: { key } });
    if (!site) throw new Error(`no site with key "${key}"`);
    const res = await collectSite(site);
    console.log(JSON.stringify(res, null, 2));
  } else {
    const res = await collectAllSites();
    console.log(JSON.stringify(res, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllPools();
    await prisma.$disconnect();
  });
