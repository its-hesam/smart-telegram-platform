import { randomBytes, randomUUID } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { telegramLoginCommand, loginBridgeToken } from '../../packages/shared/src/telegram-login.js';
import { TelegramLoginService } from '../../apps/worker/src/telegram-login.js';
import type { PrismaClient } from '../../packages/database/src/index.js';
import type { PersistentBrowserManager } from '../../packages/automation-core/src/browser-manager.js';
import { FieldCipher } from '../../packages/shared/src/crypto.js';
it('rejects invalid credentials, unknown fields and unbound commands', () => {
  expect(telegramLoginCommand.safeParse({ action: 'code', flowId: randomUUID(), code: '12345' }).success).toBe(true);
  for (const value of [{ action: 'start', password: 'leak' }, { action: 'code', code: '12345' }, { action: 'password', flowId: randomUUID(), password: '' }, { action: 'code', flowId: randomUUID(), code: 'abcd' }]) expect(telegramLoginCommand.safeParse(value).success).toBe(false);
  const key = randomBytes(32).toString('hex'); expect(loginBridgeToken(key)).not.toBe(key); expect(loginBridgeToken(key)).toHaveLength(64);
});
it('requires a live ADMIN session and binds flows to account, actor and session', async () => {
  const key = randomBytes(32).toString('hex'); const cipher = new FieldCipher(key, randomBytes(32).toString('hex'));
  const session = vi.fn().mockResolvedValue(null);
  const db = { authSession: { findFirst: session } } as unknown as PrismaClient;
  const manager = {} as PersistentBrowserManager;
  const service = new TelegramLoginService(db, manager, cipher, 'fixture-worker', new AbortController().signal);
  const input = { accountId: randomUUID(), actorId: randomUUID(), sessionId: 'a'.repeat(64), command: { action: 'status' as const, flowId: randomUUID() } };
  try {
    await expect(service.execute(input)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    session.mockResolvedValue({ id: 'authorized-fixture' });
    await expect(service.execute(input)).rejects.toMatchObject({ status: 404, code: 'LOGIN_FLOW_NOT_FOUND' });
    expect(session.mock.calls[1]?.[0].where.user.role).toBe('ADMIN');
    expect(session.mock.calls[1]?.[0].where.tokenHash).toBe(input.sessionId);
  } finally { await service.close(); }
});
