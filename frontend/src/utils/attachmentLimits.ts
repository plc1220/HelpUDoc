/**
 * The size above which Lumo is not shown a PDF or image directly. The server decides; the
 * value here comes from it and only words the notice. Files over it can still be sent.
 */
let maxBytes = 8 * 1024 * 1024;

export const setAttachmentMaxBytes = (value: unknown): void => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    maxBytes = value;
  }
};

export type AttachmentSize = { name: string; mimeType?: string | null; bytes?: number | string | null };

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const kindOf = (file: AttachmentSize): 'pdf' | 'image' | null => {
  const mime = String(file.mimeType || '').toLowerCase();
  const name = file.name.toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
  return null;
};

/** What to tell the user about large attachments before sending, or null. */
export const oversizeAttachmentNotice = (files: AttachmentSize[], limit: number = maxBytes): string | null => {
  const large = files
    .map((file) => ({ name: file.name, kind: kindOf(file), bytes: file.bytes == null ? NaN : Number(file.bytes) }))
    .filter((file) => file.kind && Number.isFinite(file.bytes) && file.bytes > limit);
  if (!large.length) return null;
  const list = large.map((file) => `${file.name} (${megabytes(file.bytes)})`).join(', ');
  const advice = [
    large.some((file) => file.kind === 'pdf')
      ? 'It can still read selectable text in a PDF. If it is a scan, split or compress it first.'
      : '',
    large.some((file) => file.kind === 'image') ? 'Use a smaller version of an image.' : '',
  ].filter(Boolean).join(' ');
  return `${list}: Lumo can't view files over ${megabytes(limit)} directly. ${advice}`;
};
