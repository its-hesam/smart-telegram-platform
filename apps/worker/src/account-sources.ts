import { z } from 'zod';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import type { PersistentBrowserManager } from '../../../packages/automation-core/src/browser-manager.js';
import { acquireLease } from '../../../packages/automation-core/src/lease.js';
import { FieldCipher } from '../../../packages/shared/src/crypto.js';
import { catalogSchema, memberResultSchema, parseSourceReference, type AccountSource } from '../../../packages/shared/src/account-sources.js';
import { AccountSourcesUi, SourceUiError } from '../../../packages/telegram-web-adapter/src/account-sources.js';
import { saveMemberContacts } from '../../../packages/shared/src/member-contacts.js';
export async function processAccountSources(db: PrismaClient, cipher: FieldCipher, manager: PersistentBrowserManager, jobId: string, ownerId: string, signal: AbortSignal) {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  const claim = await db.job.updateMany({ where: { id: jobId, status: 'PENDING', cancellationRequestedAt: null }, data: { status: 'RUNNING', workerId: ownerId, startedAt: new Date() } }); if (!claim.count) return;
  await db.job.update({ where: { id: jobId }, data: { progress: 2, processed: 0, errorCode: null } });
  let opened = false; let closed = false;
  try {
    if (!job.accountId) throw new SourceUiError('SOURCE_ACCOUNT_NOT_CONNECTED');
    const account = await db.telegramAccount.findUniqueOrThrow({ where: { id: job.accountId } });
    if (account.status !== 'CONNECTED') throw new SourceUiError('SOURCE_ACCOUNT_NOT_CONNECTED');
    const lease = await acquireLease(db, account.id, ownerId);
    const result = await manager.open(account.id, lease, new AbortController().signal);
    if (!result.ok) { await lease.release(); throw new SourceUiError('SOURCE_BROWSER_BUSY'); }
    opened = true;
    const check = async () => { signal.throwIfAborted(); await lease.assertOwned(); const current = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { cancellationRequestedAt: true } }); if (current.cancellationRequestedAt) throw new SourceUiError('SOURCE_CANCELLED'); };
    await result.value.page.goto('https://web.telegram.org/k/?a11y=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await result.value.page.locator('#column-left').waitFor({ state: 'visible', timeout: 20000 });
    const ui = new AccountSourcesUi(result.value.page);
    let data: unknown;
    if (job.payloadReference === 'account-sources:v1') {
      const { refs, partial } = await ui.references(check); const sources: AccountSource[] = []; let skipped = 0; const deadline = Date.now() + 240000;
      const reasons = new Map<string, number>();
      if (partial) reasons.set('SOURCE_SCAN_LIMIT', 1);
      await db.job.update({ where: { id: jobId }, data: { totalItems: refs.length, progress: 5 } });
      let inspected = 0;
      for (const ref of refs) {
        await check(); if (Date.now() > deadline) { const remaining = refs.length - sources.length - skipped; skipped += remaining; reasons.set('SOURCE_SCAN_LIMIT', remaining); break; }
        try {
          const type = await ui.open(ref.peer, check);
          sources.push({ ...ref, type, adminVerified: false, key: cipher.identity(`account-source:${account.id}:${ref.peer}`) });
        } catch (error) { await check(); const code = error instanceof SourceUiError ? error.code : 'SOURCE_OPEN_FAILED'; skipped++; reasons.set(code, (reasons.get(code) ?? 0) + 1); }
        inspected++;
        if (inspected % 5 === 0 || inspected === refs.length) await db.job.update({ where: { id: jobId }, data: { processed: inspected, progress: Math.min(45, 5 + Math.floor((inspected / Math.max(1, refs.length)) * 40)) } });
      }
      data = catalogSchema.parse({ sources, partial: partial || skipped > 0, skipped, diagnostics: [...reasons].map(([code, count]) => ({ code, count })), scannedAt: new Date().toISOString() });
    } else {
      const targetId = /^source-members:v1:([a-f0-9-]{36})$/.exec(job.payloadReference ?? '')?.[1]; if (!targetId) throw new SourceUiError('SOURCE_UI_UNSUPPORTED');
      const target = await db.telegramTarget.findUniqueOrThrow({ where: { id: targetId } });
      const ref = parseSourceReference(cipher.decrypt(target.reference, `target:${target.id}:reference`));
      if (!ref || ref.accountId !== account.id) throw new SourceUiError('SOURCE_SELECTION_INVALID');
      const audit = await db.auditLog.findFirst({ where: { resourceType: 'Job', resourceId: job.id, action: 'source.members.request' } });
      if (!audit || (audit.metadata as { authorizationConfirmed?: boolean } | null)?.authorizationConfirmed !== true) throw new SourceUiError('SOURCE_AUTHORIZATION_REQUIRED');
      const requested = z.object({ requestedLimit: z.number().int().min(0).max(1000000).default(0) }).parse(job.result ?? {}).requestedLimit;
      const limit = requested || 1000000;
      await db.job.update({ where: { id: jobId }, data: { totalItems: requested || null, progress: 45 } });
      data = memberResultSchema.parse(await ui.members(ref.peer, '', limit, check, async processed => {
        await db.job.update({ where: { id: jobId }, data: { processed, progress: requested ? Math.min(95, 45 + Math.floor((processed / limit) * 50)) : Math.min(95, 45 + Math.floor(processed / 10)) } });
      }));
    }
    await check(); await manager.close(account.id); closed = true;
    if (job.payloadReference?.startsWith('source-members:v1:')) { await saveMemberContacts(db, cipher, job.id, data); await db.job.update({ where: { id: job.id }, data: { progress: 100, processed: (data as { members: unknown[] }).members.length } }); }
    else await db.job.update({ where: { id: job.id }, data: { status: 'COMPLETED', progress: 100, result: { ciphertext: cipher.encrypt(JSON.stringify(data), `job:${job.id}:source-result`) }, finishedAt: new Date(), errorCode: null } });
  } catch (error) {
    let code = error instanceof SourceUiError ? error.code : signal.aborted ? 'SOURCE_CANCELLED' : 'SOURCE_UI_UNSUPPORTED';
    if (opened && !closed && job.accountId) { try { await manager.close(job.accountId); closed = true; } catch { code = 'PROFILE_RECOVERY_REQUIRED'; } }
    await db.job.update({ where: { id: job.id }, data: { status: code === 'SOURCE_CANCELLED' ? 'CANCELLED' : code === 'PROFILE_RECOVERY_REQUIRED' ? 'UNKNOWN' : 'FAILED', errorCode: code, finishedAt: new Date() } });
  }
}
