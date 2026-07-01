import { auditorQueue } from "./queues";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Register the repeatable (cron) jobs. Idempotent: BullMQ dedupes repeatables
 * by key, and we clear stale ones first so changing a cron in env takes effect.
 */
export async function registerSchedules(): Promise<void> {
  const existing = await auditorQueue.getJobSchedulers();
  await Promise.all(existing.map((s) => auditorQueue.removeJobScheduler(s.key)));

  await auditorQueue.upsertJobScheduler("cron-uptime", { pattern: env.cron.uptime, tz: process.env.TZ }, { name: "uptime", data: {} });
  await auditorQueue.upsertJobScheduler("cron-collect", { pattern: env.cron.collect, tz: process.env.TZ }, { name: "collect", data: {} });
  await auditorQueue.upsertJobScheduler("cron-audit", { pattern: env.cron.audit, tz: process.env.TZ }, { name: "audit", data: {} });

  logger.info({ uptime: env.cron.uptime, collect: env.cron.collect, audit: env.cron.audit }, "schedules registered");
}
