import './test-environment.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDatabase } from '../../packages/database/src/index.js';
import { acquireLease } from '../../packages/automation-core/src/lease.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
it('serializes ownership, increments fencing and refuses stale takeover even after expiry', async () => {
  const db = createDatabase(process.env.DATABASE_URL!);
  const account = await db.telegramAccount.create({ data: { displayName: 'Lease fixture', encryptedPhone: 'fixture-not-phone', identityKey: randomUUID() } });
  try {
    const first = await acquireLease(db, account.id, 'worker-1');
    await expect(acquireLease(db, account.id, 'worker-2')).rejects.toThrow('ACCOUNT_LOCKED');
    await first.assertOwned(); await first.release();
    const next = await acquireLease(db, account.id, 'worker-2');
    expect(next.fencingToken).toBeGreaterThan(first.fencingToken);
    await expect(first.assertOwned()).rejects.toThrow('ACCOUNT_LEASE_LOST');
    await db.accountLease.update({ where: { accountId: account.id }, data: { expiresAt: new Date(0) } });
    await expect(next.assertOwned()).rejects.toThrow('ACCOUNT_LEASE_LOST');
    await expect(acquireLease(db, account.id, 'worker-3')).rejects.toThrow('ACCOUNT_LOCKED');
    await next.release();
  } finally { await db.telegramAccount.delete({ where: { id: account.id } }); await db.$disconnect(); }
});
