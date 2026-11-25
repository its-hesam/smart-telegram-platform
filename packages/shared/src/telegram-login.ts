import { createHmac } from 'node:crypto';
import { z } from 'zod';
const flow = { flowId: z.uuid() };
export const telegramLoginCommand = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('status'), ...flow }),
  z.strictObject({ action: z.literal('code'), ...flow, code: z.string().regex(/^\d{4,8}$/) }),
  z.strictObject({ action: z.literal('password'), ...flow, password: z.string().min(1).max(256) }),
  z.strictObject({ action: z.literal('cancel'), ...flow }),
]);
export type LoginCommand = z.infer<typeof telegramLoginCommand>;
export type LoginStep = 'OPENING' | 'CODE' | 'PASSWORD' | 'CONNECTED' | 'CANCELLED' | 'EXPIRED' | 'ERROR';
export type LoginView = { flowId: string; step: LoginStep; expiresAt: string; issue: string | null };
export const loginBridgeToken = (key: string) => createHmac('sha256', Buffer.from(key, 'hex')).update('telegram-owner-login-bridge:v1').digest('hex');
