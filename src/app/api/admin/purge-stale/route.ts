import { NextResponse } from "next/server";
import { purgeStaleExams } from "@/collector/collect";

export const dynamic = "force-dynamic";

// POST /api/exams/purge-stale
// Admin-only (behind dashboard auth). Removes superseded stale exams — those
// whose landing/clean-code is now served by an active row. Stale exams with no
// active replacement are kept and returned for review.
export async function POST() {
  const result = await purgeStaleExams();
  return NextResponse.json(result);
}
