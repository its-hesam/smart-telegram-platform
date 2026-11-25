import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { chromium } from 'playwright';
const url = 'http://127.0.0.1:3190'; let server: ChildProcess;

it('shows numeric IDs without usernames and distinguishes record removal from permanent erasure', async () => {
  const browser = await chromium.launch(); const removed: string[] = [];
  let contacts = [{ id: '11111111-1111-4111-8111-111111111111', displayName: 'Fixture with username', username: 'fixture_user', phone: null, telegramId: '111', consentStatus: 'UNKNOWN', suppressed: false, tags: [], notes: null }, { id: '22222222-2222-4222-8222-222222222222', displayName: 'Fixture numeric only', username: null, phone: '+15550000001', telegramId: '222', consentStatus: 'UNKNOWN', suppressed: false, tags: [], notes: null }];
  try {
    const page = await browser.newPage(); page.on('dialog', dialog => { void dialog.accept(); });
    await page.route('**/v1/**', route => { const request = route.request(), path = new URL(request.url()).pathname; let body: unknown = {};
      if (path === '/v1/auth/me') body = { user: { id: 'fixture', email: 'fixture@example.test', role: 'ADMIN' }, csrfToken: 'fixture' };
      else if (request.method() === 'DELETE') { removed.push(path); contacts = contacts.filter(c => !path.includes(c.id)); return route.fulfill({ status: 204 }); }
      else if (path === '/v1/contacts') body = { data: contacts, total: contacts.length };
      else if (path === '/v1/contact-lists') body = [];
      else body = { data: [], total: 0 };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }); });
    await page.goto(url); await page.getByRole('button', { name: 'مخاطبان و لیست‌ها', exact: true }).click();
    await page.getByRole('columnheader', { name: 'شناسهٔ عددی تلگرام', exact: true }).waitFor(); await page.getByRole('cell', { name: '222', exact: true }).waitFor();
    await page.getByRole('row').filter({ hasText: 'Fixture with username' }).getByRole('button', { name: 'حذف مخاطب', exact: true }).click();
    await page.getByRole('cell', { name: 'Fixture with username', exact: true }).waitFor({ state: 'hidden' }); expect(removed[0]).toMatch(/\/record$/);
    await page.getByRole('row').filter({ hasText: 'Fixture numeric only' }).getByRole('button', { name: 'ویرایش', exact: true }).click();
    await page.getByText('حذف دائمی و منع ورود مجدد', { exact: true }).click(); await page.getByRole('button', { name: 'حذف دائمی و منع ورود', exact: true }).click();
    await page.getByRole('cell', { name: 'Fixture numeric only', exact: true }).waitFor({ state: 'hidden' }); expect(removed[1]).toBe('/v1/contacts/22222222-2222-4222-8222-222222222222');
  } finally { await browser.close(); }
});
beforeAll(async () => {
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '--port', '3190', '--hostname', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return; } catch {} await delay(250); }
  throw new Error('Built Next.js server did not become ready');
}, 20000);
afterAll(() => { server?.kill(); });
it('renders RTL login and account CRUD controls with an explicit HTTP fixture, including mobile layout', async () => {
  const browser = await chromium.launch();
  let authenticated = false; const rows: unknown[] = [];
  const user = { id: 'fixture', email: 'operator@example.test', role: 'ADMIN' };
  let loginStep = 'CODE';
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/v1/**', async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/v1/auth/login') { authenticated = true; return json({ user, csrfToken: 'fixture-csrf' }); }
      if (path === '/v1/auth/me') return authenticated ? json({ user, csrfToken: 'fixture-csrf' }) : json({ code: 'AUTH_REQUIRED' }, 401);
      if (path === '/v1/accounts' && request.method() === 'POST') { const body = request.postDataJSON(); const row = { id: 'df4918aa-b6f4-4900-a7aa-1b650dc7a33b', ...body, status: 'DISCONNECTED', lastActiveAt: null }; rows.push(row); return json(row, 201); }
      if (path === '/v1/accounts') return json({ data: rows, total: rows.length });
      if (path.endsWith('/health')) return json({ status: 'DISCONNECTED', browser: 'CLOSED' });
      if (path.endsWith('/login')) {
        const body = request.postDataJSON();
        if (body.action === 'code') { expect(body.code).toBe('12345'); loginStep = 'PASSWORD'; }
        if (body.action === 'password') { expect(body.password).toBe('fixture-2fa'); loginStep = 'CONNECTED'; }
        return json({ flowId: '3fc631aa-babe-42c6-a8ed-084278ce242f', step: loginStep, expiresAt: new Date(Date.now() + 600000).toISOString(), issue: null });
      }
      return json({ code: 'OPERATION_UNSUPPORTED' }, 501);
    });
    await page.goto(url);
    await page.getByLabel('ایمیل', { exact: true }).fill(user.email);
    await page.getByLabel('رمز عبور', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'ورود امن', exact: true }).click();
    await page.getByRole('button', { name: 'مدیریت اکانت‌ها', exact: true }).click();
    await page.getByRole('button', { name: 'افزودن اکانت', exact: true }).click();
    await page.getByLabel('نام نمایشی', { exact: true }).fill('اکانت آزمایشی رابط');
    await page.getByLabel('شماره تلفن با کد کشور', { exact: false }).fill('+15550000001');
    await page.getByRole('button', { name: 'ثبت اکانت', exact: true }).click();
    await page.getByText('تأیید مالکیت الزامی است', { exact: true }).waitFor(); expect(rows).toHaveLength(0);
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'ثبت اکانت', exact: true }).click();
    await page.getByRole('button', { name: 'دریافت کد ورود', exact: true }).click();
    await page.getByLabel('کد ورود تلگرام', { exact: true }).fill('12345');
    await page.getByRole('button', { name: 'تأیید کد', exact: true }).click();
    const password = page.getByLabel('رمز دومرحله‌ای تلگرام', { exact: true });
    await password.fill('fixture-2fa'); expect(await password.getAttribute('type')).toBe('password');
    await page.getByRole('button', { name: 'تأیید رمز دومرحله‌ای', exact: true }).click();
    await page.getByText('ورود موفق بود و نشست به‌صورت رمزگذاری‌شده ذخیره شد.', { exact: true }).waitFor();
    expect((await page.evaluate(() => JSON.stringify(sessionStorage))).includes('fixture-2fa')).toBe(false);
    await page.getByRole('button', { name: 'بستن', exact: true }).click();
    await page.getByRole('cell', { name: 'اکانت آزمایشی رابط', exact: false }).waitFor();
    expect(rows).toHaveLength(1);
    await page.screenshot({ path: 'docs/dashboard-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'نمایش منو', exact: true }).click();
    await page.getByRole('navigation', { name: 'منوی اصلی' }).waitFor({ state: 'visible' });
  } finally { await browser.close(); }
}, 30000);
it('selects account-owned private sources and queues accessible non-owner member exports without a checkbox', async () => {
  const browser = await chromium.launch(); const accountId = 'df4918aa-b6f4-4900-a7aa-1b650dc7a33b', targetId = 'ef4918aa-b6f4-4900-a7aa-1b650dc7a33b';
  let ready = false, exported = false;
  try {
    const page = await browser.newPage();
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname; const body = () => route.request().postDataJSON(); const json = (v: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(v) });
      if (path === '/v1/auth/me') return json({ user: { id: 'fixture', email: 'admin@example.test', role: 'ADMIN' }, csrfToken: 'fixture' });
      if (path === '/v1/accounts') return json({ data: [{ id: accountId, displayName: 'اکانت مجاز', status: 'CONNECTED' }], total: 1 });
      if (path === '/v1/targets') return json([]);
      if (path.endsWith('/sources/refresh')) { ready = true; return json({ jobId: 'scan', status: 'PENDING' }); }
      if (path.endsWith('/sources/select')) { expect(body().sourceIds).toEqual(['a'.repeat(64)]); expect(body().authorizationConfirmed).toBe(true); return json({ targets: [{ id: targetId, type: 'GROUP' }] }); }
      if (path.endsWith('/sources')) return json({ sources: ready ? [{ key: 'a'.repeat(64), title: 'گروه خصوصی تست', type: 'GROUP', adminVerified: false, targetId: null }, { key: 'b'.repeat(64), title: 'کانال تست', type: 'CHANNEL', adminVerified: false, targetId: null }] : [], scannedAt: ready ? new Date().toISOString() : null, partial: true, skipped: 1, diagnostics: [{ code: 'SOURCE_HEADER_TIMEOUT', count: 1 }], job: ready ? { id: 'scan', status: 'COMPLETED', errorCode: null } : null });
      if (path.endsWith('/extract-members')) { expect(body()).toEqual({ authorizationConfirmed: true, limit: 500 }); exported = true; return json({ jobId: targetId, status: 'PENDING' }); }
      if (path === '/v1/targets/member-exports/recent') return json(exported ? [{ id: targetId, status: 'COMPLETED', errorCode: null, createdAt: new Date().toISOString() }] : []);
      return json({ code: 'OPERATION_UNSUPPORTED' });
    });
    await page.goto(url); await page.getByRole('button', { name: 'گروه‌ها و کانال‌ها', exact: true }).click();
    await page.getByLabel('اکانت دریافت منابع').selectOption(accountId); await page.getByRole('button', { name: 'دریافت گروه‌ها و کانال‌ها', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'باز کردن ۱ منبع کامل نشد' }).waitFor();
    await page.getByLabel('انتخاب گروه خصوصی تست', { exact: true }).check();
    const run = page.getByRole('button', { name: 'استخراج اعضای انتخاب‌شده', exact: true }); expect(await run.isEnabled()).toBe(true);
    expect(await page.getByRole('checkbox', { name: 'برای استفاده از منابع انتخاب‌شده و استخراج اعضای گروه‌ها مجوز دارم.' }).count()).toBe(0);
    await page.getByLabel('انتخاب کانال تست', { exact: true }).check(); expect(await run.isEnabled()).toBe(true);
    await page.getByLabel('انتخاب کانال تست', { exact: true }).uncheck(); await run.click();
    await page.getByRole('button', { name: 'دریافت CSV', exact: true }).waitFor({ state: 'visible' }); expect(exported).toBe(true);
  } finally { await browser.close(); }
}, 30000);
