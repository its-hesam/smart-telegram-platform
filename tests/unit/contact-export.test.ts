import { expect, it } from 'vitest';
import { contactCsv, contactExportColumns } from '../../packages/shared/src/contact-export.js';

it('always emits the export header and never exposes a consent column', () => {
  const header = contactCsv([], true);
  expect(header).toContain('displayName');
  expect(header).toContain('telegramId');
  expect(header).not.toContain('consentStatus');
  expect(header.split('\r\n')[0]!.split(',')).toHaveLength(contactExportColumns.length);
});
