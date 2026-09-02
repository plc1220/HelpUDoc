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

test('a Team Lead disables an admin-granted skill without destroying the grant', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const users = new UserService(database);
  const adminId = uuidv4();
  const leadId = uuidv4();
  const memberId = uuidv4();
  const ownerTeamId = uuidv4();
  const consumerTeamId = uuidv4();
  const skillId = uuidv4();
  const versionId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `disable-smoke-${suffix}`;
  const legacyKey = `legacy-disable-${suffix}`;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      { id: adminId, externalId: `disable-admin-${suffix}`, email: `disable-admin-${suffix}@example.test`, displayName: 'Disable admin', isAdmin: true },
      { id: leadId, externalId: `disable-lead-${suffix}`, email: `disable-lead-${suffix}@example.test`, displayName: 'Disable lead', isAdmin: false },
      { id: memberId, externalId: `disable-member-${suffix}`, email: `disable-member-${suffix}@example.test`, displayName: 'Disable member', isAdmin: false },
    ]);
    await db('groups').insert([
      { id: ownerTeamId, name: `Disable owner ${suffix}` },
      { id: consumerTeamId, name: `Disable consumer ${suffix}` },
    ]);
    // The skill is owned by a Team the Lead does not belong to: this is exactly the case
    // `setTeamSkillGrant` refuses, and the case a per-Team disable has to cover.
    await db('group_members').insert([
      { groupId: consumerTeamId, userId: leadId },
      { groupId: consumerTeamId, userId: memberId },
    ]);
    await db('team_role_bindings').insert({
      teamId: consumerTeamId, userId: leadId, role: 'lead', assignedByUserId: null,
    });
    await db('skills').insert({
      id: skillId,
      skillKey,
      displayName: 'Disable smoke skill',
      ownerTeamId,
      status: 'active',
    });
    await db('skill_versions').insert({
      id: versionId,
      skillId,
      semanticVersion: '1.0.0',
      manifestHash: 'c'.repeat(64),
      status: 'active',
    });
    await db('skills').where({ id: skillId }).update({ defaultVersionId: versionId });

    const promptSkills = async (userId: string) =>
      (await users.getEffectivePromptAccess(userId))?.skillIds || [];

    // A Platform Admin assigns the skill to a Team that does not own it.
    await governance.setTeamSkillGrant(adminId, consumerTeamId, skillKey, true);
    assert.ok((await promptSkills(memberId)).includes(skillKey));
    assert.ok((await governance.effectiveSkillAccess(memberId)).skillKeys.includes(skillKey));

    // The Lead may not touch the grant itself, which is why the disable exists.
    await assert.rejects(
      () => governance.setTeamSkillGrant(leadId, consumerTeamId, skillKey, false),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );

    const listed = await governance.listTeamSkillAccess(leadId, consumerTeamId);
    assert.ok((listed.skills as any[]).some((entry) => entry.skillKey === skillKey && entry.disabled === false));

    await governance.setTeamSkillDisabled(leadId, consumerTeamId, skillKey, true, 'Not for this Team');
    assert.ok(!(await promptSkills(memberId)).includes(skillKey));
    assert.ok(!(await governance.effectiveSkillAccess(memberId)).skillKeys.includes(skillKey));
    // The admin's grant survives, so the Lead can reverse their own decision.
    assert.ok(await db('team_skill_grants').where({ teamId: consumerTeamId, skillId }).first());

    await governance.setTeamSkillDisabled(leadId, consumerTeamId, skillKey, false);
    assert.ok((await promptSkills(memberId)).includes(skillKey));

    // An ordinary member of the Team has no such authority.
    await assert.rejects(
      () => governance.setTeamSkillDisabled(memberId, consumerTeamId, skillKey, true),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );

    // The same override has to work for skills granted through the pre-governance table,
    // whose rows key on a string skill id rather than a `skills` uuid.
    await db('skill_grants').insert({
      principalType: 'group', principalId: consumerTeamId, skillId: legacyKey, effect: 'allow',
    });
    assert.ok((await promptSkills(memberId)).includes(legacyKey));
    await governance.setTeamSkillDisabled(leadId, consumerTeamId, legacyKey, true);
    assert.ok(!(await promptSkills(memberId)).includes(legacyKey));

    // A skill the Team was never granted cannot be disabled.
    await assert.rejects(
      () => governance.setTeamSkillDisabled(leadId, consumerTeamId, `never-granted-${suffix}`, true),
      (error: any) => error?.code === 'SKILL_RESOURCE_NOT_FOUND',
    );
  } finally {
    await db('team_skill_disables').where({ teamId: consumerTeamId }).del().catch(() => undefined);
    await db('skill_grants').where({ principalId: consumerTeamId }).del().catch(() => undefined);
    await db('team_skill_grants').where({ skillId }).del().catch(() => undefined);
    await db('skills').where({ id: skillId }).update({ defaultVersionId: null }).catch(() => undefined);
    await db('skill_versions').where({ skillId }).del().catch(() => undefined);
    await db('skills').where({ id: skillId }).del().catch(() => undefined);
    await db('audit_events').whereIn('actorUserId', [adminId, leadId, memberId]).del().catch(() => undefined);
    await db('notifications').whereIn('recipientUserId', [adminId, leadId, memberId]).del().catch(() => undefined);
    await db('team_role_bindings').where({ teamId: consumerTeamId }).del().catch(() => undefined);
    await db('group_members').whereIn('groupId', [ownerTeamId, consumerTeamId]).del().catch(() => undefined);
    await db('groups').whereIn('id', [ownerTeamId, consumerTeamId]).del().catch(() => undefined);
    await db('users').whereIn('id', [adminId, leadId, memberId]).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a draft keeps subfolder files across partial saves', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const authorId = uuidv4();
  const teamId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  let draftId: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert({
      id: authorId,
      externalId: `subfolder-author-${suffix}`,
      email: `subfolder-author-${suffix}@example.test`,
      displayName: 'Subfolder author',
      isAdmin: false,
    });
    await db('groups').insert({ id: teamId, name: `Subfolder team ${suffix}` });
    await db('group_members').insert({ groupId: teamId, userId: authorId });

    const created = await governance.createDraft(authorId, { proposalType: 'new' });
    draftId = String(created.id);
    assert.deepEqual(created.files.map((file: any) => file.path), ['SKILL.md']);

    const withFiles = await governance.updateDraft(authorId, draftId, Number(created.draftRevision), {
      proposedSkillKey: `subfolder-smoke-${suffix}`,
      proposedOwnerTeamId: teamId,
      files: [
        { path: 'scripts/count.py', content: 'print("hi")\n' },
        { path: 'references/style.md', content: '# Style\n' },
        { path: 'assets/notes.txt', content: 'notes\n' },
      ],
    });
    assert.deepEqual(
      withFiles.files.map((file: any) => file.path).sort(),
      ['SKILL.md', 'assets/notes.txt', 'references/style.md', 'scripts/count.py'],
    );

    // The editor only ever sends the files it changed, so a partial save must merge
    // rather than replace: everything it left out has to survive untouched.
    const partial = await governance.updateDraft(authorId, draftId, Number(withFiles.draftRevision), {
      files: [{ path: 'scripts/count.py', content: 'print("bye")\n' }],
      deletePaths: ['assets/notes.txt'],
    });
    const byPath = Object.fromEntries(partial.files.map((file: any) => [file.path, file]));
    assert.deepEqual(Object.keys(byPath).sort(), ['SKILL.md', 'references/style.md', 'scripts/count.py']);
    assert.equal(byPath['scripts/count.py'].content, 'print("bye")\n');
    assert.equal(byPath['references/style.md'].content, '# Style\n');

    // Every file is content-addressed, which is what lets the editor pin a declared
    // sandbox script to the blob the validator will compare it against.
    assert.match(byPath['scripts/count.py'].contentHash, /^[a-f0-9]{64}$/);

    await assert.rejects(
      () => governance.updateDraft(authorId, draftId!, Number(partial.draftRevision), {
        deletePaths: ['SKILL.md'],
      }),
      (error: any) => error?.code === 'SKILL_VALIDATION_FAILED',
    );
    await assert.rejects(
      () => governance.updateDraft(authorId, draftId!, Number(partial.draftRevision), {
        files: [{ path: 'secrets/leak.txt', content: 'nope' }],
      }),
      (error: any) => error?.code === 'INVALID_SKILL_MANIFEST',
    );
  } finally {
    if (draftId) {
      await db('skill_draft_revision_files')
        .whereIn('draftRevisionId', db('skill_draft_revisions').select('id').where({ draftId }))
        .del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).update({ currentDraftRevisionId: null }).catch(() => undefined);
      await db('skill_draft_revisions').where({ draftId }).del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).del().catch(() => undefined);
    }
    await db('audit_events').where({ actorUserId: authorId }).del().catch(() => undefined);
    await db('group_members').where({ groupId: teamId }).del().catch(() => undefined);
    await db('groups').where({ id: teamId }).del().catch(() => undefined);
    await db('users').where({ id: authorId }).del().catch(() => undefined);
    await db.destroy();
  }
});
