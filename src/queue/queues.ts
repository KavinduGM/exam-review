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

/** Enqueue a one-off job. Skips if a job of the same type is already waiting or
 *  active, so repeated button clicks don't pile up duplicate runs. */
export async function enqueue(name: JobName, data: Record<string, unknown> = {}): Promise<string> {
  const [waiting, active] = await Promise.all([auditorQueue.getWaiting(0, 100), auditorQueue.getActive(0, 20)]);
  const existing = [...waiting, ...active].find((j) => j.name === name);
  if (existing) return existing.id ?? "";
  const job = await auditorQueue.add(name, data, { jobId: `${name}-manual-${Date.now()}` });
  return job.id ?? "";
}

/** Drain queued jobs and clear failures (dashboard "Clear queue"). Doesn't touch a running job. */
export async function clearQueue(): Promise<number> {
  const waiting = await auditorQueue.getWaiting(0, 1000);
  await Promise.all(waiting.map((j) => j.remove().catch(() => undefined)));
  await auditorQueue.clean(0, 1000, "failed").catch(() => undefined);
  return waiting.length;
}
