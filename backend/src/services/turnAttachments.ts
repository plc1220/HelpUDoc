/**
 * Files sent to the model with a message.
 *
 * A file over the limit used to be skipped without telling anyone. Lumo then searched for
 * minutes for content it could not see. The run now
 * carries a note, so Lumo can say what happened and what the user can do.
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** CURRENT_TURN_MULTIMODAL_MAX_BYTES: largest file, in bytes, sent to the model directly. */
export const currentTurnMultimodalMaxBytes = (): number => {
  const raw = Number(process.env.CURRENT_TURN_MULTIMODAL_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
};

export type SkippedAttachment = {
  name: string;
  mimeType: string;
  bytes: number;
  reason: 'too_large' | 'unreadable';
};

/**
 * True only when the bytes cannot be a PDF: no header, or no object at all. Anything else
 * goes to the model, so a PDF that merely looks unusual is never held back.
 */
export const isUnreadablePdf = (buffer: Buffer): boolean =>
  !buffer.subarray(0, 1024).includes('%PDF-') || !buffer.includes('endobj');

export const skipReason = (buffer: Buffer, mimeType: string, maxBytes: number): SkippedAttachment['reason'] | null => {
  if (buffer.length > maxBytes) return 'too_large';
  if (mimeType === 'application/pdf' && isUnreadablePdf(buffer)) return 'unreadable';
  return null;
};

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Appended to the prompt. Empty when every file was sent. */
export const skippedAttachmentsNote = (skipped: SkippedAttachment[], maxBytes: number): string => {
  if (!skipped.length) return '';
  const lines = skipped.map((file) => {
    if (file.reason === 'unreadable') {
      return `- ${file.name}: the file is damaged or is not a real PDF, so it could not be opened. Tell the user, and ask them to upload it again.`;
    }
    return file.mimeType === 'application/pdf'
      ? `- ${file.name} (${megabytes(file.bytes)}): over the ${megabytes(maxBytes)} limit for viewing a file directly. Try inspect_document or search_document once. If they return no text, it is a scan: do not keep searching or try Python. Tell the user it is too large for you to view, and ask them to split or compress it to under ${megabytes(maxBytes)}.`
      : `- ${file.name} (${megabytes(file.bytes)}): over the ${megabytes(maxBytes)} limit for viewing an image directly. Tell the user, and ask for a smaller version.`;
  });
  return ['[Lumo system note] These attached files were not sent to you:', ...lines].join('\n');
};
