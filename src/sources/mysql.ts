import mysql from "mysql2/promise";
import type { SourceDbConfig } from "@/lib/env";
import { logger } from "@/lib/logger";

// Lazily-created read-only connection pools, keyed by database name.
const pools = new Map<string, mysql.Pool>();

export function getPool(cfg: SourceDbConfig): mysql.Pool | null {
  if (!cfg.enabled) return null;
  const key = `${cfg.host}:${cfg.port}/${cfg.database}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: 4,
      waitForConnections: true,
      enableKeepAlive: true,
      // Safety: we only ever SELECT. The DB user should be SELECT-only too.
    });
    pools.set(key, pool);
    logger.info({ db: cfg.database, host: cfg.host }, "source DB pool created");
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  cfg: SourceDbConfig,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = getPool(cfg);
  if (!pool) return [];
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => undefined)));
  pools.clear();
}
