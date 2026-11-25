import type { Page, Locator } from 'playwright';
export type LoginObservation = 'PHONE' | 'QR' | 'CODE' | 'PASSWORD' | 'CONNECTED' | 'UNSUPPORTED' | 'WAITING';
// Telegram Web K public DOM observed 2026-11-06. Code/password widgets reviewed in
// official tweb source ae67ff9763a77cce0b9d3ff993c1e0e11637f904. No internal API calls.
export class TelegramLoginUi {
  constructor(private readonly page: Page, private readonly origin = 'https://web.telegram.org') {}
  private assertOrigin() { if (new URL(this.page.url()).origin !== this.origin) throw new Error('LOGIN_ORIGIN_REJECTED'); }
  private phone() { return this.page.getByRole('textbox', { name: 'Phone Number', exact: true }); }
  private code() { return this.page.locator('input[autocomplete="one-time-code"]:visible'); }
  private password() { return this.page.locator('input[name="notsearch_password"]:visible'); }
  private async unique(locator: Locator) { if (await locator.count() !== 1 || !await locator.isVisible()) throw new Error('LOGIN_UI_UNSUPPORTED'); return locator; }
  async observe(): Promise<LoginObservation> {
    this.assertOrigin();
    if (await this.password().count() === 1) return 'PASSWORD';
    if (await this.code().count() === 1) return 'CODE';
    if (await this.phone().isVisible().catch(() => false)) return 'PHONE';
    if (await this.page.getByRole('button', { name: /log in by phone number/i }).isVisible().catch(() => false)) return 'QR';
    if (await this.page.locator('#page-chats').isVisible() && await this.page.locator('#column-left[role="navigation"]').isVisible() && !await this.page.locator('body.has-auth-pages').count()) return 'CONNECTED';
    if (await this.page.getByRole('heading', { name: /your name|recovery|email|sign up/i }).count()) return 'UNSUPPORTED';
    return 'WAITING';
  }
  async sendPhone(phone: string) {
    this.assertOrigin();
    if (await this.observe() === 'CODE') await (await this.unique(this.page.getByRole('button', { name: 'Edit', exact: true }))).click();
    if (await this.observe() === 'QR') await (await this.unique(this.page.getByRole('button', { name: /log in by phone number/i }))).click();
    await this.phone().waitFor({ state: 'visible', timeout: 10000 });
    await (await this.unique(this.phone())).fill(phone);
    await (await this.unique(this.page.getByRole('button', { name: /^next$/i }))).click();
  }
  async sendCode(code: string) {
    this.assertOrigin();
    const input = await this.unique(this.code());
    const length = Number(await input.getAttribute('maxlength'));
    if (length && length !== code.length) throw new Error('LOGIN_CODE_LENGTH');
    await input.fill(code); // Official UI submits when all digit boxes are filled.
  }
  async sendPassword(password: string) {
    this.assertOrigin();
    await (await this.unique(this.password())).fill(password);
    await (await this.unique(this.page.getByRole('button', { name: /^next$/i }))).click();
  }
  async issue(): Promise<string | null> {
    this.assertOrigin();
    // Inspect visible errors only. Never return raw UI text, phone, code or password.
    const text = await this.page.locator('[role="alert"]:visible, .input-field.error:visible, button.btn-primary:visible').allTextContents();
    const value = text.join(' ').toLowerCase();
    if (/flood|too many|try again in/.test(value)) return 'TELEGRAM_RATE_LIMITED';
    if (/expired/.test(value)) return 'TELEGRAM_CODE_EXPIRED';
    if (/invalid.*phone|phone.*invalid/.test(value)) return 'TELEGRAM_PHONE_INVALID';
    if (/invalid.*password|password.*invalid|incorrect password/.test(value)) return 'TELEGRAM_PASSWORD_INVALID';
    if (/invalid.*code|code.*invalid|incorrect code/.test(value)) return 'TELEGRAM_CODE_INVALID';
    if (await this.password().locator('..').locator('input.error:visible').count()) return 'TELEGRAM_PASSWORD_INVALID';
    return null;
  }
}
