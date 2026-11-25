import { it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import readXlsxFile from 'read-excel-file/node';
import { memberColumns, memberRows, memberWorkbook } from '../../packages/shared/src/member-export.js';
it('preserves empty usernames, text IDs and formula-looking names in real XLSX cells', async () => {
  const data = { members: [{ displayName: 'Super proxy\tAdmin', reference: '8728609140', username: null }, { displayName: '=2+2, test', reference: '995151904', username: '@fixture_user' }], partial: false, observedAt: '2026-11-06T12:21:56.797Z' };
  const xlsx = (await readXlsxFile(memberWorkbook(data)))[0]!.data;
  expect(xlsx[0]).toEqual([...memberColumns]); expect(xlsx[1]?.[0]).toBe('Super proxy Admin'); expect(xlsx[1]?.[1]).toBe(null); expect(xlsx[1]?.[2]).toBe('8728609140'); expect(xlsx[1]?.[3]).toBe('https://web.telegram.org/k/#8728609140'); expect(xlsx[2]?.[0]).toBe('=2+2, test');
  const csv = stringify(memberRows(data), { columns: [...memberColumns], header: true, quoted: true, quoted_empty: true, record_delimiter: '\r\n', escape_formulas: true });
  const rows = parse(csv); expect(rows.map((r: string[]) => r.length)).toEqual([7, 7, 7]); expect(rows[1]![1]).toBe(''); expect(rows[1]![2]).toBe('8728609140'); expect(rows[2]![0]).toBe("'=2+2, test");
});
