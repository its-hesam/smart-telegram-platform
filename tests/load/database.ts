import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/index.js';
const url = process.env.DATABASE_URL;
if (!url || !new URL(url).pathname.includes('_test')) throw new Error('Benchmark requires an explicitly named *_test database');
const db = createDatabase(url); const prefix = `benchmark-${randomUUID()}`;
try {
  const start = performance.now();
  await db.job.createMany({ data: Array.from({ length: 500 }, () => ({ type: 'REPORT_GENERATION' as const, idempotencyKey: `${prefix}-${randomUUID()}`, traceId: randomUUID() })) });
  const inserted = performance.now();
  await db.job.findMany({ where: { idempotencyKey: { startsWith: prefix }, status: 'PENDING' }, orderBy: [{ scheduledAt: 'asc' }, { priority: 'asc' }], take: 100 });
  console.log(JSON.stringify({ benchmark: 'postgresql-500-durable-jobs', insertMs: Math.round(inserted - start), firstPageMs: Math.round(performance.now() - inserted), note: 'Local database benchmark only; no Telegram/browser capacity claim' }));
} finally { await db.job.deleteMany({ where: { idempotencyKey: { startsWith: prefix } } }); await db.$disconnect(); }
