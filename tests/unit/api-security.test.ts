import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FieldCipher, csrfFor, hashPassword, hashToken, opaqueToken, verifyPassword } from '../../apps/api/src/crypto.js';
import { apiConfigSchema } from '../../apps/api/src/config.js';
import { assertCsrf, assertOrigin, createApp } from '../../apps/api/src/app.js';
import { AuthService } from '../../apps/api/src/auth.service.js';
import { PlatformStore } from '../../apps/api/src/store.js';
import type { Principal } from '../../apps/api/src/contracts.js';
const config = apiConfigSchema.parse({ DATABASE_URL: 'postgresql://test:test@localhost/test', REDIS_URL: 'redis://localhost', APP_ORIGIN: 'http://localhost:3000', NODE_ENV: 'test', LOG_LEVEL: 'silent', DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), IDENTITY_HMAC_KEY: randomBytes(32).toString('hex') });
describe('cryptography and configuration', () => {
  it('authenticates encryption, randomizes nonce and binds account context', () => {
    const cipher = new FieldCipher(config.DATA_ENCRYPTION_KEY, config.IDENTITY_HMAC_KEY);
    const value = cipher.encrypt('+15550000001', 'account:1:phone');
    expect(value).not.toContain('98912');
    expect(cipher.decrypt(value, 'account:1:phone')).toBe('+15550000001');
    expect(cipher.encrypt('+15550000001', 'account:1:phone')).not.toBe(value);
    expect(() => cipher.decrypt(value, 'account:2:phone')).toThrow();
    const parts = value.split('.'); parts[2] = Buffer.alloc(16).toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'), 'account:1:phone')).toThrow();
    expect(cipher.identity('phone:+15550000001')).toBe(cipher.identity('phone:+15550000001'));
  });
  it('hashes passwords with Argon2id and verifies without plaintext storage', async () => {
    const hash = await hashPassword('strong test password');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'strong test password')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });
  it('rejects insecure production config and repeated keys', () => {
    expect(apiConfigSchema.safeParse({ ...config, NODE_ENV: 'production' }).success).toBe(false);
    expect(apiConfigSchema.safeParse({ ...config, IDENTITY_HMAC_KEY: config.DATA_ENCRYPTION_KEY }).success).toBe(false);
  });
  it('requires exact origin and session-bound csrf', () => {
    const token = opaqueToken();
    expect(() => assertOrigin(undefined, config.APP_ORIGIN)).toThrow();
    expect(() => assertOrigin('http://evil.test', config.APP_ORIGIN)).toThrow();
    expect(() => assertCsrf(token, csrfFor(opaqueToken()))).toThrow();
    expect(() => assertCsrf(token, csrfFor(token))).not.toThrow();
    expect(hashToken(token)).not.toBe(token);
  });
});

