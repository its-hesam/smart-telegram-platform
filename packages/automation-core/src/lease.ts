import type { PrismaClient } from '../../database/src/index.js';
import type { AccountLease } from './index.js';
export async function acquireLease(db: PrismaClient, accountId: string, ownerId: string, ttlMs = 30000): Promise<AccountLease> {
  const row = await db.$transaction(async tx => {
    await tx.accountLease.upsert({ where: { accountId }, create: { accountId, ownerId: '', fencingToken: 0, expiresAt: new Date(0), heartbeatAt: new Date(0) }, update: {} });
    const claimed = await tx.accountLease.updateMany({ where: { accountId, ownerId: '' }, data: { ownerId, fencingToken: { increment: 1 }, expiresAt: new Date(Date.now() + ttlMs), heartbeatAt: new Date() } });
    if (claimed.count !== 1) throw new Error('ACCOUNT_LOCKED: stale leases require manual recovery');
    return tx.accountLease.findUniqueOrThrow({ where: { accountId } });
  });
  let lost = false;
  const timer = setInterval(() => {
    void db.accountLease.updateMany({ where: { accountId, ownerId, fencingToken: row.fencingToken, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date(Date.now() + ttlMs), heartbeatAt: new Date() } })
      .then(result => { if (result.count !== 1) lost = true; }).catch(() => { lost = true; });
  }, Math.floor(ttlMs / 3));
  timer.unref();
  return {
    accountId, ownerId, fencingToken: row.fencingToken,
    async assertOwned() {
      if (lost) throw new Error('ACCOUNT_LEASE_LOST');
      const current = await db.accountLease.findFirst({ where: { accountId, ownerId, fencingToken: row.fencingToken, expiresAt: { gt: new Date() } } });
      if (!current) { lost = true; throw new Error('ACCOUNT_LEASE_LOST'); }
    },
    async release() {
      clearInterval(timer);
      const result = await db.accountLease.updateMany({ where: { accountId, ownerId, fencingToken: row.fencingToken }, data: { ownerId: '', expiresAt: new Date(0) } });
      if (result.count !== 1) throw new Error('ACCOUNT_LEASE_LOST');
    },
  };
}
