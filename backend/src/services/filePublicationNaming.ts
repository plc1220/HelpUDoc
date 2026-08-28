import * as path from 'path';

/**
 * Naming for published file artifacts.
 *
 * Publishing exports an immutable copy, so each republish must land on a key
 * that has never been used. The version is carried in the filename rather than
 * a folder so the artifacts sort naturally beside each other and a human
 * reading the bucket can tell which revision they have.
 *
 * Kept free of I/O so every awkward filename case is testable without a bucket.
 */

/** `reports/q3.md` at version 2 becomes `reports/q3-v2.md`. */
export function buildPublishedName(sourcePath: string, publicationVersion: number): string {
  const normalized = String(sourcePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized) throw new Error('Cannot publish a file with no path');
  if (!Number.isInteger(publicationVersion) || publicationVersion < 1) {
    throw new Error(`Publication version must be a positive integer, got ${publicationVersion}`);
  }

  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  // `path.posix.extname` takes only the final extension, so `a.final.md`
  // becomes `a.final-v2.md` rather than `a-v2.final.md`.
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const versioned = `${stem}-v${publicationVersion}${ext}`;
  return dir === '.' || dir === '' ? versioned : path.posix.join(dir, versioned);
}

/** The provenance document published beside the artifact. */
export function buildProvenanceName(publishedName: string): string {
  return `${publishedName}.provenance.json`;
}

/**
 * Full object key. Workspace-scoped because two workspaces may each hold a
 * `reports/summary.md`, and the publication bucket is shared by the whole
 * deployment.
 */
export function buildPublicationKey(input: {
  prefix?: string;
  workspaceId: string;
  publishedName: string;
}): string {
  const segments = [
    ...(input.prefix ? [input.prefix] : []),
    input.workspaceId,
    input.publishedName,
  ];
  return path.posix.normalize(segments.join('/')).replace(/^\/+/, '');
}

export function buildTargetUri(provider: string, bucket: string, key: string): string {
  const scheme = provider === 'gcs' ? 'gs' : 's3';
  return `${scheme}://${bucket}/${key}`;
}
