import { useState } from 'react';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import type { SheetPreview, WorkbookPreview } from '../utils/spreadsheetPreview';
import './SpreadsheetPreview.css';

const MISSING_VALUE_LABEL = 'Formula, no saved value';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const limitLabel = (sheet: SheetPreview) => {
  const parts = [
    sheet.truncatedRows ? `rows 1–${sheet.rows.length} of ${sheet.totalRows}` : null,
    sheet.truncatedColumns ? `columns A–${sheet.columnLabels[sheet.columnLabels.length - 1]} of ${sheet.lastColumnLabel}` : null,
  ].filter(Boolean);
  return parts.length ? `Showing ${parts.join(' · ')}` : '';
};

/** Read-only workbook preview: one tab per sheet and an A1-based grid that keeps cell addresses. */
export default function SpreadsheetPreview({ preview }: { preview: WorkbookPreview }) {
  const [selectedName, setSelectedName] = useState(() => preview.sheets[0]?.name ?? '');
  const sheet = preview.sheets.find((item) => item.name === selectedName) ?? preview.sheets[0];
  if (!sheet) return null;
  const limits = limitLabel(sheet);

  return (
    <div className="spreadsheet-preview">
      <div className="spreadsheet-preview-tabs">
        <TabList value={sheet.name} onChange={setSelectedName} size="sm" hasDivider aria-label="Worksheets">
          {preview.sheets.map((item) => (
            <Tab key={item.name} value={item.name} label={item.hidden ? `${item.name} (hidden)` : item.name} />
          ))}
        </TabList>
      </div>
      <div className="spreadsheet-preview-summary">
        <strong>{sheet.name}</strong>
        {sheet.isEmpty ? null : ` · ${plural(sheet.totalRows, 'row')} · ${plural(sheet.totalColumns, 'column')}`}
        {limits ? ` · ${limits}` : null}
      </div>
      {sheet.isEmpty ? (
        <p className="spreadsheet-preview-empty">Sheet “{sheet.name}” has no cell data.</p>
      ) : (
        <div className="spreadsheet-preview-grid" role="region" aria-label={`${sheet.name} cells`} tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th aria-hidden="true" />
                {sheet.columnLabels.map((label) => <th key={label} scope="col">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th scope="row">{rowIndex + 1}</th>
                  {row.map((cell) => (
                    <td key={cell.address} data-sheet={sheet.name} data-cell={cell.address} title={cell.formula ? `=${cell.formula}` : undefined}>
                      <div className="spreadsheet-preview-cell">
                        {cell.text}
                        {cell.missingValue ? (
                          <span className="spreadsheet-preview-formula-marker" role="img" aria-label={MISSING_VALUE_LABEL} title={MISSING_VALUE_LABEL}>ƒ</span>
                        ) : null}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
