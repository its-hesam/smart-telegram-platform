import type { ErrorCode } from '../../shared/src/index.js';
export const jobTypes = ['SESSION_VALIDATION', 'ACCOUNT_HEALTH_CHECK', 'APPROVED_MESSAGE_SEND', 'CAMPAIGN_EXECUTION', 'GROUP_INFORMATION_READ', 'INVITATION_MANAGEMENT', 'CONSENT_IMPORT', 'DATA_EXPORT', 'CLEANUP', 'REPORT_GENERATION'] as const;
export type JobType = typeof jobTypes[number];
export type FailureAction = 'RETRY' | 'FAIL' | 'PAUSE' | 'MANUAL_REVIEW';
export function failureAction(code: ErrorCode, mutationMayHaveOccurred: boolean, attempt: number): FailureAction {
  if (mutationMayHaveOccurred || code === 'UNKNOWN_RESULT') return 'MANUAL_REVIEW';
  if (['RATE_LIMITED', 'ACCOUNT_RESTRICTED', 'SESSION_EXPIRED', 'AUTH_REQUIRED'].includes(code)) return 'PAUSE';
  if (['NETWORK_ERROR', 'BROWSER_CRASH'].includes(code) && attempt < 3) return 'RETRY';
  return 'FAIL';
}
// Mutating jobs never use BullMQ automatic retries or automatic stalled replay.
// Durable PostgreSQL dispatcher must reconcile PROCESSING to UNKNOWN before dispatch.
export const mutatingJobOptions = { attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 } as const;
export function retryDelay(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new RangeError('Retry attempt must be 1..3');
  return 1000 * 2 ** (attempt - 1);
}
