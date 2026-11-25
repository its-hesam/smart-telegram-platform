import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { attachRealtime } from '../../apps/api/src/realtime.js';
import { apiConfigSchema } from '../../apps/api/src/config.js';
import type { PlatformStore } from '../../apps/api/src/store.js';
const token = randomBytes(32).toString('hex');
const config = apiConfigSchema.parse({ DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost', APP_ORIGIN: 'http://localhost:3000', DATA_ENCRYPTION_KEY: '11'.repeat(32), IDENTITY_HMAC_KEY: '22'.repeat(32) });
const server = createServer(); let url = ''; let close: () => Promise<void>;
beforeAll(async () => { close = attachRealtime(server, { authenticate: async (value: string) => value === token ? { id: 'fixture', role: 'ADMIN', email: 'fixture@example.test' } : null } as unknown as PlatformStore, config); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address'); url = `ws://127.0.0.1:${address.port}/events`; });
afterAll(async () => { await close(); await new Promise<void>(resolve => server.close(() => resolve())); });
it('rejects forged origins and tokens during the websocket handshake', async () => {
  for (const headers of [{ origin: 'https://evil.example', cookie: `smart_session=${token}` }, { origin: config.APP_ORIGIN, cookie: `smart_session=${'a'.repeat(64)}` }]) {
    const socket = new WebSocket(url, { headers });
    const rejected = await new Promise<boolean>(resolve => { socket.once('open', () => { socket.close(); resolve(false); }); socket.once('error', () => resolve(true)); });
    expect(rejected).toBe(true);
  }
});
it('emits a versioned identifier-only resync event and rejects client writes', async () => {
  const socket = new WebSocket(url, { headers: { origin: config.APP_ORIGIN, cookie: `smart_session=${token}` } });
  const message = await new Promise<string>((resolve, reject) => { socket.once('message', data => resolve(data.toString())); socket.once('error', reject); });
  expect(JSON.parse(message)).toMatchObject({ version: 1, type: 'system.resync', resourceId: 'system' });
  expect(message).not.toContain(token); expect(message).not.toContain('email');
  const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code))); socket.send('write'); expect(await closed).toBe(1008);
}, 7000);
