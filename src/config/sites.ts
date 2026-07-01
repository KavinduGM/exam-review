// Seed configuration for the managed sites. The collector discovers exams from
// `baseUrl` (these sites have no sitemap, so it crawls the /exams index + homepage
// and uses the timed DB back_links — see collector/discover.ts). Everything else
// (real practice/timed hosts, slugs, the "C" folder) is EXTRACTED from each landing
// page at collect time, so this list intentionally stays minimal. Add a new site
// here (or via the dashboard / API) and the next run picks up all of its exams.

export interface SiteSeed {
  key: string;
  name: string;
  baseUrl: string;
  sitemapUrl?: string;
  defaultSets?: number;
  defaultParts?: number;
  defaultTimedSets?: number;
}

export const SITE_SEEDS: SiteSeed[] = [
  { key: "oapractice", name: "OA Practice", baseUrl: "https://oapractice.com" },
  { key: "oaguides", name: "OA Guides", baseUrl: "https://oaguides.com" },
  { key: "nursingexamsupport", name: "Nursing Exam Support", baseUrl: "https://nursingexamsupport.com" },
  { key: "stateexamsprep", name: "State Exams Prep", baseUrl: "https://stateexamsprep.com" },
];

// External host that serves all timed exams (shared across every site).
export const TIMED_HOST = "onlineexamtest.com";

// Default front-end pagination for practice sets (parts are NOT in the DB).
export const DEFAULT_PARTS = 3;
export const DEFAULT_SETS = 5;
export const DEFAULT_TIMED_SETS = 5;
