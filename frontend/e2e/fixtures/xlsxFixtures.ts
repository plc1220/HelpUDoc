import JSZip from 'jszip';

/**
 * Minimal XLSX workbooks for the spreadsheet preview tests (issue #106).
 * Built from raw XML so every cell is exact, including whether a formula has a
 * saved value. Runs in Node (unit tests) and in the browser (fixture page).
 */

/** Text, a number, or a formula. `saved` undefined writes no <v>; '' writes an empty <v></v>. */
export type FixtureCell = string | number | { formula: string; saved?: string };
export type FixtureSheet = { name: string; hidden?: boolean; cells: Record<string, FixtureCell> };

const escapeXml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const columnName = (index: number): string => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const splitAddress = (address: string) => {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) throw new Error(`Invalid cell address: ${address}`);
  const column = [...match[1]].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return { row: Number(match[2]) - 1, column };
};

const cellXml = (address: string, cell: FixtureCell) => {
  if (typeof cell === 'number') return `<c r="${address}"><v>${cell}</v></c>`;
  if (typeof cell === 'string') return `<c r="${address}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
  const saved = cell.saved === undefined ? '' : `<v>${escapeXml(cell.saved)}</v>`;
  return `<c r="${address}"><f>${escapeXml(cell.formula)}</f>${saved}</c>`;
};

const sheetXml = (sheet: FixtureSheet) => {
  const cells = Object.entries(sheet.cells)
    .map(([address, cell]) => ({ address, cell, ...splitAddress(address) }))
    .sort((a, b) => a.row - b.row || a.column - b.column);
  const rows = new Map<number, string[]>();
  for (const item of cells) rows.set(item.row, [...(rows.get(item.row) ?? []), cellXml(item.address, item.cell)]);
  const rowXml = [...rows].map(([row, xml]) => `<row r="${row + 1}">${xml.join('')}</row>`).join('');
  // Like openpyxl, an empty sheet still declares A1:A1, so SheetJS reports a range with no cells.
  const dimension = cells.length
    ? `${columnName(Math.min(...cells.map(c => c.column)))}${Math.min(...cells.map(c => c.row)) + 1}:${columnName(Math.max(...cells.map(c => c.column)))}${Math.max(...cells.map(c => c.row)) + 1}`
    : 'A1:A1';
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${rowXml}</sheetData></worksheet>`;
};

export async function buildXlsx(sheets: FixtureSheet[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${sheetType}"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}"${sheet.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  sheets.forEach((sheet, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)));
  return zip.generateAsync({ type: 'uint8array' });
}

const bigCells: Record<string, FixtureCell> = {};
for (let row = 0; row < 150; row += 1) {
  for (let column = 0; column < 25; column += 1) bigCells[`${columnName(column)}${row + 1}`] = `${columnName(column)}${row + 1}`;
}

export const XLSX_FIXTURES = {
  multi: [
    {
      name: 'Alpha',
      cells: {
        A1: 'Name', C1: 'Score',
        A2: 'Ann', C2: 10,
        // Row 3 and column B are intentionally empty.
        A4: 'Bob', C4: 20,
        A5: 'Total', C5: { formula: 'C2+C4', saved: '30' },
        A6: 'Empty saved value', C6: { formula: 'C2*2', saved: '' },
        A7: 'No saved value', C7: { formula: 'C4*2' },
      },
    },
    { name: 'Beta', cells: { B3: 'hello from Beta' } },
    { name: 'Secret', hidden: true, cells: { A1: 'hidden' } },
    { name: 'Big', cells: bigCells },
  ],
  offset: [{ name: 'Sheet1', cells: { C3: 'C3 here' } }],
  emptyFirst: [{ name: 'Blank', cells: {} }, { name: 'Data', cells: { A1: 'x' } }],
} satisfies Record<string, FixtureSheet[]>;

export type XlsxFixtureName = keyof typeof XLSX_FIXTURES;

export const buildXlsxFixture = (name: XlsxFixtureName) => buildXlsx(XLSX_FIXTURES[name]);
