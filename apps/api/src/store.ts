import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '../../../packages/database/src/index.js';
import type { Prisma } from '../../../packages/database/generated/client/client.js';
import { FieldCipher, hashToken } from './crypto.js';
import type { Principal } from './contracts.js';
import type { z } from 'zod';
import type { accountQuerySchema, accountPatchSchema } from './contracts.js';

export function problem(status: number, code: string, message: string): never { throw new HttpException({ code, message }, status); }
type Account = Prisma.TelegramAccountGetPayload<Record<string, never>>;
export class PlatformStore {
  constructor(readonly db: PrismaClient, private readonly cipher: FieldCipher) {}
  findUser(email: string) { return this.db.adminUser.findUnique({ where: { email } }); }
  async createSession(user: Principal, token: string, expiresAt: Date) {
    await this.db.$transaction(async tx => {
      // Prune expired sessions for this user on login; raw tokens never persist.
      await tx.authSession.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } });
      await tx.authSession.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'auth.login', resourceType: 'AdminUser', resourceId: user.id } });
    });
  }
  async authenticate(token: string): Promise<Principal | null> {
    const session = await this.db.authSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) return null;
    const { id, email, role } = session.user;
    return { id, email, role };
  }
  async logout(user: Principal, token: string) {
    await this.db.$transaction(async tx => {
      await tx.authSession.deleteMany({ where: { tokenHash: hashToken(token), userId: user.id } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'auth.logout', resourceType: 'AdminUser', resourceId: user.id } });
    });
  }
  private view(row: Account, actor: Principal) {
    return { id: row.id, displayName: row.displayName, status: row.status, lastActiveAt: row.lastActiveAt,
      lastErrorCode: row.lastErrorCode, createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(actor.role === 'ADMIN' ? { phone: this.cipher.decrypt(row.encryptedPhone, `account:${row.id}:phone`) } : {}) };
  }
  async listAccounts(actor: Principal, query: z.infer<typeof accountQuerySchema>) {
    const where = query.status ? { status: query.status } : {};
    const [rows, total] = await this.db.$transaction([
      this.db.telegramAccount.findMany({ where, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: [{ [query.sort]: query.order }, { id: 'asc' }] }),
      this.db.telegramAccount.count({ where }),
    ]);
    return { data: rows.map(row => this.view(row, actor)), total, page: query.page, pageSize: query.pageSize };
  }
  async getAccount(actor: Principal, id: string) {
    const row = await this.db.telegramAccount.findUnique({ where: { id } });
    if (!row) problem(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return this.view(row, actor);
  }
  async createAccount(actor: Principal, input: { displayName: string; phone: string }) {
    const id = randomUUID();
    const row = await this.db.$transaction(async tx => {
      const account = await tx.telegramAccount.create({ data: { id, displayName: input.displayName,
        encryptedPhone: this.cipher.encrypt(input.phone, `account:${id}:phone`), identityKey: this.cipher.identity(`phone:${input.phone}`) } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'account.create', resourceType: 'TelegramAccount', resourceId: id, metadata: { ownershipConfirmed: true } } });
      return account;
    });
    return this.view(row, actor);
  }
  async updateAccount(actor: Principal, id: string, input: z.infer<typeof accountPatchSchema>) {
    const row = await this.db.$transaction(async tx => {
      const current = await tx.telegramAccount.findUnique({ where: { id } });
      if (!current) problem(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      if (input.enabled !== undefined && !['PAUSED', 'DISCONNECTED'].includes(current.status)) problem(409, 'ACCOUNT_STATE_CONFLICT', 'Account cannot change enabled state here');
      const updated = await tx.telegramAccount.update({ where: { id }, data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.enabled !== undefined ? { status: input.enabled ? 'DISCONNECTED' : 'PAUSED' } : {}),
      } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'account.update', resourceType: 'TelegramAccount', resourceId: id, metadata: { fields: Object.keys(input) } } });
      return updated;
    }, { isolationLevel: 'Serializable' });
    return this.view(row, actor);
  }
  async deleteAccount(actor: Principal, id: string) {
    await this.db.$transaction(async tx => {
      const row = await tx.telegramAccount.findUnique({ where: { id }, include: { _count: { select: { sessions: true, jobs: true, campaigns: true, recipients: true } }, lease: true } });
      if (!row) problem(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      if (!['DISCONNECTED', 'PAUSED'].includes(row.status) || (row.lease && row.lease.ownerId !== '') || Object.values(row._count).some(n => n > 0)) problem(409, 'ACCOUNT_IN_USE', 'Account has a profile, lease or historical operations; removal requires lifecycle handling');
      await tx.telegramAccount.delete({ where: { id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'account.delete', resourceType: 'TelegramAccount', resourceId: id } });
    }, { isolationLevel: 'Serializable' });
  }
  async accountHealth(actor: Principal, id: string) {
    const row = await this.getAccount(actor, id);
    const lease = await this.db.accountLease.findUnique({ where: { accountId: id } });
    const session = await this.db.accountSession.findFirst({ where: { accountId: id }, orderBy: { lastValidatedAt: 'desc' }, select: { lastValidatedAt: true, status: true } });
    return { accountId: row.id, status: row.status, lastActiveAt: row.lastActiveAt, browser: lease?.ownerId ? 'LEASE_HELD' : 'CLOSED', leaseExpired: Boolean(lease?.ownerId && lease.expiresAt <= new Date()), lastValidatedAt: session?.lastValidatedAt ?? null, liveBrowserInspection: 'UNSUPPORTED' };
  }
  async validateSessionJob(actor: Principal, id: string) {
    await this.getAccount(actor, id);
    return this.db.$transaction(async tx => {
      const existing = await tx.job.findFirst({ where: { accountId: id, type: 'SESSION_VALIDATION', status: { in: ['PENDING', 'RUNNING'] } } });
      if (existing) return { jobId: existing.id, status: existing.status };
      const job = await tx.job.create({ data: { type: 'SESSION_VALIDATION', accountId: id, idempotencyKey: randomUUID(), traceId: randomUUID() } });
      await tx.outboxEvent.create({ data: { jobId: job.id, type: 'job.created' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'account.validate_session', resourceType: 'TelegramAccount', resourceId: id } });
      return { jobId: job.id, status: job.status };
    }, { isolationLevel: 'Serializable' });
  }
}
