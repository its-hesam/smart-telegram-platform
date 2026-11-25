import './test-environment.js';
import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDatabase } from '../../packages/database/src/index.js';
import { apiConfigSchema } from '../../apps/api/src/config.js';
import { FieldCipher, hashPassword, hashToken } from '../../apps/api/src/crypto.js';
import { PlatformStore } from '../../apps/api/src/store.js';
import { AuthService } from '../../apps/api/src/auth.service.js';
import { createApp } from '../../apps/api/src/app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for real backend integration tests');
it('persists authenticated CRUD, encryption, audits, roles, expiry and revocation in real PostgreSQL', async () => {
  const config = apiConfigSchema.parse({ DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost', APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), IDENTITY_HMAC_KEY: randomBytes(32).toString('hex') });
  const db = createDatabase(config.DATABASE_URL);
  const password = 'integration-only-strong-password';
  const suffix = randomUUID();
  const admin = await db.adminUser.create({ data: { email: `admin-${suffix}@example.test`, passwordHash: await hashPassword(password), role: 'ADMIN' } });
  const viewer = await db.adminUser.create({ data: { email: `viewer-${suffix}@example.test`, passwordHash: await hashPassword(password), role: 'VIEWER' } });
  const store = new PlatformStore(db, new FieldCipher(config.DATA_ENCRYPTION_KEY, config.IDENTITY_HMAC_KEY));
  // Redis transport/limiter is tested independently; this test isolates real DB + HTTP.
  const app = await createApp({ config, store, auth: await AuthService.create(store, config), limiter: { consume: async () => true } });
  let accountId: string | undefined;
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const login = async (email: string) => {
      const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrfToken as string };
    };
    const a = await login(admin.email); const v = await login(viewer.email);
    const headers = { origin: config.APP_ORIGIN, 'content-type': 'application/json', cookie: a.cookie, 'x-csrf-token': a.csrf };
    const input = { displayName: `اکانت آزمایشی ${suffix}`, phone: `+98${String(Date.now()).slice(-10)}`, ownershipConfirmed: true };
    const response = await fetch(`${base}/v1/accounts`, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(201); const account = await response.json(); accountId = account.id;
    expect(account.phone).toBe(input.phone); expect(account.status).toBe('DISCONNECTED');
    expect(account.displayName).toBe(input.displayName);
    const restoredStore = new PlatformStore(db, new FieldCipher(config.DATA_ENCRYPTION_KEY, config.IDENTITY_HMAC_KEY));
    expect((await restoredStore.authenticate(a.cookie.split('=')[1]!))?.id).toBe(admin.id);
    const stored = await db.telegramAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.encryptedPhone).not.toContain(input.phone);
    expect(account).not.toHaveProperty('identityKey'); expect(account).not.toHaveProperty('encryptedPhone');
    const noActor = { id: randomUUID(), email: 'absent@example.test', role: 'ADMIN' as const };
    await expect(store.createAccount(noActor, { displayName: 'Rollback', phone: '+989990000001' })).rejects.toMatchObject({ code: 'P2003' });
    expect(await db.telegramAccount.count({ where: { displayName: 'Rollback' } })).toBe(0);
    expect((await fetch(`${base}/v1/accounts`, { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(409);
    const limited = await fetch(`${base}/v1/accounts/${account.id}`, { headers: { cookie: v.cookie } });
    expect(limited.status).toBe(200); expect(await limited.json()).not.toHaveProperty('phone');
    expect((await fetch(`${base}/v1/accounts/${account.id}`, { method: 'PATCH', headers: { ...headers, cookie: v.cookie, 'x-csrf-token': v.csrf }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);
    const patched = await fetch(`${base}/v1/accounts/${account.id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false, displayName: 'Updated' }) });
    expect(patched.status).toBe(200); expect((await patched.json()).status).toBe('PAUSED');
    const list = await fetch(`${base}/v1/accounts?pageSize=1&status=PAUSED&sort=displayName&order=asc`, { headers });
    expect(list.status).toBe(200); expect((await list.json()).data).toHaveLength(1);
    await db.telegramAccount.update({ where: { id: account.id }, data: { status: 'CONNECTED' } });
    expect((await fetch(`${base}/v1/accounts/${account.id}`, { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status).toBe(409);
    expect((await fetch(`${base}/v1/accounts/${account.id}`, { method: 'DELETE', headers })).status).toBe(409);
    await db.telegramAccount.update({ where: { id: account.id }, data: { status: 'PAUSED' } });
    expect((await fetch(`${base}/v1/accounts/${randomUUID()}`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/v1/accounts/bad-id`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/v1/accounts/${account.id}`, { method: 'DELETE', headers })).status).toBe(204);
    expect(await db.telegramAccount.findUnique({ where: { id: account.id } })).toBeNull();
    const audit = await db.auditLog.findMany({ where: { resourceId: account.id } });
    expect(audit.map(row => row.action).sort()).toEqual(['account.create', 'account.delete', 'account.update']);
    expect(JSON.stringify(audit)).not.toContain(input.phone);
    const tokenHash = hashToken(a.cookie.split('=')[1]!);
    expect(await db.authSession.findUnique({ where: { tokenHash } })).not.toBeNull();
    await db.authSession.update({ where: { tokenHash }, data: { expiresAt: new Date(0) } });
    expect((await fetch(`${base}/v1/auth/me`, { headers })).status).toBe(401);
    const fresh = await login(admin.email);
    expect((await fetch(`${base}/v1/auth/logout`, { method: 'POST', headers: { ...headers, cookie: fresh.cookie, 'x-csrf-token': fresh.csrf } })).status).toBe(204);
    expect((await fetch(`${base}/v1/auth/me`, { headers: { cookie: fresh.cookie } })).status).toBe(401);
  } finally {
    await app.close();
    if (accountId) { await db.auditLog.deleteMany({ where: { resourceId: accountId } }); await db.telegramAccount.deleteMany({ where: { id: accountId } }); }
    await db.auditLog.deleteMany({ where: { actorId: { in: [admin.id, viewer.id] } } });
    await db.adminUser.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await db.$disconnect();
  }
}, 30000);
