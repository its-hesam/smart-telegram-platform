# Automation engine

The real engine is now implemented in packages/automation-core/src/browser-manager.ts, profile-vault.ts and lease.ts; the strict adapter is in packages/telegram-web-adapter/src/adapter.ts. Chromium fixture tests prove profile recovery/isolation, tamper rejection and visible-send confirmation with fail-closed selector handling. Only the logged-out official Telegram Web K UI was inspected live. The default registry has no authenticated selectors; actual Telegram account/message acceptance is pending.

Phase 1 defines interfaces only; there is no live browser engine yet. BrowserManager owns acquire/open/close/health and resource limits, not messaging. TelegramWebAdapter owns searchChat/openChat/openGroup/openChannel/getVisibleChatInfo/sendApprovedMessage/checkSession/detectUiError. Inputs are typed; outcomes distinguish unsupported, auth required, UI confirmed and unknown.

Before implementing selectors, inspect the authorized test account's visible UI. Registry versions include Telegram Web variant and locale. Prefer accessible roles/labels; no hidden data extraction, internal HTTP calls or random class selectors. Multiple matching targets fail closed. Do not ship guessed selectors. Browser tests use a controlled fixture first, then an explicitly authorized account.

See ARCHITECTURE.md for durable mutation and account fencing design. Cancellation is cooperative and checked before UI mutation; cancellation after a click cannot unsend a message.
