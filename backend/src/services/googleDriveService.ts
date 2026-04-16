import { createHash } from 'crypto';
import path from 'path';
import { HttpError } from '../errors';
import { FileService } from './fileService';
import { GoogleOAuthService } from './googleOAuthService';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DOCS_API_BASE = 'https://docs.googleapis.com/v1/documents';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDE_MIME = 'application/vnd.google-apps.presentation';
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type WorkspaceFile = {
  id: string | number;
  name: string;
  workspaceId?: string;
  storageType?: 'local' | 's3';
  path?: string;
  mimeType?: string | null;
  publicUrl?: string | null;
  content?: string;
};

type GoogleDrivePickerScope = 'recent' | 'my-drive' | 'shared';

type GoogleDrivePickerItem = {
  id: string;
  name: string;
  mimeType: string;
  webViewUrl?: string | null;
  modifiedTime?: string | null;
  ownerNames?: string[];
  size?: string | null;
  iconHint: 'docs' | 'sheets' | 'slides' | 'pdf' | 'image' | 'file';
  scope?: GoogleDrivePickerScope;
};

type GoogleDriveSearchResult = {
  files: GoogleDrivePickerItem[];
  nextPageToken?: string | null;
};

type DriveOwner = {
  displayName?: string;
};

type DriveFileMetadata = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
  owners?: DriveOwner[];
};

type GoogleDocsDocument = {
  title?: string;
  body?: {
    content?: GoogleDocsStructuralElement[];
  };
};

type GoogleDocsStructuralElement = {
  paragraph?: {
    elements?: Array<{
      textRun?: {
        content?: string;
      };
    }>;
    paragraphStyle?: {
      namedStyleType?: string;
    };
  };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{
        content?: GoogleDocsStructuralElement[];
      }>;
    }>;
  };
  tableOfContents?: {
    content?: GoogleDocsStructuralElement[];
  };
};

type ImportPayload = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  forceLocal?: boolean;
};

type PreparedImport = {
  fileId: string;
  resolvedName: string;
  payload: ImportPayload;
  fingerprint: string;
  sourceUrl?: string | null;
  existingFile?: WorkspaceFile | null;
};

const escapeDriveQuery = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");

const sanitizeImportedName = (value: string, fallback: string) => {
  const normalized = String(value || '')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || fallback;
};

const appendExtension = (name: string, extension: string) => {
  if (name.toLowerCase().endsWith(extension.toLowerCase())) {
    return name;
  }
  return `${name}${extension}`;
};

