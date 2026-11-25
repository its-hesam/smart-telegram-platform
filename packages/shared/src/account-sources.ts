import { z } from 'zod';
export const sourceSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), peer: z.string().regex(/^-\d{1,20}$/), title: z.string().min(1).max(150), type: z.enum(['GROUP', 'CHANNEL']), adminVerified: z.boolean() });
export const catalogSchema = z.object({ sources: z.array(sourceSchema).max(100000), partial: z.boolean(), skipped: z.number().int().nonnegative(), scannedAt: z.iso.datetime(), diagnostics: z.array(z.object({ code: z.string().max(80), count: z.number().int().nonnegative() })).default([]) });
export type AccountSource = z.infer<typeof sourceSchema>;
export const sourceSelectionSchema = z.strictObject({ sourceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100000), authorizationConfirmed: z.literal(true) });
// limit=0 means "until Telegram's visible list ends"; the worker applies a time
// budget rather than an arbitrary row cap.
export const memberExportSchema = z.strictObject({ authorizationConfirmed: z.literal(true), limit: z.number().int().min(0).max(1000000).default(0) });
export const sourceReference = (accountId: string, peer: string) => `telegram-ui:${accountId}:${peer}`;
export function parseSourceReference(reference: string) { const match = /^telegram-ui:([a-f0-9-]{36}):(-\d{1,20})$/.exec(reference); return match ? { accountId: z.uuid().parse(match[1]), peer: match[2]! } : null; }
export const memberResultSchema = z.object({ members: z.array(z.object({ displayName: z.string().max(200), reference: z.string().regex(/^\d{1,20}$/), username: z.string().max(33).nullable(), usernameStatus: z.enum(['VISIBLE', 'NOT_VISIBLE', 'NOT_CHECKED']).default('NOT_CHECKED') })).max(1000000), partial: z.boolean(), observedAt: z.iso.datetime() });
