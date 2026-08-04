// Entry-URL precedence for an exam: a manual dashboard correction when set,
// otherwise the collected URL. Keep this the ONLY place the precedence lives so
// monitoring, the APIs, the QR codes and link enumeration can't drift apart.

export interface UrlFields {
  landingUrl: string;
  practiceBaseUrl?: string | null;
  timedBaseUrl?: string | null;
  contactUrl?: string | null;
  landingUrlOverride?: string | null;
  practiceUrlOverride?: string | null;
  timedUrlOverride?: string | null;
  contactUrlOverride?: string | null;
}

const pick = (override: string | null | undefined, collected: string | null | undefined): string | null => {
  const o = override?.trim();
  if (o) return o;
  const c = collected?.trim();
  return c ? c : null;
};

/** The landing page we monitor / return / encode in QR codes. */
export function effectiveLanding<T extends UrlFields>(e: T): string {
  // landingUrl is non-null in the schema, so this always resolves to a string.
  return pick(e.landingUrlOverride, e.landingUrl) ?? e.landingUrl;
}

export function effectivePractice<T extends UrlFields>(e: T): string | null {
  return pick(e.practiceUrlOverride, e.practiceBaseUrl);
}

export function effectiveTimed<T extends UrlFields>(e: T): string | null {
  return pick(e.timedUrlOverride, e.timedBaseUrl);
}

export function effectiveContact<T extends UrlFields>(e: T): string | null {
  return pick(e.contactUrlOverride, e.contactUrl);
}

/** All four entry links at once, in the shape the description API uses. */
export function effectiveEntryLinks<T extends UrlFields>(e: T) {
  return {
    studyGuide: effectiveLanding(e),
    practiceQuestions: effectivePractice(e),
    timedExams: effectiveTimed(e),
    contact: effectiveContact(e),
  };
}

/** True when any entry URL has been hand-corrected. */
export function hasUrlOverride<T extends UrlFields>(e: T): boolean {
  return Boolean(
    e.landingUrlOverride?.trim() || e.practiceUrlOverride?.trim() || e.timedUrlOverride?.trim() || e.contactUrlOverride?.trim(),
  );
}
