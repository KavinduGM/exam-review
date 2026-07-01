// Slug helpers.
//
// IMPORTANT: the timed-exam slug observed on onlineexamtest.com does NOT collapse
// consecutive dashes. The landing title "Exploring Data - D467" becomes
// "exploring-data---d467" (three dashes from " - "). We therefore expose a
// non-collapsing variant matching that behaviour, plus a normal collapsing one.
//
// In practice the collector EXTRACTS the real slug from the landing page link, so
// these are only used as a fallback / for validation against the timed DB.

// Combining diacritical marks (U+0300–U+036F) left over after NFKD normalization.
const COMBINING = new RegExp("[\\u0300-\\u036f]", "g");

export function slugifyTimed(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // drop punctuation except spaces and dashes
    .replace(/\s/g, "-"); // each space -> one dash (NO collapsing)
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-") // collapse runs of space/dash to a single dash
    .replace(/^-+|-+$/g, "");
}
