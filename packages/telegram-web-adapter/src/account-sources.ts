import type { Page } from 'playwright';
export class SourceUiError extends Error { constructor(readonly code: string) { super(code); } }
type Check = () => Promise<void>;
export class AccountSourcesUi {
  constructor(private readonly page: Page, private readonly origin = 'https://web.telegram.org') {}
  private assertOrigin() { if (new URL(this.page.url()).origin !== this.origin) throw new SourceUiError('SOURCE_UI_UNSUPPORTED'); }
  private chat(peer: string) { return this.page.locator('.chat-info:visible').filter({ has: this.page.locator(`.peer-title[data-peer-id="${peer}"]`) }).last(); }
  private header(peer?: string) { return this.page.locator(`.chat-info:visible .peer-title[data-peer-id${peer ? `="${peer}"` : ''}]`).last(); }
  private row(label: string) { return this.page.locator('#column-right .row:visible').filter({ has: this.page.locator('.row-title').filter({ hasText: new RegExp(`^${label}$`) }) }); }
  private async back() {
    const buttons = this.page.locator('#column-right .sidebar-close-button');
    for (let i = 0; i < await buttons.count(); i++) {
      const button = buttons.nth(i);
      if (await button.evaluate(e => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 0 && r.height > 0 && Boolean(hit && e.contains(hit)); })) { await button.click(); await this.page.waitForTimeout(250); return true; }
    }
    return false;
  }
  private async scroll(root: string, reset = false) {
    return this.page.locator(root).evaluate((node, reset) => {
      const candidates = [...node.querySelectorAll<HTMLElement>('.scrollable-y')].filter(x => x.clientHeight > 0);
      let el = candidates.find(x => x.classList.contains('selector-scrollable')) ?? candidates[0];
      for (let p: HTMLElement | null = node as HTMLElement; !el && p; p = p.parentElement) if (p.classList.contains('scrollable-y')) el = p;
      if (!el) return { end: true, moved: false };
      const old = el.scrollTop; if (reset) el.scrollTo(0, 0); else el.scrollBy(0, Math.max(200, el.clientHeight * .8));
      return { end: el.scrollTop + el.clientHeight >= el.scrollHeight - 3, moved: old !== el.scrollTop };
    }, reset);
  }
  async self(check: Check): Promise<string> {
    this.assertOrigin(); await check();
    await this.page.locator('#column-left').getByRole('button', { name: 'More', exact: true }).click();
    await this.page.getByRole('menuitem', { name: 'Saved Messages', exact: true }).click();
    const marker = this.page.locator('.chat-info:visible .peer-title[data-peer-id]:not([data-peer-id^="-"])').filter({ hasText: /^Saved Messages$/i });
    await marker.waitFor({ timeout: 20000 });
    const id = await marker.getAttribute('data-peer-id');
    if (!id || !/^\d{1,20}$/.test(id)) throw new SourceUiError('SOURCE_SELF_UNVERIFIED');
    return id;
  }
  async references(check: Check) {
    this.assertOrigin(); const refs = new Map<string, string>(); let partial = false;
    await this.page.locator('#column-left .chatlist-chat[data-peer-id]:visible').first().waitFor({ timeout: 20000 }).catch(() => { throw new SourceUiError('SOURCE_UI_UNSUPPORTED'); });
    const all = this.page.getByRole('tab', { name: /^All Chats/i });
    if (await all.count() === 1) await all.click();
    const deadline = Date.now() + 600000;
    const scan = async () => {
      let stable = 0;
      for (let n = 0; n < 100000; n++) {
        await check(); if (Date.now() > deadline) { partial = true; break; }
        const before = refs.size;
        const rows = await this.page.locator('#column-left .chatlist-chat[data-peer-id^="-"]:visible').evaluateAll(es => es.map(e => ({ peer: e.getAttribute('data-peer-id')!, title: e.querySelector('.user-title > .peer-title')?.textContent?.trim() ?? '' })));
        for (const row of rows) if (/^-\d{1,20}$/.test(row.peer) && row.title) refs.set(row.peer, row.title.slice(0, 150));
        if (refs.size >= 100000) { partial = true; break; }
        const bottom = await this.scroll('#column-left');
        stable = bottom.end && refs.size === before ? stable + 1 : 0;
        if (stable >= 3) break;
        await this.page.waitForTimeout(250);
      }
    };
    await scan();
    await this.page.locator('#column-left').getByRole('button', { name: 'More', exact: true }).click();
    const archive = this.page.getByRole('menuitem', { name: 'Archived Chats', exact: true });
    if (await archive.isVisible().catch(() => false)) { await archive.click(); await this.page.waitForTimeout(500); await scan(); }
    else await this.page.keyboard.press('Escape');
    return { refs: [...refs].map(([peer, title]) => ({ peer, title })), partial };
  }
  async open(peer: string, check: Check) {
    this.assertOrigin(); if (!/^-\d{1,20}$/.test(peer)) throw new SourceUiError('SOURCE_UI_UNSUPPORTED'); await check();
    for (let n = 0; n < 6 && await this.back(); n++) { /* Close existing profile tabs through their UI only. */ }
    const row = this.page.locator(`#column-left .chatlist-chat[data-peer-id="${peer}"]:visible`).last();
    const box = await row.count() ? await row.boundingBox().catch(() => null) : null;
    let clicked = false;
    if (box && box.x >= 0 && box.x < (this.page.viewportSize()?.width ?? 1280)) clicked = await row.click({ timeout: 3500 }).then(() => true).catch(() => false);
    if (!clicked) {
      // Full document navigation avoids the app's same-document history veto.
      // The fragment is the official UI route captured from visible dialog rows.
      await this.page.goto(`${this.origin}/k/?a11y=1&source_view=${Date.now()}#${peer}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    }
    try { await this.header(peer).waitFor({ timeout: 12000 }); }
    catch {
      await this.page.goto(`${this.origin}/k/?a11y=1&source_view=${Date.now()}#${peer}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await this.header(peer).waitFor({ timeout: 20000 }).catch(() => { throw new SourceUiError('SOURCE_HEADER_TIMEOUT'); });
    }
    const info = this.chat(peer).locator('.info').filter({ hasText: /\b(?:members?|subscribers?)\b/i });
    await info.waitFor({ timeout: 10000 }).catch(() => { throw new SourceUiError('SOURCE_TYPE_UNAVAILABLE'); });
    const status = await info.innerText();
    const type = /\bsubscribers?\b/i.test(status) ? 'CHANNEL' : /\bmembers?\b/i.test(status) ? 'GROUP' : null;
    if (!type) throw new SourceUiError('SOURCE_UI_UNSUPPORTED');
    return type;
  }
  async admin(peer: string, self: string, check: Check) {
    this.assertOrigin(); await check();
    if (await this.header(peer).count() !== 1) throw new SourceUiError('SOURCE_UI_UNSUPPORTED');
    await this.chat(peer).click();
    const edit = this.page.locator('#column-right').getByRole('button', { name: 'Edit', exact: true });
    if (!await edit.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) return false;
    await edit.click();
    const admins = this.row('Administrators'); await admins.waitFor({ timeout: 10000 }); await admins.click();
    const region = '.chat-administrators-container:visible'; await this.page.locator(region).waitFor({ timeout: 10000 });
    await this.page.locator(`${region} .chatlist-chat`).first().waitFor({ timeout: 10000 });
    let found = false;
    for (let n = 0; n < 40; n++) {
      await check();
      if (await this.page.locator(`${region} .chatlist-chat[data-peer-id="${self}"]:visible`).count() === 1) { found = true; break; }
      if ((await this.scroll(region)).end && n > 1) break;
      await this.page.waitForTimeout(500);
    }
    if (!await this.back()) throw new SourceUiError('SOURCE_UI_UNSUPPORTED');
    return found;
  }
  private async memberRegion(peer: string, check: Check) {
    const type = await this.open(peer, check);
    await this.chat(peer).click();
    let region = '#column-right .search-super-container-members:visible';
    const tab = this.page.locator('#column-right').getByRole('tab', { name: /^Members(?:\s|$)/i });
    if (await tab.isVisible().catch(() => false)) await tab.click();
    if (!await this.page.locator(region).waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)) {
      const edit = this.page.locator('#column-right').getByRole('button', { name: 'Edit', exact: true });
      if (!await edit.isVisible().catch(() => false)) throw new SourceUiError('SOURCE_MEMBERS_UNAVAILABLE');
      await edit.click();
      const members = this.row(type === 'CHANNEL' ? 'Subscribers' : 'Members');
      if (!await members.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) throw new SourceUiError('SOURCE_MEMBERS_UNAVAILABLE');
      await members.click(); region = '.chat-members-container:visible';
      await this.page.locator(region).waitFor({ timeout: 10000 }).catch(() => { throw new SourceUiError('SOURCE_MEMBERS_UNAVAILABLE'); });
    }
    await this.page.locator(`${region} .chatlist-chat`).first().waitFor({ timeout: 10000 });
    return region;
  }
  async members(peer: string, _self: string, limit: number, check: Check, onProgress?: (processed: number) => Promise<void>) {
    let region = await this.memberRegion(peer, check);
    const result = new Map<string, { displayName: string; reference: string; username: string | null }>(); let partial = false; let stable = 0;
    const scanDeadline = Date.now() + 600000;
    for (let n = 0; n < 100000; n++) {
      await check(); if (Date.now() > scanDeadline) { partial = true; break; }
      const old = result.size;
      const rows = await this.page.locator(`${region} .chatlist-chat[data-peer-id]:visible`).evaluateAll(es => es.map(e => {
        const title = e.querySelector('.row-title .peer-title'); const name = (title?.querySelector('.peer-title-inner') ?? title)?.cloneNode(true) as HTMLElement | undefined;
        name?.querySelectorAll('.badge,.member-tag,.tgico,button,svg').forEach(node => node.remove());
        return { reference: e.getAttribute('data-peer-id')!, displayName: name?.textContent?.replace(/\s+/g, ' ').trim() ?? '', subtitle: e.querySelector('.row-subtitle')?.textContent?.trim() ?? '' };
      }));
      for (const row of rows) if (/^\d{1,20}$/.test(row.reference) && row.displayName) { if (!result.has(row.reference) && result.size >= limit) { partial = true; break; } result.set(row.reference, { reference: row.reference, displayName: row.displayName.slice(0, 200), username: /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(row.subtitle) ? row.subtitle : null }); }
      if (partial) break;
      const bottom = await this.scroll(region); stable = bottom.end && old === result.size ? stable + 1 : 0;
      if (stable >= 3) break;
      await this.page.waitForTimeout(250);
    }
    const members = [];
    const deadline = Date.now() + 1800000;
    let inspected = 0;
    for (const member of result.values()) {
      await check();
      let username = member.username, usernameStatus: 'VISIBLE' | 'NOT_VISIBLE' | 'NOT_CHECKED' = username ? 'VISIBLE' : 'NOT_CHECKED';
      if (Date.now() < deadline) {
        try {
          region = await this.memberRegion(peer, check);
          await this.scroll(region, true); await this.page.waitForTimeout(250);
          const row = this.page.locator(`${region} .chatlist-chat[data-peer-id="${member.reference}"]:visible`);
          for (let n = 0; n < 2000 && !await row.count(); n++) { await check(); if (Date.now() > deadline) break; const bottom = await this.scroll(region); await this.page.waitForTimeout(250); if (bottom.end && !await row.count()) break; }
          if (await row.count() !== 1) throw new SourceUiError('SOURCE_PROFILE_UNAVAILABLE');
          await row.locator('.row-title .peer-title').first().click(); await this.header(member.reference).waitFor({ timeout: 12000 });
          const profile = await this.profileUsername(member.reference, check); username = profile.username; usernameStatus = profile.usernameStatus;
        }
        catch { await check(); usernameStatus = username ? 'VISIBLE' : 'NOT_CHECKED'; }
      }
      members.push({ ...member, username, usernameStatus });
      inspected++;
      if (onProgress && (inspected % 5 === 0 || inspected === result.size)) await onProgress(inspected);
    }
    return { members, partial, observedAt: new Date().toISOString() };
  }
  async profileUsername(reference: string, check: Check): Promise<{ username: string | null; usernameStatus: 'VISIBLE' | 'NOT_VISIBLE' }> {
    this.assertOrigin(); await check();
    if (!/^[1-9]\d{0,19}$/.test(reference)) throw new SourceUiError('SOURCE_PROFILE_UNAVAILABLE');
    // Preserve Telegram's loaded member context. Numeric routes after a full reload
    // cannot resolve every non-contact peer. Both chat and profile IDs must match.
    if (!await this.header(reference).isVisible()) { const url = new URL(this.page.url()); url.hash = reference; await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
    await this.header(reference).waitFor({ timeout: 30000 }); await check();
    const ownProfile = /Saved Messages/i.test(await this.header(reference).innerText());
    if (ownProfile) {
      await this.page.locator('#column-left').getByRole('button', { name: 'More', exact: true }).click();
      await this.page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    }
    const profile = this.page.locator(`${ownProfile ? '#column-left' : '#column-right'} .profile-container:visible`).filter({ has: this.page.locator(`.profile-name .peer-title[data-peer-id="${reference}"]`) }).last();
    if (!ownProfile && !await profile.isVisible()) await this.chat(reference).click();
    await profile.waitFor({ timeout: 15000 });
    const row = profile.locator('.row:visible').filter({ has: this.page.locator('.row-subtitle').filter({ hasText: /^(?:Username|نام کاربری)(?:\s|$)/i }) });
    await row.first().waitFor({ timeout: 2000 }).catch(() => undefined);
    await check();
    if (await row.count() === 0) return { username: null, usernameStatus: 'NOT_VISIBLE' };
    if (await row.count() !== 1) throw new SourceUiError('SOURCE_PROFILE_UNAVAILABLE');
    const value = (await row.locator('.row-title').innerText()).trim().replace(/^@/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) throw new SourceUiError('SOURCE_PROFILE_UNAVAILABLE');
    return { username: `@${value.toLowerCase()}`, usernameStatus: 'VISIBLE' };
  }
}
