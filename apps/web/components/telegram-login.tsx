'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText } from '../lib/api';
import { Button } from './ui/button';
type View = { flowId: string; step: 'OPENING' | 'CODE' | 'PASSWORD' | 'CONNECTED' | 'CANCELLED' | 'EXPIRED' | 'ERROR'; expiresAt: string; issue: string | null };
const active = (v: View | null) => Boolean(v && ['OPENING', 'CODE', 'PASSWORD'].includes(v.step));
const issues: Record<string, string> = {
  TELEGRAM_CODE_INVALID: 'کد درست نیست؛ کد جدید را بررسی و دوباره وارد کنید.',
  TELEGRAM_PASSWORD_INVALID: 'رمز دومرحله‌ای درست نیست؛ دوباره وارد کنید.',
  TELEGRAM_PHONE_INVALID: 'شماره تلفن توسط تلگرام پذیرفته نشد.',
  TELEGRAM_CODE_EXPIRED: 'کد منقضی شده است؛ ورود را از ابتدا شروع کنید.',
  TELEGRAM_RATE_LIMITED: 'تلگرام درخواست‌ها را محدود کرده است؛ بعداً دوباره تلاش کنید.',
  LOGIN_START_FAILED: 'باز کردن صفحه ورود موفق نبود؛ دوباره تلاش کنید یا وضعیت Worker را بررسی کنید.',
  LOGIN_RECOVERY_REQUIRED: 'نشست مرورگر به بررسی مدیر سیستم نیاز دارد.',
  LOGIN_UI_UNSUPPORTED: 'تلگرام مرحله‌ای متفاوت نشان داده است؛ این ورود به بررسی نیاز دارد.',
  LOGIN_ATTEMPTS_EXCEEDED: 'تعداد تلاش‌های این ورود تمام شد؛ بعداً دوباره شروع کنید.',
  LOGIN_INPUT_REJECTED: 'ورودی با فرم فعلی تلگرام مطابقت ندارد؛ کد یا رمز را بررسی کنید.',
};
export function TelegramLogin({ accountId, phone, connected }: { accountId: string; phone: string | undefined; connected: boolean }) {
  const client = useQueryClient(); const [view, setView] = useState<View | null>(null);
  const [secret, setSecret] = useState(''); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const busy = useRef(false); const mounted = useRef(true); const previousStep = useRef('');
  const storageKey = `telegram-login:${accountId}`;
  useEffect(() => {
    mounted.current = true;
    try { const saved = sessionStorage.getItem(storageKey); if (saved) { const v = JSON.parse(saved) as View; if (Date.parse(v.expiresAt) > Date.now() && /^[a-f0-9-]{36}$/.test(v.flowId)) setView(v); else sessionStorage.removeItem(storageKey); } } catch { /* Storage is optional; never store credentials. */ }
    return () => { mounted.current = false; };
  }, [storageKey]);
  const accept = (v: View) => {
    if (!mounted.current) return;
    setView(v);
    if (v.step !== previousStep.current) { setSecret(''); previousStep.current = v.step; }
    try { if (active(v)) sessionStorage.setItem(storageKey, JSON.stringify(v)); else sessionStorage.removeItem(storageKey); } catch { /* Optional metadata only. */ }
    if (!active(v)) { void client.invalidateQueries({ queryKey: ['accounts'] }); void client.invalidateQueries({ queryKey: ['health', accountId] }); }
  };
  async function command(action: string, value?: string) {
    if (busy.current) return; busy.current = true; setPending(true); setError('');
    try { accept(await api<View>(`/accounts/${accountId}/login`, { method: 'POST', body: { action, ...(action !== 'start' ? { flowId: view?.flowId } : {}), ...(action === 'code' ? { code: value } : {}), ...(action === 'password' ? { password: value } : {}) } })); }
    catch (e) { if (mounted.current) { setError(errorText(e)); if (e instanceof ApiError && e.code === 'LOGIN_FLOW_NOT_FOUND') { setView(null); setSecret(''); try { sessionStorage.removeItem(storageKey); } catch {} } } }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  useEffect(() => {
    if (!active(view)) return;
    const timer = setInterval(() => { if (!busy.current) void command('status'); }, 2500);
    return () => clearInterval(timer);
    // Recreate the poll when a stage changes so commands use its current flow ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.flowId, view?.step]);
  const terminal = !active(view);
  return <section className="mt-5" aria-label="ورود تلگرام">
    <p className="muted">شماره اکانت: <span dir="ltr">{phone}</span></p>
    <p className="small muted">کد ممکن است در تلگرام دستگاه دیگر یا از روشی که تلگرام تعیین می‌کند دریافت شود. کد و رمز دومرحله‌ای ذخیره نمی‌شوند.</p>
    {connected && !view ? <p role="status">این اکانت متصل است.</p> : <>
      {view?.step === 'OPENING' && <p role="status">در حال باز کردن تلگرام و درخواست کد…</p>}
      {(view?.step === 'CODE' || view?.step === 'PASSWORD') && <form autoComplete="off" onSubmit={e => { e.preventDefault(); const value = secret; setSecret(''); void command(view.step === 'CODE' ? 'code' : 'password', value); }}>
        <label>{view.step === 'CODE' ? 'کد ورود تلگرام' : 'رمز دومرحله‌ای تلگرام'}<input key={view.step} type="password" dir="ltr" autoComplete="off" autoFocus inputMode={view.step === 'CODE' ? 'numeric' : 'text'} value={secret} minLength={view.step === 'CODE' ? 4 : 1} maxLength={view.step === 'CODE' ? 8 : 256} pattern={view.step === 'CODE' ? '[0-9]{4,8}' : undefined} required onChange={e => setSecret(e.target.value)}/></label>
        <Button className="mt-4" disabled={pending}>{pending ? 'در حال بررسی…' : view.step === 'CODE' ? 'تأیید کد' : 'تأیید رمز دومرحله‌ای'}</Button>
      </form>}
      {view?.step === 'CONNECTED' && <p role="status">ورود موفق بود و نشست به‌صورت رمزگذاری‌شده ذخیره شد.</p>}
      {view?.step === 'EXPIRED' && <p role="status">زمان ورود تمام شد؛ دوباره شروع کنید.</p>}
      {view?.step === 'CANCELLED' && <p role="status">ورود لغو شد.</p>}
      {view?.issue && <div className="error-notice" role="alert">{issues[view.issue] ?? 'ورود به بررسی نیاز دارد.'}</div>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      {terminal && view?.step !== 'CONNECTED' && <Button className="mt-4" disabled={pending} onClick={() => { setSecret(''); void command('start'); }}>{pending ? 'در حال شروع…' : 'دریافت کد ورود'}</Button>}
      {active(view) && <Button className="mt-4" variant="outline" disabled={pending} onClick={() => { setSecret(''); void command('cancel'); }}>لغو ورود</Button>}
    </>}
  </section>;
}
