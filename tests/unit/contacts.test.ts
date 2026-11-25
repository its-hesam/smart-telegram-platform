import { expect, it } from 'vitest';
import { contactInputSchema, consentInputSchema } from '../../apps/api/src/contacts.js';
it('never infers opt-in from a CSV row or a username', () => {
  expect(contactInputSchema.parse({ displayName: 'Name', username: '@Test_User' })).toMatchObject({ consentStatus: 'UNKNOWN', username: 'test_user' });
  expect(contactInputSchema.safeParse({ displayName: 'Name', username: 'test_user', consentStatus: 'OPTED_IN' }).success).toBe(false);
  expect(consentInputSchema.safeParse({ consentStatus: 'OPTED_IN', consentTimestamp: new Date(Date.now() + 60000).toISOString(), consentEvidenceReference: 'record/1' }).success).toBe(false);
  expect(consentInputSchema.safeParse({ consentStatus: 'OPTED_IN', consentTimestamp: '2026-01-01T00:00:00Z', consentEvidenceReference: 'record/1' }).success).toBe(true);
});
