import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../../../packages/database/src/index.js';
import type { PersistentBrowserManager } from '../../../packages/automation-core/src/browser-manager.js';
import { acquireLease } from '../../../packages/automation-core/src/lease.js';
import { FieldCipher, equalSecret } from '../../../packages/shared/src/crypto.js';
import { telegramLoginCommand, loginBridgeToken, type LoginView } from '../../../packages/shared/src/telegram-login.js';
import { TelegramLoginUi } from '../../../packages/telegram-web-adapter/src/login.js';
const inputSchema = z.strictObject({ accountId: z.uuid(), actorId: z.uuid(), sessionId: z.string().regex(/^[a-f0-9]{64}$/), command: telegramLoginCommand });
type Flow = LoginView & { accountId: string; actorId: string; sessionId: string; ui: TelegramLoginUi | undefined; busy: boolean; initializing: boolean; opened: boolean; attempts: number };
class LoginError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export class TelegramLoginService {
  private flow: Flow | undefined;
  private opening: Promise<void> | undefined;
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly db: PrismaClient, private readonly manager: PersistentBrowserManager, private readonly cipher: FieldCipher, private readonly ownerId: string, private readonly signal: AbortSignal) {
    this.timer = setInterval(() => { const f = this.flow; if (f && !f.busy && this.active(f) && Date.parse(f.expiresAt) <= Date.now()) void this.finish(f, 'EXPIRED').catch(() => undefined); }, 5000); this.timer.unref();
  }
  private active(f: Flow) { return ['OPENING', 'CODE', 'PASSWORD'].includes(f.step); }
  private view(f: Flow): LoginView { return { flowId: f.flowId, step: f.initializing && this.active(f) ? 'OPENING' : f.step, expiresAt: f.expiresAt, issue: f.issue }; }
  private async audit(f: Flow, action: string) { await this.db.auditLog.create({ data: { actorId: f.actorId, action: `account.login.${action}`, resourceType: 'TelegramAccount', resourceId: f.accountId } }); }
  private async finish(f: Flow, step: 'CONNECTED' | 'CANCELLED' | 'EXPIRED' | 'ERROR') {
    f.busy = true;
    try {
      if (f.opened) { await this.manager.close(f.accountId); f.opened = false; }
      const status = step === 'CONNECTED' ? 'CONNECTED' : 'AUTH_REQUIRED';
      await this.db.$transaction(async tx => {
        await tx.telegramAccount.update({ where: { id: f.accountId }, data: { status, lastErrorCode: step === 'ERROR' ? f.issue : null, ...(step === 'CONNECTED' ? { lastActiveAt: new Date() } : {}) } });
        if (step === 'CONNECTED') await tx.accountSession.upsert({ where: { profileReference: f.accountId }, create: { accountId: f.accountId, profileReference: f.accountId, encryptionKeyVersion: 1, status: 'CONNECTED', lastValidatedAt: new Date() }, update: { status: 'CONNECTED', lastValidatedAt: new Date() } });
        await tx.auditLog.create({ data: { actorId: f.actorId, action: `account.login.${step.toLowerCase()}`, resourceType: 'TelegramAccount', resourceId: f.accountId } });
      }); f.step = step;
    } catch {
      f.step = 'ERROR'; f.issue = 'LOGIN_RECOVERY_REQUIRED';
      await this.db.telegramAccount.update({ where: { id: f.accountId }, data: { status: 'ACTION_REQUIRED', lastErrorCode: 'LOGIN_RECOVERY_REQUIRED' } }).catch(() => undefined);
    } finally { f.ui = undefined; f.busy = false; }
  }
  private async refresh(f: Flow) {
    if (!f.ui || !this.active(f)) return;
    const state = await f.ui.observe();
    if (state === 'CONNECTED') { await this.finish(f, 'CONNECTED'); return; }
    if (state === 'CODE' || state === 'PASSWORD') f.step = state;
    f.issue = await f.ui.issue();
    if (state === 'UNSUPPORTED') { f.issue = 'LOGIN_UI_UNSUPPORTED'; await this.finish(f, 'ERROR'); }
    if (f.issue && ['TELEGRAM_CODE_EXPIRED', 'TELEGRAM_RATE_LIMITED', 'TELEGRAM_PHONE_INVALID'].includes(f.issue)) await this.finish(f, 'ERROR');
  }
  private async open(f: Flow, phone: string) {
    try {
      const lease = await acquireLease(this.db, f.accountId, `${this.ownerId}:login:${f.flowId}`);
      // The login bridge owns graceful closure. Aborting the worker must not race
      // a second manager.close() against sealing this interactive profile.
      const result = await this.manager.open(f.accountId, lease, new AbortController().signal);
      if (!result.ok) { await lease.release(); throw new Error('Browser unavailable'); }
      f.opened = true;
      await this.db.telegramAccount.update({ where: { id: f.accountId }, data: { status: 'AUTHENTICATING', lastErrorCode: null } });
      await result.value.page.goto('https://web.telegram.org/k/?a11y=1', { waitUntil: 'domcontentloaded', timeout: 25000 });
      f.ui = new TelegramLoginUi(result.value.page);
      for (let n = 0; n < 40; n++) {
        this.signal.throwIfAborted(); const state = await f.ui.observe();
        if (state === 'CONNECTED') { await this.finish(f, 'CONNECTED'); return; }
        if (state === 'QR' || state === 'PHONE') { await f.ui.sendPhone(phone); break; }
        if (state === 'CODE') { await f.ui.sendPhone(phone); break; }
        if (state === 'PASSWORD') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } await this.refresh(f);
    } catch { f.issue = 'LOGIN_START_FAILED'; await this.finish(f, 'ERROR'); }
    finally { f.initializing = false; f.busy = false; }
  }
  async execute(input: z.infer<typeof inputSchema>): Promise<LoginView> {
    const { accountId, actorId, sessionId, command } = input;
    const session = await this.db.authSession.findFirst({ where: { tokenHash: sessionId, userId: actorId, expiresAt: { gt: new Date() }, user: { role: 'ADMIN' } } });
    if (!session) throw new LoginError(403, 'FORBIDDEN');
    if (command.action === 'start') {
      if (this.flow && this.active(this.flow) && this.flow.accountId === accountId && this.flow.actorId === actorId && this.flow.sessionId === sessionId) return this.view(this.flow);
      if (this.flow && (this.active(this.flow) || this.flow.busy || this.flow.opened)) throw new LoginError(409, 'LOGIN_BUSY');
      const account = await this.db.telegramAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new LoginError(404, 'ACCOUNT_NOT_FOUND');
      if (['PAUSED', 'RESTRICTED', 'CONNECTED'].includes(account.status)) throw new LoginError(409, 'ACCOUNT_STATE_CONFLICT');
      const phone = this.cipher.decrypt(account.encryptedPhone, `account:${accountId}:phone`);
      const f: Flow = { accountId, actorId, sessionId, flowId: randomUUID(), step: 'OPENING', expiresAt: new Date(Date.now() + 600000).toISOString(), issue: null, busy: true, initializing: true, opened: false, attempts: 0, ui: undefined };
      if (this.flow && (this.active(this.flow) || this.flow.busy || this.flow.opened)) throw new LoginError(409, 'LOGIN_BUSY');
      this.flow = f;
      try { await this.audit(f, 'start'); } catch (error) { this.flow = undefined; throw error; }
      this.opening = this.open(f, phone); return this.view(f);
    }
    const f = this.flow;
    if (!f || f.accountId !== accountId || f.actorId !== actorId || f.sessionId !== sessionId || f.flowId !== command.flowId) throw new LoginError(404, 'LOGIN_FLOW_NOT_FOUND');
    if (f.busy) { if (command.action === 'status') return this.view(f); throw new LoginError(409, 'LOGIN_BUSY'); }
    if (Date.parse(f.expiresAt) <= Date.now() && this.active(f)) { await this.finish(f, 'EXPIRED'); return this.view(f); }
    if (!this.active(f)) return this.view(f);
    f.busy = true;
    try {
      if (command.action === 'cancel') await this.finish(f, 'CANCELLED');
      else if (command.action === 'status') await this.refresh(f);
      else {
        if (!f.ui || (command.action === 'code' ? f.step !== 'CODE' : f.step !== 'PASSWORD')) throw new LoginError(409, 'LOGIN_STEP_MISMATCH');
        if (++f.attempts > 5) { f.issue = 'LOGIN_ATTEMPTS_EXCEEDED'; await this.finish(f, 'ERROR'); return this.view(f); }
        await this.audit(f, command.action === 'code' ? 'submit_code' : 'submit_password');
        try { if (command.action === 'code') await f.ui.sendCode(command.code); else await f.ui.sendPassword(command.password); }
        catch { f.issue = 'LOGIN_INPUT_REJECTED'; return this.view(f); }
        f.issue = null; await new Promise(resolve => setTimeout(resolve, 500)); await this.refresh(f);
      } return this.view(f);
    } catch (error) {
      if (error instanceof LoginError) throw error;
      f.issue = 'LOGIN_UI_UNSUPPORTED'; await this.finish(f, 'ERROR'); return this.view(f);
    } finally { f.busy = false; }
  }
  async close() {
    clearInterval(this.timer); await this.opening;
    const f = this.flow;
    for (let n = 0; f?.busy && n < 600; n++) await new Promise(resolve => setTimeout(resolve, 50));
    if (f && this.active(f) && !f.busy) await this.finish(f, 'CANCELLED');
  }
}
export async function startLoginBridge(service: TelegramLoginService, key: string, port = 3002, health?: () => Promise<boolean>) {
  const expected = `Bearer ${loginBridgeToken(key)}`;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
      try { const ok = health ? await health() : true; res.statusCode = ok ? 200 : 503; res.end(JSON.stringify({ status: ok ? 'ok' : 'unavailable' })); }
      catch { res.statusCode = 503; res.end(JSON.stringify({ status: 'unavailable' })); }
      return;
    }
    const reject = (status: number, code: string) => { res.statusCode = status; res.end(JSON.stringify({ code })); };
    if (req.method !== 'POST' || req.url !== '/owner-login' || !equalSecret(req.headers.authorization ?? '', expected)) { reject(403, 'FORBIDDEN'); req.resume(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 4096) { reject(413, 'PAYLOAD_TOO_LARGE'); return; } chunks.push(Buffer.from(chunk)); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(400, 'VALIDATION_FAILED'); return; }
      chunks.length = 0;
      const parsed = inputSchema.safeParse(body); body = undefined;
      if (!parsed.success) { reject(400, 'VALIDATION_FAILED'); return; }
      res.end(JSON.stringify(await service.execute(parsed.data)));
    } catch (error) { reject(error instanceof LoginError ? error.status : 503, error instanceof LoginError ? error.code : 'LOGIN_WORKER_UNAVAILABLE'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  return async () => { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); };
}
