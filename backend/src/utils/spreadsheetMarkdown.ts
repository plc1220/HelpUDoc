import ExcelJS from 'exceljs';

const DEFAULT_MAX_ROWS_PER_SHEET = 1000;
const DEFAULT_MAX_COLUMNS_PER_SHEET = 100;
const DEFAULT_MAX_CELL_CHARS = 500;

type SpreadsheetMarkdownOptions = {
  title?: string;
  sourceUrl?: string | null;
  maxRowsPerSheet?: number;
  maxColumnsPerSheet?: number;
  maxCellChars?: number;
};

const toCsvCell = (value: unknown, maxCellChars: number): string => {
  let text = String(value ?? '');
  if (maxCellChars > 0 && text.length > maxCellChars) {
    text = `${text.slice(0, maxCellChars).trimEnd()} [truncated]`;
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const toCsvText = (rows: unknown[][], maxCellChars: number): string =>
  rows.map((row) => row.map((cell) => toCsvCell(cell, maxCellChars)).join(',')).join('\n');

const trimEmptyTrailingCells = (row: unknown[]): unknown[] => {
  const next = row.slice();
  while (next.length && String(next[next.length - 1] ?? '').trim() === '') {
    next.pop();
  }
  return next;
};

const normalizeRows = (
  rows: unknown[][],
  maxRows: number,
  maxColumns: number,
): { rows: unknown[][]; truncatedRows: boolean; truncatedColumns: boolean } => {
  const limitedRows = rows
    .map(trimEmptyTrailingCells)
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  const truncatedRows = maxRows > 0 && limitedRows.length > maxRows;
  const rowSlice = truncatedRows ? limitedRows.slice(0, maxRows) : limitedRows;
  const widest = rowSlice.reduce((max, row) => Math.max(max, row.length), 0);
  const columnCount = maxColumns > 0 ? Math.min(widest, maxColumns) : widest;
  const truncatedColumns = maxColumns > 0 && widest > maxColumns;
  return {
    rows: rowSlice.map((row) => row.slice(0, columnCount)),
    truncatedRows,
    truncatedColumns,
  };
};

export const workbookBufferToMarkdown = (
  buffer: Buffer,
  options: SpreadsheetMarkdownOptions = {},
): Promise<string> => workbookToMarkdown(buffer, options);

const cellToText = (cell: ExcelJS.Cell): string => {
  if (cell.text) {
    return cell.text;
  }
  const value = cell.value;
  if (value == null) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    if ('result' in value && value.result != null) {
      return String(value.result);
    }
    if ('text' in value && value.text != null) {
      return String(value.text);
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((item: any) => String(item?.text || '')).join('');
    }
    if ('hyperlink' in value && 'text' in value && value.text != null) {
      return String(value.text);
    }
  }
  return String(value);
};

const workbookToMarkdown = async (
  buffer: Buffer,
  options: SpreadsheetMarkdownOptions = {},
): Promise<string> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const title = options.title?.trim() || 'Spreadsheet';
  const maxRows = options.maxRowsPerSheet ?? DEFAULT_MAX_ROWS_PER_SHEET;
  const maxColumns = options.maxColumnsPerSheet ?? DEFAULT_MAX_COLUMNS_PER_SHEET;
  const maxCellChars = options.maxCellChars ?? DEFAULT_MAX_CELL_CHARS;
  const sections: string[] = [`# ${title}`];

  if (options.sourceUrl?.trim()) {
    sections.push(`Imported from Google Drive: ${options.sourceUrl.trim()}`);
  }

  if (!workbook.worksheets.length) {
    sections.push('This workbook did not contain any readable sheets.');
    return `${sections.join('\n\n')}\n`;
  }

  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const rawRows: unknown[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values: unknown[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        values[colNumber - 1] = cellToText(cell);
      });
      rawRows.push(values);
    });
    const { rows, truncatedRows, truncatedColumns } = normalizeRows(rawRows, maxRows, maxColumns);
    const notes = [
      truncatedRows ? `Rows limited to first ${maxRows}.` : null,
      truncatedColumns ? `Columns limited to first ${maxColumns}.` : null,
    ].filter(Boolean);
    sections.push(
      [
        `## ${sheetName}`,
        notes.length ? `> ${notes.join(' ')}` : '',
        rows.length ? `\`\`\`csv\n${toCsvText(rows, maxCellChars)}\n\`\`\`` : '(No data)',
      ].filter(Boolean).join('\n\n'),
    );
  }

  return `${sections.join('\n\n')}\n`;
};
