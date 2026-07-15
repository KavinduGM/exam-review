import { NextResponse } from "next/server";
import { clearQueue } from "@/queue/queues";

// POST /api/queue/clear  (protected)
// Drain queued jobs + clear failures. Does not stop a running job.
export async function POST() {
  try {
    const cleared = await clearQueue();
    return NextResponse.json({ ok: true, cleared });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
