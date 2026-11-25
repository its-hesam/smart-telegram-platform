import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { FieldCipher } from './crypto.js';
import { rowsWorkbook } from './xlsx.js';

export const contactExportFormats = ['csv', 'xlsx'] as const;
export type ContactExportFormat = typeof contactExportFormats[number];

export const contactExportFilterSchema = z.strictObject({
  consentStatus: z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'REVOKED']).optional(),
  listId: z.uuid().optional(),
  tag: z.string().trim().min(1).max(40).optional(),
});
export type ContactExportFilter = z.infer<typeof contactExportFilterSchema>;

export const contactExportJobSchema = z.strictObject({
  format: z.enum(contactExportFormats).default('csv'),
  consentStatus: z.enum(['UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'REVOKED']).optional(),
  listId: z.uuid().optional(),
  tag: z.string().trim().min(1).max(40).optional(),
});

export const contactExportColumns = ['displayName', 'username', 'phone', 'telegramId', 'tags', 'source', 'suppressed', 'createdAt'] as const;
export type ContactExportRow = Record<(typeof contactExportColumns)[number], string>;

export type ContactCipherRow = {
  id: string;
  encryptedDisplayName: string;
  encryptedUsername: string | null;
  encryptedPhone: string | null;
  encryptedTelegramId: string | null;
  tags: string[];
  source: string;
  createdAt: Date;
};

export function contactExportRow(cipher: FieldCipher, row: ContactCipherRow, suppressed: boolean): ContactExportRow {
  const decrypt = (value: string | null, field: string) => value ? cipher.decrypt(value, `contact:${row.id}:${field}`) : '';
  return {
    displayName: decrypt(row.encryptedDisplayName, 'displayName').replace(/\s+/g, ' ').trim(),
    username: decrypt(row.encryptedUsername, 'username'),
    phone: decrypt(row.encryptedPhone, 'phone'),
    telegramId: decrypt(row.encryptedTelegramId, 'telegramId'),
    tags: row.tags.join('|'),
    source: row.source,
    suppressed: suppressed ? 'true' : 'false',
    createdAt: row.createdAt.toISOString(),
  };
}

export function contactCsv(rows: readonly ContactExportRow[], header: boolean): string {
  return stringify([...rows], { columns: [...contactExportColumns], header, quoted: true, quoted_empty: true, record_delimiter: '\r\n', escape_formulas: true });
}

export function contactWorkbook(rows: readonly ContactExportRow[]): Buffer {
  return rowsWorkbook('Contacts', [...contactExportColumns], rows.map(row => contactExportColumns.map(column => row[column])));
}
