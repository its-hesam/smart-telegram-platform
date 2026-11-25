// Local preview only. Never imported by the production API/worker entrypoints.
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createDatabase } from '../packages/database/src/index.js';
import { apiConfigSchema } from '../apps/api/src/config.js';
import { FieldCipher, hashPassword } from '../apps/api/src/crypto.js';
import { PlatformStore } from '../apps/api/src/store.js';
import { AuthService } from '../apps/api/src/auth.service.js';
import { ContactsService, contactInputSchema } from '../apps/api/src/contacts.js';
import { CampaignsService } from '../apps/api/src/campaigns.js';
import { OperationsService } from '../apps/api/src/operations.js';
import { createApp } from '../apps/api/src/app.js';
import { attachRealtime } from '../apps/api/src/realtime.js';
import type { Server } from 'node:http';

if (process.env.LOCAL_DEMO !== 'true') throw new Error('Local demo entrypoint requires explicit LOCAL_DEMO=true');
const config = apiConfigSchema.parse(process.env);
const database = new URL(config.DATABASE_URL);
if (database.hostname !== '127.0.0.1' || database.pathname !== '/smart_demo' || config.NODE_ENV !== 'development' || config.APP_ORIGIN !== 'http://localhost:3000') throw new Error('Demo must use the isolated loopback smart_demo database');
const db = createDatabase(config.DATABASE_URL);
const cipher = new FieldCipher(config.DATA_ENCRYPTION_KEY, config.IDENTITY_HMAC_KEY);
const store = new PlatformStore(db, cipher);
const contacts = new ContactsService(db, cipher);
const campaigns = new CampaignsService(db, cipher);
const operations = new OperationsService(db, cipher);
const passwordHash = await hashPassword('DemoPreview!2026');
const user = await db.adminUser.upsert({ where: { email: 'demo@smart.local' }, create: { email: 'demo@smart.local', passwordHash, role: 'ADMIN' }, update: { passwordHash, role: 'ADMIN' } });
const actor = { id: user.id, email: user.email, role: 'ADMIN' as const };
if (!await db.systemSetting.findUnique({ where: { key: 'demo.seed.v1' } })) {
  const accounts = [];
  for (const [index, name] of ['پشتیبانی فروش — دمو', 'ارتباط با مشتریان — دمو', 'تیم آموزش — دمو'].entries()) {
    const account = await store.createAccount(actor, { displayName: name, phone: `+99910000000${index + 1}` });
    if (index === 1) await db.telegramAccount.update({ where: { id: account.id }, data: { status: 'AUTH_REQUIRED' } });
    if (index === 2) await store.updateAccount(actor, account.id, { enabled: false });
    accounts.push(account);
  }
  const lists = [];
  for (const name of ['مشترکان خبرنامه — دمو', 'شرکت‌کنندگان دوره — دمو', 'مشتریان فروشگاه — دمو']) lists.push(await contacts.createList(actor, { name }));
  const names = ['آرمان نمایشی', 'نیلوفر نمایشی', 'سامان نمایشی', 'رها نمایشی', 'پارسا نمایشی', 'سارا نمایشی', 'کیان نمایشی', 'ترانه نمایشی', 'نوید نمایشی', 'مهسا نمایشی', 'آوا نمایشی', 'شایان نمایشی'];
  for (const [index, name] of names.entries()) await contacts.create(actor, contactInputSchema.parse({ displayName: name, username: `demo_member_${String(index + 1).padStart(2, '0')}`, source: 'MANUAL', notes: 'دادهٔ ساختگی مخصوص پیش‌نمایش؛ به هیچ اکانت واقعی متصل نیست.', tags: ['دمو', index % 2 ? 'آموزش' : 'خبرنامه'], listIds: [lists[index % lists.length]!.id], consentStatus: index === 3 ? 'REVOKED' : index === 6 ? 'UNKNOWN' : 'OPTED_IN', ...(index !== 3 && index !== 6 ? { consentTimestamp: new Date(Date.now() - 86400000 * (index + 1)).toISOString(), consentEvidenceReference: `demo/consent/${index + 1}` } : {}) }));
  await campaigns.create(actor, { name: 'خوش‌آمدگویی مشترکان — دمو', content: 'سلام {{name}} 👋\nبه خبرنامهٔ ما خوش آمدید. این پیام فقط یک پیش‌نمایش است و ارسال نمی‌شود.', contactListId: lists[0]!.id, accountId: accounts[0]!.id, creationKey: randomUUID() });
  await campaigns.create(actor, { name: 'یادآوری دوره آموزشی — دمو', content: 'سلام {{name}}،\nاطلاعات دورهٔ جدید آماده است. این کمپین نمایشی است.', contactListId: lists[1]!.id, accountId: accounts[1]!.id, creationKey: randomUUID() });
  const group = await operations.createTarget(actor, { title: 'انجمن آموزش — دمو', type: 'GROUP', reference: '@demo_learning_group', authorizationConfirmed: true });
  await operations.createTarget(actor, { title: 'اخبار مجموعه — دمو', type: 'CHANNEL', reference: '@demo_news_channel', authorizationConfirmed: true });
  // Intentionally non-Telegram URL: no invitation can target a real account.
  await operations.registerInvitation(actor, { targetId: group.id, link: 'https://example.invalid/demo-invitation', authorizationConfirmed: true });
  for (const [index, status] of (['COMPLETED', 'PAUSED', 'PENDING', 'FAILED'] as const).entries()) await db.job.create({ data: { type: index === 1 ? 'SESSION_VALIDATION' : 'REPORT_GENERATION', status, accountId: null, idempotencyKey: `demo:${randomUUID()}`, traceId: randomUUID(), result: { demo: true }, scheduledAt: index === 2 ? new Date(Date.now() + 86400000) : null, startedAt: index === 0 || index === 3 ? new Date(Date.now() - 3600000) : null, finishedAt: index === 0 || index === 3 ? new Date(Date.now() - 3500000) : null, errorCode: index === 3 ? 'DEMO_EXAMPLE_ERROR' : null } });
  await operations.updateSettings(actor, { timezone: 'Asia/Tehran', retentionDays: 90 });
  await db.systemSetting.create({ data: { key: 'demo.seed.v1', value: true } });
}
const windows = new Map<string, { count: number; expires: number }>();
const limiter = { consume: async (key: string, limit: number, seconds: number) => { const now = Date.now(); for (const [id, row] of windows) if (row.expires <= now) windows.delete(id); const row = windows.get(key) ?? { count: 0, expires: now + seconds * 1000 }; if (!windows.has(key) && windows.size >= 1000) return false; row.count++; windows.set(key, row); return row.count <= limit; } };
const app = await createApp({ config, store, auth: await AuthService.create(store, config), contacts, campaigns, operations, limiter });
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Smart-Demo', 'local-preview');
  if (req.method === 'POST' && /\/(?:connect|disconnect|start|test-send)$/.test(req.path)) { res.status(501).json({ code: 'DEMO_ACTION_DISABLED', message: 'Telegram connection and sending are disabled in the local preview' }); return; }
  next();
});
const closeRealtime = attachRealtime(app.getHttpServer() as Server, store, config);
await app.listen(config.API_PORT, '127.0.0.1');
console.log('LOCAL DEMO API READY — loopback only, in-memory preview limiter, no Redis/worker/Telegram operations');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void (async () => { await closeRealtime(); await app.close(); await db.$disconnect(); })(); });
