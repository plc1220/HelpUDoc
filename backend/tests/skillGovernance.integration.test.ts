import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../src/services/databaseService';
import {
  SkillGovernanceError,
  SkillGovernanceService,
} from '../src/services/governance/skillGovernanceService';
import { skillsRoot } from '../src/services/skills/constants';
import { UserService } from '../src/services/userService';

const enabled = process.env.RUN_GOVERNANCE_INTEGRATION === '1';

test('governed skill lifecycle works against PostgreSQL', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const proposerId = uuidv4();
  const reviewerId = uuidv4();
  const teamId = uuidv4();
  const workspaceId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `governance-smoke-${suffix}`;
  let draftId: string | null = null;
  let requestId: string | null = null;
  let skillId: string | null = null;
  let versionId: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      {
        id: proposerId,
        externalId: `governance-proposer-${suffix}`,
        email: `governance-proposer-${suffix}@example.test`,
        displayName: 'Governance proposer',
        isAdmin: false,
      },
      {
        id: reviewerId,
        externalId: `governance-reviewer-${suffix}`,
        email: `governance-reviewer-${suffix}@example.test`,
        displayName: 'Governance reviewer',
        isAdmin: false,
      },
    ]);
    await db('groups').insert({ id: teamId, name: `Governance smoke ${suffix}` });
    await db('group_members').insert([
      { groupId: teamId, userId: proposerId },
      { groupId: teamId, userId: reviewerId },
    ]);
    await db('team_role_bindings').insert([
      {
        teamId,
        userId: proposerId,
        role: 'lead',
        assignedByUserId: null,
      },
      {
        teamId,
        userId: reviewerId,
        role: 'lead',
        assignedByUserId: null,
      },
    ]);

    const disposable = await governance.createDraft(proposerId, { proposalType: 'new' });
    const deletion = await governance.deleteDraft(
      proposerId,
      String(disposable.id),
      Number(disposable.draftRevision),
    );
    assert.equal(deletion.disposition, 'deleted');
    await assert.rejects(
      () => governance.getDraft(proposerId, String(disposable.id)),
      (error: any) => error?.code === 'SKILL_RESOURCE_NOT_FOUND',
    );

    const created = await governance.createDraft(proposerId, { proposalType: 'new' });
    draftId = String(created.id);
    const updated = await governance.updateDraft(proposerId, draftId, Number(created.draftRevision), {
      proposedSkillKey: skillKey,
      proposedOwnerTeamId: teamId,
      displayName: 'Governance smoke skill',
      description: 'Exercises the governed skill lifecycle.',
      files: [{
        path: 'SKILL.md',
        content: [
          '---',
          'name: Governance smoke skill',
          'description: Exercises the governed skill lifecycle.',
          '---',
          '',
          '# Governance smoke skill',
          '',
          'Use this package only for the governance integration test.',
          '',
        ].join('\n'),
      }],
    });
    const validation = await governance.validateDraft(proposerId, draftId);
    assert.equal(validation.valid, true);
    await assert.rejects(
      () => governance.getDraft(reviewerId, draftId!),
      (error: any) => error?.code === 'SKILL_RESOURCE_NOT_FOUND',
    );

    let submitted = await governance.submitDraft(proposerId, draftId, {
      owningTeamId: teamId,
      semanticVersion: '1.0.0',
      expectedDraftRevision: Number(updated.draftRevision),
      submissionNote: 'Integration smoke test',
    });
    requestId = String(submitted.id);

    let review = await governance.getReview(reviewerId, requestId);
    assert.equal(review.permissions.canReview, true);
    await governance.decideReview(reviewerId, requestId, {
      decision: 'request_changes',
      expectedRequestRevision: Number(review.requestRevision),
      comment: 'Exercise immutable candidate resubmission',
    });
    const reopened = await governance.getDraft(proposerId, draftId);
    const revised = await governance.updateDraft(proposerId, draftId, Number(reopened.draftRevision), {
      files: [{
        path: 'SKILL.md',
        content: `${reopened.files.find((file: any) => file.path === 'SKILL.md')?.content || ''}\nRequested change applied.\n`,
      }],
    });
    submitted = await governance.submitDraft(proposerId, draftId, {
      owningTeamId: teamId,
      semanticVersion: '1.0.0',
      expectedDraftRevision: Number(revised.draftRevision),
      submissionNote: 'Resubmitted immutable candidate',
    });
    review = await governance.getReview(reviewerId, requestId);
    assert.equal(Number(review.candidate.candidateNumber), 2);
    await assert.rejects(
      () => governance.decideReview(proposerId, requestId!, {
        decision: 'approve',
        expectedRequestRevision: Number(review.requestRevision),
        comment: 'Self approval must be denied',
      }),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
    const packageStore = (governance as any).packageStore;
    const materializeVersion = packageStore.materializeVersion.bind(packageStore);
    packageStore.materializeVersion = async () => {
      throw new SkillGovernanceError(
        503,
        'SKILL_MATERIALIZATION_UNAVAILABLE',
        'Simulated integration failure',
      );
    };
    const failedDecisionInput = {
      decision: 'approve',
      expectedRequestRevision: Number(review.requestRevision),
      comment: 'Approved by integration smoke test',
    };
    const failedDecisionKey = `failed-activation-${suffix}`;
    await assert.rejects(
      () => governance.runIdempotent(
        reviewerId,
        `skill_review.decision:${requestId}`,
        failedDecisionKey,
        failedDecisionInput,
        () => governance.decideReview(reviewerId, requestId!, failedDecisionInput),
      ),
      (error: any) => error?.code === 'SKILL_MATERIALIZATION_UNAVAILABLE',
    );
    review = await governance.getReview(reviewerId, requestId);
    assert.equal(review.status, 'approved');
    assert.equal(review.activationStatus, 'failed');
    assert.equal(review.permissions.canRetryActivation, true);
    assert.equal(review.decisions.filter((entry: any) => entry.decision === 'approve').length, 1);
    const failedRevision = Number(review.requestRevision);
    await assert.rejects(
      () => governance.runIdempotent(
        reviewerId,
        `skill_review.decision:${requestId}`,
        failedDecisionKey,
        failedDecisionInput,
        () => governance.decideReview(reviewerId, requestId!, failedDecisionInput),
      ),
      (error: any) =>
        error?.code === 'SKILL_MATERIALIZATION_UNAVAILABLE'
        && Number(error?.details?.requestRevision) === failedRevision,
    );
    assert.equal(
      (await governance.getReview(reviewerId, requestId)).decisions
        .filter((entry: any) => entry.decision === 'approve').length,
      1,
    );

    packageStore.materializeVersion = materializeVersion;
    const approved = await governance.retryReviewActivation(
      reviewerId,
      requestId,
      Number(review.requestRevision),
    );
    skillId = String(approved.skillId);
    versionId = String(approved.versionId);
    assert.equal(approved.status, 'approved');
    assert.equal((await governance.getReview(reviewerId, requestId)).activationStatus, 'active');

    const users = new UserService(database);
    await users.replaceGroupPromptAccess(teamId, {
      skillIds: [skillKey],
      mcpServerIds: [],
      knowledgeSourceIds: [],
    }, reviewerId);
    assert.equal(await db('team_skill_grants').where({ teamId, skillId }).first().then(Boolean), true);
    assert.equal(await db('skill_grants').where({ principalType: 'group', principalId: teamId, skillId: skillKey }).first().then(Boolean), false);
    const detail = await governance.getSkillDetail(proposerId, skillId);
    assert.equal(detail.skill.skillKey, skillKey);
    assert.equal(detail.usage.teamGrantCount, 1);
    assert.equal(detail.files.some((file: any) => file.path === 'SKILL.md'), true);
    await db('workspaces').insert({
      id: workspaceId,
      name: `Governance smoke ${suffix}`,
      slug: `governance-smoke-${suffix}`,
      ownerId: proposerId,
      lastModifiedBy: proposerId,
      visibility: 'private',
      workspaceType: 'private',
      editingPolicy: null,
      contentRevision: 0,
    });
    await db('workspace_members').insert({
      workspaceId,
      userId: proposerId,
      role: 'owner',
      canEdit: true,
    });

    const pin = await governance.pinWorkspaceSkill(proposerId, workspaceId, skillId, versionId);
    assert.equal(pin.semanticVersion, '1.0.0');
    assert.equal((await governance.authorizeInvocation(proposerId, workspaceId, skillKey)).allowed, true);
    await db('workspaces').where({ id: workspaceId }).update({
      visibility: 'team',
      workspaceType: 'team',
      editingPolicy: 'review',
    });
    await assert.rejects(
      () => governance.pinWorkspaceSkill(proposerId, workspaceId, skillId!, versionId!),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
    await db('workspaces').where({ id: workspaceId }).update({
      visibility: 'private',
      workspaceType: 'private',
      editingPolicy: null,
    });

    await governance.setVersionStatus(reviewerId, skillId, versionId, 'suspend');
    assert.equal((await governance.authorizeInvocation(proposerId, workspaceId, skillKey)).allowed, false);
    await governance.setVersionStatus(reviewerId, skillId, versionId, 'restore');
    assert.equal((await governance.authorizeInvocation(proposerId, workspaceId, skillKey)).allowed, true);

    await governance.setSkillStatus(reviewerId, skillId, 'archive');
    assert.equal((await governance.authorizeInvocation(proposerId, workspaceId, skillKey)).allowed, false);
    assert.equal((await governance.getSkillDetail(proposerId, skillId)).skill.status, 'retired');
    await governance.setSkillStatus(reviewerId, skillId, 'restore');
    assert.equal((await governance.authorizeInvocation(proposerId, workspaceId, skillKey)).allowed, true);

    let mutations = 0;
    const first = await governance.runIdempotent(
      proposerId,
      'governance.integration',
      `idempotency-${suffix}`,
      { value: 1 },
      async () => {
        mutations += 1;
        return { ok: true };
      },
    );
    const replay = await governance.runIdempotent(
      proposerId,
      'governance.integration',
      `idempotency-${suffix}`,
      { value: 1 },
      async () => {
        mutations += 1;
        return { ok: false };
      },
    );
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(mutations, 1);
  } finally {
    await db('workspaces').where({ id: workspaceId }).del().catch(() => undefined);
    if (skillId) {
      await db('team_skill_grants').where({ skillId }).del().catch(() => undefined);
      await db('user_skill_grants').where({ skillId }).del().catch(() => undefined);
      await db('skills').where({ id: skillId }).update({ defaultVersionId: null }).catch(() => undefined);
      await db('skill_version_files')
        .whereIn('skillVersionId', db('skill_versions').select('id').where({ skillId }))
        .del()
        .catch(() => undefined);
      await db('skill_versions').where({ skillId }).del().catch(() => undefined);
    }
    if (requestId) {
      const candidateIds = db('skill_review_candidates').select('id').where({ requestId });
      await db('skill_review_decisions').where({ requestId }).del().catch(() => undefined);
      await db('skill_candidate_policy_results').whereIn('candidateId', candidateIds).del().catch(() => undefined);
      await db('skill_review_candidate_files').whereIn('candidateId', candidateIds).del().catch(() => undefined);
      await db('skill_review_candidates').where({ requestId }).del().catch(() => undefined);
      await db('skill_review_requests').where({ id: requestId }).del().catch(() => undefined);
    }
    if (draftId) {
      await db('private_skill_drafts').where({ id: draftId }).del().catch(() => undefined);
    }
    if (skillId) {
      await db('skills').where({ id: skillId }).del().catch(() => undefined);
    }
    await db('audit_events').whereIn('actorUserId', [proposerId, reviewerId]).del().catch(() => undefined);
    await db('group_members').where({ groupId: teamId }).del().catch(() => undefined);
    await db('team_role_bindings').where({ teamId }).del().catch(() => undefined);
    await db('groups').where({ id: teamId }).del().catch(() => undefined);
    await db('users').whereIn('id', [proposerId, reviewerId]).del().catch(() => undefined);
    await Promise.all([
      fs.rm(path.join(skillsRoot, skillKey), { recursive: true, force: true }),
      fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', skillKey), { recursive: true, force: true }),
    ]);
    await db.destroy();
  }
});
