import { z } from 'zod';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import { FieldCipher } from './crypto.js';
import { problem } from './store.js';
import type { Principal } from './contracts.js';
export const targetInputSchema = z.strictObject({ type: z.enum(['GROUP', 'CHANNEL']), reference: z.string().regex(/^(?:https:\/\/t\.me\/(?:\+)?[A-Za-z0-9_-]+|@[A-Za-z][A-Za-z0-9_]{4,31})$/), title: z.string().trim().min(1).max(150), authorizationConfirmed: z.literal(true) });
export const logsQuerySchema = z.strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), resourceId: z.string().max(100).optional(), action: z.string().max(100).optional(), q: z.string().max(100).optional() });
export class OperationsService {
  constructor(private readonly db: PrismaClient, private readonly cipher: FieldCipher) {}
  targets() { return this.db.telegramTarget.findMany({ select: { id: true, type: true, title: true, ownershipStatus: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 200 }); }
  async target(id: string) { const row = await this.db.telegramTarget.findUnique({ where: { id } }); if (!row) problem(404, 'TARGET_NOT_FOUND', 'Target not found'); return { id: row.id, type: row.type, title: row.title, ownershipStatus: row.ownershipStatus, reference: this.cipher.decrypt(row.reference, `target:${id}:reference`), uiCapabilities: { readMembers: false, createInvite: false, moderateJoinRequests: false }, capabilityStatus: 'UNSUPPORTED' }; }
  async createTarget(actor: Principal, input: z.infer<typeof targetInputSchema>) { return this.db.$transaction(async tx => { const { randomUUID } = await import('node:crypto'); const id = randomUUID(); const short = input.reference.replace(/^https:\/\/t\.me\//, '').replace(/^@/, ''); const normalized = short.startsWith('+') ? short : short.toLowerCase(); const row = await tx.telegramTarget.create({ data: { id, type: input.type, title: input.title, identityKey: this.cipher.identity(`target:${normalized}`), reference: this.cipher.encrypt(input.reference, `target:${id}:reference`) } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'target.register', resourceType: 'TelegramTarget', resourceId: id, metadata: { authorizationConfirmed: true } } }); return { id: row.id, type: row.type, title: row.title, ownershipStatus: row.ownershipStatus }; }); }
  async invitations() { return this.db.invitation.findMany({ select: { id: true, targetId: true, createdAt: true, expiresAt: true, revokedAt: true, target: { select: { title: true, type: true } } }, take: 200, orderBy: { createdAt: 'desc' } }); }
  async registerInvitation(actor: Principal, input: { targetId: string; link: string; authorizationConfirmed: true }) { await this.target(input.targetId); return this.db.$transaction(async tx => { const { randomUUID } = await import('node:crypto'); const id = randomUUID(); const row = await tx.invitation.create({ data: { id, targetId: input.targetId, encryptedLink: this.cipher.encrypt(input.link, `invitation:${id}`) } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'invitation.register', resourceType: 'Invitation', resourceId: id } }); return { id: row.id, targetId: row.targetId, createdAt: row.createdAt }; }); }
  async invitationLink(id: string) { const row = await this.db.invitation.findUnique({ where: { id } }); if (!row) problem(404, 'INVITATION_NOT_FOUND', 'Invitation not found'); return { id, link: this.cipher.decrypt(row.encryptedLink, `invitation:${id}`) }; }
  async jobs(page: number, pageSize: number) { const [data, total] = await this.db.$transaction([this.db.job.findMany({ select: { id: true, type: true, status: true, accountId: true, campaignId: true, createdAt: true, scheduledAt: true, startedAt: true, finishedAt: true, errorCode: true, traceId: true, attemptCount: true, progress: true, processed: true, totalItems: true, cancellationRequestedAt: true }, take: pageSize, skip: (page - 1) * pageSize, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }), this.db.job.count()]); return { data, total, page, pageSize }; }
  async job(id: string) { const row = await this.db.job.findUnique({ where: { id }, select: { id: true, type: true, status: true, accountId: true, campaignId: true, traceId: true, attemptCount: true, errorCode: true, createdAt: true, scheduledAt: true, startedAt: true, finishedAt: true, progress: true, processed: true, totalItems: true, cancellationRequestedAt: true } }); if (!row) problem(404, 'JOB_NOT_FOUND', 'Job not found'); return row; }
  async cancelJob(actor: Principal, id: string) { await this.db.$transaction(async tx => { const row = await tx.job.findUnique({ where: { id } }); if (!row) problem(404, 'JOB_NOT_FOUND', 'Job not found'); if (!['PENDING', 'PAUSED', 'RUNNING'].includes(row.status)) problem(409, 'JOB_STATE_CONFLICT', 'Terminal job cannot be cancelled'); await tx.job.update({ where: { id }, data: { cancellationRequestedAt: new Date(), ...(row.status !== 'RUNNING' ? { status: 'CANCELLED', finishedAt: new Date() } : {}) } }); if (row.status !== 'RUNNING' && row.payloadReference && row.type === 'APPROVED_MESSAGE_SEND') await tx.campaignRecipient.updateMany({ where: { id: row.payloadReference, status: 'PENDING' }, data: { status: 'CANCELLED' } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'job.cancel', resourceType: 'Job', resourceId: id } }); }); }
  async overview() {
    const [accounts, jobs, campaigns, workers, contacts] = await Promise.all([this.db.telegramAccount.groupBy({ by: ['status'], _count: true }), this.db.job.groupBy({ by: ['status'], _count: true }), this.db.campaign.groupBy({ by: ['status'], _count: true }), this.db.workerHeartbeat.findMany({ select: { id: true, lastSeenAt: true, expiresAt: true }, take: 100 }), this.db.contact.count()]);
    const counts = (rows: { status: string; _count: number }[]) => Object.fromEntries(rows.map(row => [row.status, row._count]));
    return { accounts: counts(accounts), jobs: counts(jobs), campaigns: counts(campaigns), workers: workers.map(w => ({ ...w, healthy: w.expiresAt > new Date() })), contacts, generatedAt: new Date().toISOString() };
  }
  async logs(query: z.infer<typeof logsQuerySchema>) {
    const where = { ...(query.resourceId ? { resourceId: query.resourceId } : {}), ...(query.action ? { action: query.action } : {}), ...(query.q ? { action: { contains: query.q, mode: 'insensitive' as const } } : {}) };
    const [data, total] = await this.db.$transaction([this.db.auditLog.findMany({ where, select: { id: true, actorId: true, action: true, resourceType: true, resourceId: true, timestamp: true }, orderBy: [{ timestamp: 'desc' }, { id: 'asc' }], take: query.pageSize, skip: (query.page - 1) * query.pageSize }), this.db.auditLog.count({ where })]); return { data, total, page: query.page, pageSize: query.pageSize };
  }
  async outreachAuthorization() {
    const [active, history] = await Promise.all([
      this.db.outreachAuthorization.findFirst({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, actorId: true, evidenceReference: true, scope: true, createdAt: true } }),
      this.db.outreachAuthorization.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, actorId: true, evidenceReference: true, scope: true, createdAt: true, revokedAt: true } }),
    ]);
    return { active, history };
  }
  async authorizeOutreach(actor: Principal, evidenceReference: string) {
    return this.db.$transaction(async tx => {
      await tx.outreachAuthorization.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
      const row = await tx.outreachAuthorization.create({ data: { actorId: actor.id, evidenceReference, scope: 'all' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'outreach.authorize', resourceType: 'OutreachAuthorization', resourceId: row.id, metadata: { evidenceReference } } });
      return { id: row.id, evidenceReference: row.evidenceReference, scope: row.scope, createdAt: row.createdAt };
    }, { isolationLevel: 'Serializable' });
  }
  async revokeOutreach(actor: Principal) {
    return this.db.$transaction(async tx => {
      const active = await tx.outreachAuthorization.findFirst({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' } });
      if (!active) problem(404, 'AUTHORIZATION_NOT_FOUND', 'No active authorization');
      await tx.outreachAuthorization.update({ where: { id: active.id }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'outreach.revoke', resourceType: 'OutreachAuthorization', resourceId: active.id } });
      return { id: active.id };
    }, { isolationLevel: 'Serializable' });
  }
  async settings() { const allowed = ['display.timezone', 'logs.retentionDays']; return this.db.systemSetting.findMany({ where: { key: { in: allowed } }, select: { key: true, value: true, updatedAt: true } }); }
  async updateSettings(actor: Principal, input: { timezone?: string | undefined; retentionDays?: number | undefined }) { await this.db.$transaction(async tx => { if (input.timezone) await tx.systemSetting.upsert({ where: { key: 'display.timezone' }, create: { key: 'display.timezone', value: input.timezone }, update: { value: input.timezone } }); if (input.retentionDays) await tx.systemSetting.upsert({ where: { key: 'logs.retentionDays' }, create: { key: 'logs.retentionDays', value: input.retentionDays }, update: { value: input.retentionDays } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'settings.update', resourceType: 'SystemSetting', resourceId: 'public-settings', metadata: { fields: Object.keys(input) } } }); }); }
}
