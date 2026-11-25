import pg from 'pg';
import { Redis } from 'ioredis';

export interface DependencyHealth { postgres: boolean; redis: boolean; }
export async function checkDependencies(databaseUrl: string, redisUrl: string): Promise<DependencyHealth> {
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000, query_timeout: 2000 });
  const redis = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  // Errors are reported as health state; connection URLs must not reach logs.
  redis.on('error', () => undefined);
  try {
    const results = await Promise.allSettled([
      pool.query('SELECT 1'),
      redis.connect().then(() => redis.ping()).then(reply => { if (reply !== 'PONG') throw new Error('Unexpected reply'); }),
    ]);
    return { postgres: results[0].status === 'fulfilled', redis: results[1].status === 'fulfilled' };
  } finally {
    redis.disconnect();
    await pool.end();
  }
}
