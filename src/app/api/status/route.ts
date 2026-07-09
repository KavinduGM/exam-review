import { NextResponse } from "next/server";
import { auditorQueue } from "@/queue/queues";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/status  (protected)
// Live activity for the dashboard: queue counts, any running job + its progress,
// and the most recent runs. Polled every few seconds by the Activity component.
export async function GET() {
  try {
    const [counts, activeRaw, runs] = await Promise.all([
      auditorQueue.getJobCounts("active", "waiting", "delayed", "completed", "failed"),
      auditorQueue.getActive(0, 5),
      prisma.checkRun.findMany({ orderBy: { startedAt: "desc" }, take: 8 }),
    ]);

    const activeJobs = activeRaw.map((j) => ({
      name: j.name,
      progress: j.progress ?? null,
      startedAt: j.processedOn ?? null,
    }));

    return NextResponse.json({ counts, activeJobs, runs });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), counts: null, activeJobs: [], runs: [] },
      { status: 200 },
    );
  }
}
