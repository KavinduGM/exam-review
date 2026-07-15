// Long-running worker process. Run with: npm run worker
// Processes scheduled + manual jobs: collect / uptime / audit.

import "dotenv/config";
import { Worker } from "bullmq";
import { redisConnection } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { QUEUE_NAME } from "@/queue/queues";
import { registerSchedules } from "@/queue/scheduler";
import { ensureSitesSeeded } from "@/lib/seed";
import { ensureGroups } from "@/lib/groups";
import { collectAllSites } from "@/collector/collect";
import { runUptimeSweep } from "@/monitor/run";
import { runWeeklyAudit } from "@/audit/run";

async function main() {
  await ensureSitesSeeded();
  await ensureGroups();
  await registerSchedules();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info({ job: job.name, id: job.id }, "job started");
      const onProgress = (p: Record<string, unknown>) => {
        void job.updateProgress(p as object);
      };
      switch (job.name) {
        case "collect":
          return collectAllSites(onProgress);
        case "uptime":
          return runUptimeSweep(onProgress);
        case "audit":
          return runWeeklyAudit(onProgress);
        default:
          throw new Error(`unknown job: ${job.name}`);
      }
    },
    {
      connection: redisConnection,
      concurrency: 1, // jobs run one at a time; internal fan-out is concurrency-limited
      // If this worker dies mid-job, another (or a restart) reclaims the stalled
      // job promptly instead of it hanging forever.
      lockDuration: 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    },
  );

  worker.on("completed", (job) => logger.info({ job: job.name, id: job.id }, "job completed"));
  worker.on("failed", (job, err) => logger.error({ job: job?.name, id: job?.id, err }, "job failed"));

  logger.info("worker ready");

  const shutdown = async () => {
    logger.info("shutting down worker");
    await worker.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "worker crashed");
  process.exit(1);
});
