import type { Outcome } from '../../shared/src/index.js';
import type { Page } from 'playwright';

export interface AccountLease {
  accountId: string;
  ownerId: string;
  fencingToken: bigint;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export interface BrowserHandle { accountId: string; lease: AccountLease; page: Page; }
export interface BrowserHealth { connected: boolean; lastCheckedAt: Date; }
export interface BrowserManager {
  open(accountId: string, lease: AccountLease, signal: AbortSignal): Promise<Outcome<BrowserHandle>>;
  health(accountId: string): Promise<BrowserHealth>;
  close(accountId: string): Promise<void>;
  shutdown(): Promise<void>;
}
