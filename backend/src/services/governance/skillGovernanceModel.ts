import crypto from 'crypto';
import path from 'path';
import { HttpError } from '../../errors';
import { IMPORT_ALLOWED_PREFIXES, IMPORT_BLOCKED_EXTENSIONS } from '../skills/paths';

export const GOVERNANCE_POLICY_VERSION = 'governed-skills-mvp-1';
const SKILL_KEY_PATTERN = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type JsonRecord = Record<string, unknown>;

export type GovernanceIssue = {
  code: string;
  message: string;
  path?: string;
  field?: string;
};

export type DraftFileInput = {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
  executable?: boolean;
};

export type DraftMutation = {
  displayName?: string;
  description?: string;
  proposedSkillKey?: string;
  proposedOwnerTeamId?: string | null;
  files?: DraftFileInput[];
  deletePaths?: string[];
};

export type FileSnapshot = {
  path: string;
  contentHash: string;
  sizeBytes: number;
  mimeType: string | null;
  mode: number;
};

export type ValidationResult = {
  valid: boolean;
  outcome: 'pass' | 'block';
  riskClass: 'low' | 'medium' | 'high';
  issues: GovernanceIssue[];
  declaredCapabilities: {
    tools: string[];
    mcpServers: string[];
    scripts: string[];
    pluginId: string | null;
  };
  checkedAt: string;
  policyVersion: string;
};

export class SkillGovernanceError extends HttpError {
  readonly code: string;
  readonly committed: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
    committed = false,
  ) {
    super(statusCode, message, details);
    this.code = code;
    this.committed = committed;
  }
}

export class CommittedSkillGovernanceError extends SkillGovernanceError {
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(statusCode, code, message, details, true);
  }
}

export const governanceError = (
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): never => {
  throw new SkillGovernanceError(statusCode, code, message, details);
};

export const isMaterializationError = (error: unknown): error is SkillGovernanceError =>
  error instanceof SkillGovernanceError && error.code === 'SKILL_MATERIALIZATION_UNAVAILABLE';

export const normalizeDatabaseConflict = (error: unknown): unknown => {
  if (
    error
    && typeof error === 'object'
    && String((error as { code?: unknown }).code || '') === '23505'
  ) {
    return new SkillGovernanceError(
      409,
      'SKILL_REVISION_CONFLICT',
      'Another governance operation claimed the same skill identity or version first',
    );
  }
  return error;
};

export const sha256 = (value: Buffer | string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export const stateHash = (value: unknown): string =>
  sha256(JSON.stringify(value ?? null));

export const jsonValue = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};

export const normalizeUnique = (values: unknown): string[] => {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).sort((a, b) => a.localeCompare(b));
};

export const normalizeGovernedSkillKey = (raw: string): string => {
  const skillKey = String(raw || '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!skillKey || skillKey.length > 128 || !SKILL_KEY_PATTERN.test(skillKey)) {
    governanceError(400, 'INVALID_SKILL_MANIFEST', 'Skill ID must be a lowercase safe path of at most 128 characters', {
      field: 'proposedSkillKey',
    });
  }
  return skillKey;
};

export const isGovernedSkillKey = (value: string): boolean =>
  value.length <= 128 && SKILL_KEY_PATTERN.test(value);

export const normalizeGovernedFilePath = (raw: string): string => {
  const normalized = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    !normalized
    || normalized.startsWith('.')
    || normalized.includes('\0')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
    || !IMPORT_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix))
  ) {
    governanceError(400, 'INVALID_SKILL_MANIFEST', 'File path is outside the governed skill package boundary', {
      path: raw,
    });
  }
  if (IMPORT_BLOCKED_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    governanceError(400, 'INVALID_SKILL_MANIFEST', 'Executable binary file type is not permitted', {
      path: normalized,
    });
  }
  return normalized;
};

export const compareSemanticVersions = (left: string, right: string): number => {
  const parse = (value: string): [number, number, number] => {
    const match = SEMVER_PATTERN.exec(String(value || '').trim());
    if (!match) {
      throw new SkillGovernanceError(400, 'INVALID_SKILL_MANIFEST', 'Semantic version must use major.minor.patch without prerelease metadata', {
        field: 'semanticVersion',
        value,
      });
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

export const computePackageManifestHash = (
  files: Array<Pick<FileSnapshot, 'path' | 'contentHash' | 'mode' | 'sizeBytes'>>,
): string => {
  const manifest = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      mode: file.mode,
      sizeBytes: Number(file.sizeBytes),
    }));
  return sha256(JSON.stringify(manifest));
};

export const mimeTypeForPath = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.yaml' || ext === '.yml') return 'application/yaml';
  if (ext === '.py') return 'text/x-python';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
};

export const isTextMime = (mimeType: string | null): boolean =>
  Boolean(
    mimeType
    && (
      mimeType.startsWith('text/')
      || ['application/json', 'application/yaml', 'image/svg+xml'].includes(mimeType)
    )
  );

export const displayNameFromKey = (skillKey: string): string =>
  skillKey
    .split('/')
    .pop()!
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');

export const defaultSkillMarkdown = (skillKey: string, displayName?: string, description?: string): string => {
  const name = String(displayName || '').trim() || displayNameFromKey(skillKey);
  const summary = String(description || '').trim() || 'Describe when and how this skill should be used.';
  return [
    '---',
    `name: ${name}`,
    `description: ${summary}`,
    'tools: []',
    'mcp_servers: []',
    '---',
    '',
    `# ${name}`,
    '',
    '## Instructions',
    '',
    'Describe the governed workflow here.',
    '',
  ].join('\n');
};

export const normalizeDecision = (value: string): 'approve' | 'request_changes' | 'reject' => {
  if (value === 'approve' || value === 'request_changes' || value === 'reject') return value;
  throw new SkillGovernanceError(400, 'INVALID_SKILL_MANIFEST', 'Unsupported review decision');
};
