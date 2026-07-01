import { Queue } from "bullmq";
import { redisConnection } from "@/lib/redis";

export const QUEUE_NAME = "auditor";

export type JobName = "collect" | "uptime" | "audit";

export const auditorQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
    attempts: 1,
  },
});

/** Enqueue a one-off job (used by dashboard "run now" buttons / API). */
export async function enqueue(name: JobName, data: Record<string, unknown> = {}): Promise<string> {
  const job = await auditorQueue.add(name, data, { jobId: `${name}-manual-${Date.now()}` });
  return job.id ?? "";
}