describe('HTTP guards and contracts (isolated repository fixture)', () => {
  const user: Principal = { id: '8b5a1099-2085-4308-89f7-a39797dd1f3b', email: 'admin@example.test', role: 'ADMIN' };
  const sessions = new Map<string, Principal>();
  let app: Awaited<ReturnType<typeof createApp>>;
  let base: string;
  let cookie = ''; let csrfToken = ''; let hash: string;
  const store = {
    findUser: vi.fn(async () => ({ ...user, passwordHash: hash })),
    createSession: vi.fn(async (actor: Principal, token: string) => { sessions.set(token, { ...actor }); }),
    authenticate: vi.fn(async (token: string) => sessions.get(token) ?? null),
    logout: vi.fn(async (_actor: Principal, token: string) => { sessions.delete(token); }),
    listAccounts: vi.fn(async () => ({ data: [], total: 0 })),
    createAccount: vi.fn(async () => ({ id: 'new', status: 'DISCONNECTED' })),
    getAccount: vi.fn(async () => ({ id: 'existing' })),
    validateSessionJob: vi.fn(async () => ({ jobId: 'fixture-job', status: 'PENDING' })),
  };
  let allow = true;
  beforeAll(async () => {
    hash = await hashPassword('strong test password');
    const repository = store as unknown as PlatformStore;
    app = await createApp({ config, store: repository, auth: await AuthService.create(repository, config), limiter: { consume: async () => allow } });
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => { await app.close(); });
  const headers = () => ({ origin: config.APP_ORIGIN, 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken });
  it('denies anonymous account requests', async () => {
    const response = await fetch(`${base}/v1/accounts`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'AUTH_REQUIRED', requestId: expect.any(String) });
  });
  it('rejects missing origin and wrong credentials', async () => {
    expect((await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: user.email, password: 'wrong' }) })).status).toBe(401);
  });
  it('creates HttpOnly cookie, returns csrf and never returns password hash', async () => {
    const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: user.email, password: 'strong test password' }) });
    expect(response.status).toBe(200);
    const rawCookie = response.headers.get('set-cookie')!;
    expect(rawCookie).toContain('HttpOnly'); expect(rawCookie).toContain('SameSite=Strict');
    cookie = rawCookie.split(';')[0]!;
    const body = await response.json(); csrfToken = body.csrfToken;
    expect(body.user).toEqual(user); expect(JSON.stringify(body)).not.toContain('$argon2');
    expect((await fetch(`${base}/v1/auth/me`, { headers: { cookie } })).status).toBe(200);
  });
  it('requires CSRF before writes and enforces role before controller', async () => {
    expect((await fetch(`${base}/v1/accounts`, { method: 'POST', headers: { ...headers(), 'x-csrf-token': 'wrong' }, body: '{}' })).status).toBe(403);
    const token = cookie.split('=')[1]!;
    sessions.set(token, { ...user, role: 'VIEWER' });
    expect((await fetch(`${base}/v1/accounts`, { method: 'POST', headers: headers(), body: '{}' })).status).toBe(403);
    sessions.set(token, user);
    expect(store.createAccount).not.toHaveBeenCalled();
  });
  it('validates pagination and ownership before repository', async () => {
    expect((await fetch(`${base}/v1/accounts?pageSize=101`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/v1/accounts`, { method: 'POST', headers: headers(), body: JSON.stringify({ displayName: 'Test', phone: '+15550000001', ownershipConfirmed: false }) })).status).toBe(400);
    expect(store.createAccount).not.toHaveBeenCalled();
  });
  it('queues session validation without claiming the account is connected', async () => {
    const response = await fetch(`${base}/v1/accounts/${user.id}/connect`, { method: 'POST', headers: headers() });
    expect(response.status).toBe(202); expect((await response.json()).status).toBe('PENDING');
  });
  it('protects Telegram login secrets with ADMIN, CSRF, strict contracts and fail-closed worker configuration', async () => {
    const endpoint = `${base}/v1/accounts/${user.id}/login`;
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers(), 'x-csrf-token': 'wrong' }, body: '{"action":"start"}' })).status).toBe(403);
    const token = cookie.split('=')[1]!; sessions.set(token, { ...user, role: 'OPERATOR' });
    expect((await fetch(endpoint, { method: 'POST', headers: headers(), body: '{"action":"start"}' })).status).toBe(403);
    sessions.set(token, user);
    expect((await fetch(endpoint, { method: 'POST', headers: headers(), body: '{"action":"start","password":"must-not-be-accepted"}' })).status).toBe(400);
    const response = await fetch(endpoint, { method: 'POST', headers: headers(), body: '{"action":"start"}' });
    expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).code).toBe('LOGIN_WORKER_UNAVAILABLE');
  });
  it('fails closed when rate limiter refuses requests', async () => {
    allow = false;
    expect((await fetch(`${base}/v1/accounts`, { headers: { cookie } })).status).toBe(429);
    allow = true;
  });
  it('requires ADMIN and CSRF for ordinary contact removal', async () => {
    const endpoint = `${base}/v1/contacts/${user.id}/record`, token = cookie.split('=')[1]!;
    expect((await fetch(endpoint, { method: 'DELETE', headers: { ...headers(), 'x-csrf-token': 'wrong' } })).status).toBe(403);
    sessions.set(token, { ...user, role: 'OPERATOR' });
    try { expect((await fetch(endpoint, { method: 'DELETE', headers: headers() })).status).toBe(403); } finally { sessions.set(token, user); }
  });
  it('restricts account source discovery and member downloads to ADMIN and protects writes with CSRF', async () => {
    const token = cookie.split('=')[1]!; sessions.set(token, { ...user, role: 'OPERATOR' });
    for (const path of [`/accounts/${user.id}/sources`, '/targets/member-exports/recent', '/targets/member-exports/00000000-0000-4000-8000-000000000001/xlsx', `/targets/member-exports/${user.id}/csv`]) expect((await fetch(base + '/v1' + path, { headers: { cookie } })).status).toBe(403);
    for (const path of [`/accounts/${user.id}/sources/refresh`, `/accounts/${user.id}/sources/select`, `/targets/${user.id}/extract-members`, '/targets/member-exports/00000000-0000-4000-8000-000000000001/import']) expect((await fetch(base + '/v1' + path, { method: 'POST', headers: headers(), body: '{}' })).status).toBe(403);
    sessions.set(token, user);
    expect((await fetch(`${base}/v1/accounts/${user.id}/sources/refresh`, { method: 'POST', headers: { ...headers(), 'x-csrf-token': 'wrong' } })).status).toBe(403);
  });
  it('publishes OpenAPI contracts and rejects malformed JSON with request ID', async () => {
    const docs = await fetch(`${base}/docs/openapi.json`);
    expect(docs.status).toBe(200);
    const document = await docs.json();
    expect(document.paths['/v1/accounts'].post.requestBody).toBeDefined();
    expect(document.paths['/v1/accounts'].get.parameters).toHaveLength(5);
    const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: headers(), body: '{bad json' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'HTTP_400', requestId: expect.any(String) });
  });
  it('revokes session on logout and blocks reuse', async () => {
    const metrics = await fetch(`${base}/v1/analytics/metrics`, { headers: { cookie } }); expect(metrics.status).toBe(200); expect(await metrics.text()).toContain('smart_http_requests_total');
    expect((await fetch(`${base}/v1/auth/logout`, { method: 'POST', headers: headers() })).status).toBe(204);
    expect((await fetch(`${base}/v1/auth/me`, { headers: { cookie } })).status).toBe(401);
  });
});
