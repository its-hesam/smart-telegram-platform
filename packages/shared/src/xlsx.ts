import { strToU8, zipSync } from 'fflate';

const clean = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const xml = (value: string) => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const columnName = (index: number) => {
  let value = index + 1;
  let name = '';
  while (value > 0) { const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26); }
  return name;
};

/**
 * Build a real XLSX workbook with inline strings. Rows are supplied already
 * as display strings so callers keep control over decryption and redaction.
 */
export function rowsWorkbook(sheetName: string, columns: readonly string[], rows: readonly (readonly string[])[]): Buffer {
  if (!columns.length) throw new Error('Workbook requires at least one column');
  const all = [columns, ...rows];
  const lastColumn = columnName(columns.length - 1);
  const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="' + columns.length + '" width="26" customWidth="1"/></cols><sheetData>'
    + all.map((row, rowIndex) => `<row r="${rowIndex + 1}">` + row.map((value, columnIndex) => `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`).join('') + '</row>').join('')
    + `</sheetData><autoFilter ref="A1:${lastColumn}${all.length}"/></worksheet>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])), { level: 6 }));
}
