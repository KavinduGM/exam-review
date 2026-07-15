import { NextResponse } from "next/server";
import { auditorQueue } from "@/queue/queues";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/status  (protected)
// Rich live activity: whether a worker is connected, full queue counts, the
// active job's elapsed time + progress, how long jobs have been waiting, recent
// failures, and recent run durations. Polled by the Activity component.
export async function GET() {
  try {
    const now = Date.now();
    const [counts, activeRaw, waitingRaw, failedRaw, runs, workers, recentRun] = await Promise.all([
      auditorQueue.getJobCounts("active", "waiting", "delayed", "completed", "failed", "paused"),
      auditorQueue.getActive(0, 5),
      auditorQueue.getWaiting(0, 15),
      auditorQueue.getFailed(0, 5),
      prisma.checkRun.findMany({ orderBy: { startedAt: "desc" }, take: 8 }),
      auditorQueue.getWorkers().catch(() => [] as unknown[]),
      prisma.checkRun.findFirst({ where: { finishedAt: { gte: new Date(now - 15 * 60_000) } }, orderBy: { finishedAt: "desc" } }),
    ]);

    // getWorkers() can be flaky on Redis, so also treat an active job or a run
    // finished in the last 15 min (uptime runs every 10) as proof of a live worker.
    const workerAlive = workers.length > 0 || (counts.active ?? 0) > 0 || Boolean(recentRun);
    const activeJobs = activeRaw.map((j) => ({
      name: j.name,
      progress: j.progress ?? null,
      elapsedMs: j.processedOn ? now - j.processedOn : null,
    }));
    const waiting = waitingRaw.map((j) => ({ name: j.name, ageMs: j.timestamp ? now - j.timestamp : null }));
    const failed = failedRaw.map((j) => ({
      name: j.name,
      reason: (j.failedReason ?? "").slice(0, 300),
      at: j.finishedOn ?? null,
    }));
    const recentRuns = runs.map((r) => ({
      type: r.type,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.finishedAt ? +r.finishedAt - +r.startedAt : null,
    }));

    return NextResponse.json({ counts, workers: workers.length, workerAlive, activeJobs, waiting, failed, recentRuns });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), counts: null, workers: 0, workerAlive: false, activeJobs: [], waiting: [], failed: [], recentRuns: [] },
      { status: 200 },
    );
  }
}
