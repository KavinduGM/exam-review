// Maps the automation system's channel codes to our site keys, and parses the
// combined key format "OAP_SG_D310" / "NURSING_QA_TEAS".

export const CHANNEL_TO_SITE: Record<string, string> = {
  OAP: "oapractice",
  OAG: "oaguides",
  NURSING: "nursingexamsupport",
  STATE: "stateexamsprep",
};

// The middle token is the content type; it's not needed to resolve the exam.
const CONTENT_TYPES = new Set(["SG", "QA"]);

// Suffix used in QR filenames per channel.
const CHANNEL_QR_TAG: Record<string, string> = { OAP: "oaP", OAG: "oaG", NURSING: "Nursing", STATE: "State" };

/** Filename-safe token: runs of non-alphanumerics collapse to one "_". */
function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * QR image filename for an exam, per the agreed convention:
 *   OAP/OAG      -> QR_{UPPERCODE}_oaP  / _oaG      (code-based)
 *   NURSING/STATE -> QR_{Exam_Name}_Nursing / _State (name-based)
 * Returns the base name WITHOUT extension.
 */
export function qrFilenameBase(channel: string, examCode: string, examName: string): string {
  const ch = channel.toUpperCase();
  const tag = CHANNEL_QR_TAG[ch] ?? ch;
  const ident = ch === "OAP" || ch === "OAG" ? examCode.toUpperCase() : sanitizeForFilename(examName);
  return `QR_${ident}_${tag}`;
}

export interface ParsedKey {
  channel: string; // "OAP"
  site: string | null; // "oapractice" (null if channel unknown)
  contentType: string | null; // "SG" | "QA" | null
  examCode: string; // "D310" (may itself contain separators, preserved)
  raw: string;
}

/**
 * Parse "OAP_SG_D310" -> { channel: OAP, site: oapractice, contentType: SG, examCode: D310 }.
 * Tolerant: accepts "_" or "-" or "/" separators, missing content type
 * ("OAP_D310"), and exam codes that themselves contain a separator
 * ("STATE_QA_NY_PCL" -> examCode "NY_PCL").
 */
export function parseChannelKey(raw: string): ParsedKey {
  const cleaned = raw.trim();
  const parts = cleaned.split(/[_\-/\s]+/).filter(Boolean);
  const channel = (parts[0] ?? "").toUpperCase();
  const site = CHANNEL_TO_SITE[channel] ?? null;

  let contentType: string | null = null;
  let rest: string[];
  if (parts[1] && CONTENT_TYPES.has(parts[1].toUpperCase())) {
    contentType = parts[1].toUpperCase();
    rest = parts.slice(2);
  } else {
    rest = parts.slice(1);
  }

  return { channel, site, contentType, examCode: rest.join("_").toUpperCase(), raw: cleaned };
}
