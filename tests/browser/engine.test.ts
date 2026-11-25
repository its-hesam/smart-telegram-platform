import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProfileVault } from '../../packages/automation-core/src/profile-vault.js';
import { PersistentBrowserManager } from '../../packages/automation-core/src/browser-manager.js';
import { StrictTelegramWebAdapter } from '../../packages/telegram-web-adapter/src/adapter.js';
import type { AccountLease } from '../../packages/automation-core/src/index.js';
const root = await mkdtemp(join(tmpdir(), 'smart-engine-'));
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<main><h1>Authorized test chat</h1><button aria-label="Session ready">Ready</button><input aria-label="Message"><button aria-label="Send" onclick="let p=document.createElement(\'p\');p.textContent=document.querySelector(\'input\').value;document.querySelector(\'[aria-label=Sent]\').append(p)">Send</button><div role="log" aria-label="Sent" style="min-height:20px"></div><span role="status" aria-label="User">user</span></main>'); });
let origin = '';
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); origin = `http://127.0.0.1:${address.port}`; });
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
const leaseFor = (id: string): AccountLease => ({ accountId: id, ownerId: 'fixture', fencingToken: 1n, assertOwned: async () => undefined, release: async () => undefined });
it('encrypts the entire profile, restores localStorage and IndexedDB, and isolates accounts', async () => {
  const id = randomUUID(); const vault = new ProfileVault(join(root, 'archives'), join(root, 'runtime'), randomBytes(32), false);
  const manager = new PersistentBrowserManager(vault, { headless: true, maxContexts: 2 });
  try {
    const result = await manager.open(id, leaseFor(id), new AbortController().signal); if (!result.ok) throw new Error(result.code);
    await result.value.page.goto(origin);
    // Fixture only: creates test browser storage, never inspects Telegram hidden state.
    await result.value.page.evaluate(async () => { localStorage.setItem('fixture', 'private-session'); await new Promise<void>((resolve, reject) => { const request = indexedDB.open('fixture', 1); request.onupgradeneeded = () => request.result.createObjectStore('test'); request.onsuccess = () => { const db = request.result; const tx = db.transaction('test', 'readwrite'); tx.objectStore('test').put('secret', 'key'); tx.oncomplete = () => { db.close(); resolve(); }; }; request.onerror = () => reject(request.error); }); });
    await manager.close(id);
    expect((await readFile(join(root, 'archives', `${id}.enc`))).includes(Buffer.from('private-session'))).toBe(false);
    const restored = await manager.open(id, leaseFor(id), new AbortController().signal); if (!restored.ok) throw new Error(restored.code);
    await restored.value.page.goto(origin);
    expect(await restored.value.page.evaluate(() => localStorage.getItem('fixture'))).toBe('private-session');
    const value = await restored.value.page.evaluate(() => new Promise(resolve => { const request = indexedDB.open('fixture', 1); request.onsuccess = () => { const db = request.result; const get = db.transaction('test').objectStore('test').get('key'); get.onsuccess = () => { resolve(get.result); db.close(); }; }; }));
    expect(value).toBe('secret');
    const otherId = randomUUID(); const other = await manager.open(otherId, leaseFor(otherId), new AbortController().signal); if (!other.ok) throw new Error(other.code);
    await other.value.page.goto(origin); expect(await other.value.page.evaluate(() => localStorage.getItem('fixture'))).toBeNull();
  } finally { await manager.shutdown(); }
}, 30000);
it('fails closed for missing/ambiguous selectors and only confirms a new visible outgoing message', async () => {
  const id = randomUUID(); const manager = new PersistentBrowserManager(new ProfileVault(join(root, 'adapter-archive'), join(root, 'adapter-runtime'), randomBytes(32), false), { headless: true, maxContexts: 1 });
  try {
    const opened = await manager.open(id, leaseFor(id), new AbortController().signal); if (!opened.ok) throw new Error(opened.code);
    const page = opened.value.page; await page.goto(origin);
    const registry = { version: 'fixture-only-v1', variant: 'k' as const, locale: 'en', selectors: { sessionReady: { role: 'button', accessibleName: 'Session ready' }, chatTitle: { role: 'heading', accessibleName: 'Authorized test chat' }, userMarker: { role: 'status', accessibleName: 'User' }, composer: { role: 'textbox', accessibleName: 'Message' }, send: { role: 'button', accessibleName: 'Send' }, outgoing: { role: 'log', accessibleName: 'Sent' } } };
    const adapter = new StrictTelegramWebAdapter(page, registry, origin, true);
    expect(await adapter.checkSession()).toEqual({ ok: true, value: 'CONNECTED' });
    let checked = false;
    expect(await adapter.sendApprovedMessage({ recipientReference: 'Authorized test chat', content: 'Consented fixture message', idempotencyKey: 'fixture', beforeMutation: async () => { checked = true; } }, new AbortController().signal)).toEqual({ ok: true, value: 'SENT_UI_CONFIRMED' });
    expect(checked).toBe(true);
    expect(await new StrictTelegramWebAdapter(page, { ...registry, selectors: {} }, origin).checkSession()).toEqual({ ok: false, code: 'OPERATION_UNSUPPORTED' });
    await page.getByRole('button', { name: 'Session ready', exact: true }).evaluate(el => el.after(el.cloneNode(true)));
    expect(await adapter.checkSession()).toEqual({ ok: false, code: 'UI_ELEMENT_NOT_FOUND' });
  } finally { await manager.shutdown(); }
}, 30000);
it('rejects stale runtime directories and unauthenticated/tampered archives', async () => {
  const id = randomUUID(); const vault = new ProfileVault(join(root, 'tamper-archive'), join(root, 'tamper-runtime'), randomBytes(32), false);
  const path = await vault.prepare(id); await writeFile(join(path, 'test'), 'secret');
  await expect(vault.prepare(id)).rejects.toThrow();
  await vault.seal(id, path);
  const archive = join(root, 'tamper-archive', `${id}.enc`); const bytes = await readFile(archive); bytes[40] = bytes[40]! ^ 1; await writeFile(archive, bytes);
  await expect(vault.prepare(id)).rejects.toThrow();
  await expect(vault.prepare('../escape')).rejects.toThrow();
});
it('detects an unexpected context shutdown and refuses automatic profile takeover', async () => {
  const id = randomUUID(); const vault = new ProfileVault(join(root, 'crash-archive'), join(root, 'crash-runtime'), randomBytes(32), false);
  const manager = new PersistentBrowserManager(vault, { headless: true, maxContexts: 1 }); let releases = 0;
  const lease = { ...leaseFor(id), release: async () => { releases++; } };
  const opened = await manager.open(id, lease, new AbortController().signal); if (!opened.ok) throw new Error(opened.code);
  await opened.value.page.goto(origin); await opened.value.page.context().close();
  expect((await manager.health(id)).connected).toBe(false); await expect(manager.close(id)).rejects.toThrow('BROWSER_CRASH'); expect(releases).toBe(0);
  const other = new PersistentBrowserManager(vault, { headless: true, maxContexts: 1 }); await expect(other.open(id, lease, new AbortController().signal)).rejects.toThrow();
}, 15000);
