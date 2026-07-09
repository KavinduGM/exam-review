// A progress reporter passed into long-running jobs so they can surface live
// status (via BullMQ job.updateProgress) to the dashboard.
export type ProgressFn = (p: Record<string, unknown>) => void;
