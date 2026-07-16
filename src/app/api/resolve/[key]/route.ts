import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { descriptionKeyOk } from "@/lib/apikey";
import { parseChannelKey, CHANNEL_TO_SITE } from "@/config/channels";
import { resolveExam } from "@/lib/resolveExam";

export const dynamic = "force-dynamic";

// GET /api/resolve/{key}   (x-api-key: DESCRIPTION_API_KEY)
// The automation system sends a channel-coded exam key ("OAP_SG_D310",
// "NURSING_QA_TEAS"). We parse the channel + exam number, resolve the canonical
// exam NAME (fuzzy-matching vendor prefixes / name variants), and return it with
// the exam's entry links and a confidence level.
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  if (!env.descriptionApiKey) return NextResponse.json({ error: "DESCRIPTION_API_KEY not configured" }, { status: 503 });
  if (!descriptionKeyOk(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { key } = await ctx.params;
  const parsed = parseChannelKey(decodeURIComponent(key));

  if (!parsed.site) {
    return NextResponse.json(
      { input: parsed.raw, error: `unknown channel "${parsed.channel}"`, validChannels: Object.keys(CHANNEL_TO_SITE) },
      { status: 400 },
    );
  }
  if (!parsed.examCode) {
    return NextResponse.json({ input: parsed.raw, error: "no exam code found in key" }, { status: 400 });
  }

  const result = await resolveExam(parsed.site, parsed.examCode);

  const base = {
    input: parsed.raw,
    channel: parsed.channel,
    site: parsed.site,
    contentType: parsed.contentType,
    requestedCode: parsed.examCode,
    confidence: result.confidence,
    matchedVia: result.matchedVia,
  };

  // Nothing matched, or too ambiguous to auto-pick — hand back candidates so the
  // automation can flag it for review rather than use a wrong name.
  if (!result.exam) {
    return NextResponse.json({ ...base, resolved: false, candidates: result.candidates }, { status: result.confidence === "none" ? 404 : 409 });
  }

  const exam = result.exam;

  return NextResponse.json({
    ...base,
    resolved: true,
    examCode: exam.examCode,
    examName: exam.examName,
    nameResolved: exam.nameResolved, // true = name came from the exam-manager DB (authoritative)
    links: {
      studyGuide: exam.landingUrl,
      practiceQuestions: exam.practiceBaseUrl,
      timedExams: exam.timedBaseUrl,
      contact: exam.contactUrl,
    },
    // Other exams that also scored (empty when the match was unambiguous).
    alternativeCandidates: result.candidates.filter((c) => c.examCode !== exam.examCode),
  });
}
