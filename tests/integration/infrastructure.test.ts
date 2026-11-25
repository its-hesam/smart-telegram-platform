import './test-environment.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { RedisRateLimiter } from '../../apps/api/src/rate-limit.js';
import { checkDependencies } from '../../packages/shared/src/health.js';
import { createDatabase } from '../../packages/database/src/index.js';
import { dispatchOutbox } from '../../packages/queue/src/runtime.js';
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Integration tests require DATABASE_URL and REDIS_URL');
it('enforces a shared Redis rate window atomically', async () => {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0, connectTimeout: 2000 });
  const key = `test-${randomUUID()}`;
  try {
    const limiter = new RedisRateLimiter(redis);
    const results = await Promise.all(Array.from({ length: 8 }, () => limiter.consume(key, 5, 60)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await redis.ttl(`api:rate:${key}`)).toBeGreaterThan(0);
  } finally { await redis.del(`api:rate:${key}`); redis.disconnect(); }
}, 10000);
it('connects to real dependencies and migrated Prisma schema', async () => {
  expect(await checkDependencies(databaseUrl, redisUrl)).toEqual({ postgres: true, redis: true });
  const db = createDatabase(databaseUrl);
  const key = `integration-${randomUUID()}`;
  try {
    await db.systemSetting.create({ data: { key, value: { test: true } } });
    expect((await db.systemSetting.findUnique({ where: { key } }))?.value).toEqual({ test: true });
    await expect(db.systemSetting.create({ data: { key, value: {} } })).rejects.toMatchObject({ code: 'P2002' });
  } finally {
    await db.systemSetting.deleteMany({ where: { key } });
    await db.$disconnect();
  }
}, 15000);
it('delivers two real outbox events through Redis but claims the durable job once', async () => {
  const db = createDatabase(databaseUrl);
  const url = new URL(redisUrl); const connection = { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: decodeURIComponent(url.password) } : {}) };
  const name = `durable-${randomUUID()}`; const queue = new Queue(name, { connection });
  const durable = await db.job.create({ data: { type: 'REPORT_GENERATION', idempotencyKey: randomUUID(), traceId: randomUUID() } });
  let claimed = 0; let delivered = 0;
  const worker = new Worker(name, async queued => { const changed = await db.job.updateMany({ where: { id: queued.data.jobId as string, status: 'PENDING' }, data: { status: 'COMPLETED', finishedAt: new Date() } }); claimed += changed.count; }, { connection, maxStalledCount: 0 });
  try {
    await db.outboxEvent.createMany({ data: [{ jobId: durable.id, type: 'job.created' }, { jobId: durable.id, type: 'job.publication_duplicate' }] });
    const finished = new Promise<void>((resolve, reject) => { worker.on('completed', () => { if (++delivered === 2) resolve(); }); worker.once('failed', (_, error) => reject(error)); worker.once('error', reject); });
    await dispatchOutbox(db, queue); await finished;
    expect(claimed).toBe(1); expect(await db.outboxEvent.count({ where: { jobId: durable.id, publishedAt: null } })).toBe(0);
  } finally { await worker.close(); await queue.obliterate({ force: true }); await queue.close(); await db.outboxEvent.deleteMany({ where: { jobId: durable.id } }); await db.job.delete({ where: { id: durable.id } }); await db.$disconnect(); }
}, 15000);
it('moves reference-only jobs through real BullMQ worker', async () => {
  const url = new URL(redisUrl);
  const connection = { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === 'rediss:' ? { tls: {} } : {}) };
  const name = `integration-${randomUUID()}`;
  const queue = new Queue(name, { connection });
  let received: unknown;
  const worker = new Worker(name, async job => { received = job.data; }, { connection });
  try {
    const payload = { version: 1, jobId: randomUUID(), traceId: randomUUID() };
    const finished = new Promise<void>((resolve, reject) => { worker.once('completed', () => resolve()); worker.once('failed', (_, error) => reject(error)); worker.once('error', reject); });
    await queue.add('INFRASTRUCTURE_TEST', payload, { attempts: 1 });
    await finished;
    expect(received).toEqual(payload);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }
}, 15000);
