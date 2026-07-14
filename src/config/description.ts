// Labels + formatting for the YouTube-description export. Edit these to change
// the exact wording that appears in generated descriptions.

export interface DescriptionLinks {
  studyGuide: string | null;
  practiceQuestions: string | null;
  timedExams: string | null;
  contact: string | null;
}

export const DESCRIPTION_LABELS: DescriptionLinks & Record<string, string> = {
  studyGuide: "Study Guide & Course Breakdown:",
  practiceQuestions: "Free Practice Questions:",
  timedExams: "Free Timed Exams:",
  contact: "Want a Guaranteed Pass? Connect with our premium tutors today:",
};

/** Build the ready-to-paste description block, skipping any missing link. */
export function buildDescriptionBlock(l: DescriptionLinks): string {
  const lines: string[] = [];
  if (l.studyGuide) lines.push(`${DESCRIPTION_LABELS.studyGuide} ${l.studyGuide}`);
  if (l.practiceQuestions) lines.push(`${DESCRIPTION_LABELS.practiceQuestions} ${l.practiceQuestions}`);
  if (l.timedExams) lines.push(`${DESCRIPTION_LABELS.timedExams} ${l.timedExams}`);
  if (l.contact) lines.push(`${DESCRIPTION_LABELS.contact} ${l.contact}`);
  return lines.join("\n\n");
}
