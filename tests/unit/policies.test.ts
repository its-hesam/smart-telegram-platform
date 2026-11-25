import { describe, expect, it } from 'vitest';
import { canContact, errorCodes } from '../../packages/shared/src/index.js';
import { failureAction, retryDelay } from '../../packages/queue/src/index.js';
import { accountInputSchema, environmentSchema, jobReferenceSchema } from '../../packages/validation/src/index.js';
describe('consent gate', () => {
  const valid = { status: 'OPTED_IN', timestamp: new Date('2025-01-01'), evidence: 'consent/123', suppressed: false } as const;
  it('accepts recorded opt-in', () => expect(canContact(valid)).toBe(true));
  it.each(['UNKNOWN', 'OPTED_OUT', 'REVOKED'] as const)('blocks %s', status => expect(canContact({ ...valid, status })).toBe(false));
  it('suppression overrides opt-in', () => expect(canContact({ ...valid, suppressed: true })).toBe(false));
  it('authorized outreach bypasses per-contact consent but never suppression', () => {
    expect(canContact({ ...valid, status: 'UNKNOWN', timestamp: null, evidence: null }, true)).toBe(true);
    expect(canContact({ ...valid, suppressed: true }, true)).toBe(false);
  });
  it('requires valid timestamp and evidence', () => {
    expect(canContact({ ...valid, timestamp: null })).toBe(false);
    expect(canContact({ ...valid, timestamp: new Date('invalid') })).toBe(false);
    expect(canContact({ ...valid, timestamp: new Date(Date.now() + 60000) })).toBe(false);
    expect(canContact({ ...valid, evidence: ' ' })).toBe(false);
  });
});
describe('failure policy', () => {
  it.each(errorCodes)('never replays possible mutation (%s)', code => expect(failureAction(code, true, 1)).toBe('MANUAL_REVIEW'));
  it('bounds infrastructure retries', () => {
    expect(failureAction('NETWORK_ERROR', false, 1)).toBe('RETRY');
    expect(failureAction('BROWSER_CRASH', false, 3)).toBe('FAIL');
    expect([1, 2, 3].map(retryDelay)).toEqual([1000, 2000, 4000]);
    expect(() => retryDelay(4)).toThrow();
  });
  it.each(['RATE_LIMITED', 'ACCOUNT_RESTRICTED', 'SESSION_EXPIRED', 'AUTH_REQUIRED'] as const)('pauses %s', code => expect(failureAction(code, false, 1)).toBe('PAUSE'));
  it.each(['PERMISSION_DENIED', 'PRIVACY_RESTRICTED', 'OPERATION_UNSUPPORTED', 'CONSENT_MISSING', 'DUPLICATE_OPERATION', 'UI_ELEMENT_NOT_FOUND'] as const)('does not retry %s', code => expect(failureAction(code, false, 1)).toBe('FAIL'));
  it('reviews unknown outcome', () => expect(failureAction('UNKNOWN_RESULT', false, 0)).toBe('MANUAL_REVIEW'));
});
describe('input boundaries', () => {
  it('requires explicit ownership and E.164 phone', () => {
    expect(accountInputSchema.safeParse({ displayName: 'Test', phone: '+15550000001', ownershipConfirmed: true }).success).toBe(true);
    expect(accountInputSchema.safeParse({ displayName: 'Test', phone: '0912', ownershipConfirmed: true }).success).toBe(false);
    expect(accountInputSchema.safeParse({ displayName: 'Test', phone: '+15550000001', ownershipConfirmed: false }).success).toBe(false);
  });
  it('rejects secrets in queue references', () => {
    const ref = { version: 1, jobId: 'ee818662-5774-4546-bd55-83d5d8983a91', traceId: 'ea8f2c33-9f63-44bc-92c9-86a55322ba11' };
    expect(jobReferenceSchema.safeParse(ref).success).toBe(true);
    expect(jobReferenceSchema.safeParse({ ...ref, password: 'secret' }).success).toBe(false);
  });
  it('validates dependency protocols and bounds', () => {
    expect(environmentSchema.safeParse({ DATABASE_URL: 'https://example.com', REDIS_URL: 'redis://localhost' }).success).toBe(false);
    expect(environmentSchema.safeParse({ DATABASE_URL: 'postgresql://localhost/smart', REDIS_URL: 'redis://localhost', API_PORT: 70000 }).success).toBe(false);
  });
});
