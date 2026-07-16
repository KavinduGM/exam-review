import type { LinkType } from "@prisma/client";
import type { PracticeFormat } from "./extract";

export interface GeneratedLink {
  type: LinkType;
  setNo: number; // 0 = not applicable
  part: number; // 0 = not applicable
  variant: string; // practice subdomain ("questions"/"answers"); "" otherwise
  url: string;
}

/** One practice subdomain's base URL + its set/part structure. */
export interface PracticeBase {
  variant: string; // "questions" | "answers"
  baseUrl: string; // query: …/practice-questions/C/?ec=CODE&set=1&part=1  ·  path: …/classes/{code}/set1-part1.html
  format: PracticeFormat; // how set/part is encoded in the URL
  sets: number;
  parts: number;
}

export interface EnumerateInput {
  landingUrl: string;
  practices: PracticeBase[];
  timedUrl: string | null;
  contactUrl: string | null;
  timedSetsCount: number;
}

/**
 * Expand the extracted/known bases into the full concrete link set:
 *   landing(1) + practice(subdomains × sets × parts) + timed(sets) + contact(1).
 */
export function enumerateLinks(input: EnumerateInput): GeneratedLink[] {
  const links: GeneratedLink[] = [];

  links.push({ type: "LANDING", setNo: 0, part: 0, variant: "", url: input.landingUrl });

  for (const p of input.practices) {
    for (let set = 1; set <= p.sets; set++) {
      for (let part = 1; part <= p.parts; part++) {
        links.push({
          type: "PRACTICE",
          setNo: set,
          part,
          variant: p.variant,
          url: p.format === "path" ? withPathSetPart(p.baseUrl, set, part) : withQuery(p.baseUrl, { set: String(set), part: String(part) }),
        });
      }
    }
  }

  if (input.timedUrl) {
    for (let set = 1; set <= input.timedSetsCount; set++) {
      links.push({ type: "TIMED", setNo: set, part: 0, variant: "", url: withTimedSet(input.timedUrl, set) });
    }
  }

  if (input.contactUrl) {
    links.push({ type: "CONTACT", setNo: 0, part: 0, variant: "", url: input.contactUrl });
  }

  return links;
}

function withQuery(url: string, params: Record<string, string>): string {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

function withTimedSet(url: string, set: number): string {
  return url.replace(/\/set-\d+(\/?$)/i, `/set-${set}$1`);
}

/** …/classes/{code}/set1-part1.html -> set{N}-part{P}.html */
function withPathSetPart(url: string, set: number, part: number): string {
  return url.replace(/set\d+-part\d+/i, `set${set}-part${part}`);
}
