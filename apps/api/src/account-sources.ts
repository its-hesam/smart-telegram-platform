import { randomUUID } from 'node:crypto';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import type { Principal } from './contracts.js';
import { FieldCipher } from './crypto.js';
import { problem } from './store.js';
import { catalogSchema, memberResultSchema, sourceReference, parseSourceReference } from '../../../packages/shared/src/account-sources.js';
import { memberColumns, memberRows, memberWorkbook } from '../../../packages/shared/src/member-export.js';
import { saveMemberContacts } from '../../../packages/shared/src/member-contacts.js';
export class AccountSourcesService {
  constructor(private readonly db: PrismaClient, private readonly cipher: FieldCipher, private readonly maxPending = 5000) {}
  private async account(id: string) { const a = await this.db.telegramAccount.findUnique({ where: { id } }); if (!a) problem(404, 'ACCOUNT_NOT_FOUND', 'Account not found'); return a; }
  private decode(job: { id: string; result: unknown }) { const result = z.object({ ciphertext: z.string() }).parse(job.result); return JSON.parse(this.cipher.decrypt(result.ciphertext, `job:${job.id}:source-result`)) as unknown; }
  private async catalog(accountId: string) { const job = await this.db.job.findFirst({ where: { accountId, type: 'GROUP_INFORMATION_READ', payloadReference: 'account-sources:v1', status: 'COMPLETED' }, orderBy: { createdAt: 'desc' } }); return job ? { job, data: catalogSchema.parse(this.decode(job)) } : null; }
  async list(accountId: string) {
    await this.account(accountId);
    const [catalog, latest] = await Promise.all([this.catalog(accountId), this.db.job.findFirst({ where: { accountId, type: 'GROUP_INFORMATION_READ', payloadReference: 'account-sources:v1' }, select: { id: true, status: true, errorCode: true, progress: true, processed: true, totalItems: true }, orderBy: { createdAt: 'desc' } })]);
    const targets = await this.db.telegramTarget.findMany({ select: { id: true, identityKey: true } }); const selected = new Map(targets.map(t => [t.identityKey, t.id]));
    return { sources: catalog?.data.sources.map(({ peer: _peer, ...s }) => ({ ...s, targetId: selected.get(s.key) ?? null })) ?? [], scannedAt: catalog?.data.scannedAt ?? null, partial: catalog?.data.partial ?? false, skipped: catalog?.data.skipped ?? 0, diagnostics: catalog?.data.diagnostics ?? [], job: latest };
  }
  private async enqueue(actor: Principal, accountId: string, payloadReference: string, action: string, limit?: number) {
    const account = await this.account(accountId); if (account.status !== 'CONNECTED') problem(409, 'SOURCE_ACCOUNT_NOT_CONNECTED', 'Connect the Telegram account first');
    return this.db.$transaction(async tx => {
      // Serialize duplicate requests for this account without racing the worker's browser lease.
      await tx.$queryRaw`SELECT id FROM "TelegramAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
      const existing = await tx.job.findFirst({ where: { accountId, type: 'GROUP_INFORMATION_READ', payloadReference, status: { in: ['PENDING', 'RUNNING'] } } });
      if (existing) return { jobId: existing.id, status: existing.status };
      if (await tx.job.count({ where: { status: 'PENDING' } }) >= this.maxPending) problem(429, 'QUEUE_FULL', 'Queue is full');
      const job = await tx.job.create({ data: { accountId, type: 'GROUP_INFORMATION_READ', payloadReference, traceId: randomUUID(), idempotencyKey: randomUUID(), ...(limit !== undefined ? { result: { requestedLimit: limit } } : {}) } });
      await tx.outboxEvent.create({ data: { jobId: job.id, type: 'job.created' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action, resourceType: 'Job', resourceId: job.id, metadata: { authorizationConfirmed: true } } });
      return { jobId: job.id, status: job.status };
    });
  }
  refresh(actor: Principal, accountId: string) { return this.enqueue(actor, accountId, 'account-sources:v1', 'source.catalog.request'); }
  async select(actor: Principal, accountId: string, sourceIds: string[]) {
    const catalog = await this.catalog(accountId); if (!catalog || Date.parse(catalog.data.scannedAt) < Date.now() - 86400000) problem(409, 'SOURCE_REFRESH_REQUIRED', 'Refresh account sources first');
    const ids = [...new Set(sourceIds)]; const chosen = ids.map(id => catalog.data.sources.find(s => s.key === id));
    if (chosen.some(s => !s)) problem(400, 'SOURCE_SELECTION_INVALID', 'A selected source does not belong to this account snapshot');
    return this.db.$transaction(async tx => {
      const rows = [];
      for (const source of chosen) {
        if (!source) continue;
        const id = randomUUID(); const reference = this.cipher.encrypt(sourceReference(accountId, source.peer), `target:${id}:reference`);
        const row = await tx.telegramTarget.upsert({ where: { identityKey: source.key }, create: { id, type: source.type, title: source.title, reference, identityKey: source.key, ownershipStatus: source.adminVerified ? 'ADMINISTRATOR' : 'UNVERIFIED' }, update: { title: source.title, type: source.type, ownershipStatus: source.adminVerified ? 'ADMINISTRATOR' : 'UNVERIFIED' } }); rows.push({ id: row.id, title: row.title, type: row.type });
      }
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'source.select', resourceType: 'TelegramAccount', resourceId: accountId, metadata: { count: rows.length, authorizationConfirmed: true } } }); return { targets: rows };
    });
  }
  async extract(actor: Principal, targetId: string, limit: number) {
    const target = await this.db.telegramTarget.findUnique({ where: { id: targetId } }); if (!target) problem(404, 'TARGET_NOT_FOUND', 'Target not found');
    const source = parseSourceReference(this.cipher.decrypt(target.reference, `target:${targetId}:reference`));
    if (!source) problem(409, 'SOURCE_PICK_ACCOUNT_FIRST', 'Select the source from a connected account first');
    // Ownership is not required; the worker checks the member list actually
    // available to this signed-in account through Telegram's own UI.
    return this.enqueue(actor, source.accountId, `source-members:v1:${targetId}`, 'source.members.request', limit);
  }
  async exports() {
    const rows = await this.db.job.findMany({ where: { type: 'GROUP_INFORMATION_READ', payloadReference: { startsWith: 'source-members:v1:' } }, select: { id: true, status: true, errorCode: true, accountId: true, payloadReference: true, createdAt: true, finishedAt: true, progress: true, processed: true, totalItems: true, result: true }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(({ result, ...row }) => { const summary = result as { memberCount?: number; partial?: boolean; usernameCounts?: { visible: number; notVisible: number; notChecked: number }; contactsImport?: { created: number; updated: number; existing: number; skipped: number } } | null; return { ...row, memberCount: summary?.memberCount ?? null, partial: summary?.partial ?? null, usernameCounts: summary?.usernameCounts ?? null, contactsImport: summary?.contactsImport ?? null }; });
  }
  importContacts(actor: Principal, jobId: string) { return saveMemberContacts(this.db, this.cipher, jobId, undefined, actor.id); }
  private async exportData(jobId: string) {
    const job = await this.db.job.findUnique({ where: { id: jobId } });
    if (!job || job.type !== 'GROUP_INFORMATION_READ' || !job.payloadReference?.startsWith('source-members:v1:')) problem(404, 'JOB_NOT_FOUND', 'Member export not found');
    if (job.status !== 'COMPLETED') problem(409, 'SOURCE_EXPORT_NOT_READY', 'Member export is not ready');
    return memberResultSchema.parse(this.decode(job));
  }
  async xlsx(actor: Principal, jobId: string) {
    const data = await this.exportData(jobId);
    await this.db.auditLog.create({ data: { actorId: actor.id, action: 'source.members.download_xlsx', resourceType: 'Job', resourceId: jobId } });
    return memberWorkbook(data);
  }
  async csv(actor: Principal, jobId: string) {
    const job = await this.db.job.findUnique({ where: { id: jobId } });
    if (!job || job.type !== 'GROUP_INFORMATION_READ' || !job.payloadReference?.startsWith('source-members:v1:')) problem(404, 'JOB_NOT_FOUND', 'Member export not found');
    if (job.status !== 'COMPLETED') problem(409, 'SOURCE_EXPORT_NOT_READY', 'Member export is not ready');
    const data = memberResultSchema.parse(this.decode(job));
    await this.db.auditLog.create({ data: { actorId: actor.id, action: 'source.members.download', resourceType: 'Job', resourceId: job.id } });
    return '\uFEFF' + stringify(memberRows(data), { columns: [...memberColumns], header: true, quoted: true, quoted_empty: true, record_delimiter: '\r\n', escape_formulas: true });
  }
}
