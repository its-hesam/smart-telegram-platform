import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import type { Prisma } from '../../../packages/database/generated/client/client.js';
import { canContact } from '../../../packages/shared/src/index.js';
import { FieldCipher, hashToken } from './crypto.js';
import { problem } from './store.js';
import type { Principal } from './contracts.js';

import { renderMessage } from '../../../packages/shared/src/template.js';
export { renderMessage };
export const campaignInputSchema = z.strictObject({ name: z.string().trim().min(1).max(120), content: z.string().min(1).max(4000).refine(v => { try { renderMessage(v, 'preview'); return true; } catch { return false; } }), contactListId: z.uuid(), accountId: z.uuid(), scheduledAt: z.iso.datetime({ offset: true }).optional(), creationKey: z.uuid() });
export const pagingSchema = z.strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
type Input = z.infer<typeof campaignInputSchema>;
export class CampaignsService {
  constructor(private readonly db: PrismaClient, private readonly cipher: FieldCipher, private readonly maxPending = 5000) {}
  async create(actor: Principal, input: Input) {
    const requestHash = hashToken(JSON.stringify({ ...input, creationKey: undefined }));
    return this.db.$transaction(async tx => {
      const existing = await tx.campaign.findUnique({ where: { creationKey: input.creationKey } });
      if (existing) { if (existing.requestHash !== requestHash) problem(409, 'IDEMPOTENCY_CONFLICT', 'Key already used with different campaign'); return { id: existing.id, status: existing.status }; }
      const id = randomUUID(); const templateId = randomUUID();
      await tx.messageTemplate.create({ data: { id: templateId, name: id, version: 1, content: this.cipher.encrypt(input.content, `template:${templateId}`) } });
      const row = await tx.campaign.create({ data: { id, creationKey: input.creationKey, requestHash, name: input.name, accountId: input.accountId, contactListId: input.contactListId, messageTemplateId: templateId, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'campaign.create', resourceType: 'Campaign', resourceId: id } });
      return { id: row.id, status: row.status };
    }, { isolationLevel: 'Serializable' });
  }
  async list(query: z.infer<typeof pagingSchema>) {
    const [data, total] = await this.db.$transaction([this.db.campaign.findMany({ select: { id: true, name: true, status: true, scheduledAt: true, createdAt: true, accountId: true, _count: { select: { recipients: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), this.db.campaign.count()]); return { data, total, ...query };
  }
  async get(id: string) {
    const row = await this.db.campaign.findUnique({ where: { id }, include: { template: true, _count: { select: { recipients: true } } } }); if (!row) problem(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    const counts = await this.db.campaignRecipient.groupBy({ by: ['status'], where: { campaignId: id }, _count: true });
    return { id: row.id, name: row.name, status: row.status, accountId: row.accountId, contactListId: row.contactListId, scheduledAt: row.scheduledAt, content: this.cipher.decrypt(row.template.content, `template:${row.template.id}`), templateVersion: row.template.version, recipients: row._count.recipients, counts: Object.fromEntries(counts.map(c => [c.status, c._count])) };
  }
  async reviseTemplate(actor: Principal, id: string, content: string) {
    renderMessage(content, 'preview');
    return this.db.$transaction(async tx => {
      const campaign = await tx.campaign.findUnique({ where: { id }, include: { template: true } }); if (!campaign) problem(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      if (campaign.status !== 'DRAFT') problem(409, 'CAMPAIGN_STATE_CONFLICT', 'Only drafts can change templates');
      const templateId = randomUUID(); const template = await tx.messageTemplate.create({ data: { id: templateId, name: id, version: campaign.template.version + 1, content: this.cipher.encrypt(content, `template:${templateId}`) } });
      await tx.campaign.update({ where: { id }, data: { messageTemplateId: template.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'template.revise', resourceType: 'Campaign', resourceId: id, metadata: { version: template.version } } });
      return { version: template.version };
    }, { isolationLevel: 'Serializable' });
  }
  async templateHistory(id: string) { await this.get(id); const rows = await this.db.messageTemplate.findMany({ where: { name: id }, orderBy: { version: 'desc' }, take: 100 }); return rows.map(row => ({ version: row.version, createdAt: row.createdAt, content: this.cipher.decrypt(row.content, `template:${row.id}`) })); }
  private activeAuthorization(client: PrismaClient | Prisma.TransactionClient) {
    return client.outreachAuthorization.findFirst({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  }
  async testSend(actor: Principal, id: string, contactId: string, creationKey: string) {
    const original = await this.get(id);
    const row = await this.db.contact.findUnique({ where: { id: contactId }, include: { identities: true } }); if (!row) problem(404, 'CONTACT_NOT_FOUND', 'Contact not found');
    const suppressed = await this.db.suppression.count({ where: { identityKey: { in: row.identities.map(i => i.key) } } });
    const authorized = Boolean(await this.activeAuthorization(this.db));
    if (!canContact({ status: row.consentStatus, timestamp: row.consentTimestamp, evidence: row.consentEvidenceReference, suppressed: Boolean(suppressed) }, authorized)) problem(409, authorized ? 'SUPPRESSED' : 'AUTHORIZATION_MISSING', 'Test recipient is suppressed or lacks a legal outreach authorization');
    const list = await this.db.contactList.upsert({ where: { name: `test-send:${creationKey}` }, create: { name: `test-send:${creationKey}`, members: { create: { contactId } } }, update: {}, include: { members: true } });
    if (list.members.length !== 1 || list.members[0]?.contactId !== contactId) problem(409, 'IDEMPOTENCY_CONFLICT', 'Test key already used for another recipient');
    const draft = await this.create(actor, { name: `Test: ${original.name}`, content: original.content, contactListId: list.id, accountId: original.accountId, creationKey });
    if (draft.status !== 'DRAFT') return { id: draft.id, status: draft.status };
    return this.start(actor, draft.id);
  }
  // Keyset SQL keeps the audience query fast and does not load contact rows or
  // their identities into Node memory. Suppression always excludes a contact.
  private async audience(tx: Prisma.TransactionClient, listId: string, authorized: boolean) {
    const totalRows = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM "ContactListMember" WHERE "listId" = ${listId}::uuid`;
    const total = totalRows[0]?.count ?? 0;
    const rows = authorized
      ? await tx.$queryRaw<{ id: string }[]>`SELECT c.id FROM "Contact" c JOIN "ContactListMember" m ON m."contactId" = c.id WHERE m."listId" = ${listId}::uuid AND NOT EXISTS (SELECT 1 FROM "ContactIdentity" i JOIN "Suppression" s ON s."identityKey" = i.key WHERE i."contactId" = c.id) AND NOT EXISTS (SELECT 1 FROM "Suppression" s WHERE s."identityKey" = c."identityKey") ORDER BY c.id`
      : await tx.$queryRaw<{ id: string }[]>`SELECT c.id FROM "Contact" c JOIN "ContactListMember" m ON m."contactId" = c.id WHERE m."listId" = ${listId}::uuid AND c."consentStatus" = 'OPTED_IN' AND c."consentTimestamp" IS NOT NULL AND c."consentTimestamp" <= now() AND c."consentEvidenceReference" IS NOT NULL AND btrim(c."consentEvidenceReference") <> '' AND NOT EXISTS (SELECT 1 FROM "ContactIdentity" i JOIN "Suppression" s ON s."identityKey" = i.key WHERE i."contactId" = c.id) AND NOT EXISTS (SELECT 1 FROM "Suppression" s WHERE s."identityKey" = c."identityKey") ORDER BY c.id`;
    return { ids: rows.map(row => row.id), total, excluded: total - rows.length };
  }
  async validate(id: string) {
    return this.db.$transaction(async tx => {
      const row = await tx.campaign.findUnique({ where: { id }, include: { account: true } }); if (!row) problem(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      const authorization = await this.activeAuthorization(tx);
      const audience = await this.audience(tx, row.contactListId, Boolean(authorization));
      return { eligible: audience.ids.length, excluded: audience.excluded, total: audience.total, authorizationActive: Boolean(authorization), accountReady: row.account.status === 'CONNECTED', canStart: audience.ids.length > 0 && Boolean(authorization) && row.account.status === 'CONNECTED' && row.status === 'DRAFT' };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async start(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const row = await tx.campaign.findUnique({ where: { id }, include: { account: true } }); if (!row) problem(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      if (row.status !== 'DRAFT') problem(409, 'CAMPAIGN_STATE_CONFLICT', 'Campaign must be a draft');
      if (row.account.status !== 'CONNECTED') problem(409, 'ACCOUNT_NOT_CONNECTED', 'Sender needs a validated connected session');
      const authorization = await this.activeAuthorization(tx);
      if (!authorization) problem(409, 'AUTHORIZATION_MISSING', 'Record a legal outreach authorization in Settings before starting');
      const audience = await this.audience(tx, row.contactListId, true);
      if (!audience.ids.length) problem(409, 'NO_RECIPIENTS', 'No eligible recipients after suppression');
      const pending = await tx.job.count({ where: { status: { in: ['PENDING', 'RUNNING', 'PAUSED'] } } });
      if (pending + audience.ids.length > this.maxPending) problem(409, 'QUEUE_BACKPRESSURE', 'Local pending-job capacity reached');
      const status = row.scheduledAt && row.scheduledAt > new Date() ? 'SCHEDULED' : 'RUNNING';
      await tx.campaign.update({ where: { id }, data: { status } });
      const createdRecipients: { id: string; idempotencyKey: string }[] = [];
      const chunkSize = 1000;
      for (let offset = 0; offset < audience.ids.length; offset += chunkSize) {
        const recipients = audience.ids.slice(offset, offset + chunkSize).map(contactId => ({ id: randomUUID(), campaignId: id, contactId, accountId: row.accountId, idempotencyKey: `${id}:${contactId}` }));
        const created = await tx.campaignRecipient.createManyAndReturn({ data: recipients, skipDuplicates: true, select: { id: true, idempotencyKey: true } });
        createdRecipients.push(...created);
      }
      if (!createdRecipients.length) problem(409, 'NO_RECIPIENTS', 'No new recipients could be created for this campaign');
      for (let offset = 0; offset < createdRecipients.length; offset += chunkSize) {
        const jobs = createdRecipients.slice(offset, offset + chunkSize).map(recipient => ({ id: randomUUID(), type: 'APPROVED_MESSAGE_SEND' as const, accountId: row.accountId, campaignId: id, payloadReference: recipient.id, idempotencyKey: recipient.idempotencyKey, traceId: randomUUID(), scheduledAt: row.scheduledAt }));
        await tx.job.createMany({ data: jobs, skipDuplicates: true });
        await tx.outboxEvent.createMany({ data: jobs.map(job => ({ jobId: job.id, type: 'job.created' })) });
      }
      const excluded = audience.excluded + (audience.ids.length - createdRecipients.length);
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'campaign.start', resourceType: 'Campaign', resourceId: id, metadata: { eligible: createdRecipients.length, excluded, authorizationId: authorization.id } } });
      return { id, status, eligible: createdRecipients.length, excluded };
    }, { isolationLevel: 'Serializable', timeout: 120000, maxWait: 10000 });
  }
  async transition(actor: Principal, id: string, action: 'pause' | 'resume' | 'cancel') {
    await this.db.$transaction(async tx => {
      const row = await tx.campaign.findUnique({ where: { id } }); if (!row) problem(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      const allowed = action === 'resume' ? ['PAUSED'] : action === 'pause' ? ['RUNNING', 'SCHEDULED'] : ['DRAFT', 'RUNNING', 'SCHEDULED', 'PAUSED'];
      if (!allowed.includes(row.status)) problem(409, 'CAMPAIGN_STATE_CONFLICT', 'Transition is not permitted');
      await tx.campaign.update({ where: { id }, data: { status: action === 'pause' ? 'PAUSED' : action === 'cancel' ? 'CANCELLED' : row.scheduledAt && row.scheduledAt > new Date() ? 'SCHEDULED' : 'RUNNING' } });
      if (action === 'cancel') {
        await tx.job.updateMany({ where: { campaignId: id, status: { in: ['PENDING', 'PAUSED'] } }, data: { status: 'CANCELLED', cancellationRequestedAt: new Date(), finishedAt: new Date() } });
        await tx.job.updateMany({ where: { campaignId: id, status: 'RUNNING' }, data: { cancellationRequestedAt: new Date() } });
        await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      } else if (action === 'resume') {
        const jobs = await tx.job.findMany({ where: { campaignId: id, status: 'PAUSED' } });
        for (const job of jobs) { await tx.job.update({ where: { id: job.id }, data: { status: 'PENDING' } }); await tx.outboxEvent.create({ data: { jobId: job.id, type: 'job.resumed' } }); }
      }
      await tx.auditLog.create({ data: { actorId: actor.id, action: `campaign.${action}`, resourceType: 'Campaign', resourceId: id } });
    }, { isolationLevel: 'Serializable' });
  }
}
