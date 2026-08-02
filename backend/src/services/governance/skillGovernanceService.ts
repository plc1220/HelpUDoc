import path from 'path';
import { promises as fs } from 'fs';
import type { Knex } from 'knex';
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseService } from '../databaseService';
import { skillsRoot } from '../skills/constants';
import { collectSkillIds } from '../skills/registry';
import { GovernanceIdempotency } from './governanceIdempotency';
import { withGovernanceLock } from './governanceLocks';
import { SkillPackageValidator } from './skillPackageValidator';
import { GOVERNED_VERSIONS_DIR, SkillPackageStore } from './skillPackageStore';
import {
  CommittedSkillGovernanceError,
  DraftMutation,
  FileSnapshot,
  GOVERNANCE_POLICY_VERSION,
  JsonRecord,
  SkillGovernanceError,
  ValidationResult,
  compareSemanticVersions,
  computePackageManifestHash,
  defaultSkillMarkdown,
  displayNameFromKey,
  governanceError,
  isGovernedSkillKey,
  isMaterializationError,
  isTextMime,
  jsonValue,
  normalizeDatabaseConflict,
  normalizeDecision,
  normalizeGovernedFilePath,
  normalizeGovernedSkillKey,
  stateHash,
} from './skillGovernanceModel';

export {
  GOVERNANCE_POLICY_VERSION,
  SkillGovernanceError,
  compareSemanticVersions,
  computePackageManifestHash,
  normalizeGovernedFilePath,
  normalizeGovernedSkillKey,
} from './skillGovernanceModel';

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 500;
const DEFAULT_MIGRATION_TEAM = 'Platform Migration';

export class SkillGovernanceService {
  private readonly db: Knex;
  private readonly idempotency: GovernanceIdempotency;
  private readonly packageStore: SkillPackageStore;
  private readonly validator: SkillPackageValidator;

  constructor(databaseService: DatabaseService) {
    this.db = databaseService.getDb();
    this.idempotency = new GovernanceIdempotency(this.db);
    this.packageStore = new SkillPackageStore(
      this.db,
      (files) => this.assertPackageLimits(files),
    );
    this.validator = new SkillPackageValidator(
      (contentHash) => this.packageStore.readBlob(contentHash),
      (files) => this.assertPackageLimits(files),
    );
  }

  async initialize(): Promise<void> {
    await this.packageStore.initialize();
    await this.backfillLegacyRegistry();
    await this.backfillLegacyGrants();
    await this.archiveLegacySkillEvolution();
    const migration = await this.validateMigrationParity();
    const log = migration.ready ? console.info : console.warn;
    log('Governed skill migration parity', migration);
  }

  async runIdempotent<T extends JsonRecord>(
    userId: string,
    action: string,
    key: string | undefined,
    requestBody: unknown,
    operation: () => Promise<T>,
  ): Promise<{ body: T; replayed: boolean }> {
    return this.idempotency.run(userId, action, key, requestBody, operation);
  }

  async listMySkills(userId: string): Promise<JsonRecord> {
    const [drafts, reviews, versions, teams] = await Promise.all([
      this.db('private_skill_drafts as d')
        .leftJoin('groups as g', 'g.id', 'd.proposedOwnerTeamId')
        .select(
          'd.id',
          'd.proposalType',
          'd.proposedSkillKey',
          'd.displayName',
          'd.description',
          'd.proposedOwnerTeamId',
          'g.name as proposedOwnerTeamName',
          'd.draftRevision',
          'd.status',
          'd.createdAt',
          'd.updatedAt',
        )
        .select(this.db.raw(
          'EXISTS (SELECT 1 FROM skill_review_requests review WHERE review."draftId" = d.id) AS "hasReviewHistory"',
        ))
        .where('d.ownerUserId', userId)
        .orderBy('d.updatedAt', 'desc'),
      this.db('skill_review_requests as r')
        .join('groups as g', 'g.id', 'r.ownerTeamId')
        .leftJoin('skill_review_candidates as c', 'c.id', 'r.currentCandidateId')
        .select(
          'r.id',
          'r.draftId',
          'r.proposalType',
          'r.status',
          'r.activationStatus',
          'r.activationErrorCode',
          'r.ownerTeamId',
          'g.name as ownerTeamName',
          'r.requestRevision',
          'c.skillKey',
          'c.semanticVersion',
          'c.manifestHash',
          'r.createdAt',
          'r.updatedAt',
        )
        .where('r.proposerUserId', userId)
        .orderBy('r.updatedAt', 'desc'),
      this.db('skill_versions as v')
        .join('skills as s', 's.id', 'v.skillId')
        .join('groups as g', 'g.id', 's.ownerTeamId')
        .select(
          's.id as skillId',
          's.skillKey',
          's.displayName',
          's.status as skillStatus',
          's.defaultVersionId',
          'g.id as ownerTeamId',
          'g.name as ownerTeamName',
          'v.id as versionId',
          'v.semanticVersion',
          'v.manifestHash',
          'v.status',
          'v.activatedAt',
        )
        .where('v.createdByUserId', userId)
        .orderBy('v.createdAt', 'desc'),
      this.listEligibleTeams(userId),
    ]);
    return { drafts, reviews, versions, eligibleTeams: teams };
  }

