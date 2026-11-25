import './test-environment.js';
import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDatabase } from '../../packages/database/src/index.js';
import { FieldCipher } from '../../apps/api/src/crypto.js';
import { OperationsService } from '../../apps/api/src/operations.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
it('keeps ownership unverified, encrypts invitation links and provides real jobs/audit/settings', async () => {
  const db = createDatabase(process.env.DATABASE_URL!); const cipher = new FieldCipher(randomBytes(32).toString('hex'), randomBytes(32).toString('hex')); const ops = new OperationsService(db, cipher);
  const user = await db.adminUser.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'fixture', role: 'ADMIN' } }); const actor = { id: user.id, email: user.email, role: 'ADMIN' as const }; const targets: string[] = [];
  try {
    const target = await ops.createTarget(actor, { type: 'GROUP', reference: '@fixture_group', title: 'گروه تست', authorizationConfirmed: true }); targets.push(target.id);
    expect(target.ownershipStatus).toBe('UNVERIFIED'); await expect(ops.createTarget(actor, { type: 'GROUP', reference: 'https://t.me/fixture_group', title: 'Duplicate', authorizationConfirmed: true })).rejects.toMatchObject({ code: 'P2002' });
    expect((await ops.target(target.id)).capabilityStatus).toBe('UNSUPPORTED');
    const invite = await ops.registerInvitation(actor, { targetId: target.id, link: 'https://t.me/+fixture-link', authorizationConfirmed: true });
    const stored = await db.invitation.findUniqueOrThrow({ where: { id: invite.id } }); expect(stored.encryptedLink).not.toContain('fixture-link'); expect((await ops.invitationLink(invite.id)).link).toBe('https://t.me/+fixture-link');
    const job = await db.job.create({ data: { type: 'REPORT_GENERATION', traceId: randomUUID(), idempotencyKey: randomUUID() } });
    await ops.cancelJob(actor, job.id); expect((await ops.job(job.id)).status).toBe('CANCELLED'); await db.job.delete({ where: { id: job.id } });
    expect((await ops.overview()).generatedAt).toBeTruthy();
    const logs = await ops.logs({ page: 1, pageSize: 100 }); expect(JSON.stringify(logs)).not.toContain('fixture-link');
    await ops.updateSettings(actor, { timezone: 'Asia/Tehran', retentionDays: 90 }); expect(await ops.settings()).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'logs.retentionDays', value: 90 })]));
  } finally { await db.telegramTarget.deleteMany({ where: { id: { in: targets } } }); await db.auditLog.deleteMany({ where: { actorId: actor.id } }); await db.adminUser.delete({ where: { id: actor.id } }); await db.$disconnect(); }
});
