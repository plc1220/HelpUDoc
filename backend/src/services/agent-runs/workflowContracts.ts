import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { resolveSkillDir } from '../skills/paths';

export type WorkflowArtifactRequirement = {
  artifactId: string;
  required: boolean;
  type?: string;
  description?: string;
  patterns: string[];
  pathRegex?: string;
  instructions?: string;
};

export type WorkflowGateContract = {
  gateId: string;
  component: string;
  required: boolean;
};

export type SkillWorkflowContract = {
  skillId: string;
  gates: WorkflowGateContract[];
  artifacts: WorkflowArtifactRequirement[];
};

type CacheEntry = {
  signature: string;
  contract: SkillWorkflowContract;
};

const contractCache = new Map<string, CacheEntry>();

const getRecord = (value: unknown): Record<string, unknown> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim());
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
};

const workflowContractPath = (skillId: string): string | undefined => {
  const skillDir = resolveSkillDir(skillId);
  for (const filename of ['interaction_contract.yaml', 'interaction_contract.yml', 'a2ui_contract.yaml', 'a2ui_contract.yml']) {
    const candidate = path.join(skillDir, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const fileSignature = (filePath: string): string => {
  const stat = statSync(filePath);
  return `${stat.mtimeMs}:${stat.size}`;
};

const normalizeWorkflowContract = (skillId: string, raw: unknown): SkillWorkflowContract => {
  const record = getRecord(raw);
  const gates = Array.isArray(record?.gates)
    ? record.gates
        .map((gate) => {
          const gateRecord = getRecord(gate);
          const gateId = String(gateRecord?.gate_id || gateRecord?.gateId || gateRecord?.id || '').trim();
          const component = String(gateRecord?.component || '').trim();
          if (!gateId || !component) {
            return null;
          }
          return {
            gateId,
            component,
            required: gateRecord?.required !== false,
          };
        })
        .filter((gate): gate is WorkflowGateContract => Boolean(gate))
    : [];

  const artifacts = Array.isArray(record?.artifacts)
    ? record.artifacts
        .reduce<WorkflowArtifactRequirement[]>((acc, artifact) => {
          const artifactRecord = getRecord(artifact);
          const artifactId = String(
            artifactRecord?.artifact_id || artifactRecord?.artifactId || artifactRecord?.id || '',
          ).trim();
          if (!artifactId) {
            return acc;
          }
          const requirement: WorkflowArtifactRequirement = {
            artifactId,
            required: artifactRecord?.required !== false,
            patterns: stringArray(artifactRecord?.patterns).concat(stringArray(artifactRecord?.pattern)),
          };
          if (typeof artifactRecord?.type === 'string') {
            requirement.type = artifactRecord.type;
          }
          if (typeof artifactRecord?.description === 'string') {
            requirement.description = artifactRecord.description;
          }
          if (typeof artifactRecord?.path_regex === 'string') {
            requirement.pathRegex = artifactRecord.path_regex;
          } else if (typeof artifactRecord?.pathRegex === 'string') {
            requirement.pathRegex = artifactRecord.pathRegex;
          }
          if (typeof artifactRecord?.instructions === 'string') {
            requirement.instructions = artifactRecord.instructions;
          }
          acc.push(requirement);
          return acc;
        }, [])
    : [];

  return { skillId, gates, artifacts };
};

export const loadSkillWorkflowContract = (skillId: string | null | undefined): SkillWorkflowContract | null => {
  const normalizedSkillId = String(skillId || '').trim();
  if (!normalizedSkillId) {
    return null;
  }
  let contractPath: string | undefined;
  try {
    contractPath = workflowContractPath(normalizedSkillId);
  } catch {
    return null;
  }
  if (!contractPath) {
    return null;
  }
  const signature = fileSignature(contractPath);
  const cached = contractCache.get(normalizedSkillId);
  if (cached?.signature === signature) {
    return cached.contract;
  }
  const parsed = parseYaml(readFileSync(contractPath, 'utf-8'));
  const contract = normalizeWorkflowContract(normalizedSkillId, parsed);
  contractCache.set(normalizedSkillId, { signature, contract });
  return contract;
};

export const requiredGateIdsForSkill = (skillId: string | null | undefined): string[] => (
  loadSkillWorkflowContract(skillId)?.gates
    .filter((gate) => gate.required)
    .map((gate) => gate.gateId) || []
);

export const requiredArtifactsForSkill = (skillId: string | null | undefined): WorkflowArtifactRequirement[] => (
  loadSkillWorkflowContract(skillId)?.artifacts.filter((artifact) => artifact.required) || []
);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const patternToRegExp = (pattern: string): RegExp | null => {
  const normalized = pattern.trim().replace(/\\/g, '/');
  if (!normalized) {
    return null;
  }
  const placeholder = '\u0000';
  const escaped = escapeRegExp(normalized.replace(/\*\*/g, placeholder));
  const regex = escaped
    .replace(new RegExp(placeholder, 'g'), '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${regex}$`, 'i');
};

export const artifactPathMatchesRequirement = (
  artifactPath: string,
  requirement: WorkflowArtifactRequirement,
): boolean => {
  const normalizedPath = artifactPath.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return false;
  }
  if (requirement.pathRegex) {
    try {
      if (new RegExp(requirement.pathRegex, 'i').test(normalizedPath)) {
        return true;
      }
    } catch {
      // Invalid custom regex should not make every artifact match.
    }
  }
  return requirement.patterns.some((pattern) => patternToRegExp(pattern)?.test(normalizedPath));
};
