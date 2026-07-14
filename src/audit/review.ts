import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const client = env.anthropic.enabled ? new Anthropic({ apiKey: env.anthropic.apiKey }) : null;

export const VerdictSchema = z.object({
  healthy: z.boolean(),
  layoutOk: z.boolean(),
  ctaPresent: z.boolean(),
  ctaWorking: z.boolean(),
  contentRendered: z.boolean(), // questions/exam content actually visible
  imagesOk: z.boolean(), // no broken/missing images or CTA banners
  issues: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

const PROMPTS: Record<string, string> = {
  LANDING:
    "This is an exam landing/article page. Check carefully: (1) does the layout look intact (not broken/blank/error)? (2) Are the call-to-action buttons/links present (Study Guide, Free Practice Questions, Free Timed Exams, Contact)? (3) IMPORTANT — are there any BROKEN or MISSING IMAGES, especially a CTA banner? A broken image shows as an empty box, a broken-image icon (a small square with '?'), or just alt text like a caption sitting on a blank area where a promotional banner should be. If a banner/image failed to load, set imagesOk=false and healthy=false.",
  PRACTICE:
    "This is a free practice-questions page. Check: do actual questions with answer options render? Is the layout intact? Is there any database/server error, or an empty/'no questions' state?",
  TIMED:
    "This is a timed exam page. Check: does the exam/questions UI render with a start or submit control? Is the layout intact? Any error or empty state?",
  CONTACT: "This is a contact page. Check: is there a working-looking contact form (fields + submit)? Is the layout intact?",
};

const SYSTEM =
  "You are a meticulous QA reviewer for exam-prep websites. You inspect a screenshot of a page and return ONLY a JSON object (no prose, no markdown fences) matching this shape: " +
  '{"healthy": boolean, "layoutOk": boolean, "ctaPresent": boolean, "ctaWorking": boolean, "contentRendered": boolean, "imagesOk": boolean, "issues": string[], "confidence": number (0..1), "summary": string}. ' +
  "Set ctaWorking based only on whether buttons look enabled/real (you cannot click). Set imagesOk=false if ANY image is broken or missing — a broken-image placeholder icon, an empty framed box, or stray alt text/caption where a banner should be. " +
  "Be strict: blank pages, error text, missing content, broken layout, OR broken/missing images => healthy=false.";

/**
 * Tier-2 visual review of a page screenshot.
 * `flagged` routes to the stronger model; healthy-sample uses the cheap one.
 */
export async function reviewScreenshot(
  type: string,
  pngBase64: string,
  opts: { flagged?: boolean; hint?: string } = {},
): Promise<Verdict | null> {
  if (!client) {
    logger.info("Anthropic disabled (no ANTHROPIC_API_KEY) — skipping AI review");
    return null;
  }
  const model = opts.flagged ? env.anthropic.reviewModel : env.anthropic.triageModel;
  const instruction = (PROMPTS[type] ?? PROMPTS.LANDING) + (opts.hint ? `\n\nContext: ${opts.hint}` : "");

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 700,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
            { type: "text", text: instruction },
          ],
        },
      ],
    });

    const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    const json = extractJson(text);
    if (!json) return null;
    const parsed = VerdictSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.issues }, "AI verdict failed schema validation");
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.error({ err, model }, "AI review failed");
    return null;
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