const collapseWhitespace = (value: string) =>
  value
    .replace(/\u000b/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const markdownHeadingForNamedStyle = (namedStyleType?: string): string | null => {
  switch (String(namedStyleType || '').trim()) {
    case 'TITLE':
      return '#';
    case 'SUBTITLE':
      return '##';
    case 'HEADING_1':
      return '##';
    case 'HEADING_2':
      return '###';
    case 'HEADING_3':
      return '####';
    case 'HEADING_4':
      return '#####';
    default:
      return null;
  }
};

const renderGoogleDocsParagraph = (
  paragraph: NonNullable<GoogleDocsStructuralElement['paragraph']>,
): string => {
  const rawText = (paragraph.elements || [])
    .map((element) => String(element.textRun?.content || ''))
    .join('');
  const text = collapseWhitespace(rawText);
  if (!text) {
    return '';
  }
  const headingPrefix = markdownHeadingForNamedStyle(paragraph.paragraphStyle?.namedStyleType);
  return headingPrefix ? `${headingPrefix} ${text}` : text;
};

const renderGoogleDocsTable = (
  table: NonNullable<GoogleDocsStructuralElement['table']>,
): string => {
  const rows = (table.tableRows || [])
    .map((row) =>
      (row.tableCells || [])
        .map((cell) =>
          collapseWhitespace(renderGoogleDocsStructuralContent(cell.content || [])) || ' '
        ),
    )
    .filter((row) => row.length);
  if (!rows.length) {
    return '';
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => {
    const next = row.slice();
    while (next.length < columnCount) {
      next.push(' ');
    }
    return next;
  });
  const [header, ...rest] = normalizedRows;
  const separator = new Array(columnCount).fill('---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rest.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
};

const renderGoogleDocsStructuralContent = (
  content: GoogleDocsStructuralElement[],
): string => {
  const sections: string[] = [];
  for (const element of content) {
    if (element.paragraph) {
      const paragraph = renderGoogleDocsParagraph(element.paragraph);
      if (paragraph) {
        sections.push(paragraph);
      }
      continue;
    }
    if (element.table) {
      const table = renderGoogleDocsTable(element.table);
      if (table) {
        sections.push(table);
      }
      continue;
    }
    if (element.tableOfContents?.content?.length) {
      const toc = renderGoogleDocsStructuralContent(element.tableOfContents.content);
      if (toc) {
        sections.push(toc);
      }
    }
  }
  return sections.join('\n\n').trim();
};

const toCsvCell = (value: unknown) => {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const toCsvText = (rows: string[][]) =>
  rows.map((row) => row.map((cell) => toCsvCell(cell)).join(',')).join('\n');

const extractDriveFileId = (value?: string): string | null => {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) {
    return raw;
  }

  try {
    const url = new URL(raw);
    const directId = url.searchParams.get('id');
    if (directId && /^[a-zA-Z0-9_-]{20,}$/.test(directId)) {
      return directId;
    }
    const match = url.pathname.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    return null;
  }

  return null;
};

const rangeForSheet = (title: string) => `'${title.replace(/'/g, "''")}'`;

const toIconHint = (mimeType: string): GoogleDrivePickerItem['iconHint'] => {
  if (mimeType === GOOGLE_DOC_MIME) return 'docs';
  if (mimeType === GOOGLE_SHEET_MIME) return 'sheets';
  if (mimeType === GOOGLE_SLIDE_MIME) return 'slides';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  return 'file';
};

export class GoogleDriveService {
  constructor(
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly fileService: FileService,
  ) {}

  async searchFiles(
    userId: string,
    options: {
      query?: string;
      scope?: GoogleDrivePickerScope;
      pageSize?: number;
      pageToken?: string;
    } = {},
  ): Promise<GoogleDriveSearchResult> {
    const scope = options.scope || 'recent';
    const query = String(options.query || '').trim();
    const pageSize = Math.min(Math.max(options.pageSize || 24, 1), 50);
    const pageToken = String(options.pageToken || '').trim();
    const { accessToken } = await this.googleOAuthService.getDelegatedAccessToken(userId);

    const directId = extractDriveFileId(query);
    if (directId) {
      const file = await this.getFileMetadata(accessToken, directId);
      if (file.mimeType === GOOGLE_FOLDER_MIME) {
        return { files: [], nextPageToken: null };
      }
      return {
        files: [this.toPickerItem(file, scope)],
        nextPageToken: null,
      };
    }

    const url = new URL(`${DRIVE_API_BASE}/files`);
    const clauses = [
      'trashed = false',
      `mimeType != '${GOOGLE_FOLDER_MIME}'`,
    ];

    if (scope === 'my-drive') {
      clauses.push(`'me' in owners`);
    } else if (scope === 'shared') {
      clauses.push('sharedWithMe = true');
    }

    if (query) {
      clauses.push(`name contains '${escapeDriveQuery(query)}'`);
    }

    url.searchParams.set('q', clauses.join(' and '));
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,size,owners(displayName))',
    );
    url.searchParams.set(
      'orderBy',
      scope === 'recent'
        ? 'viewedByMeTime desc, modifiedTime desc'
        : 'modifiedTime desc',
    );

    const payload = await this.fetchJson<{ files?: DriveFileMetadata[]; nextPageToken?: string }>(
      accessToken,
      url.toString(),
      'Failed to search Google Drive',
    );
    return {
      files: (payload.files || []).map((file) => this.toPickerItem(file, scope)),
      nextPageToken: payload.nextPageToken || null,
    };
  }

  async importFiles(
    workspaceId: string,
    userId: string,
    fileIds: string[],
  ): Promise<WorkspaceFile[]> {
    const uniqueFileIds = Array.from(new Set(fileIds.map((value) => value.trim()).filter(Boolean)));
    if (!uniqueFileIds.length) {
      return [];
    }

    const { accessToken } = await this.googleOAuthService.getDelegatedAccessToken(userId);
    const reservedNames = new Set<string>();
    const prepared: PreparedImport[] = [];

    for (const fileId of uniqueFileIds) {
      const metadata = await this.getFileMetadata(accessToken, fileId);
      if (metadata.mimeType === GOOGLE_FOLDER_MIME) {
        throw new HttpError(400, `Google Drive folder "${metadata.name}" cannot be attached here.`);
      }
      const payload = await this.buildImportPayload(accessToken, metadata);
      const fingerprint = createHash('sha256').update(payload.buffer).digest('hex');
      const existingFile = await this.fileService.findImportedExternalFile(workspaceId, userId, {
        sourceProvider: 'google_drive',
        sourceExternalId: metadata.id,
        sourceVersionFingerprint: fingerprint,
      });
      if (existingFile) {
        prepared.push({
          fileId,
          resolvedName: String(existingFile.name || metadata.name),
          payload,
          fingerprint,
          sourceUrl: metadata.webViewLink || null,
          existingFile: existingFile as WorkspaceFile,
        });
        reservedNames.add(String(existingFile.name || metadata.name));
        continue;
      }
      const resolvedName = await this.resolveUniqueFileName(workspaceId, userId, payload.fileName, reservedNames);
      reservedNames.add(resolvedName);
      prepared.push({
        fileId,
        resolvedName,
        payload,
        fingerprint,
        sourceUrl: metadata.webViewLink || null,
        existingFile: null,
      });
    }

    const imported: WorkspaceFile[] = [];
    const createdIds: number[] = [];

    try {
      for (const entry of prepared) {
        if (entry.existingFile) {
          imported.push(entry.existingFile);
          continue;
        }
        const created = await this.fileService.createFile(
          workspaceId,
          entry.resolvedName,
          entry.payload.buffer,
          entry.payload.mimeType,
          userId,
          {
            forceLocal: entry.payload.forceLocal,
            sourceProvider: 'google_drive',
            sourceExternalId: entry.fileId,
            sourceVersionFingerprint: entry.fingerprint,
            sourceUrl: entry.sourceUrl || null,
          },
        );
        imported.push(created as WorkspaceFile);
        createdIds.push(Number(created.id));
      }
      return imported;
    } catch (error) {
      await Promise.all(
        createdIds.map(async (numericId) => {
          if (!Number.isFinite(numericId)) {
            return;
          }
          try {
            await this.fileService.deleteFile(numericId, userId);
          } catch (rollbackError) {
            console.error('Failed to roll back Google Drive import file', {
              workspaceId,
              userId,
              fileId: numericId,
              rollbackError,
            });
          }
        }),
      );
      throw error;
    }
  }

  private toPickerItem(file: DriveFileMetadata, scope: GoogleDrivePickerScope): GoogleDrivePickerItem {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      webViewUrl: file.webViewLink || null,
      modifiedTime: file.modifiedTime || null,
      ownerNames: (file.owners || [])
        .map((owner) => String(owner.displayName || '').trim())
        .filter(Boolean),
      size: file.size || null,
      iconHint: toIconHint(file.mimeType),
      scope,
    };
  }

  private async buildImportPayload(accessToken: string, metadata: DriveFileMetadata): Promise<ImportPayload> {
    const safeName = sanitizeImportedName(metadata.name, 'google-drive-import');

    if (metadata.mimeType === GOOGLE_DOC_MIME) {
      try {
        const buffer = await this.exportGoogleWorkspaceFile(accessToken, metadata.id, PDF_MIME);
        return {
          fileName: appendExtension(safeName, '.pdf'),
          mimeType: PDF_MIME,
          buffer,
        };
      } catch (error) {
        if (!this.isGoogleExportSizeLimitError(error)) {
          throw error;
        }
        const markdown = await this.renderGoogleDocumentMarkdown(accessToken, metadata);
        return {
          fileName: appendExtension(safeName, '.md'),
          mimeType: 'text/markdown',
          buffer: Buffer.from(markdown, 'utf-8'),
          forceLocal: true,
        };
      }
    }

    if (metadata.mimeType === GOOGLE_SHEET_MIME) {
      const markdown = await this.renderSpreadsheetMarkdown(accessToken, metadata);
      return {
        fileName: appendExtension(safeName, '.md'),
        mimeType: 'text/markdown',
        buffer: Buffer.from(markdown, 'utf-8'),
        forceLocal: true,
      };
    }

    if (metadata.mimeType === GOOGLE_SLIDE_MIME) {
      try {
        const buffer = await this.exportGoogleWorkspaceFile(accessToken, metadata.id, PDF_MIME);
        return {
          fileName: appendExtension(safeName, '.pdf'),
          mimeType: PDF_MIME,
          buffer,
        };
      } catch {
        const buffer = await this.exportGoogleWorkspaceFile(accessToken, metadata.id, PPTX_MIME);
        return {
          fileName: appendExtension(safeName, '.pptx'),
          mimeType: PPTX_MIME,
          buffer,
        };
      }
    }

    if (metadata.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new HttpError(400, `Google Drive item "${metadata.name}" is not supported in the chat attachment flow yet.`);
    }

    const buffer = await this.downloadDriveBinary(accessToken, metadata.id);
    return {
      fileName: safeName,
      mimeType: metadata.mimeType || 'application/octet-stream',
      buffer,
    };
  }

  private async renderSpreadsheetMarkdown(accessToken: string, metadata: DriveFileMetadata): Promise<string> {
    const infoUrl = new URL(`${SHEETS_API_BASE}/${metadata.id}`);
    infoUrl.searchParams.set('fields', 'properties.title,sheets.properties.title');
    const info = await this.fetchJson<{
      properties?: { title?: string };
      sheets?: Array<{ properties?: { title?: string } }>;
    }>(accessToken, infoUrl.toString(), `Failed to inspect Google Sheet "${metadata.name}"`);

    const sheetTitles = (info.sheets || [])
      .map((sheet) => String(sheet.properties?.title || '').trim())
      .filter(Boolean);

    if (!sheetTitles.length) {
      return `# ${metadata.name}\n\nThis spreadsheet did not contain any readable sheets.`;
    }

    const valuesUrl = new URL(`${SHEETS_API_BASE}/${metadata.id}/values:batchGet`);
    valuesUrl.searchParams.set('majorDimension', 'ROWS');
    valuesUrl.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
    valuesUrl.searchParams.set('dateTimeRenderOption', 'FORMATTED_STRING');
    sheetTitles.forEach((title) => valuesUrl.searchParams.append('ranges', rangeForSheet(title)));

    const valuesPayload = await this.fetchJson<{
      valueRanges?: Array<{ range?: string; values?: string[][] }>;
    }>(accessToken, valuesUrl.toString(), `Failed to read Google Sheet "${metadata.name}"`);

    const valuesByTitle = new Map<string, string[][]>();
    for (const valueRange of valuesPayload.valueRanges || []) {
      const range = String(valueRange.range || '');
      const title = range.replace(/^'(.+)'!?$/, '$1').replace(/!.*$/, '');
      valuesByTitle.set(title, Array.isArray(valueRange.values) ? valueRange.values : []);
    }

    const sections = sheetTitles.map((title) => {
      const rows = valuesByTitle.get(title) || [];
      const csvText = rows.length ? toCsvText(rows) : '(No data)';
      return `## ${title}\n\n\`\`\`csv\n${csvText}\n\`\`\``;
    });

    return [
      `# ${info.properties?.title || metadata.name}`,
      '',
      `Imported from Google Drive: ${metadata.webViewLink || ''}`.trim(),
      '',
      ...sections,
      '',
    ].join('\n');
  }

  private async getFileMetadata(accessToken: string, fileId: string): Promise<DriveFileMetadata> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', 'id,name,mimeType,webViewLink,modifiedTime,size,owners(displayName)');
    return this.fetchJson<DriveFileMetadata>(accessToken, url.toString(), 'Failed to load Google Drive file');
  }

  private async exportGoogleWorkspaceFile(accessToken: string, fileId: string, mimeType: string): Promise<Buffer> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set('mimeType', mimeType);
    return this.fetchBuffer(accessToken, url.toString(), 'Failed to export Google Workspace file');
  }

  private isGoogleExportSizeLimitError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return message.includes('exportSizeLimitExceeded');
  }

  private async renderGoogleDocumentMarkdown(accessToken: string, metadata: DriveFileMetadata): Promise<string> {
    const url = new URL(`${DOCS_API_BASE}/${encodeURIComponent(metadata.id)}`);
    url.searchParams.set('fields', 'title,body(content(paragraph(elements(textRun/content),paragraphStyle/namedStyleType),table(tableRows(tableCells(content(paragraph(elements(textRun/content),paragraphStyle/namedStyleType),table))))))');
    const document = await this.fetchJson<GoogleDocsDocument>(
      accessToken,
      url.toString(),
      `Failed to read Google Doc "${metadata.name}"`,
    );
    const title = collapseWhitespace(String(document.title || metadata.name || 'Google Doc')) || metadata.name;
    const body = renderGoogleDocsStructuralContent(document.body?.content || []);
    return [
      `# ${title}`,
      '',
      `Imported from Google Drive: ${metadata.webViewLink || ''}`.trim(),
      '',
      body || '(No readable text content was returned by the Google Docs API.)',
      '',
    ].join('\n');
  }

  private async downloadDriveBinary(accessToken: string, fileId: string): Promise<Buffer> {
    const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    return this.fetchBuffer(accessToken, url.toString(), 'Failed to download Google Drive file');
  }

  private async fetchJson<T>(accessToken: string, url: string, fallbackMessage: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new HttpError(response.status, `${fallbackMessage} (${response.status}): ${text.slice(0, 300)}`);
    }

    return response.json() as Promise<T>;
  }

  private async fetchBuffer(accessToken: string, url: string, fallbackMessage: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new HttpError(response.status, `${fallbackMessage} (${response.status}): ${text.slice(0, 300)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async resolveUniqueFileName(
    workspaceId: string,
    userId: string,
    fileName: string,
    reservedNames?: Set<string>,
  ): Promise<string> {
    const parsed = path.posix.parse(fileName.replace(/\\/g, '/'));
    const safeBaseName = sanitizeImportedName(parsed.name, 'google-drive-import');
    const safeExt = parsed.ext || '';
    const baseCandidate = `${safeBaseName}${safeExt}`;

    if (!reservedNames?.has(baseCandidate) && !await this.fileService.hasFileName(workspaceId, baseCandidate, userId)) {
      return baseCandidate;
    }

    for (let index = 2; index <= 99; index += 1) {
      const candidate = `${safeBaseName} (${index})${safeExt}`;
      if (!reservedNames?.has(candidate) && !await this.fileService.hasFileName(workspaceId, candidate, userId)) {
        return candidate;
      }
    }

    let attempt = `${safeBaseName}-${Date.now()}${safeExt}`;
    while (reservedNames?.has(attempt) || await this.fileService.hasFileName(workspaceId, attempt, userId)) {
      attempt = `${safeBaseName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${safeExt}`;
    }
    return attempt;
  }
}
