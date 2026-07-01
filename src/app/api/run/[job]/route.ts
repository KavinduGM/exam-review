import { NextResponse } from "next/server";
import { enqueue, type JobName } from "@/queue/queues";

const VALID: JobName[] = ["collect", "uptime", "audit"];

// POST /api/run/{job}  (protected by middleware)
// Manually trigger a collect / uptime / audit run from the dashboard.
export async function POST(_req: Request, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  if (!VALID.includes(job as JobName)) {
    return NextResponse.json({ ok: false, error: `unknown job "${job}"` }, { status: 400 });
  }
  try {
    const id = await enqueue(job as JobName);
    return NextResponse.json({ ok: true, job, jobId: id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
