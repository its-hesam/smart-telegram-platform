import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import { Readable } from 'node:stream';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import type { Prisma } from '../../../packages/database/generated/client/client.js';
import { FieldCipher } from './crypto.js';
import { problem } from './store.js';
import type { Principal } from './contracts.js';
import { contactCsv, contactExportRow, type ContactExportFilter, type ContactExportFormat, type ContactExportRow } from '../../../packages/shared/src/contact-export.js';

const consentFields = { consentStatus: z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'REVOKED']).default('UNKNOWN'), consentTimestamp: z.iso.datetime({ offset: true }).optional(), consentEvidenceReference: z.string().trim().min(1).max(256).optional() };
const consentValid = (v: { consentStatus: string; consentTimestamp?: string | undefined; consentEvidenceReference?: string | undefined }) => v.consentStatus !== 'OPTED_IN' || Boolean(v.consentTimestamp && Date.parse(v.consentTimestamp) <= Date.now() && v.consentEvidenceReference);
export const contactInputSchema = z.strictObject({ displayName: z.string().trim().min(1).max(100), username: z.string().trim().regex(/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/).transform(v => v.replace(/^@/, '').toLowerCase()).optional(), phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(), telegramId: z.string().regex(/^[1-9]\d{0,19}$/).optional(), source: z.enum(['MANUAL', 'CSV', 'EXCEL', 'OPT_IN_FORM', 'AUTHORIZED_GROUP']).default('MANUAL'), sourceReference: z.string().max(256).optional(), notes: z.string().max(2000).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]), listIds: z.array(z.uuid()).max(20).default([]), ...consentFields }).refine(v => Boolean(v.username || v.phone || v.telegramId), 'An identity is required').refine(consentValid, 'Valid timestamp and evidence are required for opt-in');
export const consentInputSchema = z.strictObject(consentFields).refine(consentValid);
export const contactQuerySchema = z.strictObject({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), consentStatus: z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'REVOKED']).optional(), listId: z.uuid().optional(), tag: z.string().max(40).optional() });
export const contactPatchSchema = z.strictObject({ displayName: z.string().trim().min(1).max(100).optional(), notes: z.string().max(2000).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional() }).refine(v => Object.keys(v).length > 0);
export const listSchema = z.strictObject({ name: z.string().trim().min(1).max(100), description: z.string().max(500).optional() });
export const importSchema = z.strictObject({ format: z.enum(['csv', 'xlsx']), content: z.string().max(700000), listId: z.uuid().optional() });
type Input = z.infer<typeof contactInputSchema>;
type Row = Prisma.ContactGetPayload<{ include: { identities: true; lists: true } }>;
async function parseWorkbook(bytes: Buffer): Promise<Record<string, unknown>[]> {
  // XLSX parsing is isolated from the API event loop with a bounded heap/time budget.
  const compiled = new URL('./excel-worker.js', import.meta.url);
  const worker = new Worker(existsSync(compiled) ? compiled : new URL('./excel-worker.ts', import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Workbook timeout')); }, 5000);
    const finish = () => { clearTimeout(timer); void worker.terminate(); };
    worker.once('message', (result: { ok: boolean; rows?: Record<string, unknown>[] }) => { finish(); if (result.ok && result.rows) resolve(result.rows); else reject(new Error('Workbook rejected')); });
    worker.once('error', () => { finish(); reject(new Error('Workbook worker failed')); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Workbook worker exited')); });
  });
}
export class ContactsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cipher: FieldCipher,
    private readonly options: { batchSize: number; exportRoot: string; importMaxRows: number } = { batchSize: 500, exportRoot: '/tmp/smart-exports', importMaxRows: 5000 },
  ) {}
  private get batchSize() { return Math.max(50, this.options.batchSize); }
  private identities(input: Input) { return (['username', 'phone', 'telegramId'] as const).flatMap(kind => input[kind] ? [{ key: this.cipher.identity(`contact:${kind}:${input[kind]}`), kind }] : []); }
  private view(row: Row, suppressed: boolean) {
    const decrypt = (v: string | null, field: string) => v ? this.cipher.decrypt(v, `contact:${row.id}:${field}`) : null;
    return { id: row.id, displayName: decrypt(row.encryptedDisplayName, 'displayName'), username: decrypt(row.encryptedUsername, 'username'), phone: decrypt(row.encryptedPhone, 'phone'), telegramId: decrypt(row.encryptedTelegramId, 'telegramId'), notes: decrypt(row.encryptedNotes, 'notes'), source: row.source, tags: row.tags, suppressed, listIds: row.lists.map(m => m.listId), createdAt: row.createdAt };
  }
  async list(query: z.infer<typeof contactQuerySchema>) {
    const where: Prisma.ContactWhereInput = { ...(query.consentStatus ? { consentStatus: query.consentStatus } : {}), ...(query.listId ? { lists: { some: { listId: query.listId } } } : {}), ...(query.tag ? { tags: { has: query.tag } } : {}) };
    const [rows, total] = await this.db.$transaction([this.db.contact.findMany({ where, include: { identities: true, lists: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }), this.db.contact.count({ where })]);
    const suppressed = new Set((await this.db.suppression.findMany({ where: { identityKey: { in: rows.flatMap(r => r.identities.map(i => i.key)) } }, select: { identityKey: true } })).map(r => r.identityKey));
    return { data: rows.map(row => this.view(row, row.identities.some(i => suppressed.has(i.key)))), total, page: query.page, pageSize: query.pageSize };
  }
  async create(actor: Principal, input: Input) {
    const id = randomUUID(); const identities = this.identities(input); const keys = identities.map(i => i.key);
    const encrypt = (value: string | undefined, field: string) => value ? this.cipher.encrypt(value, `contact:${id}:${field}`) : null;
    const row = await this.db.$transaction(async tx => {
      const suppressed = await tx.suppression.count({ where: { identityKey: { in: keys } } });
      if (suppressed && input.consentStatus === 'OPTED_IN') problem(409, 'CONTACT_SUPPRESSED', 'Identity is suppressed; explicit consent review required');
      const contact = await tx.contact.create({ data: { id, identityKey: keys[0]!, encryptedDisplayName: encrypt(input.displayName, 'displayName')!, encryptedUsername: encrypt(input.username, 'username'), encryptedPhone: encrypt(input.phone, 'phone'), encryptedTelegramId: encrypt(input.telegramId, 'telegramId'), encryptedNotes: encrypt(input.notes, 'notes'), source: input.source, sourceReference: input.sourceReference ?? null, tags: [...new Set(input.tags)], consentStatus: input.consentStatus, consentTimestamp: input.consentTimestamp ? new Date(input.consentTimestamp) : null, consentEvidenceReference: input.consentEvidenceReference ?? null,
        identities: { create: identities }, lists: { create: input.listIds.map(listId => ({ listId })) } }, include: { identities: true, lists: true } });
      await tx.consentRecord.create({ data: { contactId: id, status: input.consentStatus, evidenceReference: input.consentEvidenceReference ?? null, consentedAt: input.consentTimestamp ? new Date(input.consentTimestamp) : null } });
      if (['OPTED_OUT', 'REVOKED'].includes(input.consentStatus)) for (const identityKey of keys) await tx.suppression.upsert({ where: { identityKey }, create: { identityKey, reason: input.consentStatus }, update: {} });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contact.create', resourceType: 'Contact', resourceId: id } });
      return contact;
    }, { isolationLevel: 'Serializable' });
    return this.view(row, ['OPTED_OUT', 'REVOKED'].includes(input.consentStatus) || Boolean(await this.db.suppression.count({ where: { identityKey: { in: keys } } })));
  }
  async update(actor: Principal, id: string, input: z.infer<typeof contactPatchSchema>) {
    return this.db.$transaction(async tx => {
      if (!await tx.contact.findUnique({ where: { id } })) problem(404, 'CONTACT_NOT_FOUND', 'Contact not found');
      const row = await tx.contact.update({ where: { id }, data: { ...(input.displayName !== undefined ? { encryptedDisplayName: this.cipher.encrypt(input.displayName, `contact:${id}:displayName`) } : {}), ...(input.notes !== undefined ? { encryptedNotes: input.notes ? this.cipher.encrypt(input.notes, `contact:${id}:notes`) : null } : {}), ...(input.tags ? { tags: [...new Set(input.tags)] } : {}) }, include: { identities: true, lists: true } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contact.update', resourceType: 'Contact', resourceId: id, metadata: { fields: Object.keys(input) } } });
      return { id: row.id };
    });
  }
  async consent(actor: Principal, id: string, input: z.infer<typeof consentInputSchema>) {
    await this.db.$transaction(async tx => {
      const row = await tx.contact.findUnique({ where: { id }, include: { identities: true } }); if (!row) problem(404, 'CONTACT_NOT_FOUND', 'Contact not found');
      const keys = row.identities.map(i => i.key);
      if (input.consentStatus === 'OPTED_IN' && await tx.suppression.count({ where: { identityKey: { in: keys } } })) problem(409, 'CONTACT_SUPPRESSED', 'Identity is suppressed; explicit consent review required');
      await tx.contact.update({ where: { id }, data: { consentStatus: input.consentStatus, consentTimestamp: input.consentTimestamp ? new Date(input.consentTimestamp) : null, consentEvidenceReference: input.consentEvidenceReference ?? null } });
      await tx.consentRecord.create({ data: { contactId: id, status: input.consentStatus, evidenceReference: input.consentEvidenceReference ?? null, consentedAt: input.consentTimestamp ? new Date(input.consentTimestamp) : null } });
      if (['OPTED_OUT', 'REVOKED'].includes(input.consentStatus)) for (const identityKey of keys) await tx.suppression.upsert({ where: { identityKey }, create: { identityKey, reason: input.consentStatus }, update: {} });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contact.consent', resourceType: 'Contact', resourceId: id, metadata: { status: input.consentStatus } } });
    }, { isolationLevel: 'Serializable' });
  }
  async removeRecord(actor: Principal, id: string) {
    await this.db.$transaction(async tx => {
      const row = await tx.contact.findUnique({ where: { id }, include: { identities: true } }); if (!row) problem(404, 'CONTACT_NOT_FOUND', 'Contact not found');
      if (await tx.campaignRecipient.count({ where: { contactId: id, status: 'PROCESSING' } })) problem(409, 'CONTACT_IN_USE', 'Wait for the active operation before removal');
      // Removing a record is distinct from erasure. Existing opt-outs remain effective.
      if (['OPTED_OUT', 'REVOKED'].includes(row.consentStatus)) for (const key of new Set([row.identityKey, ...row.identities.map(i => i.key)])) await tx.suppression.upsert({ where: { identityKey: key }, create: { identityKey: key, reason: row.consentStatus }, update: {} });
      await tx.campaignRecipient.updateMany({ where: { contactId: id, status: 'PENDING' }, data: { status: 'CANCELLED', errorCode: 'CONTACT_REMOVED' } });
      await tx.contact.delete({ where: { id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contact.remove', resourceType: 'Contact', resourceId: id } });
    }, { isolationLevel: 'Serializable' });
  }
  async erase(actor: Principal, id: string) {
    await this.db.$transaction(async tx => {
      const row = await tx.contact.findUnique({ where: { id }, include: { identities: true } }); if (!row) problem(404, 'CONTACT_NOT_FOUND', 'Contact not found');
      if (await tx.campaignRecipient.count({ where: { contactId: id, status: 'PROCESSING' } })) problem(409, 'CONTACT_IN_USE', 'Wait for the active operation before erasure');
      for (const identity of row.identities) await tx.suppression.upsert({ where: { identityKey: identity.key }, create: { identityKey: identity.key, reason: 'ERASURE' }, update: {} });
      await tx.contact.delete({ where: { id } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contact.erase', resourceType: 'Contact', resourceId: id } });
    }, { isolationLevel: 'Serializable' });
  }
  lists() { return this.db.contactList.findMany({ take: 200, orderBy: { name: 'asc' }, include: { _count: { select: { members: true } } } }); }
  async createList(actor: Principal, input: z.infer<typeof listSchema>) { return this.db.$transaction(async tx => { const list = await tx.contactList.create({ data: { name: input.name, description: input.description ?? null } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'list.create', resourceType: 'ContactList', resourceId: list.id } }); return list; }); }
  async listMembers(actor: Principal, listId: string, contactIds: string[]) { await this.db.$transaction(async tx => { await tx.contactListMember.createMany({ data: contactIds.map(contactId => ({ listId, contactId })), skipDuplicates: true }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'list.members.add', resourceType: 'ContactList', resourceId: listId, metadata: { count: contactIds.length } } }); }); }
  async renameList(actor: Principal, id: string, name: string) { await this.db.$transaction(async tx => { await tx.contactList.update({ where: { id }, data: { name } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'list.rename', resourceType: 'ContactList', resourceId: id } }); }); }
  async deleteList(actor: Principal, id: string) { await this.db.$transaction(async tx => { await tx.contactList.delete({ where: { id } }); await tx.auditLog.create({ data: { actorId: actor.id, action: 'list.delete', resourceType: 'ContactList', resourceId: id } }); }); }
  async mergeLists(actor: Principal, targetId: string, sourceId: string) {
    if (targetId === sourceId) problem(400, 'VALIDATION_FAILED', 'Lists must differ');
    await this.db.$transaction(async tx => {
      if (await tx.contactList.count({ where: { id: { in: [targetId, sourceId] } } }) !== 2) problem(404, 'LIST_NOT_FOUND', 'List not found');
      const members = await tx.contactListMember.findMany({ where: { listId: sourceId } });
      await tx.contactListMember.createMany({ data: members.map(m => ({ listId: targetId, contactId: m.contactId })), skipDuplicates: true });
      // Keep the source and its campaign references intact; merge is a deduplicated union.
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'list.merge', resourceType: 'ContactList', resourceId: targetId, metadata: { sourceId } } });
    }, { isolationLevel: 'Serializable' });
  }
  async import(actor: Principal, input: z.infer<typeof importSchema>) {
    let rows: Record<string, unknown>[];
    try {
      if (input.format === 'csv') rows = parseCsv(input.content, { columns: true, bom: true, skip_empty_lines: true, max_record_size: 10000 }) as Record<string, unknown>[];
      else {
        const bytes = Buffer.from(input.content, 'base64'); if (bytes.length > 512000) problem(400, 'IMPORT_TOO_LARGE', 'File is too large');
        rows = await parseWorkbook(bytes);
      }
    } catch (error) { if (error instanceof Error && 'getStatus' in error) throw error; problem(400, 'INVALID_IMPORT', 'File cannot be parsed'); }
    if (rows.length > this.options.importMaxRows) problem(400, 'IMPORT_TOO_LARGE', `Maximum ${this.options.importMaxRows} rows`);
    const result = { imported: 0, duplicates: 0, errors: [] as { row: number; code: string }[] };
    for (const [index, row] of rows.entries()) {
      const cleaned = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== null));
      const parsed = contactInputSchema.safeParse({ ...cleaned, tags: typeof cleaned.tags === 'string' ? cleaned.tags.split('|').filter(Boolean) : [], source: input.format === 'csv' ? 'CSV' : 'EXCEL', listIds: input.listId ? [input.listId] : [] });
      if (!parsed.success) { result.errors.push({ row: index + 2, code: 'VALIDATION_FAILED' }); continue; }
      try { await this.create(actor, parsed.data); result.imported++; }
      catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') result.duplicates++; else { result.errors.push({ row: index + 2, code: 'IMPORT_ROW_REJECTED' }); } }
    }
    return result;
  }
  private exportWhere(filter: ContactExportFilter): Prisma.ContactWhereInput {
    return {
      ...(filter.consentStatus ? { consentStatus: filter.consentStatus } : {}),
      ...(filter.listId ? { lists: { some: { listId: filter.listId } } } : {}),
      ...(filter.tag ? { tags: { has: filter.tag } } : {}),
    };
  }
  private async *exportBatches(filter: ContactExportFilter): AsyncGenerator<ContactExportRow[]> {
    const base = this.exportWhere(filter);
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db.contact.findMany({
        where: { ...base, ...(cursor ? { id: { gt: cursor } } : {}) } as Prisma.ContactWhereInput,
        include: { identities: true },
        orderBy: { id: 'asc' },
        take: this.batchSize,
      });
      if (!rows.length) return;
      cursor = rows[rows.length - 1]!.id;
      const keys = rows.flatMap(row => row.identities.map(identity => identity.key));
      const suppressed = new Set((await this.db.suppression.findMany({ where: { identityKey: { in: keys } }, select: { identityKey: true } })).map(row => row.identityKey));
      yield rows.map(row => contactExportRow(this.cipher, row, row.identities.some(identity => suppressed.has(identity.key))));
      if (rows.length < this.batchSize) return;
    }
  }
  // Direct stream: keyset pagination keeps memory bounded and removes the old
  // 100-contact cap. Larger or repeatable exports use the durable job below.
  async exportCsvStream(actor: Principal, filter: ContactExportFilter): Promise<Readable> {
    await this.db.auditLog.create({ data: { actorId: actor.id, action: 'contacts.export', resourceType: 'Contact', resourceId: 'stream', metadata: { filter } } });
    const batches = this.exportBatches(filter);
    async function* chunks() { yield '\uFEFF' + contactCsv([], true); for await (const batch of batches) yield contactCsv(batch, false); }
    return Readable.from(chunks(), { objectMode: false });
  }
  async createExportJob(actor: Principal, format: ContactExportFormat, filter: ContactExportFilter) {
    return this.db.$transaction(async tx => {
      const job = await tx.job.create({ data: { type: 'DATA_EXPORT', params: { format, ...filter } as Prisma.InputJsonValue, idempotencyKey: randomUUID(), traceId: randomUUID() } });
      await tx.outboxEvent.create({ data: { jobId: job.id, type: 'job.created' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contacts.export.request', resourceType: 'Job', resourceId: job.id, metadata: { format, filter } } });
      return { jobId: job.id, status: job.status };
    });
  }
  async exportJob(actor: Principal, id: string) {
    const job = await this.db.job.findUnique({ where: { id } });
    if (!job || job.type !== 'DATA_EXPORT') problem(404, 'EXPORT_NOT_FOUND', 'Export job not found');
    return { id: job.id, status: job.status, progress: job.progress, processed: job.processed, totalItems: job.totalItems, errorCode: job.errorCode, createdAt: job.createdAt, finishedAt: job.finishedAt, params: job.params, result: job.result };
  }
  async exportFile(actor: Principal, id: string) {
    const job = await this.db.job.findUnique({ where: { id } });
    if (!job || job.type !== 'DATA_EXPORT') problem(404, 'EXPORT_NOT_FOUND', 'Export job not found');
    if (job.status !== 'COMPLETED') problem(409, 'EXPORT_NOT_READY', 'Export is not ready');
    const params = z.object({ format: z.enum(['csv', 'xlsx']) }).safeParse(job.params);
    if (!params.success) problem(409, 'EXPORT_NOT_READY', 'Export parameters are invalid');
    const root = resolve(this.options.exportRoot);
    const path = resolve(root, `${job.id}.${params.data.format}`);
    if (!path.startsWith(root + sep)) problem(500, 'EXPORT_PATH_INVALID', 'Export path is invalid');
    try { await stat(path); } catch { problem(404, 'EXPORT_FILE_MISSING', 'Export file is no longer available'); }
    await this.db.auditLog.create({ data: { actorId: actor.id, action: 'contacts.export_download', resourceType: 'Job', resourceId: id, metadata: { format: params.data.format } } });
    return { path, filename: `contacts-${job.id.slice(0, 8)}.${params.data.format}`, format: params.data.format };
  }
  async resumeExportJob(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const job = await tx.job.findUnique({ where: { id } });
      if (!job || job.type !== 'DATA_EXPORT') problem(404, 'EXPORT_NOT_FOUND', 'Export job not found');
      if (!['FAILED', 'CANCELLED', 'UNKNOWN'].includes(job.status)) problem(409, 'EXPORT_STATE_CONFLICT', 'Only failed or cancelled exports can be resumed');
      const updated = await tx.job.update({ where: { id }, data: { status: 'PENDING', workerId: null, startedAt: null, finishedAt: null, errorCode: null, cancellationRequestedAt: null } });
      await tx.outboxEvent.create({ data: { jobId: id, type: 'job.resumed' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contacts.export.resume', resourceType: 'Job', resourceId: id } });
      return { jobId: updated.id, status: updated.status };
    });
  }
  async suppress(actor: Principal, id: string) {
    await this.db.$transaction(async tx => {
      const row = await tx.contact.findUnique({ where: { id }, include: { identities: true } });
      if (!row) problem(404, 'CONTACT_NOT_FOUND', 'Contact not found');
      for (const key of new Set([row.identityKey, ...row.identities.map(identity => identity.key)])) await tx.suppression.upsert({ where: { identityKey: key }, create: { identityKey: key, reason: 'MANUAL' }, update: {} });
      await tx.campaignRecipient.updateMany({ where: { contactId: id, status: 'PENDING' }, data: { status: 'CANCELLED', errorCode: 'SUPPRESSED' } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: 'contact.suppress', resourceType: 'Contact', resourceId: id } });
    }, { isolationLevel: 'Serializable' });
  }
}
