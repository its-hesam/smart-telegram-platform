import { z } from 'zod';
import { environmentSchema } from '../../../packages/validation/src/index.js';
const key = z.string().regex(/^[a-fA-F0-9]{64}$/);
export const apiConfigSchema = environmentSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.url().refine(v => new URL(v).origin === v, 'Use an origin without path or trailing slash'),
  DATA_ENCRYPTION_KEY: key,
  IDENTITY_HMAC_KEY: key,
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(100000).default(5000),
  WORKER_LOGIN_URL: z.url().refine(v => new URL(v).origin === v && ['http:', 'https:'].includes(new URL(v).protocol)).optional(),
}).superRefine((v, ctx) => {
  if (v.DATA_ENCRYPTION_KEY.toLowerCase() === v.IDENTITY_HMAC_KEY.toLowerCase()) ctx.addIssue({ code: 'custom', message: 'Keys must differ' });
  if (v.NODE_ENV === 'production' && !v.APP_ORIGIN.startsWith('https://')) ctx.addIssue({ code: 'custom', message: 'HTTPS required in production' });
});
export type ApiConfig = z.infer<typeof apiConfigSchema>;