  async createDraft(
    userId: string,
    input: { proposalType: 'new' | 'improvement'; sourceSkillId?: string; sourceVersionId?: string },
  ): Promise<JsonRecord> {
    const proposalType = input.proposalType;
    if (proposalType !== 'new' && proposalType !== 'improvement') {
      governanceError(400, 'INVALID_SKILL_MANIFEST', 'proposalType must be new or improvement');
    }

    const draftId = uuidv4();
    let sourceSkill: any = null;
    let sourceVersion: any = null;
    let initialFiles: FileSnapshot[] = [];
    let skillKey = '';
    let displayName = '';
    let description = '';
    let ownerTeamId: string | null = null;

    if (proposalType === 'improvement') {
      sourceSkill = await this.resolveSkill(input.sourceSkillId || '');
      if (!sourceSkill) {
        governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Source skill not found');
      }
      const membership = await this.db('group_members')
        .where({ groupId: sourceSkill.ownerTeamId, userId })
        .first();
      if (!membership) {
        governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'Only a member of the owning Team may propose an improvement');
      }
      sourceVersion = input.sourceVersionId
        ? await this.db('skill_versions').where({ id: input.sourceVersionId, skillId: sourceSkill.id }).first()
        : await this.db('skill_versions').where({ id: sourceSkill.defaultVersionId, skillId: sourceSkill.id }).first();
      if (!sourceVersion || sourceVersion.status === 'retired') {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'The selected base version is unavailable');
      }
      initialFiles = await this.packageStore.versionFiles(sourceVersion.id);
      skillKey = sourceSkill.skillKey;
      displayName = sourceSkill.displayName;
      description = sourceSkill.description || '';
      ownerTeamId = sourceSkill.ownerTeamId;
    } else {
      skillKey = `new-skill-${draftId.slice(0, 8)}`;
      displayName = 'New skill';
      const file = await this.packageStore.persistBlob(
        Buffer.from(defaultSkillMarkdown(skillKey, displayName), 'utf-8'),
        'SKILL.md',
      );
      initialFiles = [file];
    }

    const revision = await this.createDraftRevision({
      draftId,
      userId,
      revisionNumber: 1,
      parentRevisionId: null,
      files: initialFiles,
      validationSummary: {},
      createDraft: {
        ownerUserId: userId,
        proposalType,
        sourceSkillId: sourceSkill?.id || null,
        sourceVersionId: sourceVersion?.id || null,
        proposedOwnerTeamId: ownerTeamId,
        proposedSkillKey: skillKey,
        displayName,
        description,
      },
    });
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: 'skill_proposer',
      action: 'skill_draft.created',
      resourceType: 'private_skill_draft',
      resourceId: draftId,
      metadata: { proposalType, sourceSkillId: sourceSkill?.id || null },
    });
    return { ...await this.getDraft(userId, draftId, revision.id), auditEventId };
  }

  async getDraft(userId: string, draftId: string, knownRevisionId?: string): Promise<JsonRecord> {
    const draft = await this.db('private_skill_drafts as d')
      .leftJoin('groups as g', 'g.id', 'd.proposedOwnerTeamId')
      .select('d.*', 'g.name as proposedOwnerTeamName')
      .where('d.id', draftId)
      .first();
    if (!draft || draft.ownerUserId !== userId) {
      governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill draft not found');
    }
    const revisionId = knownRevisionId || draft.currentDraftRevisionId;
    const files = revisionId ? await this.packageStore.draftFiles(revisionId) : [];
    const eligibleTeams = await this.listEligibleTeams(userId);
    const validationSummary = revisionId
      ? jsonValue<JsonRecord>(
        (await this.db('skill_draft_revisions').where({ id: revisionId }).first())?.validationSummary,
        {},
      )
      : {};
    const hasReviewHistory = Boolean(
      await this.db('skill_review_requests').where({ draftId }).first(),
    );
    return {
      ...draft,
      draftRevision: Number(draft.draftRevision),
      etag: `"${draft.draftRevision}"`,
      files: await Promise.all(files.map(async (file) => ({
        ...file,
        content: isTextMime(file.mimeType)
          ? (await this.packageStore.readBlob(file.contentHash)).toString('utf-8')
          : undefined,
        encoding: isTextMime(file.mimeType) ? 'utf-8' : 'binary',
      }))),
      validationSummary,
      eligibleTeams,
      hasReviewHistory,
    };
  }

  async updateDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
    mutation: DraftMutation,
  ): Promise<JsonRecord> {
    const draft = await this.ownedEditableDraft(userId, draftId);
    if (Number(draft.draftRevision) !== expectedRevision) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'The draft changed since it was opened', {
        expectedRevision,
        currentRevision: Number(draft.draftRevision),
      });
    }

    const currentFiles = await this.packageStore.draftFiles(draft.currentDraftRevisionId);
    const nextFiles = new Map(currentFiles.map((file) => [file.path, file]));
    for (const rawPath of mutation.deletePaths || []) {
      nextFiles.delete(normalizeGovernedFilePath(rawPath));
    }
    for (const input of mutation.files || []) {
      const normalizedPath = normalizeGovernedFilePath(input.path);
      const buffer = Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf-8');
      nextFiles.set(
        normalizedPath,
        await this.packageStore.persistBlob(buffer, normalizedPath, input.executable),
      );
    }
    if (!nextFiles.has('SKILL.md')) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', 'SKILL.md is required');
    }
    this.assertPackageLimits([...nextFiles.values()]);

    const nextSkillKey = mutation.proposedSkillKey === undefined
      ? draft.proposedSkillKey
      : normalizeGovernedSkillKey(mutation.proposedSkillKey);
    const nextOwnerTeamId = mutation.proposedOwnerTeamId === undefined
      ? draft.proposedOwnerTeamId
      : mutation.proposedOwnerTeamId;
    if (draft.proposalType === 'improvement') {
      if (nextOwnerTeamId !== draft.proposedOwnerTeamId || nextSkillKey !== draft.proposedSkillKey) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'An improvement inherits its skill ID and owning Team');
      }
    }
    if (nextOwnerTeamId && nextOwnerTeamId !== draft.proposedOwnerTeamId) {
      await this.requireTeamMembership(userId, nextOwnerTeamId);
    }

    const nextRevision = expectedRevision + 1;
    await this.createDraftRevision({
      draftId,
      userId,
      revisionNumber: nextRevision,
      parentRevisionId: draft.currentDraftRevisionId,
      files: [...nextFiles.values()],
      validationSummary: {},
      updateDraft: {
        expectedRevision,
        proposedSkillKey: nextSkillKey,
        proposedOwnerTeamId: nextOwnerTeamId,
        displayName: mutation.displayName === undefined ? draft.displayName : mutation.displayName.trim(),
        description: mutation.description === undefined ? draft.description : mutation.description.trim(),
      },
    });
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: 'skill_proposer',
      action: 'skill_draft.updated',
      resourceType: 'private_skill_draft',
      resourceId: draftId,
      metadata: { draftRevision: nextRevision },
    });
    return { ...await this.getDraft(userId, draftId), auditEventId };
  }

  async deleteDraft(
    userId: string,
    draftId: string,
    expectedRevision: number,
  ): Promise<JsonRecord> {
    const disposition = await withGovernanceLock(this.db, 'skill-draft', draftId, async () => {
      const draft = await this.ownedEditableDraft(userId, draftId);
      if (Number(draft.draftRevision) !== expectedRevision) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'The draft changed since it was opened', {
          expectedRevision,
          currentRevision: Number(draft.draftRevision),
        });
      }

      const review = await this.db('skill_review_requests').where({ draftId }).first();
      if (review) {
        await this.db('private_skill_drafts').where({ id: draftId }).update({
          status: 'archived',
          updatedAt: this.db.fn.now(),
        });
        return 'archived' as const;
      }

      await this.db('private_skill_drafts').where({ id: draftId }).del();
      return 'deleted' as const;
    });

    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: 'skill_proposer',
      action: disposition === 'deleted' ? 'skill_draft.deleted' : 'skill_draft.archived',
      resourceType: 'private_skill_draft',
      resourceId: draftId,
      metadata: { disposition, expectedRevision },
    });
    return { draftId, disposition, auditEventId };
  }

  async validateDraft(userId: string, draftId: string): Promise<ValidationResult & { auditEventId: string }> {
    const draft = await this.ownedDraft(userId, draftId);
    const files = await this.packageStore.draftFiles(draft.currentDraftRevisionId);
    const result = await this.validateSnapshot(draft, files);
    await this.db('skill_draft_revisions')
      .where({ id: draft.currentDraftRevisionId })
      .update({ validationSummary: JSON.stringify(result) });
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: 'skill_proposer',
      action: 'skill_draft.validated',
      resourceType: 'private_skill_draft',
      resourceId: draftId,
      policyVersion: result.policyVersion,
      metadata: { outcome: result.outcome, riskClass: result.riskClass, issueCount: result.issues.length },
    });
    return { ...result, auditEventId };
  }

  async submitDraft(
    userId: string,
    draftId: string,
    input: {
      owningTeamId?: string;
      semanticVersion: string;
      submissionNote?: string;
      expectedDraftRevision: number;
    },
  ): Promise<JsonRecord> {
    const draft = await this.ownedEditableDraft(userId, draftId);
    if (Number(draft.draftRevision) !== input.expectedDraftRevision) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'The draft revision is stale');
    }
    const skillKey = normalizeGovernedSkillKey(draft.proposedSkillKey || '');
    compareSemanticVersions(input.semanticVersion, '0.0.0');
    const ownerTeamId = draft.proposalType === 'improvement'
      ? draft.proposedOwnerTeamId
      : input.owningTeamId || draft.proposedOwnerTeamId;
    if (!ownerTeamId) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', 'Select an eligible owning Team before submission', {
        field: 'owningTeamId',
      });
    }
    await this.requireTeamMembership(userId, ownerTeamId);

    let targetSkill: any = null;
    if (draft.proposalType === 'improvement') {
      targetSkill = await this.resolveSkill(draft.sourceSkillId);
      if (!targetSkill || targetSkill.ownerTeamId !== ownerTeamId) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'The improvement ownership no longer matches its skill');
      }
      const versions = await this.db('skill_versions').select('semanticVersion').where({ skillId: targetSkill.id });
      if (versions.some((version) => compareSemanticVersions(input.semanticVersion, version.semanticVersion) <= 0)) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'Improvement version must be greater than every existing version');
      }
    } else {
      const existingSkill = await this.db('skills').where({ skillKey }).first();
      if (existingSkill) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'This skill ID is already governed');
      }
      if (input.semanticVersion !== '1.0.0') {
        governanceError(422, 'SKILL_VALIDATION_FAILED', 'A new skill must begin at semantic version 1.0.0');
      }
    }

    const files = await this.packageStore.draftFiles(draft.currentDraftRevisionId);
    const validation = await this.validateSnapshot({ ...draft, proposedOwnerTeamId: ownerTeamId }, files);
    if (!validation.valid) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', 'The candidate does not pass mandatory governance checks', {
        issues: validation.issues,
        validation,
      });
    }
    const manifestHash = computePackageManifestHash(files);
    const existingRequest = await this.db('skill_review_requests')
      .where({ draftId })
      .whereIn('status', ['changes_requested'])
      .orderBy('createdAt', 'desc')
      .first();
    const requestId = existingRequest?.id || uuidv4();
    const candidateId = uuidv4();

    const result = await withGovernanceLock(
      this.db,
      'skill-candidate',
      `${skillKey}@${input.semanticVersion}`,
      () => this.db.transaction(async (tx) => {
      const locked = await tx('private_skill_drafts').where({ id: draftId, ownerUserId: userId }).forUpdate().first();
      if (!locked || Number(locked.draftRevision) !== input.expectedDraftRevision || locked.status !== 'private') {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'The draft changed before submission committed');
      }
      const collision = await tx('skill_review_candidates')
        .where({ skillKey, semanticVersion: input.semanticVersion })
        .whereNot({ requestId })
        .first();
      if (collision) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'Another candidate already claims this skill ID and version');
      }

      let requestRevision = 1;
      let candidateNumber = 1;
      if (existingRequest) {
        requestRevision = Number(existingRequest.requestRevision) + 1;
        const last = await tx('skill_review_candidates')
          .where({ requestId })
          .max<{ max: string | number | null }>('candidateNumber as max')
          .first();
        candidateNumber = Number(last?.max || 0) + 1;
        await tx('skill_review_requests').where({ id: requestId }).update({
          status: 'submitted',
          ownerTeamId,
          targetSkillId: targetSkill?.id || null,
          currentCandidateId: candidateId,
          requestRevision,
          updatedAt: tx.fn.now(),
        });
      } else {
        await tx('skill_review_requests').insert({
          id: requestId,
          draftId,
          proposalType: draft.proposalType,
          ownerTeamId,
          targetSkillId: targetSkill?.id || null,
          proposerUserId: userId,
          status: 'submitted',
          currentCandidateId: candidateId,
          requestRevision,
        });
      }
      await tx('skill_review_candidates').insert({
        id: candidateId,
        requestId,
        candidateNumber,
        sourceDraftRevisionId: draft.currentDraftRevisionId,
        skillKey,
        semanticVersion: input.semanticVersion,
        sourceSkillId: targetSkill?.id || null,
        sourceVersionId: draft.sourceVersionId || null,
        manifestHash,
        submissionNote: input.submissionNote?.trim() || null,
        validationSummary: JSON.stringify(validation),
        riskSummary: JSON.stringify({
          riskClass: validation.riskClass,
          declaredCapabilities: validation.declaredCapabilities,
        }),
        submittedByUserId: userId,
      });
      if (files.length) {
        await tx('skill_review_candidate_files').insert(files.map((file) => ({
          candidateId,
          path: file.path,
          contentHash: file.contentHash,
          mode: file.mode,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
        })));
      }
      await tx('skill_candidate_policy_results').insert({
        id: uuidv4(),
        candidateId,
        policyVersion: GOVERNANCE_POLICY_VERSION,
        outcome: validation.outcome,
        riskClass: validation.riskClass,
        issues: JSON.stringify(validation.issues),
        validationSummary: JSON.stringify(validation),
      });
      await tx('private_skill_drafts').where({ id: draftId }).update({
        proposedOwnerTeamId: ownerTeamId,
        status: 'submitted',
        updatedAt: tx.fn.now(),
      });
      return {
        id: requestId,
        candidateId,
        candidateNumber,
        requestRevision,
        status: 'submitted',
        skillKey,
        semanticVersion: input.semanticVersion,
        manifestHash,
        ownerTeamId,
      };
      }),
    );

    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: 'skill_proposer',
      action: 'skill_review.submitted',
      resourceType: 'skill_review_request',
      resourceId: requestId,
      policyVersion: GOVERNANCE_POLICY_VERSION,
      metadata: { candidateId, manifestHash, ownerTeamId, skillKey, semanticVersion: input.semanticVersion },
    });
    await this.notifyTeamLeads(ownerTeamId, 'skill_review.submitted', 'skill_review_request', requestId, {
      skillKey,
      semanticVersion: input.semanticVersion,
    });
    return { ...result, auditEventId };
  }

  async listTeamReviews(
    userId: string,
    teamId: string,
    status?: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<JsonRecord> {
    await this.requireTeamLead(userId, teamId);
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
    const offset = Math.max(Number(options.offset || 0), 0);
    const query = this.db('skill_review_requests as r')
      .join('skill_review_candidates as c', 'c.id', 'r.currentCandidateId')
      .join('users as u', 'u.id', 'r.proposerUserId')
      .select(
        'r.id',
        'r.draftId',
        'r.proposalType',
        'r.status',
        'r.activationStatus',
        'r.activationErrorCode',
        'r.requestRevision',
        'r.proposerUserId',
        'u.displayName as proposerName',
        'c.id as candidateId',
        'c.candidateNumber',
        'c.skillKey',
        'c.semanticVersion',
        'c.manifestHash',
        'c.validationSummary',
        'c.riskSummary',
        'c.submittedAt',
        'r.updatedAt',
      )
      .where('r.ownerTeamId', teamId)
      .orderBy('r.updatedAt', 'desc')
      .orderBy('r.id', 'asc')
      .limit(limit)
      .offset(offset);
    if (status === 'actionable') {
      query.andWhere((builder) => {
        builder.where('r.status', 'submitted')
          .orWhere((nested) => nested
            .where('r.status', 'approved')
            .andWhere('r.activationStatus', 'failed'));
      });
    } else if (status) {
      query.andWhere('r.status', status);
    }
    const rows = await query;
    return {
      reviews: rows.map((row: any) => ({
        ...row,
        requestRevision: Number(row.requestRevision),
        validationSummary: jsonValue(row.validationSummary, {}),
        riskSummary: jsonValue(row.riskSummary, {}),
      })),
      limit,
      offset,
    };
  }

  async getReview(userId: string, requestId: string): Promise<JsonRecord> {
    const request = await this.reviewRequest(requestId);
    const isProposer = request.proposerUserId === userId;
    const isLead = await this.isTeamLead(userId, request.ownerTeamId);
    const selfApprovalAllowed = isProposer
      ? await this.selfApprovalAllowed(userId, request.ownerTeamId)
      : false;
    if (!isProposer && !isLead) {
      governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill review not found');
    }
    const candidate = await this.db('skill_review_candidates')
      .where({ id: request.currentCandidateId, requestId })
      .first();
    const files = candidate
      ? await this.db('skill_review_candidate_files').where({ candidateId: candidate.id }).orderBy('path', 'asc')
      : [];
    const baseVersion = candidate?.sourceVersionId
      ? await this.db('skill_versions').where({ id: candidate.sourceVersionId }).first()
      : null;
    const baseFiles = baseVersion ? await this.packageStore.versionFiles(baseVersion.id) : [];
    const baseByPath = new Map(baseFiles.map((file) => [file.path, file]));
    const candidateByPath = new Map(files.map((file: any) => [file.path, file]));
    const targetSkill = request.targetSkillId
      ? await this.db('skills').where({ id: request.targetSkillId }).first()
      : null;
    const diff = {
      baseVersionId: baseVersion?.id || null,
      baseSemanticVersion: baseVersion?.semanticVersion || null,
      basedOnCurrentDefault: !baseVersion || baseVersion.id === targetSkill?.defaultVersionId,
      added: files.filter((file: any) => !baseByPath.has(file.path)).map((file: any) => file.path),
      modified: files
        .filter((file: any) => {
          const base = baseByPath.get(file.path);
          return base && base.contentHash !== file.contentHash;
        })
        .map((file: any) => file.path),
      deleted: baseFiles.filter((file) => !candidateByPath.has(file.path)).map((file) => file.path),
    };
    const decisions = await this.db('skill_review_decisions as d')
      .leftJoin('users as u', 'u.id', 'd.reviewerUserId')
      .select('d.*', 'u.displayName as reviewerName')
      .where('d.requestId', requestId)
      .orderBy('d.createdAt', 'asc');
    return {
      ...request,
      requestRevision: Number(request.requestRevision),
      candidate: candidate ? {
        ...candidate,
        validationSummary: jsonValue(candidate.validationSummary, {}),
        riskSummary: jsonValue(candidate.riskSummary, {}),
        diff,
        files: await Promise.all(files.map(async (file: any) => ({
          ...file,
          content: isTextMime(file.mimeType)
            ? (await this.packageStore.readBlob(file.contentHash)).toString('utf-8')
            : undefined,
        }))),
      } : null,
      decisions,
      permissions: {
        canReview: isLead && (!isProposer || selfApprovalAllowed),
        canRetryActivation: isLead && request.status === 'approved' && request.activationStatus === 'failed',
        isProposer,
        isTeamLead: isLead,
        selfApprovalAllowed,
      },
    };
  }

  async decideReview(
    userId: string,
    requestId: string,
    input: {
      decision: string;
      comment?: string;
      expectedRequestRevision: number;
      leavePreviousDefault?: boolean;
      retryActivation?: boolean;
    },
  ): Promise<JsonRecord> {
    const decision = normalizeDecision(input.decision);
    const request = await this.reviewRequest(requestId);
    await this.requireTeamLead(userId, request.ownerTeamId);
    const retryingActivation = input.retryActivation === true;
    if (retryingActivation && (
      decision !== 'approve'
      || request.status !== 'approved'
      || request.activationStatus !== 'failed'
    )) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'Only a failed approved activation can be retried');
    }
    if (!retryingActivation
      && request.proposerUserId === userId
      && !await this.selfApprovalAllowed(userId, request.ownerTeamId)) {
      governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'A proposer cannot approve or decide their own candidate');
    }
    if ((!retryingActivation && request.status !== 'submitted')
      || Number(request.requestRevision) !== input.expectedRequestRevision) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'The review request changed before the decision committed');
    }
    const candidate = await this.db('skill_review_candidates').where({ id: request.currentCandidateId }).first();
    if (!candidate) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'The current frozen candidate is missing');
    }
    const policy = await this.db('skill_candidate_policy_results')
      .where({ candidateId: candidate.id, policyVersion: GOVERNANCE_POLICY_VERSION })
      .orderBy('evaluatedAt', 'desc')
      .first();
    if (!policy || policy.outcome !== 'pass') {
      governanceError(422, 'SKILL_VALIDATION_FAILED', 'Automated platform policy must pass before approval');
    }

    const candidateFiles = await this.db('skill_review_candidate_files')
      .where({ candidateId: candidate.id })
      .orderBy('path', 'asc') as FileSnapshot[];
    const revalidated = await this.validateSnapshot({
      proposedSkillKey: candidate.skillKey,
      displayName: '',
      description: '',
    }, candidateFiles);
    if (decision === 'approve' && !revalidated.valid) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', 'The candidate no longer passes automated policy', {
        issues: revalidated.issues,
      });
    }
    const candidateMetadata = await this.packageStore.readSkillMetadata(candidateFiles);

    let skill: any = request.targetSkillId
      ? await this.db('skills').where({ id: request.targetSkillId }).first()
      : null;
    const previousDefaultVersion = skill?.defaultVersionId
      ? await this.db('skill_versions').where({ id: skill.defaultVersionId, skillId: skill.id }).first()
      : null;
    const skillId = skill?.id || uuidv4();
    const versionId = uuidv4();
    const activationErrorCode = (error: unknown) => error instanceof SkillGovernanceError
      ? error.code
      : 'SKILL_MATERIALIZATION_UNAVAILABLE';
    const reportActivationFailure = async (error: unknown) => {
      const errorCode = activationErrorCode(error);
      await this.audit({
        actorUserId: userId,
        actorRole: 'team_lead',
        action: 'skill_version.activation_failed',
        resourceType: 'skill_review_request',
        resourceId: requestId,
        policyVersion: GOVERNANCE_POLICY_VERSION,
        metadata: {
          candidateId: candidate.id,
          manifestHash: candidate.manifestHash,
          errorCode,
        },
      }).catch(() => undefined);
      await this.notify(
        request.proposerUserId,
        'skill_version.activation_failed',
        'skill_review_request',
        requestId,
        {
          skillKey: candidate.skillKey,
          semanticVersion: candidate.semanticVersion,
          errorCode,
        },
      );
    };
    const persistFailedApproval = async (error: unknown) => {
      const errorCode = activationErrorCode(error);
      let failedRevision = input.expectedRequestRevision;
      let decisionId: string | null = null;
      await this.db.transaction(async (tx) => {
        const locked = await tx('skill_review_requests').where({ id: requestId }).forUpdate().first();
        const expectedState = retryingActivation
          ? locked?.status === 'approved' && locked?.activationStatus === 'failed'
          : locked?.status === 'submitted';
        if (!expectedState || Number(locked.requestRevision) !== input.expectedRequestRevision) {
          governanceError(409, 'SKILL_REVISION_CONFLICT', 'The review request changed before activation failure committed');
        }
        failedRevision = Number(locked.requestRevision) + 1;
        if (!retryingActivation) {
          decisionId = uuidv4();
          await tx('skill_review_decisions').insert({
            id: decisionId,
            requestId,
            candidateId: candidate.id,
            decision: 'approve',
            reviewerUserId: userId,
            reviewerRole: 'team_lead',
            comment: input.comment?.trim() || null,
            policyVersion: GOVERNANCE_POLICY_VERSION,
            selfApproved: request.proposerUserId === userId,
          });
          await tx('private_skill_drafts').where({ id: request.draftId }).update({
            status: 'archived',
            updatedAt: tx.fn.now(),
          });
        }
        await tx('skill_review_requests').where({ id: requestId }).update({
          status: 'approved',
          activationStatus: 'failed',
          activationErrorCode: errorCode,
          requestRevision: failedRevision,
          updatedAt: tx.fn.now(),
        });
      });
      if (!retryingActivation) {
        await this.audit({
          actorUserId: userId,
          actorRole: 'team_lead',
          action: 'skill_review.approve',
          resourceType: 'skill_review_request',
          resourceId: requestId,
          reason: input.comment,
          policyVersion: GOVERNANCE_POLICY_VERSION,
          selfApproved: request.proposerUserId === userId,
          metadata: {
            status: 'approved',
            activationStatus: 'failed',
            requestRevision: failedRevision,
            decisionId,
            candidateId: candidate.id,
          },
        }).catch(() => undefined);
      }
      await reportActivationFailure(error);
      return failedRevision;
    };
    let materializedPath: string | null = null;
    if (decision === 'approve') {
      try {
        materializedPath = await this.packageStore.materializeVersion(
          candidate.skillKey,
          versionId,
          candidate.manifestHash,
          candidateFiles,
        );
      } catch (error) {
        const failedRevision = await persistFailedApproval(error);
        throw new CommittedSkillGovernanceError(
          503,
          'SKILL_MATERIALIZATION_UNAVAILABLE',
          'The candidate was approved, but immutable runtime materialization failed and can be retried',
          {
            requestId,
            requestRevision: failedRevision,
            activationStatus: 'failed',
            causeCode: activationErrorCode(error),
          },
        );
      }
    }

    let promotedDefault = false;
    let result: any;
    result = await withGovernanceLock(this.db, 'governed-skill', skillId, async () => {
      try {
        return await this.db.transaction(async (tx) => {
        const locked = await tx('skill_review_requests').where({ id: requestId }).forUpdate().first();
        const expectedState = retryingActivation
          ? locked?.status === 'approved' && locked?.activationStatus === 'failed'
          : locked?.status === 'submitted';
        if (!expectedState || Number(locked.requestRevision) !== input.expectedRequestRevision) {
          governanceError(409, 'SKILL_REVISION_CONFLICT', 'The review request changed before the decision committed');
        }
        const nextRevision = Number(locked.requestRevision) + 1;
        let decisionId: string;
        const selfApproved = request.proposerUserId === userId;
        if (retryingActivation) {
          const approvedDecision = await tx('skill_review_decisions')
            .select('id')
            .where({ requestId, candidateId: candidate.id, decision: 'approve' })
            .orderBy('createdAt', 'desc')
            .first();
          if (!approvedDecision) {
            governanceError(409, 'SKILL_REVISION_CONFLICT', 'The approved decision required for activation retry is missing');
          }
          decisionId = approvedDecision.id;
        } else {
          decisionId = uuidv4();
          await tx('skill_review_decisions').insert({
            id: decisionId,
            requestId,
            candidateId: candidate.id,
            decision,
            reviewerUserId: userId,
            reviewerRole: 'team_lead',
            comment: input.comment?.trim() || null,
            policyVersion: GOVERNANCE_POLICY_VERSION,
            selfApproved,
          });
        }

        if (decision === 'request_changes') {
          await tx('skill_review_requests').where({ id: requestId }).update({
            status: 'changes_requested',
            requestRevision: nextRevision,
            updatedAt: tx.fn.now(),
          });
          await tx('private_skill_drafts').where({ id: request.draftId }).update({
            status: 'private',
            updatedAt: tx.fn.now(),
          });
          return { status: 'changes_requested', requestRevision: nextRevision, decisionId };
        }
        if (decision === 'reject') {
          await tx('skill_review_requests').where({ id: requestId }).update({
            status: 'rejected',
            requestRevision: nextRevision,
            updatedAt: tx.fn.now(),
          });
          await tx('private_skill_drafts').where({ id: request.draftId }).update({
            status: 'archived',
            updatedAt: tx.fn.now(),
          });
          return { status: 'rejected', requestRevision: nextRevision, decisionId };
        }

        if (!skill) {
          const collision = await tx('skills').where({ skillKey: candidate.skillKey }).first();
          if (collision) {
            governanceError(409, 'SKILL_REVISION_CONFLICT', 'The proposed skill ID was approved elsewhere first');
          }
          await tx('skills').insert({
            id: skillId,
            skillKey: candidate.skillKey,
            displayName: candidateMetadata.name || displayNameFromKey(candidate.skillKey),
            description: candidateMetadata.description || null,
            ownerTeamId: request.ownerTeamId,
            originalCreatorUserId: request.proposerUserId,
            defaultVersionId: versionId,
            status: 'active',
          });
          skill = { id: skillId, defaultVersionId: null, ownerTeamId: request.ownerTeamId };
        } else {
          const duplicate = await tx('skill_versions')
            .where({ skillId, semanticVersion: candidate.semanticVersion })
            .first();
          if (duplicate) {
            governanceError(409, 'SKILL_REVISION_CONFLICT', 'The semantic version was approved elsewhere first');
          }
        }
        await tx('skill_versions').insert({
          id: versionId,
          skillId,
          semanticVersion: candidate.semanticVersion,
          manifestHash: candidate.manifestHash,
          baseVersionId: candidate.sourceVersionId || null,
          status: 'active',
          createdByUserId: request.proposerUserId,
          approvedCandidateId: candidate.id,
          validationSummary: JSON.stringify(revalidated),
          materializedPath,
          activatedAt: tx.fn.now(),
        });
        if (candidateFiles.length) {
          await tx('skill_version_files').insert(candidateFiles.map((file) => ({
            skillVersionId: versionId,
            path: file.path,
            contentHash: file.contentHash,
            executable: (Number(file.mode) & 0o111) !== 0,
            mode: file.mode,
            sizeBytes: file.sizeBytes,
            mimeType: file.mimeType,
          })));
        }
        const shouldSetDefault = !skill.defaultVersionId || !input.leavePreviousDefault;
        if (shouldSetDefault) {
          await tx('skills').where({ id: skillId }).update({
            defaultVersionId: versionId,
            updatedAt: tx.fn.now(),
          });
        }
        await tx('skill_review_requests').where({ id: requestId }).update({
          targetSkillId: skillId,
          status: 'approved',
          activationStatus: 'active',
          activationErrorCode: null,
          requestRevision: nextRevision,
          updatedAt: tx.fn.now(),
        });
        await tx('private_skill_drafts').where({ id: request.draftId }).update({
          status: 'archived',
          updatedAt: tx.fn.now(),
        });
        if (shouldSetDefault) {
          await this.packageStore.promoteDefaultPackage(candidate.skillKey, materializedPath!);
          promotedDefault = true;
        }
        return {
          status: 'approved',
          requestRevision: nextRevision,
          decisionId,
          skillId,
          versionId,
          semanticVersion: candidate.semanticVersion,
          manifestHash: candidate.manifestHash,
          active: true,
          defaultSelected: shouldSetDefault,
        };
        });
      } catch (error) {
        const normalizedError = normalizeDatabaseConflict(error);
        if (materializedPath) {
          await fs.rm(materializedPath, { recursive: true, force: true });
        }
        if (promotedDefault) {
          if (previousDefaultVersion?.materializedPath) {
            await this.packageStore.promoteDefaultPackage(
              candidate.skillKey,
              previousDefaultVersion.materializedPath,
            )
              .catch(() => undefined);
          } else {
            await fs.rm(path.join(skillsRoot, candidate.skillKey), { recursive: true, force: true });
          }
        }
        if (decision === 'approve' && isMaterializationError(normalizedError)) {
          const failedRevision = await persistFailedApproval(normalizedError);
          throw new CommittedSkillGovernanceError(
            503,
            'SKILL_MATERIALIZATION_UNAVAILABLE',
            'The candidate was approved, but activation failed and can be retried',
            {
              requestId,
              requestRevision: failedRevision,
              activationStatus: 'failed',
              causeCode: activationErrorCode(normalizedError),
            },
          );
        }
        throw normalizedError;
      }
    });
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: 'team_lead',
      action: retryingActivation ? 'skill_version.activation_retried' : `skill_review.${decision}`,
      resourceType: 'skill_review_request',
      resourceId: requestId,
      reason: input.comment,
      policyVersion: GOVERNANCE_POLICY_VERSION,
      selfApproved: request.proposerUserId === userId,
      metadata: result,
    });
    if (decision === 'approve') {
      await this.audit({
        actorUserId: userId,
        actorRole: 'team_lead',
        action: 'skill_version.activated',
        resourceType: 'skill_version',
        resourceId: String(result.versionId),
        policyVersion: GOVERNANCE_POLICY_VERSION,
        metadata: { skillId: result.skillId, manifestHash: result.manifestHash },
      });
      if (result.defaultSelected) {
        await this.audit({
          actorUserId: userId,
          actorRole: 'team_lead',
          action: 'skill.default_version_changed',
          resourceType: 'skill',
          resourceId: String(result.skillId),
          policyVersion: GOVERNANCE_POLICY_VERSION,
          metadata: {
            previousVersionId: previousDefaultVersion?.id || null,
            versionId: result.versionId,
          },
        });
      }
    }
    await this.notify(
      request.proposerUserId,
      retryingActivation ? 'skill_version.activation_retried' : `skill_review.${decision}`,
      'skill_review_request',
      requestId,
      {
      comment: input.comment?.trim() || null,
      skillKey: candidate.skillKey,
      semanticVersion: candidate.semanticVersion,
      },
    );
    return { ...result, auditEventId };
  }

  async retryReviewActivation(
    userId: string,
    requestId: string,
    expectedRequestRevision: number,
  ): Promise<JsonRecord> {
    return this.decideReview(userId, requestId, {
      decision: 'approve',
      expectedRequestRevision,
      retryActivation: true,
    });
  }

  async listReviewEvents(userId: string, requestId: string): Promise<JsonRecord> {
    await this.getReview(userId, requestId);
    const events = await this.db('audit_events')
      .where({ resourceType: 'skill_review_request', resourceId: requestId })
      .orderBy('createdAt', 'asc');
    return { events: events.map((event: any) => ({ ...event, metadata: jsonValue(event.metadata, {}) })) };
  }

  async catalog(userId: string, options: { limit?: number; offset?: number } = {}): Promise<JsonRecord> {
    const user = await this.db('users').where({ id: userId }).first();
    if (!user) governanceError(401, 'AUTHENTICATION_REQUIRED', 'User not found');
    const isPlatformAdmin = await this.isPlatformAdmin(userId);
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 100);
    const offset = Math.max(Number(options.offset || 0), 0);
    const effective = await this.effectiveSkillAccess(userId);
    const teamIds = await this.userTeamIds(userId);
    const leadRows = await this.db('team_role_bindings as role')
      .join('group_members as membership', function joinMembership() {
        this.on('membership.groupId', '=', 'role.teamId')
          .andOn('membership.userId', '=', 'role.userId');
      })
      .select('role.teamId')
      .where({ 'role.userId': userId, 'role.role': 'lead' });
    const leadTeamIds = new Set(leadRows.map((row: any) => String(row.teamId)));
    const query = this.db('skills as s')
      .join('groups as g', 'g.id', 's.ownerTeamId')
      .leftJoin('skill_versions as v', 'v.id', 's.defaultVersionId')
      .select(
        's.id',
        's.skillKey',
        's.displayName',
        's.description',
        's.ownerTeamId',
        'g.name as ownerTeamName',
        's.status',
        's.defaultVersionId',
        'v.semanticVersion as defaultSemanticVersion',
        'v.manifestHash as defaultManifestHash',
        'v.status as defaultVersionStatus',
        's.createdAt',
        's.updatedAt',
      )
      .orderBy('s.displayName', 'asc')
      .orderBy('s.id', 'asc')
      .limit(limit)
      .offset(offset);
    if (!isPlatformAdmin) {
      query.where((builder) => {
        if (effective.skillIds.length) builder.whereIn('s.id', effective.skillIds);
        if (teamIds.length) {
          if (effective.skillIds.length) builder.orWhereIn('s.ownerTeamId', teamIds);
          else builder.whereIn('s.ownerTeamId', teamIds);
        }
        if (!effective.skillIds.length && !teamIds.length) builder.whereRaw('FALSE');
      });
    }
    const skills = await query;
    return {
      skills: skills.map((skill: any) => ({
        ...skill,
        entitled: effective.skillIds.includes(skill.id),
        accessReasons: effective.reasons[skill.id] || [],
        canAdminister: isPlatformAdmin || leadTeamIds.has(skill.ownerTeamId),
      })),
      limit,
      offset,
    };
  }

  async listVersions(userId: string, skillReference: string): Promise<JsonRecord> {
    const skill = await this.requireCatalogVisibility(userId, skillReference);
    const versions = await this.db('skill_versions')
      .select(
        'id',
        'semanticVersion',
        'manifestHash',
        'baseVersionId',
        'status',
        'createdByUserId',
        'validationSummary',
        'activatedAt',
        'createdAt',
      )
      .where({ skillId: skill.id })
      .orderBy('createdAt', 'desc');
    return {
      skill,
      versions: versions.map((version: any) => ({
        ...version,
        validationSummary: jsonValue(version.validationSummary, {}),
        isDefault: version.id === skill.defaultVersionId,
      })),
    };
  }

  async getSkillDetail(userId: string, skillReference: string): Promise<JsonRecord> {
    const visibleSkill = await this.requireCatalogVisibility(userId, skillReference);
    const [ownerTeam, effective, isPlatformAdmin, isTeamLead, versionsResult, teamGrantCount, userGrantCount, workspacePinCount] = await Promise.all([
      this.db('groups').select('id', 'name').where({ id: visibleSkill.ownerTeamId }).first(),
      this.effectiveSkillAccess(userId),
      this.isPlatformAdmin(userId),
      this.isTeamLead(userId, visibleSkill.ownerTeamId),
      this.listVersions(userId, visibleSkill.id),
      this.db('team_skill_grants').where({ skillId: visibleSkill.id, effect: 'allow' }).count<{ count: string }[]>({ count: '*' }),
      this.db('user_skill_grants').where({ skillId: visibleSkill.id, effect: 'allow' }).count<{ count: string }[]>({ count: '*' }),
      this.db('workspace_skill_pins').where({ skillId: visibleSkill.id }).count<{ count: string }[]>({ count: '*' }),
    ]);
    const versions = (versionsResult.versions || []) as any[];
    const defaultVersion = versions.find((version) => version.id === visibleSkill.defaultVersionId) || null;
    const files = defaultVersion
      ? await this.packageStore.versionFiles(defaultVersion.id)
      : [];
    const readableFiles = await Promise.all(files.map(async (file) => ({
      ...file,
      content: isTextMime(file.mimeType)
        ? (await this.packageStore.readBlob(file.contentHash)).toString('utf-8')
        : undefined,
      encoding: isTextMime(file.mimeType) ? 'utf-8' : 'binary',
    })));
    const validationSummary = jsonValue<Partial<ValidationResult>>(
      defaultVersion?.validationSummary,
      {},
    );
    const metadata = await this.packageStore.readSkillMetadata(files);
    const declaredCapabilities = validationSummary.declaredCapabilities;
    const capabilities = {
      tools: Array.from(new Set([...(declaredCapabilities?.tools || []), ...metadata.tools])),
      mcpServers: Array.from(new Set([...(declaredCapabilities?.mcpServers || []), ...metadata.mcpServers])),
      scripts: Array.from(new Set([...(declaredCapabilities?.scripts || []), ...metadata.scripts])),
      pluginId: declaredCapabilities?.pluginId || null,
    };
    return {
      skill: {
        ...visibleSkill,
        ownerTeamName: ownerTeam?.name || 'Unknown Team',
        defaultSemanticVersion: defaultVersion?.semanticVersion || null,
        defaultManifestHash: defaultVersion?.manifestHash || null,
        defaultVersionStatus: defaultVersion?.status || null,
        entitled: effective.skillIds.includes(visibleSkill.id),
        accessReasons: effective.reasons[visibleSkill.id] || [],
        canAdminister: isPlatformAdmin || isTeamLead,
      },
      defaultVersion,
      versions,
      files: readableFiles,
      capabilities,
      usage: {
        teamGrantCount: Number(teamGrantCount[0]?.count || 0),
        userGrantCount: Number(userGrantCount[0]?.count || 0),
        workspacePinCount: Number(workspacePinCount[0]?.count || 0),
      },
      permissions: {
        canImprove: visibleSkill.status === 'active',
        canArchive: (isPlatformAdmin || isTeamLead) && visibleSkill.status !== 'retired',
        canRestore: (isPlatformAdmin || isTeamLead) && visibleSkill.status === 'retired',
      },
    };
  }

  async setSkillStatus(
    userId: string,
    skillReference: string,
    action: 'archive' | 'restore',
  ): Promise<JsonRecord> {
    const skill = await this.requireSkillAdministration(userId, skillReference);
    const nextStatus = action === 'archive' ? 'retired' : 'active';
    const allowed = action === 'archive'
      ? ['active', 'suspended'].includes(skill.status)
      : skill.status === 'retired';
    if (!allowed) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', `Cannot ${action} a ${skill.status} skill`);
    }

    const defaultVersion = skill.defaultVersionId
      ? await this.db('skill_versions').where({ id: skill.defaultVersionId, skillId: skill.id }).first()
      : null;
    if (action === 'restore' && (!defaultVersion || defaultVersion.status !== 'active')) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'Restore an active published version before restoring the skill');
    }

    await withGovernanceLock(this.db, 'governed-skill', skill.id, async () => {
      const updated = await this.db('skills')
        .where({ id: skill.id, status: skill.status })
        .update({ status: nextStatus, updatedAt: this.db.fn.now() });
      if (!updated) {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'The skill changed before the lifecycle update committed');
      }
      try {
        if (action === 'archive') {
          await this.packageStore.withdrawDefaultPackage(skill.skillKey);
        } else {
          await this.packageStore.promoteDefaultPackage(skill.skillKey, defaultVersion.materializedPath);
        }
      } catch (error) {
        await this.db('skills').where({ id: skill.id }).update({
          status: skill.status,
          updatedAt: this.db.fn.now(),
        });
        throw error;
      }
    });

    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: await this.actorRoleForSkillAdmin(userId, skill.ownerTeamId),
      action: action === 'archive' ? 'skill.archived' : 'skill.restored',
      resourceType: 'skill',
      resourceId: skill.id,
      previousState: { status: skill.status },
      newState: { status: nextStatus },
      metadata: { skillKey: skill.skillKey, defaultVersionId: skill.defaultVersionId },
    });
    await this.notifyTeamMembers(
      skill.ownerTeamId,
      action === 'archive' ? 'skill.archived' : 'skill.restored',
      'skill',
      skill.id,
      { skillKey: skill.skillKey, status: nextStatus },
    );
    if (action === 'archive' && defaultVersion) {
      await this.notifyPinnedVersionUsers(defaultVersion.id, 'skill.archived', {
        skillId: skill.id,
        skillKey: skill.skillKey,
        versionId: defaultVersion.id,
      });
    }
    return { skillId: skill.id, skillKey: skill.skillKey, status: nextStatus, auditEventId };
  }

  async setTeamSkillGrant(userId: string, teamId: string, skillReference: string, allow: boolean): Promise<JsonRecord> {
    await this.requireUser(userId);
    const isPlatformAdmin = await this.isPlatformAdmin(userId);
    const skill = await this.resolveSkill(skillReference);
    if (!skill) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    if (skill.status !== 'active' || !await this.hasActiveVersion(skill.id)) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'Only an active approved skill can be assigned');
    }
    if (!isPlatformAdmin) {
      await this.requireTeamLead(userId, teamId);
      if (skill.ownerTeamId !== teamId) {
        governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'A Team Lead may assign skills only for their own Team');
      }
    }
    if (allow) {
      await this.db('team_skill_grants').insert({
        teamId,
        skillId: skill.id,
        effect: 'allow',
        grantedByUserId: userId,
      }).onConflict(['teamId', 'skillId']).merge({
        effect: 'allow',
        grantedByUserId: userId,
        updatedAt: this.db.fn.now(),
      });
    } else {
      await this.db('team_skill_grants').where({ teamId, skillId: skill.id }).del();
    }
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: isPlatformAdmin ? 'platform_admin' : 'team_lead',
      action: allow ? 'skill_access.team_granted' : 'skill_access.team_revoked',
      resourceType: 'skill',
      resourceId: skill.id,
      metadata: { teamId },
    });
    await this.notifyTeamMembers(teamId, allow ? 'skill_access.granted' : 'skill_access.revoked', 'skill', skill.id, {
      skillKey: skill.skillKey,
      source: 'team',
      teamId,
    });
    return { teamId, skillId: skill.id, skillKey: skill.skillKey, granted: allow, auditEventId };
  }

  async setUserSkillGrant(
    adminUserId: string,
    targetUserId: string,
    skillReference: string,
    allow: boolean,
  ): Promise<JsonRecord> {
    await this.requirePlatformAdmin(adminUserId);
    await this.requireUser(targetUserId);
    const skill = await this.resolveSkill(skillReference);
    if (!skill) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    if (skill.status !== 'active' || !await this.hasActiveVersion(skill.id)) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'Only an active approved skill can be assigned');
    }
    if (allow) {
      await this.db('user_skill_grants').insert({
        userId: targetUserId,
        skillId: skill.id,
        effect: 'allow',
        grantedByUserId: adminUserId,
      }).onConflict(['userId', 'skillId']).merge({
        effect: 'allow',
        grantedByUserId: adminUserId,
        updatedAt: this.db.fn.now(),
      });
    } else {
      await this.db('user_skill_grants').where({ userId: targetUserId, skillId: skill.id }).del();
    }
    const auditEventId = await this.audit({
      actorUserId: adminUserId,
      actorRole: 'platform_admin',
      action: allow ? 'skill_access.user_granted' : 'skill_access.user_revoked',
      resourceType: 'skill',
      resourceId: skill.id,
      metadata: { targetUserId },
    });
    await this.notify(targetUserId, allow ? 'skill_access.granted' : 'skill_access.revoked', 'skill', skill.id, {
      skillKey: skill.skillKey,
      source: 'direct',
    });
    return { userId: targetUserId, skillId: skill.id, skillKey: skill.skillKey, granted: allow, auditEventId };
  }

  async setDefaultVersion(userId: string, skillReference: string, versionId: string): Promise<JsonRecord> {
    const skill = await this.requireSkillAdministration(userId, skillReference);
    const transition = await withGovernanceLock(this.db, 'governed-skill', skill.id, async () => {
      const [currentSkill, version] = await Promise.all([
        this.db('skills').where({ id: skill.id }).first(),
        this.db('skill_versions').where({ id: versionId, skillId: skill.id }).first(),
      ]);
      if (!currentSkill || !version || version.status !== 'active') {
        governanceError(409, 'SKILL_REVISION_CONFLICT', 'Default version must be active');
      }
      if (currentSkill.defaultVersionId === version.id) {
        return { previousVersionId: currentSkill.defaultVersionId, version };
      }
      const previous = currentSkill.defaultVersionId
        ? await this.db('skill_versions').where({ id: currentSkill.defaultVersionId, skillId: skill.id }).first()
        : null;
      await this.packageStore.promoteDefaultPackage(skill.skillKey, version.materializedPath);
      try {
        await this.db('skills').where({ id: skill.id }).update({
          defaultVersionId: version.id,
          updatedAt: this.db.fn.now(),
        });
      } catch (error) {
        if (previous?.materializedPath) {
          await this.packageStore.promoteDefaultPackage(skill.skillKey, previous.materializedPath)
            .catch(() => undefined);
        } else {
          await fs.rm(path.join(skillsRoot, skill.skillKey), { recursive: true, force: true });
        }
        throw error;
      }
      return { previousVersionId: currentSkill.defaultVersionId, version };
    });
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: await this.actorRoleForSkillAdmin(userId, skill.ownerTeamId),
      action: 'skill.default_version_changed',
      resourceType: 'skill',
      resourceId: skill.id,
      metadata: { previousVersionId: transition.previousVersionId, versionId: transition.version.id },
    });
    return {
      skillId: skill.id,
      skillKey: skill.skillKey,
      defaultVersionId: transition.version.id,
      auditEventId,
    };
  }

  async setVersionStatus(
    userId: string,
    skillReference: string,
    versionId: string,
    action: 'suspend' | 'restore' | 'retire',
  ): Promise<JsonRecord> {
    const skill = await this.requireSkillAdministration(userId, skillReference);
    const version = await this.db('skill_versions').where({ id: versionId, skillId: skill.id }).first();
    if (!version) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill version not found');
    const nextStatus = action === 'restore' ? 'active' : action === 'suspend' ? 'suspended' : 'retired';
    const allowed =
      (action === 'suspend' && version.status === 'active')
      || (action === 'restore' && ['suspended', 'retired'].includes(version.status))
      || (action === 'retire' && ['active', 'suspended'].includes(version.status));
    if (!allowed) {
      governanceError(409, 'SKILL_REVISION_CONFLICT', `Cannot ${action} a ${version.status} version`);
    }
    const lifecycle = await withGovernanceLock(this.db, 'governed-skill', skill.id, async () => {
      const transition = await this.db.transaction(async (tx) => {
        const lockedSkill = await tx('skills').where({ id: skill.id }).forUpdate().first();
        const lockedVersion = await tx('skill_versions').where({ id: version.id, skillId: skill.id }).forUpdate().first();
        if (!lockedSkill || !lockedVersion || lockedVersion.status !== version.status) {
          governanceError(409, 'SKILL_REVISION_CONFLICT', 'The skill version changed before the lifecycle update committed');
        }
        await tx('skill_versions').where({ id: version.id }).update({ status: nextStatus });

        let defaultVersionId = lockedSkill.defaultVersionId;
        let skillStatus = lockedSkill.status;
        if (nextStatus !== 'active' && defaultVersionId === version.id) {
          const fallback = await tx('skill_versions')
            .where({ skillId: skill.id, status: 'active' })
            .whereNot({ id: version.id })
            .orderBy('activatedAt', 'desc')
            .first();
          defaultVersionId = fallback?.id || null;
          if (!defaultVersionId) skillStatus = 'suspended';
        } else if (nextStatus === 'active' && !defaultVersionId) {
          defaultVersionId = version.id;
          skillStatus = 'active';
        }
        if (defaultVersionId !== lockedSkill.defaultVersionId || skillStatus !== lockedSkill.status) {
          await tx('skills').where({ id: skill.id }).update({
            defaultVersionId,
            status: skillStatus,
            updatedAt: tx.fn.now(),
          });
        }
        const selectedDefault = defaultVersionId
          ? await tx('skill_versions').where({ id: defaultVersionId, skillId: skill.id }).first()
          : null;
        return {
          defaultVersionId,
          defaultChanged: defaultVersionId !== lockedSkill.defaultVersionId,
          materializedPath: selectedDefault?.materializedPath || null,
          skillStatus,
          previousDefaultVersionId: lockedSkill.defaultVersionId,
          previousSkillStatus: lockedSkill.status,
        };
      });
      if (transition.defaultChanged && transition.defaultVersionId) {
        try {
          await this.packageStore.promoteDefaultPackage(skill.skillKey, transition.materializedPath);
        } catch (error) {
          await this.db.transaction(async (tx) => {
            await tx('skill_versions').where({ id: version.id }).update({ status: version.status });
            await tx('skills').where({ id: skill.id }).update({
              defaultVersionId: transition.previousDefaultVersionId,
              status: transition.previousSkillStatus,
              updatedAt: tx.fn.now(),
            });
          });
          throw new SkillGovernanceError(
            503,
            'SKILL_MATERIALIZATION_UNAVAILABLE',
            'The version lifecycle change could not be activated safely',
          );
        }
      }
      return transition;
    });
    const actionPastTense = action === 'suspend' ? 'suspended' : action === 'restore' ? 'restored' : 'retired';
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: await this.actorRoleForSkillAdmin(userId, skill.ownerTeamId),
      action: `skill_version.${actionPastTense}`,
      resourceType: 'skill_version',
      resourceId: version.id,
      metadata: {
        skillId: skill.id,
        previousStatus: version.status,
        status: nextStatus,
        defaultVersionId: lifecycle.defaultVersionId,
        skillStatus: lifecycle.skillStatus,
      },
    });
    if (action === 'suspend' || action === 'retire') {
      await this.notifyPinnedVersionUsers(
        version.id,
        `skill_version.${actionPastTense}`,
        {
          skillId: skill.id,
          skillKey: skill.skillKey,
          versionId: version.id,
          semanticVersion: version.semanticVersion,
        },
      );
    }
    return { skillId: skill.id, versionId: version.id, status: nextStatus, auditEventId };
  }

  async transferSkill(adminUserId: string, skillReference: string, targetTeamId: string): Promise<JsonRecord> {
    await this.requirePlatformAdmin(adminUserId);
    const skill = await this.resolveSkill(skillReference);
    if (!skill) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    const targetTeam = await this.db('groups').where({ id: targetTeamId }).first();
    if (!targetTeam) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Target Team not found');
    const open = await this.db('skill_review_requests')
      .where({ targetSkillId: skill.id })
      .whereIn('status', ['submitted', 'changes_requested'])
      .first();
    if (open) governanceError(409, 'SKILL_REVISION_CONFLICT', 'Ownership cannot transfer while a review is open');
    await this.db('skills').where({ id: skill.id }).update({
      ownerTeamId: targetTeamId,
      updatedAt: this.db.fn.now(),
    });
    const auditEventId = await this.audit({
      actorUserId: adminUserId,
      actorRole: 'platform_admin',
      action: 'skill.ownership_transferred',
      resourceType: 'skill',
      resourceId: skill.id,
      metadata: { previousOwnerTeamId: skill.ownerTeamId, ownerTeamId: targetTeamId },
    });
    return { skillId: skill.id, ownerTeamId: targetTeamId, auditEventId };
  }

  async pinWorkspaceSkill(
    userId: string,
    workspaceId: string,
    skillReference: string,
    versionId: string,
  ): Promise<JsonRecord> {
    const workspace = await this.requireWorkspacePublisher(userId, workspaceId);
    if (workspace.workspaceType === 'team' || workspace.visibility === 'team') {
      governanceError(
        403,
        'SKILL_ACTION_FORBIDDEN',
        'Published Team Workspace pins can change only through workspace publication or restore',
      );
    }
    const skill = await this.resolveSkill(skillReference);
    if (!skill) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    const effective = await this.effectiveSkillAccess(userId);
    if (!effective.skillIds.includes(skill.id)) {
      governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'The workspace publisher is not entitled to this skill');
    }
    const version = await this.db('skill_versions').where({ id: versionId, skillId: skill.id }).first();
    if (!version || version.status !== 'active' || skill.status !== 'active') {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'Only an approved active version may be pinned');
    }
    await this.db('workspace_skill_pins').insert({
      workspaceId,
      skillId: skill.id,
      skillVersionId: version.id,
      semanticVersion: version.semanticVersion,
      manifestHash: version.manifestHash,
      pinnedByUserId: userId,
      validationStatus: 'valid',
    }).onConflict(['workspaceId', 'skillId']).merge({
      skillVersionId: version.id,
      semanticVersion: version.semanticVersion,
      manifestHash: version.manifestHash,
      pinnedByUserId: userId,
      validationStatus: 'valid',
      updatedAt: this.db.fn.now(),
    });
    const auditEventId = await this.audit({
      actorUserId: userId,
      actorRole: workspace.ownerId === userId ? 'workspace_owner' : 'workspace_publisher',
      action: 'workspace_skill.pinned',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: {
        skillId: skill.id,
        skillKey: skill.skillKey,
        versionId: version.id,
        semanticVersion: version.semanticVersion,
        manifestHash: version.manifestHash,
      },
    });
    return {
      workspaceId,
      skillId: skill.id,
      skillKey: skill.skillKey,
      versionId: version.id,
      semanticVersion: version.semanticVersion,
      manifestHash: version.manifestHash,
      auditEventId,
    };
  }

  async listWorkspacePins(userId: string, workspaceId: string): Promise<JsonRecord> {
    await this.requireWorkspaceRead(userId, workspaceId);
    const pins = await this.db('workspace_skill_pins as p')
      .join('skills as s', 's.id', 'p.skillId')
      .join('skill_versions as v', 'v.id', 'p.skillVersionId')
      .select(
        'p.workspaceId',
        'p.skillId',
        's.skillKey',
        's.displayName',
        's.ownerTeamId',
        's.status as skillStatus',
        'p.skillVersionId as versionId',
        'p.semanticVersion',
        'p.manifestHash',
        'p.validationStatus',
        'v.status as versionStatus',
      )
      .where('p.workspaceId', workspaceId)
      .orderBy('s.displayName', 'asc');
    const effective = await this.effectiveSkillAccess(userId);
    return {
      pins: pins.map((pin: any) => ({
        ...pin,
        entitled: effective.skillIds.includes(pin.skillId),
        available: effective.skillIds.includes(pin.skillId)
          && pin.skillStatus === 'active'
          && pin.versionStatus === 'active',
        accessReasons: effective.reasons[pin.skillId] || [],
      })),
    };
  }

  async authorizeInvocation(userId: string, workspaceId: string, skillKey: string): Promise<JsonRecord> {
    await this.requireWorkspaceRead(userId, workspaceId);
    const skill = await this.resolveSkill(skillKey);
    if (!skill) {
      return { allowed: false, code: 'SKILL_RESOURCE_NOT_FOUND', reason: 'The governed skill does not exist.' };
    }
    const workspace = await this.db('workspaces').where({ id: workspaceId }).first();
    const pin = await this.db('workspace_skill_pins').where({ workspaceId, skillId: skill.id }).first();
    if (workspace?.workspaceType === 'team' && !pin) {
      return {
        allowed: false,
        code: 'SKILL_VERSION_NOT_PINNED',
        reason: 'This Team Workspace does not pin an exact approved version.',
      };
    }
    const versionId = pin?.skillVersionId || skill.defaultVersionId;
    const version = versionId ? await this.db('skill_versions').where({ id: versionId, skillId: skill.id }).first() : null;
    if (!version || version.status !== 'active' || skill.status !== 'active') {
      return {
        allowed: false,
        code: 'SKILL_VERSION_UNAVAILABLE',
        reason: 'The selected skill version is suspended, retired, or unavailable.',
      };
    }
    if (pin && (pin.semanticVersion !== version.semanticVersion || pin.manifestHash !== version.manifestHash)) {
      return {
        allowed: false,
        code: 'SKILL_PIN_INTEGRITY_FAILED',
        reason: 'The workspace pin no longer matches the immutable version manifest.',
      };
    }
    const effective = await this.effectiveSkillAccess(userId);
    if (!effective.skillIds.includes(skill.id)) {
      return {
        allowed: false,
        code: 'SKILL_ENTITLEMENT_REQUIRED',
        reason: `${skill.displayName} is not assigned to you directly or through any of your Teams.`,
      };
    }
    return {
      allowed: true,
      skillId: skill.id,
      skillKey: skill.skillKey,
      versionId: version.id,
      semanticVersion: version.semanticVersion,
      manifestHash: version.manifestHash,
      materializedPath: version.materializedPath,
      accessReasons: effective.reasons[skill.id] || [],
    };
  }

  async listNotifications(userId: string, unreadOnly = false): Promise<JsonRecord> {
    const query = this.db('notifications')
      .where({ recipientUserId: userId })
      .orderBy('createdAt', 'desc')
      .limit(100);
    if (unreadOnly) query.whereNull('readAt');
    const notifications = await query;
    return {
      notifications: notifications.map((notification: any) => ({
        ...notification,
        payload: jsonValue(notification.payload, {}),
      })),
    };
  }

  async listAuditEvents(
    userId: string,
    filters: {
      resourceType?: string;
      resourceId?: string;
      action?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<JsonRecord> {
    await this.requirePlatformAdmin(userId);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);
    const offset = Math.max(Number(filters.offset || 0), 0);
    const query = this.db('audit_events as event')
      .leftJoin('users as actor', 'actor.id', 'event.actorUserId')
      .select('event.*', 'actor.displayName as actorName')
      .orderBy('event.createdAt', 'desc')
      .orderBy('event.id', 'desc')
      .limit(limit)
      .offset(offset);
    if (filters.resourceType) query.where('event.resourceType', filters.resourceType);
    if (filters.resourceId) query.where('event.resourceId', filters.resourceId);
    if (filters.action) query.where('event.action', filters.action);
    const events = await query;
    return {
      events: events.map((event: any) => ({
        ...event,
        metadata: jsonValue(event.metadata, {}),
      })),
      limit,
      offset,
    };
  }

  async listEligibleTeams(userId: string): Promise<any[]> {
    return this.db('groups as g')
      .join('group_members as gm', 'gm.groupId', 'g.id')
      .leftJoin('team_role_bindings as tr', function joinLead() {
        this.on('tr.teamId', '=', 'g.id')
          .andOn('tr.userId', '=', 'gm.userId')
          .andOnVal('tr.role', '=', 'lead');
      })
      .select('g.id', 'g.name')
      .select(this.db.raw('CASE WHEN tr."userId" IS NULL THEN FALSE ELSE TRUE END AS "isLead"'))
      .where('gm.userId', userId)
      .orderBy('g.name', 'asc');
  }

  async setTeamLead(adminUserId: string, teamId: string, targetUserId: string, enabled: boolean): Promise<JsonRecord> {
    await this.requirePlatformAdmin(adminUserId);
    await this.requireTeamMembership(targetUserId, teamId);
    if (enabled) {
      await this.db('team_role_bindings').insert({
        teamId,
        userId: targetUserId,
        role: 'lead',
        assignedByUserId: adminUserId,
      }).onConflict(['teamId', 'userId', 'role']).ignore();
    } else {
      await this.db('team_role_bindings').where({ teamId, userId: targetUserId, role: 'lead' }).del();
    }
    const auditEventId = await this.audit({
      actorUserId: adminUserId,
      actorRole: 'platform_admin',
      action: enabled ? 'team_role.lead_assigned' : 'team_role.lead_removed',
      resourceType: 'team',
      resourceId: teamId,
      metadata: { targetUserId },
    });
    return { teamId, userId: targetUserId, role: 'lead', enabled, auditEventId };
  }

  async effectiveSkillAccess(userId: string): Promise<{ skillIds: string[]; skillKeys: string[]; reasons: Record<string, string[]> }> {
    const teamIds = await this.userTeamIds(userId);
    const [direct, team] = await Promise.all([
      this.db('user_skill_grants as ug')
        .join('skills as s', 's.id', 'ug.skillId')
        .join('skill_versions as v', 'v.id', 's.defaultVersionId')
        .select('s.id', 's.skillKey')
        .where({
          'ug.userId': userId,
          'ug.effect': 'allow',
          's.status': 'active',
          'v.status': 'active',
        }),
      teamIds.length
        ? this.db('team_skill_grants as tg')
          .join('skills as s', 's.id', 'tg.skillId')
          .join('skill_versions as v', 'v.id', 's.defaultVersionId')
          .join('groups as g', 'g.id', 'tg.teamId')
          .select('s.id', 's.skillKey', 'g.name as teamName')
          .where({ 'tg.effect': 'allow', 's.status': 'active', 'v.status': 'active' })
          .whereIn('tg.teamId', teamIds)
        : Promise.resolve([]),
    ]);
    const byId = new Map<string, { skillKey: string; reasons: string[] }>();
    for (const row of direct as any[]) {
      byId.set(row.id, { skillKey: row.skillKey, reasons: ['Direct access'] });
    }
    for (const row of team as any[]) {
      const current: { skillKey: string; reasons: string[] } = byId.get(row.id)
        || { skillKey: row.skillKey, reasons: [] };
      current.reasons.push(`via ${row.teamName} Team`);
      byId.set(row.id, current);
    }
    return {
      skillIds: [...byId.keys()].sort(),
      skillKeys: [...byId.values()].map((item) => item.skillKey).sort(),
      reasons: Object.fromEntries([...byId].map(([id, value]) => [id, Array.from(new Set(value.reasons))])),
    };
  }

  private async createDraftRevision(input: {
    draftId: string;
    userId: string;
    revisionNumber: number;
    parentRevisionId: string | null;
    files: FileSnapshot[];
    validationSummary: JsonRecord;
    createDraft?: JsonRecord;
    updateDraft?: JsonRecord & { expectedRevision: number };
  }): Promise<{ id: string; manifestHash: string }> {
    const revisionId = uuidv4();
    const manifestHash = computePackageManifestHash(input.files);
    await this.db.transaction(async (tx) => {
      if (input.createDraft) {
        await tx('private_skill_drafts').insert({
          id: input.draftId,
          ...input.createDraft,
          currentDraftRevisionId: revisionId,
          draftRevision: input.revisionNumber,
          status: 'private',
        });
      } else if (input.updateDraft) {
        const { expectedRevision, ...updates } = input.updateDraft;
        const updated = await tx('private_skill_drafts')
          .where({ id: input.draftId, ownerUserId: input.userId, status: 'private', draftRevision: expectedRevision })
          .update({
            ...updates,
            currentDraftRevisionId: revisionId,
            draftRevision: input.revisionNumber,
            updatedAt: tx.fn.now(),
          });
        if (!updated) governanceError(409, 'SKILL_REVISION_CONFLICT', 'The draft changed before the update committed');
      }
      await tx('skill_draft_revisions').insert({
        id: revisionId,
        draftId: input.draftId,
        revisionNumber: input.revisionNumber,
        parentRevisionId: input.parentRevisionId,
        manifestHash,
        validationSummary: JSON.stringify(input.validationSummary),
        createdByUserId: input.userId,
      });
      if (input.files.length) {
        await tx('skill_draft_revision_files').insert(input.files.map((file) => ({
          draftRevisionId: revisionId,
          path: file.path,
          contentHash: file.contentHash,
          mode: file.mode,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
        })));
      }
    });
    return { id: revisionId, manifestHash };
  }

  private assertPackageLimits(files: FileSnapshot[]): void {
    if (files.length > MAX_FILES) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', `Skill package exceeds ${MAX_FILES} files`);
    }
    const size = files.reduce((total, file) => total + Number(file.sizeBytes || 0), 0);
    if (size > MAX_PACKAGE_BYTES) {
      governanceError(422, 'SKILL_VALIDATION_FAILED', `Skill package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
  }

  private async validateSnapshot(draft: any, files: FileSnapshot[]): Promise<ValidationResult> {
    return this.validator.validate(draft, files);
  }

  private async backfillLegacyRegistry(): Promise<void> {
    await fs.mkdir(skillsRoot, { recursive: true });
    let migrationTeam = await this.db('groups').where({ name: DEFAULT_MIGRATION_TEAM }).first();
    if (!migrationTeam) {
      const [created] = await this.db('groups').insert({
        id: uuidv4(),
        name: DEFAULT_MIGRATION_TEAM,
      }).returning('*');
      migrationTeam = created;
    }
    const skillKeys = await collectSkillIds(skillsRoot);
    for (const rawKey of skillKeys) {
      if (rawKey.startsWith(`${GOVERNED_VERSIONS_DIR}/`)) continue;
      const skillKey = rawKey.toLowerCase();
      if (!isGovernedSkillKey(skillKey)) continue;
      if (await this.db('skills').where({ skillKey }).first()) continue;
      const packageRoot = path.join(skillsRoot, rawKey);
      const files = await this.packageStore.snapshotDirectory(packageRoot);
      if (!files.length || !files.some((file) => file.path === 'SKILL.md')) continue;
      const manifestHash = computePackageManifestHash(files);
      const skillId = uuidv4();
      const versionId = uuidv4();
      const materializedPath = await this.packageStore.materializeVersion(
        skillKey,
        versionId,
        manifestHash,
        files,
      );
      const metadata = await this.packageStore.readSkillMetadata(files);
      try {
        await this.db.transaction(async (tx) => {
          await tx('skills').insert({
            id: skillId,
            skillKey,
            displayName: metadata.name || displayNameFromKey(skillKey),
            description: metadata.description || null,
            ownerTeamId: migrationTeam.id,
            originalCreatorUserId: null,
            defaultVersionId: versionId,
            status: 'active',
          });
          await tx('skill_versions').insert({
            id: versionId,
            skillId,
            semanticVersion: '1.0.0',
            manifestHash,
            status: 'active',
            validationSummary: JSON.stringify({ migrated: true, policyVersion: GOVERNANCE_POLICY_VERSION }),
            materializedPath,
            activatedAt: tx.fn.now(),
          });
          await tx('skill_version_files').insert(files.map((file) => ({
            skillVersionId: versionId,
            path: file.path,
            contentHash: file.contentHash,
            executable: (file.mode & 0o111) !== 0,
            mode: file.mode,
            sizeBytes: file.sizeBytes,
            mimeType: file.mimeType,
          })));
          const legacyGrants = await tx('skill_grants')
            .where({ skillId: rawKey, effect: 'allow' });
          for (const grant of legacyGrants) {
            if (grant.principalType === 'group') {
              await tx('team_skill_grants').insert({
                teamId: grant.principalId,
                skillId,
                effect: 'allow',
                grantedByUserId: null,
              }).onConflict(['teamId', 'skillId']).ignore();
            } else if (grant.principalType === 'user') {
              await tx('user_skill_grants').insert({
                userId: grant.principalId,
                skillId,
                effect: 'allow',
                grantedByUserId: null,
              }).onConflict(['userId', 'skillId']).ignore();
            }
          }
        });
      } catch (error) {
        await fs.rm(materializedPath, { recursive: true, force: true });
        throw error;
      }
      await this.audit({
        actorUserId: null,
        actorRole: 'migration',
        action: 'skill.migrated',
        resourceType: 'skill',
        resourceId: skillId,
        policyVersion: GOVERNANCE_POLICY_VERSION,
        metadata: { skillKey, versionId, manifestHash, ownerTeamId: migrationTeam.id },
      });
    }
  }

  private async backfillLegacyGrants(): Promise<void> {
    const legacyGrants = await this.db('skill_grants').where({ effect: 'allow' });
    for (const grant of legacyGrants) {
      const skillKey = String(grant.skillId || '').trim().toLowerCase();
      const skill = await this.db('skills').where({ skillKey }).first();
      if (!skill) continue;
      if (grant.principalType === 'group') {
        const team = await this.db('groups').where({ id: grant.principalId }).first();
        if (!team) continue;
        await this.db('team_skill_grants').insert({
          teamId: grant.principalId,
          skillId: skill.id,
          effect: 'allow',
          grantedByUserId: null,
        }).onConflict(['teamId', 'skillId']).ignore();
      } else if (grant.principalType === 'user') {
        const user = await this.db('users').where({ id: grant.principalId }).first();
        if (!user) continue;
        await this.db('user_skill_grants').insert({
          userId: grant.principalId,
          skillId: skill.id,
          effect: 'allow',
          grantedByUserId: null,
        }).onConflict(['userId', 'skillId']).ignore();
      }
    }
  }

  private async validateMigrationParity(): Promise<JsonRecord> {
    const [registryKeys, governedSkills, legacyGrants] = await Promise.all([
      collectSkillIds(skillsRoot),
      this.db('skills as skill')
        .leftJoin('skill_versions as version', 'version.id', 'skill.defaultVersionId')
        .select(
          'skill.id',
          'skill.skillKey',
          'skill.status',
          'skill.defaultVersionId',
          'version.manifestHash as defaultManifestHash',
        ),
      this.db('skill_grants').where({ effect: 'allow' }),
    ]);
    const governedByKey = new Map(governedSkills.map((skill: any) => [String(skill.skillKey), skill]));
    const unmappedRegistrySkills: string[] = [];
    const manifestMismatches: string[] = [];
    for (const rawKey of registryKeys) {
      const skillKey = rawKey.toLowerCase();
      if (!isGovernedSkillKey(skillKey)) continue;
      const skill: any = governedByKey.get(skillKey);
      if (!skill) {
        unmappedRegistrySkills.push(rawKey);
        continue;
      }
      if (skill.status !== 'active' || !skill.defaultVersionId) continue;
      const files = await this.packageStore.snapshotDirectory(path.join(skillsRoot, rawKey));
      if (computePackageManifestHash(files) !== skill.defaultManifestHash) {
        manifestMismatches.push(rawKey);
      }
    }

    const unmappedLegacyGrants: Array<{ principalType: string; principalId: string; skillId: string }> = [];
    for (const grant of legacyGrants) {
      const skill: any = governedByKey.get(String(grant.skillId || '').trim().toLowerCase());
      if (!skill) {
        unmappedLegacyGrants.push({
          principalType: String(grant.principalType),
          principalId: String(grant.principalId),
          skillId: String(grant.skillId),
        });
        continue;
      }
      const migrated = grant.principalType === 'group'
        ? await this.db('team_skill_grants').where({ teamId: grant.principalId, skillId: skill.id, effect: 'allow' }).first()
        : grant.principalType === 'user'
          ? await this.db('user_skill_grants').where({ userId: grant.principalId, skillId: skill.id, effect: 'allow' }).first()
          : null;
      if (!migrated) {
        unmappedLegacyGrants.push({
          principalType: String(grant.principalType),
          principalId: String(grant.principalId),
          skillId: String(grant.skillId),
        });
      }
    }
    return {
      ready: unmappedRegistrySkills.length === 0
        && manifestMismatches.length === 0
        && unmappedLegacyGrants.length === 0,
      registrySkillCount: registryKeys.length,
      governedSkillCount: governedSkills.length,
      legacyGrantCount: legacyGrants.length,
      unmappedRegistrySkills,
      manifestMismatches,
      unmappedLegacyGrants,
    };
  }

  private async archiveLegacySkillEvolution(): Promise<void> {
    await this.db('skill_evolution_suggestions')
      .where({ status: 'pending' })
      .update({ status: 'archived', updatedAt: this.db.fn.now() });
  }

  private async ownedDraft(userId: string, draftId: string): Promise<any> {
    const draft = await this.db('private_skill_drafts').where({ id: draftId, ownerUserId: userId }).first();
    if (!draft) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill draft not found');
    return draft;
  }

  private async ownedEditableDraft(userId: string, draftId: string): Promise<any> {
    const draft = await this.ownedDraft(userId, draftId);
    if (draft.status !== 'private') {
      governanceError(409, 'SKILL_REVISION_CONFLICT', 'Only a private editable draft can be changed or submitted');
    }
    return draft;
  }

  private async reviewRequest(requestId: string): Promise<any> {
    const request = await this.db('skill_review_requests').where({ id: requestId }).first();
    if (!request) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill review not found');
    return request;
  }

  private async resolveSkill(reference: string): Promise<any | null> {
    const normalized = String(reference || '').trim();
    if (!normalized) return null;
    const query = this.db('skills').where({ skillKey: normalized.toLowerCase() });
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(normalized)) query.orWhere({ id: normalized });
    return await query.first() || null;
  }

  private async requireCatalogVisibility(userId: string, reference: string): Promise<any> {
    const skill = await this.resolveSkill(reference);
    if (!skill) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    const user = await this.requireUser(userId);
    if (user.isAdmin) return skill;
    const effective = await this.effectiveSkillAccess(userId);
    const teams = await this.userTeamIds(userId);
    if (!effective.skillIds.includes(skill.id) && !teams.includes(skill.ownerTeamId)) {
      governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    }
    return skill;
  }

  private async requireSkillAdministration(userId: string, reference: string): Promise<any> {
    const skill = await this.resolveSkill(reference);
    if (!skill) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Skill not found');
    await this.requireUser(userId);
    if (!await this.isPlatformAdmin(userId)) await this.requireTeamLead(userId, skill.ownerTeamId);
    return skill;
  }

  private async actorRoleForSkillAdmin(userId: string, teamId: string): Promise<string> {
    await this.requireUser(userId);
    return await this.isPlatformAdmin(userId) && !await this.isTeamLead(userId, teamId)
      ? 'platform_admin'
      : 'team_lead';
  }

  private async requireTeamMembership(userId: string, teamId: string): Promise<void> {
    const member = await this.db('group_members').where({ groupId: teamId, userId }).first();
    if (!member) governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'Active Team membership is required');
  }

  private async userTeamIds(userId: string): Promise<string[]> {
    const rows = await this.db('group_members').select('groupId').where({ userId });
    return rows.map((row: any) => String(row.groupId));
  }

  private async isTeamLead(userId: string, teamId: string): Promise<boolean> {
    return Boolean(await this.db('team_role_bindings as role')
      .join('group_members as membership', function joinMembership() {
        this.on('membership.groupId', '=', 'role.teamId')
          .andOn('membership.userId', '=', 'role.userId');
      })
      .where({ 'role.teamId': teamId, 'role.userId': userId, 'role.role': 'lead' })
      .first());
  }

  private async requireTeamLead(userId: string, teamId: string): Promise<void> {
    const [isMember, isLead] = await Promise.all([
      this.db('group_members').where({ groupId: teamId, userId }).first(),
      this.isTeamLead(userId, teamId),
    ]);
    if (!isMember || !isLead) {
      governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'Team Lead access is required');
    }
  }

  private async requirePlatformAdmin(userId: string): Promise<any> {
    const user = await this.requireUser(userId);
    if (!await this.isPlatformAdmin(userId)) {
      governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'Platform Admin access is required');
    }
    return user;
  }

  private async isPlatformAdmin(userId: string): Promise<boolean> {
    const [user, binding] = await Promise.all([
      this.db('users').select('isAdmin').where({ id: userId }).first(),
      this.db('platform_role_bindings').where({ userId, role: 'platform_admin' }).first(),
    ]);
    return Boolean(user?.isAdmin || binding);
  }

  private async requireUser(userId: string): Promise<any> {
    const user = await this.db('users').where({ id: userId }).first();
    if (!user) governanceError(401, 'AUTHENTICATION_REQUIRED', 'User not found');
    return user;
  }

  private async hasActiveVersion(skillId: string): Promise<boolean> {
    return Boolean(await this.db('skill_versions').where({ skillId, status: 'active' }).first());
  }

  private async requireWorkspacePublisher(userId: string, workspaceId: string): Promise<any> {
    const workspace = await this.db('workspaces').where({ id: workspaceId }).first();
    if (!workspace) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Workspace not found');
    if (workspace.ownerId === userId) return workspace;
    const direct = await this.db('workspace_user_grants').where({ workspaceId, userId, role: 'publisher' }).first()
      || await this.db('workspace_members').where({ workspaceId, userId }).whereIn('role', ['owner', 'editor', 'publisher']).first();
    if (!direct) governanceError(403, 'SKILL_ACTION_FORBIDDEN', 'Workspace Owner or Publisher access is required');
    return workspace;
  }

  private async requireWorkspaceRead(userId: string, workspaceId: string): Promise<any> {
    const workspace = await this.db('workspaces').where({ id: workspaceId }).first();
    if (!workspace) governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Workspace not found');
    if (workspace.ownerId === userId) return workspace;
    const direct = await this.db('workspace_user_grants').where({ workspaceId, userId }).first()
      || await this.db('workspace_members').where({ workspaceId, userId }).first();
    if (direct) return workspace;
    const teamIds = await this.userTeamIds(userId);
    if (teamIds.length) {
      const teamGrant = await this.db('workspace_team_grants').where({ workspaceId }).whereIn('teamId', teamIds).first();
      if (teamGrant) return workspace;
    }
    governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'Workspace not found');
  }

  private async selfApprovalAllowed(userId: string, teamId: string): Promise<boolean> {
    if (String(process.env.ALLOW_SINGLE_LEAD_SKILL_SELF_APPROVAL || '').toLowerCase() !== 'true') {
      return false;
    }
    const activeLeads = await this.db('team_role_bindings as role')
      .join('group_members as membership', function joinMembership() {
        this.on('membership.groupId', '=', 'role.teamId')
          .andOn('membership.userId', '=', 'role.userId');
      })
      .select('role.userId')
      .where({ 'role.teamId': teamId, 'role.role': 'lead' });
    return activeLeads.length === 1 && activeLeads[0].userId === userId;
  }

  private async notifyTeamLeads(
    teamId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    payload: JsonRecord,
  ): Promise<void> {
    const leads = await this.db('team_role_bindings').select('userId').where({ teamId, role: 'lead' });
    await Promise.all(leads.map((lead: any) => this.notify(lead.userId, eventType, resourceType, resourceId, payload)));
  }

  private async notifyTeamMembers(
    teamId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    payload: JsonRecord,
  ): Promise<void> {
    const members = await this.db('group_members').select('userId').where({ groupId: teamId });
    await Promise.all(members.map((member: any) =>
      this.notify(member.userId, eventType, resourceType, resourceId, payload)));
  }

  private async notifyPinnedVersionUsers(
    versionId: string,
    eventType: string,
    payload: JsonRecord,
  ): Promise<void> {
    const workspaces = await this.db('workspace_skill_pins as pin')
      .join('workspaces as workspace', 'workspace.id', 'pin.workspaceId')
      .select('workspace.id', 'workspace.ownerId')
      .where('pin.skillVersionId', versionId);
    const recipients = new Set<string>();
    for (const workspace of workspaces) {
      if (workspace.ownerId) recipients.add(String(workspace.ownerId));
      const [direct, teamGrants] = await Promise.all([
        this.db('workspace_user_grants').select('userId').where({ workspaceId: workspace.id }),
        this.db('workspace_team_grants').select('teamId').where({ workspaceId: workspace.id }),
      ]);
      direct.forEach((row: any) => recipients.add(String(row.userId)));
      if (teamGrants.length) {
        const teamMembers = await this.db('group_members')
          .select('userId')
          .whereIn('groupId', teamGrants.map((row: any) => row.teamId));
        teamMembers.forEach((row: any) => recipients.add(String(row.userId)));
      }
    }
    await Promise.all([...recipients].map((recipientUserId) =>
      this.notify(recipientUserId, eventType, 'skill_version', versionId, payload)));
  }

  private async notify(
    recipientUserId: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    payload: JsonRecord,
  ): Promise<void> {
    try {
      await this.db('notifications').insert({
        id: uuidv4(),
        recipientUserId,
        eventType,
        resourceType,
        resourceId,
        payload: JSON.stringify(payload),
      });
    } catch (error) {
      // Governance state is authoritative; notification delivery must never
      // roll back or obscure a committed decision.
      console.error('Governance notification delivery failed', {
        recipientUserId,
        eventType,
        resourceType,
        resourceId,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  private async audit(input: {
    actorUserId: string | null;
    actorRole: string;
    action: string;
    resourceType: string;
    resourceId: string;
    previousState?: unknown;
    newState?: unknown;
    reason?: string;
    policyVersion?: string;
    requestId?: string;
    platformOverride?: boolean;
    selfApproved?: boolean;
    metadata?: JsonRecord;
  }): Promise<string> {
    const id = uuidv4();
    await this.db('audit_events').insert({
      id,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      previousStateHash: input.previousState === undefined ? null : stateHash(input.previousState),
      newStateHash: input.newState === undefined ? null : stateHash(input.newState),
      reason: input.reason?.trim() || null,
      policyVersion: input.policyVersion || null,
      requestId: input.requestId || null,
      platformOverride: Boolean(input.platformOverride),
      selfApproved: Boolean(input.selfApproved),
      metadata: JSON.stringify(input.metadata || {}),
    });
    return id;
  }
}
