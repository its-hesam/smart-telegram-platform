export const accountStatuses = ['DISCONNECTED', 'AUTH_REQUIRED', 'AUTHENTICATING', 'CONNECTED', 'SESSION_EXPIRED', 'ACTION_REQUIRED', 'RESTRICTED', 'PAUSED', 'ERROR'] as const;
export type AccountStatus = typeof accountStatuses[number];
export type ConsentStatus = 'UNKNOWN' | 'OPTED_IN' | 'OPTED_OUT' | 'REVOKED';
export const errorCodes = ['UI_ELEMENT_NOT_FOUND', 'SESSION_EXPIRED', 'AUTH_REQUIRED', 'NETWORK_ERROR', 'BROWSER_CRASH', 'PERMISSION_DENIED', 'PRIVACY_RESTRICTED', 'RATE_LIMITED', 'ACCOUNT_RESTRICTED', 'OPERATION_UNSUPPORTED', 'CONSENT_MISSING', 'AUTHORIZATION_MISSING', 'SUPPRESSED', 'DUPLICATE_OPERATION', 'UNKNOWN_RESULT'] as const;
export type ErrorCode = typeof errorCodes[number];
export type Outcome<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };
export interface SystemEvent {
  version: 1;
  id: string;
  type: string;
  occurredAt: string;
  resourceId: string;
  traceId: string;
}
export interface ConsentSnapshot {
  status: ConsentStatus;
  timestamp: Date | null;
  evidence: string | null;
  suppressed: boolean;
}
export function canContact(consent: ConsentSnapshot, authorized = false): boolean {
  // A recorded operator-level legal authorization removes the per-contact
  // consent requirement, but never overrides suppression or an opt-out key.
  if (consent.suppressed) return false;
  if (authorized) return true;
  return consent.status === 'OPTED_IN' && consent.timestamp !== null
    && Number.isFinite(consent.timestamp.getTime()) && consent.timestamp.getTime() <= Date.now()
    && Boolean(consent.evidence?.trim());
}
