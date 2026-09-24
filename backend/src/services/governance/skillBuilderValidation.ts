import crypto from 'crypto';
import { SkillPackageValidator } from './skillPackageValidator';
import { normalizeGovernedFilePath, type DraftMutation, type FileSnapshot } from './skillGovernanceModel';
import { HttpError } from '../../errors';

export async function validateBuilderMutation(mutation: DraftMutation) {
  const blobs = new Map<string, Buffer>();
  const seen = new Set<string>();
  const files: FileSnapshot[] = (mutation.files || []).map(file => {
    const filePath = normalizeGovernedFilePath(file.path);
    if (seen.has(filePath)) throw new HttpError(400, `Duplicate proposed file: ${filePath}`);
    seen.add(filePath);
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf-8');
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    blobs.set(contentHash, bytes);
    return { path: filePath, contentHash, sizeBytes: bytes.length, mimeType: file.encoding === 'base64' ? 'application/octet-stream' : 'text/plain', mode: 0o644 };
  });
  const validator = new SkillPackageValidator(async hash => blobs.get(hash)!, snapshots => {
    if (snapshots.length > 100 || snapshots.reduce((sum, file) => sum + file.sizeBytes, 0) > 20 * 1024 * 1024) throw new HttpError(400, 'Proposed package exceeds size limits');
  });
  return validator.validate(mutation, files);
}
