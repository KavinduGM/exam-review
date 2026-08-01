// The name every consumer should use: a manual dashboard override when set,
// otherwise the collected name. Keep this the ONLY place the precedence lives so
// the dashboard, the description API, the resolver and QR filenames can't drift.

export interface NameFields {
  examName: string;
  displayName?: string | null;
}

/** displayName (manual override) if present, else the collected examName. */
export function effectiveName<T extends NameFields>(exam: T): string {
  const override = exam.displayName?.trim();
  return override ? override : exam.examName;
}
