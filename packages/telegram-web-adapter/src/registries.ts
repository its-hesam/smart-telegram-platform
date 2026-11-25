import type { SelectorRegistry } from './index.js';
// Observed on the public, logged-out official Telegram Web K UI, 2026-11-06.
// Authenticated selectors deliberately absent until tested with an authorized account.
export const publicEnglishK: SelectorRegistry = {
  version: 'telegram-k-en-2026-11-06-login-only', variant: 'k', locale: 'en',
  selectors: { authRequired: { role: 'heading', accessibleName: 'Log in by QR Code' }, phoneLogin: { role: 'button', accessibleName: 'Log in by phone number' } },
};
