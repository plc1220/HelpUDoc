export type OfficeRun = { start: number; end: number; bold: boolean | null; italic: boolean | null; fontSize: number | null };
export type OfficeParagraph = { id: string; text: string; styleId: string | null; editable: boolean; runs: OfficeRun[] };
export type OfficeDocument = { paragraphs: OfficeParagraph[]; styles: Array<{ id: string; name: string }>; protectedTexts?: string[]; hasDynamicFields?: boolean; bodyBounds?: { left: number; top: number; right: number; bottom: number } };
export type OfficeTarget = { paragraph: OfficeParagraph; start: number; end: number; quote: string };
export type OfficeEdit = { paragraphId: string; start: number; end: number; quote: string } & (
  | { action: 'bold' | 'italic'; value: boolean }
  | { action: 'fontSize'; value: number }
  | { action: 'style' | 'replaceText'; value: string }
);

export function decodeOfficeBase64(content: string): ArrayBuffer {
  const binary = window.atob(content.replace(/^data:[^,]+,/, '').replace(/\s/g, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0)).buffer;
}

// PDF line breaks and ligatures can differ from the source. Keep an index back to
// Unicode codepoints in the DOCX, so a displayed glyph never becomes an XML offset.
function searchable(text: string) {
  const characters: string[] = [];
  const offsets: number[] = [];
  Array.from(text).forEach((character, offset) => {
    for (const normalized of character.normalize('NFKC')) {
      if (/\s/u.test(normalized) || normalized === '\u00ad') continue;
      characters.push(normalized);
      // indexOf operates in UTF-16 units, including for non-BMP characters.
      for (let unit = 0; unit < normalized.length; unit++) offsets.push(offset);
    }
  });
  return { text: characters.join(''), offsets };
}

/** Never choose the first of multiple matches, even if one is non-editable. */
export function officeSelectionTargets(document: OfficeDocument, quote: string): OfficeTarget[] {
  const needle = searchable(quote).text;
  if (!needle || needle.length > 8000) return [];
  const targets: OfficeTarget[] = [];
  const paragraphs = [...document.paragraphs, ...(document.protectedTexts || []).map((text, index) => ({ id: `protected:${index}`, text, editable: false, styleId: null, runs: [] }))];
  for (const paragraph of paragraphs) {
    const haystack = searchable(paragraph.text);
    let cursor = haystack.text.indexOf(needle);
    while (cursor !== -1) {
      const start = haystack.offsets[cursor];
      const end = haystack.offsets[cursor + needle.length - 1] + 1;
      // Reject selecting half of a compatibility glyph, e.g. just f in ﬁ.
      const sourceQuote = Array.from(paragraph.text).slice(start, end).join('');
      if (searchable(sourceQuote).text === needle) targets.push({ paragraph, start, end, quote: sourceQuote });
      if (targets.length > 100) return targets; // certainly ambiguous; do not scan an entire book
      cursor = haystack.text.indexOf(needle, cursor + 1);
    }
  }
  // Page text can concatenate unrelated paragraphs. Never use that surrounding
  // text to choose between duplicate body/header/footer/field matches.
  return targets;
}

/** Short generated labels and dynamic fields need an explicit source choice. */
export function officeSelectionNeedsConfirmation(document: OfficeDocument, quote: string): boolean {
  const value = searchable(quote).text;
  return Boolean(document.hasDynamicFields) || value.length < 4 || /^[\d\p{P}\p{S}]+$/u.test(value);
}

export function selectedOfficeFormat(target: OfficeTarget, property: 'bold' | 'italic'): boolean {
  const runs = target.paragraph.runs.filter(run => run.start < target.end && run.end > target.start);
  return runs.length > 0 && runs.every(run => run[property] === true);
}

export function officeEditRequest(target: OfficeTarget, action: OfficeEdit['action'], value: OfficeEdit['value']): OfficeEdit {
  return { paragraphId: target.paragraph.id, start: target.start, end: target.end, quote: target.quote, action, value } as OfficeEdit;
}
