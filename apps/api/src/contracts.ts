import { z } from 'zod';
import { accountStatuses } from '../../../packages/shared/src/index.js';
export const loginSchema = z.strictObject({ email: z.email().trim().toLowerCase().max(254), password: z.string().min(1).max(256) });
export const createAdminSchema = z.strictObject({ email: z.email().trim().toLowerCase().max(254), password: z.string().min(14).max(256) });
export const accountPatchSchema = z.strictObject({ displayName: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional() }).refine(v => Object.keys(v).length > 0);
export const accountQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(accountStatuses).optional(),
  sort: z.enum(['createdAt', 'displayName']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type Principal = { id: string; email: string; role: 'ADMIN' | 'OPERATOR' | 'VIEWER' };
