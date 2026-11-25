import type { Page, Locator } from 'playwright';
import type { Outcome, ErrorCode } from '../../shared/src/index.js';
import type { TelegramWebAdapter, SelectorRegistry, VisibleChat, ApprovedMessage } from './index.js';
export class StrictTelegramWebAdapter implements TelegramWebAdapter {
  constructor(private readonly page: Page, private readonly registry: SelectorRegistry, private readonly origin = 'https://web.telegram.org', private readonly allowSend = false) {}
  private locator(key: string): Locator {
    if (new URL(this.page.url()).origin !== this.origin) throw new Error('UNSUPPORTED');
    const selector = this.registry.selectors[key];
    if (!selector) throw new Error('UNSUPPORTED');
    return this.page.getByRole(selector.role as Parameters<Page['getByRole']>[0], { name: selector.accessibleName, exact: true });
  }
  private async one(key: string): Promise<Locator> {
    const locator = this.locator(key);
    if (await locator.count() !== 1) throw new Error('UI_ELEMENT_NOT_FOUND');
    await locator.waitFor({ state: 'visible', timeout: 5000 }); return locator;
  }
  private code(error: unknown): ErrorCode { return error instanceof Error && error.message === 'UNSUPPORTED' ? 'OPERATION_UNSUPPORTED' : 'UI_ELEMENT_NOT_FOUND'; }
  async checkSession(): Promise<Outcome<'CONNECTED'>> {
    try {
      const restriction = await this.detectUiError(); if (restriction) return { ok: false, code: restriction };
      if (this.registry.selectors.authRequired && !this.registry.selectors.sessionReady) {
        try { await this.one('authRequired'); return { ok: false, code: 'AUTH_REQUIRED' }; } catch { return { ok: false, code: 'OPERATION_UNSUPPORTED' }; }
      }
      if (this.registry.selectors.authRequired && await this.locator('authRequired').isVisible()) return { ok: false, code: 'AUTH_REQUIRED' };
      await this.one('sessionReady'); return { ok: true, value: 'CONNECTED' };
    } catch (error) { return { ok: false, code: this.code(error) }; }
  }
  async detectUiError(): Promise<ErrorCode | null> {
    for (const [key, code] of [['restricted', 'ACCOUNT_RESTRICTED'], ['rateLimited', 'RATE_LIMITED'], ['permissionDenied', 'PERMISSION_DENIED']] as const) {
      if (this.registry.selectors[key] && await this.locator(key).isVisible()) return code;
    }
    return null;
  }
  async searchChat(query: string, signal: AbortSignal): Promise<Outcome<VisibleChat[]>> {
    try {
      signal.throwIfAborted(); await (await this.one('search')).fill(query);
      // This registry must describe a visible results list, never hidden app state.
      const region = await this.one('results');
      const entries = region.getByRole('button', { name: query, exact: true });
      await entries.first().waitFor({ state: 'visible', timeout: 5000 });
      if (await entries.count() !== 1) throw new Error('UI_ELEMENT_NOT_FOUND');
      return { ok: true, value: [{ title: query, type: 'USER' }] };
    } catch (error) { return { ok: false, code: this.code(error) }; }
  }
  async openChat(reference: string, signal: AbortSignal): Promise<Outcome<VisibleChat>> {
    const result = await this.searchChat(reference, signal); if (!result.ok) return result;
    try {
      signal.throwIfAborted(); await (await this.one('results')).getByRole('button', { name: reference, exact: true }).click();
      const info = await this.getVisibleChatInfo();
      if (info.ok && info.value.title !== reference) return { ok: false, code: 'UI_ELEMENT_NOT_FOUND' };
      return info;
    } catch (error) { return { ok: false, code: this.code(error) }; }
  }
  async openGroup(reference: string, signal: AbortSignal): Promise<Outcome<VisibleChat>> { const result = await this.openChat(reference, signal); return result.ok && result.value.type !== 'GROUP' ? { ok: false, code: 'OPERATION_UNSUPPORTED' } : result; }
  async openChannel(reference: string, signal: AbortSignal): Promise<Outcome<VisibleChat>> { const result = await this.openChat(reference, signal); return result.ok && result.value.type !== 'CHANNEL' ? { ok: false, code: 'OPERATION_UNSUPPORTED' } : result; }
  async getVisibleChatInfo(): Promise<Outcome<VisibleChat>> {
    try {
      const title = (await (await this.one('chatTitle')).innerText()).trim();
      for (const [key, type] of [['groupMarker', 'GROUP'], ['channelMarker', 'CHANNEL'], ['userMarker', 'USER']] as const) {
        if (this.registry.selectors[key] && await this.locator(key).isVisible()) return { ok: true, value: { title, type } };
      }
      return { ok: false, code: 'OPERATION_UNSUPPORTED' };
    } catch (error) { return { ok: false, code: this.code(error) }; }
  }
  async sendApprovedMessage(input: ApprovedMessage, signal: AbortSignal): Promise<Outcome<'SENT_UI_CONFIRMED'>> {
    if (!this.allowSend) return { ok: false, code: 'OPERATION_UNSUPPORTED' };
    let attempted = false;
    try {
      signal.throwIfAborted(); const session = await this.checkSession(); if (!session.ok) return session;
      const uiError = await this.detectUiError(); if (uiError) return { ok: false, code: uiError };
      const chat = await this.getVisibleChatInfo(); if (!chat.ok) return chat;
      if (chat.value.title !== input.recipientReference) return { ok: false, code: 'PERMISSION_DENIED' };
      const composer = await this.one('composer'); const send = await this.one('send');
      const confirmations = (await this.one('outgoing')).getByText(input.content, { exact: true });
      const previous = await confirmations.count(); await composer.fill(input.content);
      signal.throwIfAborted(); await input.beforeMutation();
      attempted = true; await send.click();
      await confirmations.nth(previous).waitFor({ state: 'visible', timeout: 10000 });
      return { ok: true, value: 'SENT_UI_CONFIRMED' };
    } catch (error) { return { ok: false, code: attempted ? 'UNKNOWN_RESULT' : this.code(error) }; }
  }
}
