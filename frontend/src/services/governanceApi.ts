import { API_URL, apiFetch } from './apiClient';

export type GovernanceTeam = {
  id: string;
  name: string;
  isLead: boolean;
};

export type SkillDraftSummary = {
  id: string;
  proposalType: 'new' | 'improvement';
  proposedSkillKey: string;
  displayName: string;
  description?: string | null;
  proposedOwnerTeamId?: string | null;
  proposedOwnerTeamName?: string | null;
  draftRevision: number;
  status: 'private' | 'submitted' | 'archived';
  updatedAt: string;
};

export type SkillDraftFile = {
  path: string;
  contentHash: string;
  sizeBytes: number;
  mimeType?: string | null;
  mode: number;
  content?: string;
  encoding: 'utf-8' | 'binary';
};

export type GovernanceIssue = {
  code: string;
  message: string;
  path?: string;
  field?: string;
};

export type SkillValidation = {
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

export type SkillDraft = SkillDraftSummary & {
  currentDraftRevisionId: string;
  etag: string;
  files: SkillDraftFile[];
  validationSummary?: Partial<SkillValidation>;
  eligibleTeams: GovernanceTeam[];
};

export type MySkillsResponse = {
  drafts: SkillDraftSummary[];
  reviews: Array<{
    id: string;
    draftId: string;
    proposalType: 'new' | 'improvement';
    status: string;
    activationStatus?: 'active' | 'failed' | null;
    activationErrorCode?: string | null;
    ownerTeamId: string;
    ownerTeamName: string;
    requestRevision: number;
    skillKey: string;
    semanticVersion: string;
    manifestHash: string;
    updatedAt: string;
  }>;
  versions: Array<{
    skillId: string;
    skillKey: string;
    displayName: string;
    ownerTeamId: string;
    ownerTeamName: string;
    versionId: string;
    semanticVersion: string;
    manifestHash: string;
    status: string;
    activatedAt: string;
  }>;
  eligibleTeams: GovernanceTeam[];
};

export type TeamReviewSummary = {
  id: string;
  draftId: string;
  proposalType: 'new' | 'improvement';
  status: string;
  activationStatus?: 'active' | 'failed' | null;
  activationErrorCode?: string | null;
  requestRevision: number;
  proposerUserId: string;
  proposerName: string;
  candidateId: string;
  candidateNumber: number;
  skillKey: string;
  semanticVersion: string;
  manifestHash: string;
  validationSummary: SkillValidation;
  riskSummary: Record<string, unknown>;
  submittedAt: string;
  updatedAt: string;
};

export type TeamReviewDetail = {
  id: string;
  draftId: string;
  proposalType: 'new' | 'improvement';
  ownerTeamId: string;
  proposerUserId: string;
  status: string;
  activationStatus?: 'active' | 'failed' | null;
  activationErrorCode?: string | null;
  requestRevision: number;
  candidate: {
    id: string;
    candidateNumber: number;
    skillKey: string;
    semanticVersion: string;
    manifestHash: string;
    submissionNote?: string | null;
    validationSummary: SkillValidation;
    riskSummary: Record<string, unknown>;
    diff: {
      baseVersionId?: string | null;
      baseSemanticVersion?: string | null;
      basedOnCurrentDefault: boolean;
      added: string[];
      modified: string[];
      deleted: string[];
    };
    files: SkillDraftFile[];
  };
  decisions: Array<{
    id: string;
    decision: string;
    comment?: string | null;
    reviewerName?: string | null;
    createdAt: string;
  }>;
  permissions: {
    canReview: boolean;
    canRetryActivation: boolean;
    isProposer: boolean;
    isTeamLead: boolean;
  };
};

export type CatalogSkill = {
  id: string;
  skillKey: string;
  displayName: string;
  description?: string | null;
  ownerTeamId: string;
  ownerTeamName: string;
  status: string;
  defaultVersionId?: string | null;
  defaultSemanticVersion?: string | null;
  defaultManifestHash?: string | null;
  defaultVersionStatus?: string | null;
  entitled: boolean;
  accessReasons: string[];
  canAdminister: boolean;
};

export type GovernedSkillVersion = {
  id: string;
  semanticVersion: string;
  manifestHash: string;
  baseVersionId?: string | null;
  status: 'active' | 'suspended' | 'retired';
  createdByUserId?: string | null;
  validationSummary: Partial<SkillValidation>;
  activatedAt?: string | null;
  createdAt: string;
  isDefault: boolean;
};

const apiError = async (response: Response, fallback: string): Promise<never> => {
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    details?: { issues?: GovernanceIssue[] };
  };
  const error = new Error(body.error || fallback) as Error & {
    code?: string;
    issues?: GovernanceIssue[];
    status?: number;
  };
  error.code = body.code;
  error.issues = body.details?.issues;
  error.status = response.status;
  throw error;
};

const jsonRequest = async <T>(url: string, init?: RequestInit, fallback = 'Governance request failed'): Promise<T> => {
  const response = await apiFetch(url, init);
  if (!response.ok) return apiError(response, fallback);
  return response.json() as Promise<T>;
};

const idempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const fetchMySkills = () =>
  jsonRequest<MySkillsResponse>(`${API_URL}/skills/mine`, undefined, 'Failed to load your governed skills');

