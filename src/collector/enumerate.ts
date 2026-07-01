import type { LinkType } from "@prisma/client";

export interface GeneratedLink {
  type: LinkType;
  setNo: number; // 0 = not applicable
  part: number; // 0 = not applicable
  url: string;
}

export interface EnumerateInput {
  landingUrl: string;
  practiceUrl: string | null;
  timedUrl: string | null;
  contactUrl: string | null;
  setsCount: number;
  partsCount: number;
  timedSetsCount: number;
}

/**
 * Expand the extracted base links into the full concrete link set:
 *   landing(1) + practice(sets × parts) + timed(sets) + contact(1).
 * Built by editing the real URLs so query/encoding quirks are preserved.
 * setNo/part use 0 (not null) when not applicable — see schema note.
 */
export function enumerateLinks(input: EnumerateInput): GeneratedLink[] {
  const links: GeneratedLink[] = [];

  links.push({ type: "LANDING", setNo: 0, part: 0, url: input.landingUrl });

  if (input.practiceUrl) {
    for (let set = 1; set <= input.setsCount; set++) {
      for (let part = 1; part <= input.partsCount; part++) {
        links.push({
          type: "PRACTICE",
          setNo: set,
          part,
          url: withQuery(input.practiceUrl, { set: String(set), part: String(part) }),
        });
      }
    }
  }

  if (input.timedUrl) {
    for (let set = 1; set <= input.timedSetsCount; set++) {
      links.push({ type: "TIMED", setNo: set, part: 0, url: withTimedSet(input.timedUrl, set) });
    }
  }

  if (input.contactUrl) {
    links.push({ type: "CONTACT", setNo: 0, part: 0, url: input.contactUrl });
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

/** Replace the trailing /set-N segment with the requested set number. */
function withTimedSet(url: string, set: number): string {
  return url.replace(/\/set-\d+(\/?$)/i, `/set-${set}$1`);
}
