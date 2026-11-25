import './test-environment.js';
import 'dotenv/config';
import { randomUUID, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDatabase } from '../../packages/database/src/index.js';
import { FieldCipher } from '../../apps/api/src/crypto.js';
import { ContactsService, contactInputSchema } from '../../apps/api/src/contacts.js';
import { consentWorkbook } from '../fixtures/workbook.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
it('enforces consent, alias dedup, suppression, union membership, safe export and erasure in PostgreSQL', async () => {
  const db = createDatabase(process.env.DATABASE_URL!); const key = randomBytes(32).toString('hex');
  const cipher = new FieldCipher(key, randomBytes(32).toString('hex')); const service = new ContactsService(db, cipher, { batchSize: 100, exportRoot: '/tmp/smart-test-exports', importMaxRows: 500 });
  const user = await db.adminUser.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'not-a-real-login', role: 'ADMIN' } });
  const actor = { id: user.id, email: user.email, role: 'ADMIN' as const }; const ids: string[] = []; const listIds: string[] = [];
  try {
    const list = await service.createList(actor, { name: `List ${randomUUID()}` }); listIds.push(list.id);
    const other = await service.createList(actor, { name: `Other ${randomUUID()}` }); listIds.push(other.id);
    const input = contactInputSchema.parse({ displayName: '=HYPERLINK("bad")', username: 'test_user', phone: '+15550000001', consentStatus: 'OPTED_IN', consentTimestamp: '2026-01-01T00:00:00Z', consentEvidenceReference: 'record/1', listIds: [list.id] });
    const contact = await service.create(actor, input); ids.push(contact.id);
    const stored = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(stored.encryptedDisplayName).not.toContain('HYPERLINK'); expect(stored.encryptedPhone).not.toContain('+98912');
    await expect(service.create(actor, contactInputSchema.parse({ displayName: 'Duplicate phone alias', phone: input.phone }))).rejects.toMatchObject({ code: 'P2002' });
    await service.listMembers(actor, other.id, [contact.id]); await service.mergeLists(actor, list.id, other.id);
    expect(await db.contactListMember.count({ where: { listId: list.id } })).toBe(1);
    const stream = await service.exportCsvStream(actor, {}); let csv = ''; for await (const chunk of stream) csv += chunk.toString(); expect(csv).toContain("'=HYPERLINK");
    const imported = await service.import(actor, { format: 'csv', content: 'displayName,username\nImported,import_user\nDuplicate,test_user\nMissing identity,\n' });
    expect(imported).toMatchObject({ imported: 1, duplicates: 1 }); expect(imported.errors).toHaveLength(1);
    ids.push(...(await db.contact.findMany({ where: { source: 'CSV' } })).map(c => c.id));
    await expect(service.import(actor, { format: 'csv', content: 'displayName,username\n' + Array.from({ length: 501 }, () => 'Too many,too_many_user').join('\n') })).rejects.toThrow();
    const excel = await service.import(actor, { format: 'xlsx', content: consentWorkbook() }); expect(excel).toMatchObject({ imported: 1, duplicates: 0, errors: [] });
    ids.push(...(await db.contact.findMany({ where: { source: 'EXCEL' } })).map(c => c.id));
    await service.consent(actor, contact.id, { consentStatus: 'REVOKED' });
    expect((await service.list({ page: 1, pageSize: 100 })).data.find(c => c.id === contact.id)?.suppressed).toBe(true);
    await expect(service.consent(actor, contact.id, { consentStatus: 'OPTED_IN', consentTimestamp: '2026-01-01T00:00:00Z', consentEvidenceReference: 'record/2' })).rejects.toThrow();
    await service.erase(actor, contact.id);
    expect(await db.contact.findUnique({ where: { id: contact.id } })).toBeNull();
    expect(await db.consentRecord.count({ where: { contactId: contact.id } })).toBe(0);
    await expect(service.create(actor, input)).rejects.toThrow();
  } finally {
    await db.contact.deleteMany({ where: { id: { in: ids } } });
    await db.contactList.deleteMany({ where: { id: { in: listIds } } });
    await db.auditLog.deleteMany({ where: { actorId: actor.id } });
    await db.suppression.deleteMany({ where: { identityKey: { in: ['username:test_user', 'phone:+15550000001'].map(v => cipher.identity(`contact:${v}`)) } } });
    await db.adminUser.delete({ where: { id: actor.id } }); await db.$disconnect();
  }
}, 30000);
