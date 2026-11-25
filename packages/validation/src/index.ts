import { z } from 'zod';

const databaseUrl = z.url().refine(v => ['postgres:', 'postgresql:'].includes(new URL(v).protocol), 'PostgreSQL URL required');
const redisUrl = z.url().refine(v => ['redis:', 'rediss:'].includes(new URL(v).protocol), 'Redis URL required');
export const environmentSchema = z.object({
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_PROBE_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
  EXPORT_ROOT: z.string().min(1).default('/tmp/smart-exports'),
  EXPORT_BATCH_SIZE: z.coerce.number().int().min(50).max(10000).default(500),
  WORKER_DISPATCH_BATCH: z.coerce.number().int().min(10).max(5000).default(500),
  WORKER_MAINTENANCE_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
  IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1000000).default(5000),
});
// No inline messages, phone numbers, auth credentials or arbitrary payloads in Redis.
export const jobReferenceSchema = z.strictObject({
  version: z.literal(1), jobId: z.uuid(), accountId: z.uuid().optional(), traceId: z.uuid(),
});
export const accountInputSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
  ownershipConfirmed: z.literal(true),
});
