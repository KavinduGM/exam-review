import "dotenv/config";
import { ensureSitesSeeded } from "../src/lib/seed";
import { prisma } from "../src/lib/prisma";

ensureSitesSeeded()
  .then(() => console.log("seed complete"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