export const createSkillDraft = (input: {
  proposalType: 'new' | 'improvement';
  sourceSkillId?: string;
  sourceVersionId?: string;
}) => jsonRequest<SkillDraft>(`${API_URL}/skills/drafts`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey(),
  },
  body: JSON.stringify(input),
}, 'Failed to create private skill draft');

export const fetchSkillDraft = (draftId: string) =>
  jsonRequest<SkillDraft>(`${API_URL}/skills/drafts/${encodeURIComponent(draftId)}`, undefined, 'Failed to load skill draft');

export const updateSkillDraft = (
  draftId: string,
  revision: number,
  input: {
    displayName?: string;
    description?: string;
    proposedSkillKey?: string;
    proposedOwnerTeamId?: string | null;
    files?: Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64'; executable?: boolean }>;
    deletePaths?: string[];
  },
) => jsonRequest<SkillDraft>(`${API_URL}/skills/drafts/${encodeURIComponent(draftId)}`, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    'If-Match': `"${revision}"`,
  },
  body: JSON.stringify(input),
}, 'Failed to save private skill draft');

export const validateSkillDraft = (draftId: string) =>
  jsonRequest<SkillValidation>(`${API_URL}/skills/drafts/${encodeURIComponent(draftId)}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, 'Skill validation failed');

export const submitSkillDraft = (
  draftId: string,
  input: {
    owningTeamId?: string;
    semanticVersion: string;
    submissionNote?: string;
    expectedDraftRevision: number;
  },
) => jsonRequest<{
  id: string;
  status: string;
  requestRevision: number;
  skillKey: string;
  semanticVersion: string;
  manifestHash: string;
}>(`${API_URL}/skills/drafts/${encodeURIComponent(draftId)}/submit`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey(),
  },
  body: JSON.stringify(input),
}, 'Failed to submit skill to the Team Lead');

export const fetchTeamReviews = (teamId: string, status = 'actionable') =>
  jsonRequest<{ reviews: TeamReviewSummary[] }>(
    `${API_URL}/teams/${encodeURIComponent(teamId)}/skill-reviews?status=${encodeURIComponent(status)}`,
    undefined,
    'Failed to load Team review queue',
  );

export const fetchSkillReview = (requestId: string) =>
  jsonRequest<TeamReviewDetail>(
    `${API_URL}/skill-reviews/${encodeURIComponent(requestId)}`,
    undefined,
    'Failed to load frozen candidate',
  );

export const decideSkillReview = (
  requestId: string,
  input: {
    decision: 'approve' | 'request_changes' | 'reject';
    comment?: string;
    expectedRequestRevision: number;
    leavePreviousDefault?: boolean;
  },
) => jsonRequest<Record<string, unknown>>(
  `${API_URL}/skill-reviews/${encodeURIComponent(requestId)}/decision`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(),
    },
    body: JSON.stringify(input),
  },
  'Failed to record Team Lead decision',
);

export const retrySkillActivation = (
  requestId: string,
  expectedRequestRevision: number,
) => jsonRequest<Record<string, unknown>>(
  `${API_URL}/skill-reviews/${encodeURIComponent(requestId)}/actions/retry-activation`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(),
    },
    body: JSON.stringify({ expectedRequestRevision }),
  },
  'Failed to retry governed skill activation',
);

export const fetchSkillCatalog = () =>
  jsonRequest<{ skills: CatalogSkill[] }>(`${API_URL}/skills/catalog`, undefined, 'Failed to load governed skill catalog');

export const fetchSkillVersions = (skillId: string) =>
  jsonRequest<{ skill: CatalogSkill; versions: GovernedSkillVersion[] }>(
    `${API_URL}/skills/${encodeURIComponent(skillId)}/versions`,
    undefined,
    'Failed to load immutable skill versions',
  );

export const setDefaultSkillVersion = (skillId: string, versionId: string) =>
  jsonRequest<Record<string, unknown>>(
    `${API_URL}/skills/${encodeURIComponent(skillId)}/default-version`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    },
    'Failed to change the default skill version',
  );

export const updateSkillVersionStatus = (
  skillId: string,
  versionId: string,
  action: 'suspend' | 'restore' | 'retire',
) => jsonRequest<Record<string, unknown>>(
  `${API_URL}/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/${action}`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(),
    },
    body: '{}',
  },
  `Failed to ${action} the skill version`,
);

export const pinWorkspaceSkillVersion = (
  workspaceId: string,
  skillId: string,
  versionId: string,
) => jsonRequest<Record<string, unknown>>(
  `${API_URL}/workspaces/${encodeURIComponent(workspaceId)}/skill-pins/${encodeURIComponent(skillId)}`,
  {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionId }),
  },
  'Failed to pin the exact skill version to the workspace',
);

export const createImprovementDraft = (skillId: string, sourceVersionId?: string) =>
  createSkillDraft({ proposalType: 'improvement', sourceSkillId: skillId, sourceVersionId });

export const setTeamLead = (teamId: string, userId: string, enabled: boolean) =>
  jsonRequest<{ teamId: string; userId: string; role: 'lead'; enabled: boolean }>(
    `${API_URL}/teams/${encodeURIComponent(teamId)}/lead`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, enabled }),
    },
    'Failed to update Team Lead assignment',
  );
