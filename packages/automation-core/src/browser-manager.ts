import { chromium, type BrowserContext, type Page } from 'playwright';
import type { BrowserManager, AccountLease, BrowserHandle } from './index.js';
import { ProfileVault } from './profile-vault.js';
import type { Outcome } from '../../shared/src/index.js';
type Entry = { context: BrowserContext; page: Page; lease: AccountLease; runtime: string; closing: boolean; crashed: boolean; watch: NodeJS.Timeout; signal: AbortSignal; abort: () => void };
export class PersistentBrowserManager implements BrowserManager {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Set<string>();
  constructor(private readonly vault: ProfileVault, private readonly options: { headless: boolean; maxContexts: number }) {}
  async open(accountId: string, lease: AccountLease, signal: AbortSignal): Promise<Outcome<BrowserHandle>> {
    signal.throwIfAborted();
    if (lease.accountId !== accountId) throw new Error('Lease does not match profile');
    if (this.entries.has(accountId) || this.opening.has(accountId) || this.entries.size + this.opening.size >= this.options.maxContexts) return { ok: false, code: 'DUPLICATE_OPERATION' };
    this.opening.add(accountId);
    try {
      await lease.assertOwned();
      const runtime = await this.vault.prepare(accountId);
      let context: BrowserContext;
      try { context = await chromium.launchPersistentContext(runtime, { headless: this.options.headless, chromiumSandbox: process.env.NODE_ENV === 'production', acceptDownloads: false, timeout: 30000, viewport: { width: 1280, height: 850 } }); }
      catch (error) { await this.vault.seal(accountId, runtime); await lease.release(); throw error; }
      const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10000);
      const abort = () => { void this.close(accountId).catch(() => undefined); };
      const entry: Entry = { context, page, lease, runtime, closing: false, crashed: false, signal, abort, watch: setInterval(() => { void lease.assertOwned().catch(() => { entry.crashed = true; void context.close().catch(() => undefined); }); }, 5000) };
      entry.watch.unref(); this.entries.set(accountId, entry);
      context.on('close', () => { if (!entry.closing) entry.crashed = true; clearInterval(entry.watch); });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { await this.close(accountId); signal.throwIfAborted(); }
      return { ok: true, value: { accountId, lease, page } };
    } finally { this.opening.delete(accountId); }
  }
  async health(accountId: string) { const entry = this.entries.get(accountId); return { connected: Boolean(entry && !entry.crashed && !entry.page.isClosed()), lastCheckedAt: new Date() }; }
  async close(accountId: string): Promise<void> {
    const entry = this.entries.get(accountId); if (!entry) return;
    if (entry.closing) throw new Error('Browser close already in progress');
    entry.closing = true; clearInterval(entry.watch);
    entry.signal.removeEventListener('abort', entry.abort);
    await entry.context.close();
    // Never reuse a profile or release ownership after an unverified crash/lease loss.
    if (entry.crashed) { this.entries.delete(accountId); throw new Error('BROWSER_CRASH: manual profile recovery required'); }
    await entry.lease.assertOwned();
    await this.vault.seal(accountId, entry.runtime);
    await entry.lease.release(); this.entries.delete(accountId);
  }
  async shutdown() { const results = await Promise.allSettled([...this.entries.keys()].map(id => this.close(id))); if (results.some(r => r.status === 'rejected')) throw new Error('Some browser profiles require manual recovery'); }
}
