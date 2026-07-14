import { prisma } from "./prisma";
import { logger } from "./logger";

interface GroupDef {
  key: string;
  name: string;
  namePrefix?: string;
  siteKeys: string[];
}

// Brand groups. OA aggregates oapractice + oaguides (shared exams). Everything
// else is standalone (one site per group). User-added sites get their own group.
export const GROUP_DEFS: GroupDef[] = [
  { key: "oa", name: "OA (WGU)", namePrefix: "WGU", siteKeys: ["oapractice", "oaguides"] },
  { key: "nursing", name: "Nursing Exam Support", siteKeys: ["nursingexamsupport"] },
  { key: "state", name: "State Exams Prep", siteKeys: ["stateexamsprep"] },
  { key: "onlineexamtest", name: "Online Exam Test", siteKeys: ["onlineexamtest"] },
  { key: "onlinedegreeblogs", name: "Online Degree Blogs", siteKeys: ["onlinedegreeblogs"] },
];

export function groupKeyForSite(siteKey: string): string {
  const g = GROUP_DEFS.find((d) => d.siteKeys.includes(siteKey));
  return g ? g.key : siteKey; // standalone group keyed by the site itself
}

async function ensureGroup(key: string, name: string, namePrefix = ""): Promise<number> {
  const g = await prisma.siteGroup.upsert({ where: { key }, update: { name, namePrefix }, create: { key, name, namePrefix } });
  return g.id;
}

/** Ensure brand groups exist and every site is assigned to one. Idempotent. */
export async function ensureGroups(): Promise<void> {
  const idByKey = new Map<string, number>();
  for (const d of GROUP_DEFS) idByKey.set(d.key, await ensureGroup(d.key, d.name, d.namePrefix ?? ""));

  const sites = await prisma.site.findMany();
  for (const s of sites) {
    const gkey = groupKeyForSite(s.key);
    let gid = idByKey.get(gkey);
    if (gid === undefined) {
      gid = await ensureGroup(gkey, s.name); // standalone group for a user-added site
      idByKey.set(gkey, gid);
    }
    if (s.groupId !== gid) await prisma.site.update({ where: { id: s.id }, data: { groupId: gid } });
  }
  logger.info({ groups: idByKey.size, sites: sites.length }, "groups ensured");
}
