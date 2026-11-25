import { createDatabase } from '../../../packages/database/src/index.js';
const connection = process.env.CLEANUP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connection) { console.error('DATABASE_URL or maintenance CLEANUP_DATABASE_URL required'); process.exit(1); }
const db = createDatabase(connection);
try {
  const setting = await db.systemSetting.findUnique({ where: { key: 'logs.retentionDays' } });
  const days = typeof setting?.value === 'number' ? setting.value : 90;
  if (!Number.isInteger(days) || days < 7 || days > 365) throw new Error('Invalid retention policy');
  const cutoff = new Date(Date.now() - days * 86400000); const now = new Date();
  const expired = await db.authSession.count({ where: { expiresAt: { lt: now } } });
  const audits = await db.auditLog.count({ where: { timestamp: { lt: cutoff } } });
  console.log(JSON.stringify({ mode: process.env.CLEANUP_APPLY === 'true' ? 'apply' : 'dry-run', expiredSessions: expired, expiredAuditLogs: audits, retentionDays: days }));
  if (process.env.CLEANUP_APPLY === 'true') await db.$transaction(async tx => {
    await tx.authSession.deleteMany({ where: { expiresAt: { lt: now } } });
    await tx.auditLog.deleteMany({ where: { timestamp: { lt: cutoff } } });
    await tx.auditLog.create({ data: { action: 'system.retention.cleanup', resourceType: 'SystemSetting', resourceId: 'logs.retentionDays', metadata: { expiredSessions: expired, expiredAuditLogs: audits, retentionDays: days } } });
  });
} finally { await db.$disconnect(); }
