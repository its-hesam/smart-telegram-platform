import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { environmentSchema, jobReferenceSchema } from '../../../packages/validation/src/index.js';
import { createDatabase } from '../../../packages/database/src/index.js';
import { FieldCipher } from '../../../packages/shared/src/crypto.js';
import { dispatchOutbox, processMessageJob, recoverOrphanedJobs, reconcilePendingJobs } from '../../../packages/queue/src/runtime.js';
import { ProfileVault } from '../../../packages/automation-core/src/profile-vault.js';
import { PersistentBrowserManager } from '../../../packages/automation-core/src/browser-manager.js';
import { acquireLease } from '../../../packages/automation-core/src/lease.js';
import { StrictTelegramWebAdapter } from '../../../packages/telegram-web-adapter/src/adapter.js';
import { publicEnglishK } from '../../../packages/telegram-web-adapter/src/registries.js';
import { TelegramLoginService, startLoginBridge } from './telegram-login.js';
import { processAccountSources } from './account-sources.js';
import { processContactsExport } from './contacts-export.js';
const key = z.string().regex(/^[a-fA-F0-9]{64}$/);
const config = environmentSchema.extend({ DATA_ENCRYPTION_KEY: key, IDENTITY_HMAC_KEY: key, PROFILE_ENCRYPTION_KEY: key, PROFILE_ARCHIVE_ROOT: z.string().min(1), PROFILE_RUNTIME_ROOT: z.string().min(1), NODE_ENV: z.enum(['development', 'production', 'test']).default('development'), TELEGRAM_MUTATIONS_ENABLED: z.enum(['true', 'false']).default('false'), SELECTOR_REGISTRY_PATH: z.string().optional(), ACTION_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(30000) }).refine(value => new Set([value.DATA_ENCRYPTION_KEY.toLowerCase(), value.IDENTITY_HMAC_KEY.toLowerCase(), value.PROFILE_ENCRYPTION_KEY.toLowerCase()]).size === 3, { message: 'Use three independent encryption/HMAC keys' }).safeParse(process.env);
if (!config.success) { console.error('Invalid worker configuration; check .env.example'); process.exit(1); }
const env = config.data; process.umask(0o077);
const logger = pino({ level: env.LOG_LEVEL }); const ownerId = randomUUID(); const db = createDatabase(env.DATABASE_URL);
const cipher = new FieldCipher(env.DATA_ENCRYPTION_KEY, env.IDENTITY_HMAC_KEY);
const manager = new PersistentBrowserManager(new ProfileVault(env.PROFILE_ARCHIVE_ROOT, env.PROFILE_RUNTIME_ROOT, Buffer.from(env.PROFILE_ENCRYPTION_KEY, 'hex'), env.NODE_ENV === 'production'), { headless: true, maxContexts: 1 });
let registry = publicEnglishK;
if (env.SELECTOR_REGISTRY_PATH) {
  registry = z.object({ version: z.string().min(1), variant: z.enum(['a', 'k']), locale: z.string(), verifiedAt: z.iso.datetime(), evidenceReference: z.string().min(1), selectors: z.record(z.string(), z.object({ role: z.string(), accessibleName: z.string() })) }).parse(JSON.parse(await readFile(env.SELECTOR_REGISTRY_PATH, 'utf8')));
}
if (env.TELEGRAM_MUTATIONS_ENABLED === 'true' && !env.SELECTOR_REGISTRY_PATH) throw new Error('Verified registry required before enabling mutations');
const url = new URL(env.REDIS_URL);
const connection = { host: url.hostname, port: Number(url.port || 6379), ...(url.username ? { username: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === 'rediss:' ? { tls: {} } : {}), db: Number(url.pathname.slice(1) || 0) };
const redis = new Redis({ ...connection, maxRetriesPerRequest: 0 }); redis.on('error', () => undefined);
const queue = new Queue('telegram-operations-v1', { connection });
const deadLetters = new Queue('telegram-dead-letters-v1', { connection });
const heartbeat = async () => db.workerHeartbeat.upsert({ where: { id: ownerId }, create: { id: ownerId, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 60000) }, update: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 60000) } });
await heartbeat();
const stop = new AbortController();
const loginService = new TelegramLoginService(db, manager, cipher, ownerId, stop.signal);
const closeLoginBridge = await startLoginBridge(loginService, env.DATA_ENCRYPTION_KEY, 3002, async () => { await db.$queryRaw`SELECT 1`; return true; });
const worker = new Worker('telegram-operations-v1', async queued => {
  const reference = jobReferenceSchema.parse(queued.data);
  const job = await db.job.findUnique({ where: { id: reference.jobId } }); if (!job || job.status !== 'PENDING') return;
  if (job.scheduledAt && job.scheduledAt > new Date()) { await db.outboxEvent.create({ data: { jobId: job.id, type: 'job.not_due' } }); return; }
  if (!job.accountId && job.type !== 'DATA_EXPORT') { await db.job.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: 'OPERATION_UNSUPPORTED', finishedAt: new Date() } }); return; }
  if (job.type === 'APPROVED_MESSAGE_SEND') {
    // Conservative local deployment capacity, never advertised as a Telegram rate limit.
    const reserved = await redis.set('worker:global:action-slot', ownerId, 'PX', env.ACTION_INTERVAL_MS, 'NX');
    if (!reserved) { await db.$transaction(async tx => { const changed = await tx.job.updateMany({ where: { id: job.id, status: 'PENDING' }, data: { scheduledAt: new Date(Date.now() + env.ACTION_INTERVAL_MS) } }); if (changed.count) await tx.outboxEvent.create({ data: { jobId: job.id, type: 'job.capacity_deferred' } }); }); return; }
    await processMessageJob(db, cipher, job.id, ownerId, async input => {
      if (env.TELEGRAM_MUTATIONS_ENABLED !== 'true') return { ok: false, code: 'OPERATION_UNSUPPORTED' };
      const lease = await acquireLease(db, input.accountId, ownerId);
      try {
        const opened = await manager.open(input.accountId, lease, stop.signal); if (!opened.ok) { await lease.release(); return opened; }
        await opened.value.page.goto(`https://web.telegram.org/${registry.variant}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const adapter = new StrictTelegramWebAdapter(opened.value.page, registry, 'https://web.telegram.org', true);
        const session = await adapter.checkSession(); if (!session.ok) return session;
        const chat = await adapter.openChat(input.recipientReference, stop.signal); if (!chat.ok) return chat;
        return await adapter.sendApprovedMessage({ ...input, beforeMutation: async () => { stop.signal.throwIfAborted(); await lease.assertOwned(); await input.beforeMutation(); } }, stop.signal);
      } finally { await manager.close(input.accountId); }
    });
  } else if (job.type === 'GROUP_INFORMATION_READ' && (job.payloadReference === 'account-sources:v1' || job.payloadReference?.startsWith('source-members:v1:'))) {
    await processAccountSources(db, cipher, manager, job.id, ownerId, stop.signal);
  } else if (job.type === 'DATA_EXPORT') {
    await processContactsExport(db, cipher, job.id, ownerId, stop.signal, env.EXPORT_ROOT, env.EXPORT_BATCH_SIZE);
  } else if (job.type === 'SESSION_VALIDATION') {
    if (!job.accountId) { await db.job.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: 'OPERATION_UNSUPPORTED', finishedAt: new Date() } }); return; }
    const claim = await db.job.updateMany({ where: { id: job.id, status: 'PENDING', cancellationRequestedAt: null }, data: { status: 'RUNNING', workerId: ownerId, startedAt: new Date() } }); if (!claim.count) return;
    try {
      const account = await db.telegramAccount.findUniqueOrThrow({ where: { id: job.accountId } }); if (['PAUSED', 'RESTRICTED'].includes(account.status)) throw new Error('Account unavailable');
      const lease = await acquireLease(db, job.accountId, ownerId);
      try {
        const opened = await manager.open(job.accountId, lease, stop.signal); if (!opened.ok) { await lease.release(); throw new Error('Browser capacity unavailable'); }
        await opened.value.page.goto(`https://web.telegram.org/${registry.variant}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const result = await new StrictTelegramWebAdapter(opened.value.page, registry).checkSession();
        await manager.close(job.accountId);
        await db.$transaction(async tx => {
          await tx.telegramAccount.update({ where: { id: job.accountId! }, data: { status: result.ok ? 'CONNECTED' : result.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'ACTION_REQUIRED', lastErrorCode: result.ok ? null : result.code, lastActiveAt: result.ok ? new Date() : null } });
          const sessionStatus = result.ok ? 'CONNECTED' : result.code === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'ACTION_REQUIRED';
          await tx.accountSession.upsert({ where: { profileReference: job.accountId! }, create: { accountId: job.accountId!, profileReference: job.accountId!, encryptionKeyVersion: 1, status: sessionStatus, lastValidatedAt: new Date() }, update: { status: sessionStatus, lastValidatedAt: new Date() } });
          await tx.job.update({ where: { id: job.id }, data: { status: result.ok ? 'COMPLETED' : 'FAILED', errorCode: result.ok ? null : result.code, finishedAt: new Date() } });
        });
      } finally { await manager.close(job.accountId); }
    } catch { await db.job.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: 'SESSION_VALIDATION_FAILED', finishedAt: new Date() } }); }
  } else await db.job.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: 'OPERATION_UNSUPPORTED', finishedAt: new Date() } });
}, { connection, concurrency: 1, maxStalledCount: 0 });
worker.on('error', () => logger.error({ code: 'QUEUE_UNAVAILABLE' }, 'Worker queue error'));
worker.on('failed', queued => {
  const parsed = jobReferenceSchema.safeParse(queued?.data); if (!parsed.success) return;
  const reference = parsed.data;
  void (async () => {
    const durable = await db.job.findUnique({ where: { id: reference.jobId } });
    if (durable?.status === 'RUNNING' && durable.type === 'DATA_EXPORT') {
      await db.job.updateMany({ where: { id: durable.id, status: 'RUNNING' }, data: { status: 'PENDING', workerId: null, startedAt: null, finishedAt: null, errorCode: 'RESUMED' } });
    } else if (durable?.status === 'RUNNING') await db.$transaction(async tx => {
      await tx.job.updateMany({ where: { id: durable.id, status: 'RUNNING' }, data: { status: 'UNKNOWN', errorCode: 'UNKNOWN_RESULT', finishedAt: new Date() } });
      if (durable.payloadReference && durable.type === 'APPROVED_MESSAGE_SEND') await tx.campaignRecipient.updateMany({ where: { id: durable.payloadReference, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'UNKNOWN', errorCode: 'UNKNOWN_RESULT' } });
      if (durable.campaignId) await tx.campaign.updateMany({ where: { id: durable.campaignId, status: { in: ['RUNNING', 'SCHEDULED'] } }, data: { status: 'PAUSED' } });
    });
    await deadLetters.add('manual-review', reference, { jobId: queued!.id!, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 });
    logger.warn({ jobId: reference.jobId, traceId: reference.traceId, code: 'JOB_EXECUTION_FAILED' }, 'Job requires manual inspection; not replayed');
  })().catch(() => logger.error({ code: 'RECOVERY_WRITE_FAILED' }, 'Failed job reconciliation unavailable'));
});
let dispatching = false;
const dispatchTick = async () => {
  if (dispatching || stop.signal.aborted) return;
  dispatching = true;
  try { await heartbeat(); await dispatchOutbox(db, queue, env.WORKER_DISPATCH_BATCH); }
  catch { logger.error({ code: 'INFRASTRUCTURE_UNAVAILABLE' }, 'Dispatch/heartbeat unavailable'); }
  finally { dispatching = false; }
};
let maintaining = false;
const maintain = async () => {
  if (maintaining || stop.signal.aborted) return;
  maintaining = true;
  try { await recoverOrphanedJobs(db); await reconcilePendingJobs(db); }
  catch { logger.error({ code: 'INFRASTRUCTURE_UNAVAILABLE' }, 'Recovery/reconcile unavailable'); }
  finally { maintaining = false; }
};
const dispatchTimer = setInterval(() => { void dispatchTick(); }, 2000);
const maintenanceTimer = setInterval(() => { void maintain(); }, env.WORKER_MAINTENANCE_MS);
await dispatchTick(); await maintain();
logger.info({ workerId: ownerId, mutationsEnabled: env.TELEGRAM_MUTATIONS_ENABLED === 'true', registryVersion: registry.version }, 'Automation worker ready');
await new Promise<void>(resolve => { for (const event of ['SIGTERM', 'SIGINT'] as const) process.once(event, () => { stop.abort(); resolve(); }); });
clearInterval(dispatchTimer); clearInterval(maintenanceTimer); await closeLoginBridge(); await worker.close(); await manager.shutdown().catch(() => logger.error({ code: 'PROFILE_RECOVERY_REQUIRED' }, 'Manual profile recovery required')); await queue.close(); await deadLetters.close(); redis.disconnect(); await db.workerHeartbeat.update({ where: { id: ownerId }, data: { expiresAt: new Date(0) } }); await db.$disconnect();
