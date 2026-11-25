import { parentPort, workerData } from 'node:worker_threads';
import { readSheet } from 'read-excel-file/node';
try {
  const sheet = await readSheet(Buffer.from(workerData as Uint8Array));
  if (sheet.length > 501 || sheet.some(row => row.length > 16)) throw new Error('Workbook exceeds limits');
  const headers = sheet[0]?.map(String) ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate columns');
  parentPort?.postMessage({ ok: true, rows: sheet.slice(1).map(row => Object.fromEntries(headers.map((key, index) => [key, row[index] instanceof Date ? (row[index] as Date).toISOString() : row[index] ?? '']))) });
} catch { parentPort?.postMessage({ ok: false }); }
