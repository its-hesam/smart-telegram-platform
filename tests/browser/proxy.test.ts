import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { chromium } from 'playwright';
const frontend = 'http://127.0.0.1:3191'; const token = 'fixture-http-only-token'; const seen: { origin?: string | undefined; csrf?: string | string[] | undefined; cookie?: string | undefined }[] = [];
let next: ChildProcess;
const backend = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/auth/login') { seen.push({ origin: req.headers.origin }); res.setHeader('Set-Cookie', `smart_session=${token}; HttpOnly; SameSite=Strict; Path=/`); res.end(JSON.stringify({ user: { id: 'fixture', email: 'proxy@example.test', role: 'ADMIN' }, csrfToken: 'csrf-fixture' })); return; }
  if (req.url === '/v1/auth/logout') { seen.push({ origin: req.headers.origin, csrf: req.headers['x-csrf-token'], cookie: req.headers.cookie }); res.statusCode = 204; res.end(); return; }
  if (req.url === '/v1/auth/me') { res.statusCode = 401; res.end(JSON.stringify({ code: 'AUTH_REQUIRED' })); return; }
  res.end(JSON.stringify({ data: [], total: 0 }));
});
beforeAll(async () => {
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve)); const address = backend.address(); if (!address || typeof address === 'string') throw new Error('No address');
  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '--port', '3191', '--hostname', '127.0.0.1'], { env: { ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${address.port}` }, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(frontend)).ok) return; } catch {} await delay(250); } throw new Error('No frontend');
}, 20000);
afterAll(async () => { next?.kill(); await new Promise<void>(resolve => backend.close(() => resolve())); });
it('forwards real HTTP cookie/origin/CSRF through the runtime-configured Next backend proxy', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(frontend);
    await page.getByLabel('ایمیل', { exact: true }).fill('proxy@example.test'); await page.getByLabel('رمز عبور', { exact: true }).fill('test-password'); await page.getByRole('button', { name: 'ورود امن', exact: true }).click();
    await page.getByRole('button', { name: 'خروج', exact: true }).waitFor();
    expect(await page.evaluate(() => document.cookie)).not.toContain(token);
    await page.getByRole('button', { name: 'خروج', exact: true }).click();
    await page.getByLabel('ایمیل', { exact: true }).waitFor();
    expect(seen[0]?.origin).toBe(frontend); expect(seen[1]).toMatchObject({ origin: frontend, csrf: 'csrf-fixture', cookie: `smart_session=${token}` });
  } finally { await browser.close(); }
}, 20000);
