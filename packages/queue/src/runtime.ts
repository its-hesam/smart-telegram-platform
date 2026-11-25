import type { PrismaClient } from '../../database/src/index.js';
import { FieldCipher } from '../../shared/src/crypto.js';
import { canContact, type Outcome } from '../../shared/src/index.js';
import { renderMessage } from '../../shared/src/template.js';
export interface QueueWriter { add(name: string, data: { version: number; jobId: string; traceId: string }, options: { jobId: string; delay: number; attempts: number; removeOnComplete: number; removeOnFail: number }): Promise<unknown>; }
export async function dispatchOutbox(db: PrismaClient, queue: QueueWriter, batchSize = 500) {
  const events = await db.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { createdAt: 'asc' }, take: batchSize, include: { job: true } });
  for (const event of events) {
    if (event.job.status === 'PENDING') await queue.add(event.job.type, { version: 1, jobId: event.jobId, traceId: event.job.traceId }, { jobId: event.id, delay: Math.max(0, (event.job.scheduledAt?.getTime() ?? 0) - Date.now()), attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 });
    await db.outboxEvent.updateMany({ where: { id: event.id, publishedAt: null }, data: { publishedAt: new Date() } });
  }
  return events.length;
}
export async function recoverOrphanedJobs(db: PrismaClient) {
  const activeWorkers = (await db.workerHeartbeat.findMany({ where: { expiresAt: { gt: new Date() } } })).map(w => w.id);
  const rows = await db.job.findMany({ where: { status: 'RUNNING', OR: [{ workerId: null }, { workerId: { notIn: activeWorkers } }] }, take: 100 });
  for (const job of rows) {
    // Read-only exports are safe to resume from their durable checkpoint.
    if (job.type === 'DATA_EXPORT') {
      await db.job.updateMany({ where: { id: job.id, status: 'RUNNING', workerId: job.workerId }, data: { status: 'PENDING', workerId: null, startedAt: null, finishedAt: null, errorCode: 'RESUMED' } });
      continue;
    }
    await db.$transaction(async tx => {
      const changed = await tx.job.updateMany({ where: { id: job.id, status: 'RUNNING', workerId: job.workerId }, data: { status: 'UNKNOWN', errorCode: 'UNKNOWN_RESULT', finishedAt: new Date() } });
      if (changed.count && job.payloadReference && job.type === 'APPROVED_MESSAGE_SEND') await tx.campaignRecipient.updateMany({ where: { id: job.payloadReference, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'UNKNOWN', errorCode: 'UNKNOWN_RESULT' } });
      if (changed.count && job.campaignId) await tx.campaign.updateMany({ where: { id: job.campaignId, status: { in: ['RUNNING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
    });
  }
}
export async function reconcilePendingJobs(db: PrismaClient): Promise<number> {
  // Redis is disposable transport. Only durable PENDING operations may be republished;
  // PROCESSING/RUNNING/UNKNOWN must never be returned to the send queue.
  return db.$transaction(async tx => {
    const cutoff = new Date(Date.now() - 60000);
    const rows = await tx.job.findMany({ where: { status: 'PENDING', type: { in: ['APPROVED_MESSAGE_SEND', 'SESSION_VALIDATION', 'DATA_EXPORT'] }, cancellationRequestedAt: null, OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }], events: { none: { OR: [{ publishedAt: null }, { createdAt: { gt: cutoff } }] } } }, take: 100 });
    for (const row of rows) await tx.outboxEvent.create({ data: { jobId: row.id, type: 'job.pending_reconciled' } });
    return rows.length;
  }, { isolationLevel: 'Serializable' });
}
export interface MessageExecution {
  accountId: string;
  recipientReference: string;
  content: string;
  idempotencyKey: string;
  beforeMutation: () => Promise<void>;
}
export async function processMessageJob(db: PrismaClient, cipher: FieldCipher, jobId: string, workerId: string, execute: (input: MessageExecution) => Promise<Outcome<'SENT_UI_CONFIRMED'>>) {
  const claimed = await db.job.updateMany({ where: { id: jobId, type: 'APPROVED_MESSAGE_SEND', status: 'PENDING', cancellationRequestedAt: null, OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }] }, data: { status: 'RUNNING', workerId, startedAt: new Date(), attemptCount: { increment: 1 } } });
  if (!claimed.count) return;
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.payloadReference || !job.campaignId || !job.accountId) { await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorCode: 'INVALID_JOB', finishedAt: new Date() } }); return; }
  let attempted = false;
  try {
    const recipient = await db.campaignRecipient.findUniqueOrThrow({ where: { id: job.payloadReference }, include: { campaign: { include: { template: true } }, contact: true } });
    if (recipient.status !== 'PENDING') { await db.job.update({ where: { id: jobId }, data: { status: recipient.status === 'UNKNOWN' ? 'UNKNOWN' : 'CANCELLED', finishedAt: new Date() } }); return; }
    if (recipient.campaign.status === 'SCHEDULED' && recipient.campaign.scheduledAt && recipient.campaign.scheduledAt <= new Date()) await db.campaign.updateMany({ where: { id: recipient.campaignId, status: 'SCHEDULED' }, data: { status: 'RUNNING' } });
    const check = async (markAttempt: boolean) => {
      await db.$transaction(async tx => {
        const current = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        const row = await tx.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id }, include: { campaign: true, contact: { include: { identities: true } }, account: true } });
        if (current.cancellationRequestedAt || current.status !== 'RUNNING' || row.campaign.status === 'CANCELLED') throw new Error('CANCELLED');
        if (row.campaign.status !== 'RUNNING' || row.account.status !== 'CONNECTED') throw new Error('PAUSED');
        const contact = row.contact;
        if (!contact) throw new Error('CONTACT_REMOVED');
        const keys = [contact.identityKey, ...contact.identities.map(i => i.key)];
        const suppressed = await tx.suppression.count({ where: { identityKey: { in: keys } } });
        if (suppressed) throw new Error('SUPPRESSED');
        const authorization = await tx.outreachAuthorization.findFirst({ where: { revokedAt: null }, select: { id: true } });
        if (!canContact({ status: contact.consentStatus, timestamp: contact.consentTimestamp, evidence: contact.consentEvidenceReference, suppressed: false }, Boolean(authorization))) throw new Error('AUTHORIZATION_MISSING');
        if (row.status !== 'PENDING') throw new Error('DUPLICATE_OPERATION');
        if (markAttempt) await tx.campaignRecipient.update({ where: { id: row.id }, data: { status: 'PROCESSING', attemptedAt: new Date() } });
      }, { isolationLevel: 'Serializable' });
    };
    await check(false);
    const contact = recipient.contact!;
    if (!contact.encryptedUsername) throw new Error('OPERATION_UNSUPPORTED');
    const reference = cipher.decrypt(contact.encryptedUsername, `contact:${contact.id}:username`);
    const content = renderMessage(cipher.decrypt(recipient.campaign.template.content, `template:${recipient.campaign.template.id}`), cipher.decrypt(contact.encryptedDisplayName, `contact:${contact.id}:displayName`));
    const outcome = await execute({ accountId: job.accountId, recipientReference: reference, content, idempotencyKey: recipient.idempotencyKey,
      beforeMutation: async () => { await check(true); attempted = true; } });
    const status = outcome.ok ? 'SENT_UI_CONFIRMED' : attempted ? 'UNKNOWN' : 'FAILED';
    // No adapter may report a sent message without executing the durable pre-mutation check.
    if (outcome.ok && !attempted) throw new Error('INVALID_EXECUTOR_RESULT');
    await db.$transaction(async tx => {
      await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { status, confirmedAt: status === 'SENT_UI_CONFIRMED' ? new Date() : null, errorCode: outcome.ok ? null : outcome.code } });
      await tx.job.update({ where: { id: jobId }, data: { status: status === 'SENT_UI_CONFIRMED' ? 'COMPLETED' : status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', finishedAt: new Date(), errorCode: outcome.ok ? null : outcome.code } });
      if (status === 'UNKNOWN' || (!outcome.ok && ['RATE_LIMITED', 'ACCOUNT_RESTRICTED', 'AUTH_REQUIRED', 'SESSION_EXPIRED', 'OPERATION_UNSUPPORTED', 'UI_ELEMENT_NOT_FOUND', 'AUTHORIZATION_MISSING', 'SUPPRESSED'].includes(outcome.code))) {
        await tx.campaign.updateMany({ where: { id: recipient.campaignId, status: { in: ['RUNNING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
        if (!outcome.ok && ['RATE_LIMITED', 'ACCOUNT_RESTRICTED'].includes(outcome.code)) await tx.telegramAccount.update({ where: { id: job.accountId! }, data: { status: outcome.code === 'ACCOUNT_RESTRICTED' ? 'RESTRICTED' : 'PAUSED', lastErrorCode: outcome.code } });
        if (!outcome.ok && ['RATE_LIMITED', 'ACCOUNT_RESTRICTED'].includes(outcome.code)) await tx.accountRestriction.create({ data: { accountId: job.accountId!, restrictionType: outcome.code, description: 'Visible UI restriction detected; operations paused for manual review' } });
        if (!outcome.ok && ['AUTH_REQUIRED', 'SESSION_EXPIRED', 'OPERATION_UNSUPPORTED', 'UI_ELEMENT_NOT_FOUND'].includes(outcome.code)) await tx.telegramAccount.update({ where: { id: job.accountId! }, data: { status: outcome.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : outcome.code === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'ACTION_REQUIRED', lastErrorCode: outcome.code } });
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_RESULT';
    const known = ['CONTACT_REMOVED', 'SUPPRESSED', 'AUTHORIZATION_MISSING', 'CONSENT_MISSING', 'OPERATION_UNSUPPORTED', 'PAUSED', 'CANCELLED', 'DUPLICATE_OPERATION', 'INVALID_EXECUTOR_RESULT'];
    const code = known.includes(reason) ? reason : 'EXECUTION_FAILED';
    const paused = !attempted && (reason === 'PAUSED' || reason === 'AUTHORIZATION_MISSING'); const cancelled = !attempted && reason === 'CANCELLED';
    await db.$transaction(async tx => {
      await tx.job.update({ where: { id: jobId }, data: { status: attempted ? 'UNKNOWN' : paused ? 'PAUSED' : cancelled ? 'CANCELLED' : 'FAILED', finishedAt: new Date(), errorCode: attempted ? 'UNKNOWN_RESULT' : code } });
      if (!paused) await tx.campaignRecipient.updateMany({ where: { id: job.payloadReference!, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: attempted ? 'UNKNOWN' : cancelled ? 'CANCELLED' : 'SKIPPED', errorCode: attempted ? 'UNKNOWN_RESULT' : code } });
      if (attempted) await tx.campaign.updateMany({ where: { id: job.campaignId!, status: { in: ['RUNNING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
      if (paused) await tx.campaign.updateMany({ where: { id: job.campaignId!, status: { in: ['RUNNING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
    });
  }
  const pending = await db.campaignRecipient.count({ where: { campaignId: job.campaignId, status: { in: ['PENDING', 'PROCESSING'] } } });
  if (!pending) {
    const unknown = await db.campaignRecipient.count({ where: { campaignId: job.campaignId, status: 'UNKNOWN' } });
    const failed = await db.campaignRecipient.count({ where: { campaignId: job.campaignId, status: { in: ['FAILED', 'SKIPPED', 'CANCELLED'] } } });
    await db.campaign.updateMany({ where: { id: job.campaignId, status: { in: ['RUNNING', 'SCHEDULED'] } }, data: { status: unknown ? 'PAUSED' : failed ? 'PARTIALLY_COMPLETED' : 'COMPLETED' } });
  }
}
