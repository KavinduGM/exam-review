import { env } from "./env";

// We hand BullMQ a plain connection-options object (parsed from REDIS_URL) rather
// than a shared ioredis instance. BullMQ bundles its own ioredis copy, and passing
// an instance from a different copy trips a TypeScript class-identity error. A
// plain options object is matched structurally and avoids the whole problem.
function parseRedis(url: string) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || "localhost",
      port: u.port ? Number(u.port) : 6379,
      username: u.username || undefined,
      password: u.password || undefined,
      db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
      // Required by BullMQ for blocking commands.
      maxRetriesPerRequest: null as null,
    };
  } catch {
    return { host: "localhost", port: 6379, maxRetriesPerRequest: null as null };
  }
}

export const redisConnection = parseRedis(env.redisUrl);
