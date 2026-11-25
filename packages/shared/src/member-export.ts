import { memberResultSchema } from './account-sources.js';
import { rowsWorkbook } from './xlsx.js';

// Consent is an operator-level legal record, not a per-row export column.
export const memberColumns = ['displayName', 'username', 'telegramId', 'telegramWebReference', 'observedAt', 'partial', 'usernameStatus'] as const;
export function memberRows(input: unknown) {
  const data = memberResultSchema.parse(input);
  return data.members.map(m => ({ displayName: m.displayName.replace(/\s+/g, ' ').trim(), username: m.username ?? '', telegramId: m.reference, telegramWebReference: `https://web.telegram.org/k/#${m.reference}`, observedAt: data.observedAt, partial: data.partial ? 'true' : 'false', usernameStatus: m.username ? 'VISIBLE' : m.usernameStatus }));
}
export function memberWorkbook(input: unknown): Buffer {
  const rows = memberRows(input);
  return rowsWorkbook('Members', [...memberColumns], rows.map(row => memberColumns.map(column => String(row[column]))));
}
