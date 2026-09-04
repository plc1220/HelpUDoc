import path from 'path';
import type {
  GcsBrowseEntry,
  GcsBrowseResult,
  GcsBucketSummary,
  GoogleDriveIconHint,
} from '@helpudoc/contracts/types';
import { HttpError } from '../errors';
import { FileService } from './fileService';
import { GcsBucketRegistryService, type GcsBucketRecord } from './gcsBucketRegistryService';
import { fetchGoogleBuffer, fetchGoogleJson } from './googleApiFetch';
import { GCS_READ_SCOPE, GoogleOAuthService } from './googleOAuthService';

const GCS_API_BASE = 'https://storage.googleapis.com/storage/v1';
const GCS_CONSOLE_BASE = 'https://storage.cloud.google.com';
const SOURCE_PROVIDER = 'gcs';

/**
 * `createFile` takes the whole object as a Buffer, and GCS objects are
 * unbounded, so the size ceiling is a memory guard rather than a policy. Read
 * from the listing metadata, before any bytes are transferred.
 */
const DEFAULT_MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function maxImportBytes(): number {
  const raw = Number(process.env.GCS_IMPORT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_IMPORT_BYTES;
}

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

type GcsObjectMetadata = {
  name?: string;
  size?: string | number;
  contentType?: string;
  updated?: string;
  generation?: string | number;
};

type GcsListResponse = {
  items?: GcsObjectMetadata[];
  prefixes?: string[];
  nextPageToken?: string;
};

type PreparedImport = {
  objectName: string;
  resolvedName: string;
  mimeType: string;
  sizeBytes: number;
  generation: string;
  sourceUrl: string;
  existingFile: WorkspaceFile | null;
};

const EXTENSION_ICON_HINTS: Record<string, GoogleDriveIconHint> = {
  '.pdf': 'pdf',
  '.doc': 'docs',
  '.docx': 'docs',
  '.md': 'docs',
  '.txt': 'docs',
  '.csv': 'sheets',
  '.tsv': 'sheets',
  '.xls': 'sheets',
  '.xlsx': 'sheets',
  '.ppt': 'slides',
  '.pptx': 'slides',
};

function toIconHint(objectName: string, contentType?: string | null): GoogleDriveIconHint {
  const mime = String(contentType || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return EXTENSION_ICON_HINTS[path.posix.extname(objectName).toLowerCase()] || 'file';
}

/**
 * Objects whose key ends in '/' and hold no bytes are the placeholders the
 * Cloud console writes when someone "creates a folder". They are not files and
 * importing one would produce an empty, unnamed entry.
 */
function isFolderPlaceholder(objectName: string, sizeBytes: number): boolean {
  return objectName.endsWith('/') && sizeBytes === 0;
}

function leafName(objectPath: string): string {
  const trimmed = objectPath.endsWith('/') ? objectPath.slice(0, -1) : objectPath;
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
}

/** Filenames are flat inside a workspace, so a nested key keeps only its leaf. */
function sanitizeImportedName(objectName: string): string {
  const normalized = leafName(objectName)
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'gcs-import';
}

function toBucketSummary(bucket: GcsBucketRecord): GcsBucketSummary {
  return {
    id: bucket.id,
    bucketName: bucket.bucketName,
    displayName: bucket.displayName,
    pathPrefix: bucket.pathPrefix,
    description: bucket.description,
  };
}

function objectUrl(bucketName: string, objectName: string, suffix = ''): string {
  return `${GCS_API_BASE}/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectName)}${suffix}`;
}

export class GoogleCloudStorageService {
  constructor(
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly fileService: FileService,
    private readonly bucketRegistry: GcsBucketRegistryService,
  ) {}

  async listBuckets(userId: string): Promise<GcsBucketSummary[]> {
    const buckets = await this.bucketRegistry.listAccessibleBuckets(userId);
    return buckets.map(toBucketSummary);
  }

  /**
   * One page of a bucket listing. `delimiter=/` makes GCS return the folder
   * prefixes alongside the objects, so navigation needs no client-side grouping.
   *
   * `query` is a name prefix within the current folder, not a search: the GCS
   * object API has no query language, and pretending otherwise would silently
   * miss matches deeper in the bucket.
   */
  async listObjects(
    userId: string,
    options: {
      bucketId: string;
      prefix?: string;
      query?: string;
      pageToken?: string;
      pageSize?: number;
    },
  ): Promise<GcsBrowseResult> {
    const bucket = await this.bucketRegistry.requireAccessibleBucket(userId, options.bucketId);
    const prefix = this.resolvePrefix(bucket, options.prefix);
    const query = String(options.query || '').trim();
    const pageSize = Math.min(Math.max(options.pageSize || 50, 1), 200);
    const accessToken = await this.getAccessToken(userId);

    const url = new URL(`${GCS_API_BASE}/b/${encodeURIComponent(bucket.bucketName)}/o`);
    url.searchParams.set('prefix', `${prefix}${query}`);
    url.searchParams.set('delimiter', '/');
    url.searchParams.set('maxResults', String(pageSize));
    url.searchParams.set(
      'fields',
      'nextPageToken,prefixes,items(name,size,contentType,updated,generation)',
    );
    if (options.pageToken) {
      url.searchParams.set('pageToken', options.pageToken);
    }

    const payload = await fetchGoogleJson<GcsListResponse>(
      accessToken,
      url.toString(),
      `Failed to list objects in "${bucket.bucketName}"`,
    );

    const folders: GcsBrowseEntry[] = (payload.prefixes || []).map((entry) => ({
      kind: 'prefix',
      name: leafName(entry),
      path: entry,
      iconHint: 'file',
    }));

    const objects: GcsBrowseEntry[] = (payload.items || [])
      .map((item) => this.toBrowseEntry(item))
      .filter((entry): entry is GcsBrowseEntry => entry !== null);

    return {
      bucket: toBucketSummary(bucket),
      prefix,
      entries: [...folders, ...objects],
      nextPageToken: payload.nextPageToken || null,
    };
  }

  /**
   * Downloads the selected objects and persists them as ordinary workspace
   * files, mirroring the Google Drive import: dedupe, unique-name resolution,
   * then a compensating delete of everything created if any one of them fails.
   *
   * Unlike Drive, the dedupe check happens *before* the download. GCS hands us
   * the object generation in the listing, so an unchanged object costs nothing.
   */
  async importObjects(
    workspaceId: string,
    userId: string,
    bucketId: string,
    objectNames: string[],
  ): Promise<WorkspaceFile[]> {
    const uniqueNames = Array.from(new Set(objectNames.map((value) => value.trim()).filter(Boolean)));
    if (!uniqueNames.length) {
      return [];
    }

    const bucket = await this.bucketRegistry.requireAccessibleBucket(userId, bucketId);
    const accessToken = await this.getAccessToken(userId);
    const sizeLimit = maxImportBytes();
    const reservedNames = new Set<string>();
    const prepared: PreparedImport[] = [];

    for (const objectName of uniqueNames) {
      this.assertWithinBucketPrefix(bucket, objectName);
      const metadata = await this.getObjectMetadata(accessToken, bucket.bucketName, objectName);
      const sizeBytes = Number(metadata.size || 0);

      if (objectName.endsWith('/')) {
        throw new HttpError(400, `"${objectName}" is a folder and cannot be attached here.`);
      }
      if (sizeBytes > sizeLimit) {
        throw new HttpError(
          400,
          `"${leafName(objectName)}" is ${Math.round(sizeBytes / (1024 * 1024))} MB, above the ${Math.round(sizeLimit / (1024 * 1024))} MB import limit.`,
        );
      }

      const generation = String(metadata.generation || '');
      const sourceExternalId = `${bucket.bucketName}/${objectName}`;
      const existingFile = await this.fileService.findImportedExternalFile(workspaceId, userId, {
        sourceProvider: SOURCE_PROVIDER,
        sourceExternalId,
        sourceVersionFingerprint: generation,
      });

      const sourceUrl = `${GCS_CONSOLE_BASE}/${bucket.bucketName}/${objectName}`;

      if (existingFile) {
        const name = String((existingFile as WorkspaceFile).name || sanitizeImportedName(objectName));
        reservedNames.add(name);
        prepared.push({
          objectName,
          resolvedName: name,
          mimeType: metadata.contentType || 'application/octet-stream',
          sizeBytes,
          generation,
          sourceUrl,
          existingFile: existingFile as WorkspaceFile,
        });
        continue;
      }

      const resolvedName = await this.resolveUniqueFileName(
        workspaceId,
        userId,
        sanitizeImportedName(objectName),
        reservedNames,
      );
      reservedNames.add(resolvedName);
      prepared.push({
        objectName,
        resolvedName,
        mimeType: metadata.contentType || 'application/octet-stream',
        sizeBytes,
        generation,
        sourceUrl,
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
        const buffer = await fetchGoogleBuffer(
          accessToken,
          objectUrl(bucket.bucketName, entry.objectName, '?alt=media'),
          `Failed to download "${leafName(entry.objectName)}" from Cloud Storage`,
        );
        const created = await this.fileService.createFile(
          workspaceId,
          entry.resolvedName,
          buffer,
          entry.mimeType,
          userId,
          {
            sourceProvider: SOURCE_PROVIDER,
            sourceExternalId: `${bucket.bucketName}/${entry.objectName}`,
            sourceVersionFingerprint: entry.generation,
            sourceUrl: entry.sourceUrl,
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
            console.error('Failed to roll back Cloud Storage import file', {
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

  private getAccessToken(userId: string): Promise<string> {
    return this.googleOAuthService
      .getDelegatedAccessToken(userId, { requireScopes: [GCS_READ_SCOPE] })
      .then((delegated) => delegated.accessToken);
  }

  private toBrowseEntry(item: GcsObjectMetadata): GcsBrowseEntry | null {
    const objectName = String(item.name || '');
    if (!objectName) {
      return null;
    }
    const sizeBytes = Number(item.size || 0);
    if (isFolderPlaceholder(objectName, sizeBytes)) {
      return null;
    }
    return {
      kind: 'object',
      name: leafName(objectName),
      path: objectName,
      sizeBytes,
      contentType: item.contentType || null,
      updated: item.updated || null,
      generation: item.generation === undefined ? null : String(item.generation),
      iconHint: toIconHint(objectName, item.contentType),
    };
  }

  /**
   * A registration may confine browsing to a subtree. Resolve the requested
   * prefix against it, and refuse anything outside — otherwise the prefix
   * parameter would be a way around the admin's boundary.
   */
  private resolvePrefix(bucket: GcsBucketRecord, requested?: string): string {
    const raw = String(requested || '').replace(/^\/+/, '');
    if (!raw) {
      return bucket.pathPrefix;
    }
    const normalized = raw.endsWith('/') ? raw : `${raw}/`;
    if (bucket.pathPrefix && !normalized.startsWith(bucket.pathPrefix)) {
      throw new HttpError(400, 'That folder is outside this bucket registration.');
    }
    return normalized;
  }

  private assertWithinBucketPrefix(bucket: GcsBucketRecord, objectName: string): void {
    if (bucket.pathPrefix && !objectName.startsWith(bucket.pathPrefix)) {
      throw new HttpError(400, `"${leafName(objectName)}" is outside this bucket registration.`);
    }
  }

  private getObjectMetadata(
    accessToken: string,
    bucketName: string,
    objectName: string,
  ): Promise<GcsObjectMetadata> {
    const url = new URL(objectUrl(bucketName, objectName));
    url.searchParams.set('fields', 'name,size,contentType,updated,generation');
    return fetchGoogleJson<GcsObjectMetadata>(
      accessToken,
      url.toString(),
      `Failed to read "${leafName(objectName)}" from Cloud Storage`,
    );
  }

  private async resolveUniqueFileName(
    workspaceId: string,
    userId: string,
    fileName: string,
    reservedNames: Set<string>,
  ): Promise<string> {
    const parsed = path.posix.parse(fileName.replace(/\\/g, '/'));
    const safeBaseName = parsed.name || 'gcs-import';
    const safeExt = parsed.ext || '';
    const baseCandidate = `${safeBaseName}${safeExt}`;

    if (!reservedNames.has(baseCandidate) && !await this.fileService.hasFileName(workspaceId, baseCandidate, userId)) {
      return baseCandidate;
    }

    for (let index = 2; index <= 99; index += 1) {
      const candidate = `${safeBaseName} (${index})${safeExt}`;
      if (!reservedNames.has(candidate) && !await this.fileService.hasFileName(workspaceId, candidate, userId)) {
        return candidate;
      }
    }

    let attempt = `${safeBaseName}-${Date.now()}${safeExt}`;
    while (reservedNames.has(attempt) || await this.fileService.hasFileName(workspaceId, attempt, userId)) {
      attempt = `${safeBaseName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}${safeExt}`;
    }
    return attempt;
  }
}
