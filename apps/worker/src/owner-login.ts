import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { createDatabase } from '../../../packages/database/src/index.js';
import { ProfileVault } from '../../../packages/automation-core/src/profile-vault.js';
import { PersistentBrowserManager } from '../../../packages/automation-core/src/browser-manager.js';
import { acquireLease } from '../../../packages/automation-core/src/lease.js';

const config = z.object({ DATABASE_URL: z.url(), PROFILE_ARCHIVE_ROOT: z.string().min(1), PROFILE_RUNTIME_ROOT: z.string().min(1), PROFILE_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/), ACCOUNT_ID: z.uuid(), NODE_ENV: z.enum(['development', 'production', 'test']).default('development') }).safeParse(process.env);
if (!config.success) { console.error('Set DATABASE_URL, ACCOUNT_ID and PROFILE_* settings; see ACCOUNT_SESSIONS.md'); process.exit(1); }
const env = config.data; const db = createDatabase(env.DATABASE_URL);
process.umask(0o077);
const manager = new PersistentBrowserManager(new ProfileVault(env.PROFILE_ARCHIVE_ROOT, env.PROFILE_RUNTIME_ROOT, Buffer.from(env.PROFILE_ENCRYPTION_KEY, 'hex'), env.NODE_ENV === 'production'), { headless: false, maxContexts: 1 });
const readline = createInterface({ input: stdin, output: stdout });
try {
  const account = await db.telegramAccount.findUniqueOrThrow({ where: { id: env.ACCOUNT_ID } });
  if (['PAUSED', 'RESTRICTED'].includes(account.status)) throw new Error('Account is paused or restricted');
  const lease = await acquireLease(db, account.id, `owner-login-${randomUUID()}`);
  const result = await manager.open(account.id, lease, new AbortController().signal);
  if (!result.ok) throw new Error(result.code);
  await db.telegramAccount.update({ where: { id: account.id }, data: { status: 'AUTHENTICATING' } });
  await result.value.page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await readline.question('Complete login yourself in the Telegram browser. Do not close the window. Press Enter here to close and encrypt the profile. Credentials are never read by this program.\n');
  await manager.close(account.id);
  await db.$transaction(async tx => {
    await tx.accountSession.upsert({ where: { profileReference: account.id }, create: { accountId: account.id, profileReference: account.id, encryptionKeyVersion: 1, status: 'ACTION_REQUIRED' }, update: { status: 'ACTION_REQUIRED' } });
    await tx.telegramAccount.update({ where: { id: account.id }, data: { status: 'ACTION_REQUIRED' } });
  });
  console.log('Profile encrypted. Session remains ACTION_REQUIRED until a verified Telegram selector registry validates the visible UI.');
} catch { console.error('Login/profile operation failed. No connected-session claim was made. Inspect lease/runtime before recovery.'); process.exitCode = 1; }
finally { readline.close(); await manager.shutdown().catch(() => undefined); await db.$disconnect(); }
