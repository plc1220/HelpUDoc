/**
 * Workspace path classification shared by the file, publication and audit
 * services.
 *
 * Lives here rather than on `FileService` so `fileAuditService` can use it
 * without an import cycle (`fileService` already imports the audit emitter).
 */

/**
 * Directories holding storage the product manages on the user's behalf rather
 * than documents anyone authored:
 *  - `.system/` — immutable file versions, upload staging, and the OKF
 *    knowledge bundles that an ingestion explodes a single document into
 *    (hundreds of derived concept files per source).
 *  - `sandbox-runs/` — per-run agent scratch space.
 *
 * These never appear in the file browser, so they must not appear in a
 * provenance trail either.
 */
export const INTERNAL_WORKSPACE_DIR_NAMES = new Set(['.system', 'sandbox-runs']);

export function isInternalWorkspacePath(fileName: string): boolean {
  const normalized = String(fileName ?? '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part) => INTERNAL_WORKSPACE_DIR_NAMES.has(part));
}
