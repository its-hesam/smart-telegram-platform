import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../database/src/index.js';
import { FieldCipher } from './crypto.js';
import { memberResultSchema } from './account-sources.js';
export async function saveMemberContacts(db: PrismaClient, cipher: FieldCipher, jobId: string, extracted?: unknown, requestedBy?: string) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Job" WHERE id = ${jobId}::uuid FOR UPDATE`;
    const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.type !== 'GROUP_INFORMATION_READ' || !job.payloadReference?.startsWith('source-members:v1:') || (extracted === undefined ? job.status !== 'COMPLETED' : job.status !== 'RUNNING')) throw new Error('MEMBER_IMPORT_JOB_INVALID');
    const prior = job.result as { ciphertext?: string; contactsImport?: { version: number; created: number; updated: number; existing: number; skipped: number } } | null;
    if (prior?.contactsImport?.version === 1) return prior.contactsImport;
    const authorization = await tx.auditLog.findFirst({ where: { action: 'source.members.request', resourceType: 'Job', resourceId: job.id } });
    if (!authorization) throw new Error('MEMBER_IMPORT_NOT_AUTHORIZED');
    const data = memberResultSchema.parse(extracted ?? JSON.parse(cipher.decrypt(prior!.ciphertext!, `job:${job.id}:source-result`)));
    const summary = { version: 1, created: 0, updated: 0, existing: 0, skipped: 0 };
    const seen = new Set<string>();
    for (const member of [...data.members].sort((a, b) => a.reference.localeCompare(b.reference))) {
      if (seen.has(member.reference)) continue; seen.add(member.reference);
      const username = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(member.username ?? '') ? member.username!.replace(/^@/, '').toLowerCase() : undefined;
      const identities = [{ kind: 'telegramId', key: cipher.identity(`contact:telegramId:${member.reference}`) }, ...(username ? [{ kind: 'username', key: cipher.identity(`contact:username:${username}`) }] : [])];
      const keys = identities.map(i => i.key);
      for (const key of [...keys].sort()) await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      if (await tx.suppression.count({ where: { identityKey: { in: keys } } })) { summary.skipped++; continue; }
      const aliases = await tx.contactIdentity.findMany({ where: { key: { in: keys } } });
      const legacy = await tx.contact.findMany({ where: { identityKey: { in: keys } }, select: { id: true } });
      const owners = [...new Set([...aliases.map(a => a.contactId), ...legacy.map(a => a.id)])];
      if (owners.length > 1) { summary.skipped++; continue; }
      if (owners.length) {
        const row = await tx.contact.findUniqueOrThrow({ where: { id: owners[0]! } });
        if (['OPTED_OUT', 'REVOKED'].includes(row.consentStatus)) { summary.skipped++; continue; }
        const fillId = !row.encryptedTelegramId, fillUsername = username && !row.encryptedUsername;
        if (fillId || fillUsername) { await tx.contact.update({ where: { id: row.id }, data: { ...(fillId ? { encryptedTelegramId: cipher.encrypt(member.reference, `contact:${row.id}:telegramId`) } : {}), ...(fillUsername ? { encryptedUsername: cipher.encrypt(username, `contact:${row.id}:username`) } : {}) } }); summary.updated++; } else summary.existing++;
        for (const identity of identities) await tx.contactIdentity.upsert({ where: { key: identity.key }, create: { ...identity, contactId: row.id }, update: {} });
      } else {
        const id = randomUUID();
        await tx.contact.create({ data: { id, identityKey: identities[0]!.key, encryptedDisplayName: cipher.encrypt(member.displayName.replace(/\s+/g, ' ').trim().slice(0, 100), `contact:${id}:displayName`), encryptedTelegramId: cipher.encrypt(member.reference, `contact:${id}:telegramId`), encryptedUsername: username ? cipher.encrypt(username, `contact:${id}:username`) : null, source: 'AUTHORIZED_GROUP', sourceReference: job.payloadReference.slice('source-members:v1:'.length), consentStatus: 'UNKNOWN', tags: ['telegram-import'], identities: { create: identities }, consents: { create: { status: 'UNKNOWN' } } } }); summary.created++;
      }
    }
    const ciphertext = extracted === undefined ? prior!.ciphertext! : cipher.encrypt(JSON.stringify(data), `job:${job.id}:source-result`);
    const usernameCounts = { visible: data.members.filter(m => m.username).length, notVisible: data.members.filter(m => !m.username && m.usernameStatus === 'NOT_VISIBLE').length, notChecked: data.members.filter(m => !m.username && m.usernameStatus !== 'NOT_VISIBLE').length };
    await tx.job.update({ where: { id: job.id }, data: { status: 'COMPLETED', finishedAt: job.finishedAt ?? new Date(), errorCode: null, result: { ciphertext, contactsImport: summary, memberCount: data.members.length, partial: data.partial, usernameCounts } } });
    await tx.auditLog.create({ data: { actorId: requestedBy ?? authorization.actorId, action: 'source.members.import_contacts', resourceType: 'Job', resourceId: job.id, metadata: summary } });
    return summary;
  }, { timeout: 60000, maxWait: 10000 });
}
