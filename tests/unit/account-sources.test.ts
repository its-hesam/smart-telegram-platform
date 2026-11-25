import { randomBytes, randomUUID } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import type { PrismaClient } from '../../packages/database/src/index.js';
import { FieldCipher } from '../../apps/api/src/crypto.js';
import { AccountSourcesService } from '../../apps/api/src/account-sources.js';
import { sourceSelectionSchema, memberExportSchema, sourceReference, parseSourceReference } from '../../packages/shared/src/account-sources.js';
it('requires explicit authorization and expanded source/member contracts', () => {
  expect(sourceSelectionSchema.safeParse({ sourceIds: ['a'.repeat(64)], authorizationConfirmed: false }).success).toBe(false);
  expect(memberExportSchema.safeParse({ authorizationConfirmed: true, limit: 1000001 }).success).toBe(false);
  expect(memberExportSchema.safeParse({ authorizationConfirmed: true, limit: 0 }).success).toBe(true);
  expect(parseSourceReference(sourceReference('5dd266aa-b318-4a70-acba-cdcba2a8109d', '-123'))?.peer).toBe('-123');
  expect(parseSourceReference('https://evil.example')).toBe(null);
});
it('rejects forged cross-account selections and permits a non-owner export request', async () => {
  const cipher = new FieldCipher(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')); const accountId = randomUUID(), jobId = randomUUID(), targetId = randomUUID();
  const snapshot = { sources: [{ key: 'a'.repeat(64), peer: '-123', title: 'Private group', type: 'GROUP', adminVerified: false }], partial: false, skipped: 0, scannedAt: new Date().toISOString() };
  const db = { job: { findFirst: vi.fn(async () => ({ id: jobId, result: { ciphertext: cipher.encrypt(JSON.stringify(snapshot), `job:${jobId}:source-result`) } })) }, telegramTarget: { findUnique: vi.fn(async () => ({ id: targetId, type: 'GROUP', ownershipStatus: 'UNVERIFIED', reference: cipher.encrypt(sourceReference(accountId, '-123'), `target:${targetId}:reference`) })) } } as unknown as PrismaClient;
  Object.assign(db, { telegramAccount: { findUnique: vi.fn(async () => ({ status: 'CONNECTED' })) }, $transaction: async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: vi.fn(), job: { findFirst: vi.fn(async () => ({ id: jobId, status: 'PENDING' })) } }) });
  const service = new AccountSourcesService(db, cipher); const actor = { id: randomUUID(), email: 'fixture@example.test', role: 'ADMIN' as const };
  await expect(service.select(actor, accountId, ['b'.repeat(64)])).rejects.toMatchObject({ status: 400 });
  await expect(service.extract(actor, targetId, 500)).resolves.toEqual({ jobId, status: 'PENDING' });
});
it('keeps member results encrypted and escapes CSV formulas without consent columns', async () => {
  const cipher = new FieldCipher(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')); const id = randomUUID();
  const data = { members: [{ displayName: '=2+2', reference: '123', username: null }], partial: true, observedAt: new Date().toISOString() };
  const ciphertext = cipher.encrypt(JSON.stringify(data), `job:${id}:source-result`);
  const db = { job: { findUnique: vi.fn(async () => ({ id, type: 'GROUP_INFORMATION_READ', payloadReference: 'source-members:v1:' + randomUUID(), status: 'COMPLETED', result: { ciphertext } })) }, auditLog: { create: vi.fn() } } as unknown as PrismaClient;
  const csv = await new AccountSourcesService(db, cipher).csv({ id: randomUUID(), email: 'fixture@example.test', role: 'ADMIN' }, id);
  expect(ciphertext).not.toContain('=2+2'); expect(csv).toContain("'=2+2"); expect(csv).toContain('true'); expect(csv).not.toContain('consentStatus');
});
