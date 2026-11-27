import type { CellObject } from 'xlsx';

/** The SheetJS functions the preview uses. FileRenderer passes in the lazily loaded module. */
type SheetJS = Pick<typeof import('xlsx'), 'read' | 'utils'>;

export type SpreadsheetCell = {
  /** A1-style address, e.g. "C5". */
  address: string;
  text: string;
  /** Formula without the leading "=". */
  formula?: string;
  /** The cell has a formula but the file stored no result. The preview never calculates one. */
  missingValue?: boolean;
};

export type SheetPreview = {
  name: string;
  hidden: boolean;
  isEmpty: boolean;
  /** Counted from A1 to the sheet's last used row and column, so they match the grid. */
  totalRows: number;
  totalColumns: number;
  lastColumnLabel: string;
  /** Visible column letters, starting at A. */
  columnLabels: string[];
  /** Visible rows, starting at row 1. Every visible cell is present, including blanks. */
  rows: SpreadsheetCell[][];
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

export type WorkbookPreview = { sheets: SheetPreview[] };

export type SpreadsheetPreviewLimits = { maxRows: number; maxColumns: number };

const toPreviewCell = (address: string, cell: CellObject | undefined): SpreadsheetCell => {
  const formula = typeof cell?.f === 'string' && cell.f ? cell.f : undefined;
  // SheetJS reads a formula with an empty or missing <v> as a stub (t: 'z') and fills v with 0.
  // Show it as "no saved value" instead of that made-up 0.
  if (!cell || cell.t === 'z') {
    return formula ? { address, text: '', formula, missingValue: true } : { address, text: '' };
  }
  const text = cell.w ?? (cell.v == null ? '' : String(cell.v));
  return formula ? { address, text, formula } : { address, text };
};

/**
 * Read every sheet of a workbook into a grid that starts at A1, so blank rows,
 * blank columns and data that starts away from A1 keep their real addresses.
 * Read-only: nothing is recalculated or written back.
 */
export function buildWorkbookPreview(
  XLSX: SheetJS,
  data: ArrayBuffer | Uint8Array,
  limits: SpreadsheetPreviewLimits,
): WorkbookPreview {
  // sheetStubs keeps formula cells that have no saved value; sheetRows stops parsing past the row limit.
  const workbook = XLSX.read(data, { type: 'array', cellFormula: true, sheetStubs: true, sheetRows: limits.maxRows });
  const sheetProps = workbook.Workbook?.Sheets ?? [];

  return {
    sheets: workbook.SheetNames.map((name, index): SheetPreview => {
      const worksheet = workbook.Sheets[name] ?? {};
      // With sheetRows, !ref is cut at the limit and !fullref keeps the sheet's real size.
      const ref: string | undefined = worksheet['!fullref'] ?? worksheet['!ref'];
      const range = ref ? XLSX.utils.decode_range(ref) : null;
      const hasContent = Object.keys(worksheet).some((key) => {
        if (key.startsWith('!')) return false;
        const cell = worksheet[key] as CellObject;
        return cell.t !== 'z' || Boolean(cell.f);
      });
      const rangeRows = range ? range.e.r + 1 : 0;
      // Content past the row limit is not parsed, so a cut-off sheet is never reported as empty.
      const isEmpty = !hasContent && rangeRows <= limits.maxRows;
      const totalRows = isEmpty ? 0 : rangeRows;
      const totalColumns = isEmpty || !range ? 0 : range.e.c + 1;
      const columnLabels = Array.from(
        { length: Math.min(totalColumns, limits.maxColumns) },
        (_, column) => XLSX.utils.encode_col(column),
      );
      const rows = Array.from({ length: Math.min(totalRows, limits.maxRows) }, (_, row) =>
        columnLabels.map((_, column) => {
          const address = XLSX.utils.encode_cell({ r: row, c: column });
          return toPreviewCell(address, worksheet[address] as CellObject | undefined);
        }),
      );

      return {
        name,
        hidden: Boolean(sheetProps[index]?.Hidden),
        isEmpty,
        totalRows,
        totalColumns,
        lastColumnLabel: totalColumns ? XLSX.utils.encode_col(totalColumns - 1) : '',
        columnLabels,
        rows,
        truncatedRows: totalRows > limits.maxRows,
        truncatedColumns: totalColumns > limits.maxColumns,
      };
    }),
  };
}
