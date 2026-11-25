import type { ErrorCode, Outcome } from '../../shared/src/index.js';
export interface VisibleChat { title: string; type: 'USER' | 'GROUP' | 'CHANNEL'; }
export interface ApprovedMessage {
  recipientReference: string;
  content: string;
  idempotencyKey: string;
  // Worker must recheck durable consent, cancellation and lease before clicking send.
  beforeMutation: () => Promise<void>;
}
export interface TelegramWebAdapter {
  searchChat(query: string, signal: AbortSignal): Promise<Outcome<VisibleChat[]>>;
  openChat(reference: string, signal: AbortSignal): Promise<Outcome<VisibleChat>>;
  openGroup(reference: string, signal: AbortSignal): Promise<Outcome<VisibleChat>>;
  openChannel(reference: string, signal: AbortSignal): Promise<Outcome<VisibleChat>>;
  getVisibleChatInfo(): Promise<Outcome<VisibleChat>>;
  sendApprovedMessage(input: ApprovedMessage, signal: AbortSignal): Promise<Outcome<'SENT_UI_CONFIRMED'>>;
  checkSession(): Promise<Outcome<'CONNECTED'>>;
  detectUiError(): Promise<ErrorCode | null>;
}
export interface SelectorRegistry {
  version: string;
  variant: 'a' | 'k';
  locale: string;
  selectors: Readonly<Record<string, { role: string; accessibleName: string }>>;
}
