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
import { SkillPackageStore } from '../src/services/governance/skillPackageStore';
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

test('a private draft runs only in a private workspace its author owns', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const authorId = uuidv4();
  const otherId = uuidv4();
  const privateWorkspaceId = uuidv4();
  const teamWorkspaceId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `private-run-${suffix}`;
  let draftId: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();
    const users = new UserService(database);

    await db('users').insert([
      {
        id: authorId,
        externalId: `private-run-author-${suffix}`,
        email: `private-run-author-${suffix}@example.test`,
        displayName: 'Private run author',
        isAdmin: false,
      },
      {
        id: otherId,
        externalId: `private-run-other-${suffix}`,
        email: `private-run-other-${suffix}@example.test`,
        displayName: 'Private run bystander',
        isAdmin: false,
      },
    ]);
    await db('workspaces').insert([
      {
        id: privateWorkspaceId,
        name: `Private run ${suffix}`,
        slug: `private-run-${suffix}`,
        ownerId: authorId,
        visibility: 'private',
        workspaceType: 'private',
      },
      {
        id: teamWorkspaceId,
        name: `Team run ${suffix}`,
        slug: `team-run-${suffix}`,
        ownerId: authorId,
        visibility: 'team',
        workspaceType: 'team',
      },
    ]);

    const created = await governance.createDraft(authorId, { proposalType: 'new' });
    draftId = String(created.id);
    const named = await governance.updateDraft(authorId, draftId, Number(created.draftRevision), {
      proposedSkillKey: skillKey,
      displayName: 'Private run skill',
      description: 'Runs without Team review.',
      files: [{
        path: 'SKILL.md',
        content: `---\nname: ${skillKey}\ndescription: Runs without Team review.\n---\n\n# ${skillKey}\n`,
      }],
    });

    // No Team is involved anywhere in this test: a user with no Team membership
    // must still be able to run their own skill.
    assert.deepEqual(named.eligibleTeams, []);

    await governance.pinWorkspaceSkillDraft(authorId, privateWorkspaceId, draftId);
    const runtimePins = await users.getWorkspaceSkillDraftRuntimePins(privateWorkspaceId, authorId);
    assert.equal(runtimePins.length, 1);
    assert.equal(runtimePins[0].skillKey, skillKey);
    assert.match(runtimePins[0].manifestHash, /^[a-f0-9]{64}$/);

    // The package the agent will load has to exist on disk under the exact
    // revision id, and its recomputed manifest must match the signed pin.
    const packagePath = path.join(
      skillsRoot,
      '.governed-versions',
      'packages',
      skillKey,
      runtimePins[0].versionId,
    );
    assert.ok(await fs.stat(path.join(packagePath, 'SKILL.md')).then(() => true, () => false));

    // A workspace the author owns but shares with a Team must never inherit it.
    await assert.rejects(
      () => governance.pinWorkspaceSkillDraft(authorId, teamWorkspaceId, draftId!),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
    // Nor may anybody else reach the draft or the pin.
    await assert.rejects(
      () => governance.pinWorkspaceSkillDraft(otherId, privateWorkspaceId, draftId!),
      (error: any) => error?.code === 'SKILL_RESOURCE_NOT_FOUND',
    );
    assert.deepEqual(await users.getWorkspaceSkillDraftRuntimePins(privateWorkspaceId, otherId), []);

    // Editing a pinned draft moves the pin onto the new revision, so the
    // workspace runs the edit rather than the revision that was pinned.
    const edited = await governance.updateDraft(authorId, draftId, Number(named.draftRevision), {
      files: [{
        path: 'SKILL.md',
        content: `---\nname: ${skillKey}\ndescription: Runs without Team review.\n---\n\n# ${skillKey}\n\nEdited.\n`,
      }],
    });
    const afterEdit = await users.getWorkspaceSkillDraftRuntimePins(privateWorkspaceId, authorId);
    assert.equal(afterEdit.length, 1);
    assert.notEqual(afterEdit[0].versionId, runtimePins[0].versionId);
    assert.equal(afterEdit[0].versionId, String(edited.currentDraftRevisionId));
    assert.ok(await fs.stat(path.join(
      skillsRoot, '.governed-versions', 'packages', skillKey, afterEdit[0].versionId, 'SKILL.md',
    )).then(() => true, () => false));
    // The superseded package is pruned; the database keeps every revision row.
    assert.equal(await fs.stat(packagePath).then(() => true, () => false), false);

    await governance.unpinWorkspaceSkillDraft(authorId, privateWorkspaceId, draftId);
    assert.deepEqual(await users.getWorkspaceSkillDraftRuntimePins(privateWorkspaceId, authorId), []);
  } finally {
    await fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', skillKey), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    if (draftId) {
      await db('private_workspace_skill_draft_pins').where({ draftId }).del().catch(() => undefined);
      await db('private_workspace_skill_draft_exclusions').where({ draftId }).del().catch(() => undefined);
      await db('skill_draft_revision_files')
        .whereIn('draftRevisionId', db('skill_draft_revisions').select('id').where({ draftId }))
        .del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).update({ currentDraftRevisionId: null }).catch(() => undefined);
      await db('skill_draft_revisions').where({ draftId }).del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).del().catch(() => undefined);
    }
    await db('audit_events').whereIn('actorUserId', [authorId, otherId]).del().catch(() => undefined);
    await db('workspaces').whereIn('id', [privateWorkspaceId, teamWorkspaceId]).del().catch(() => undefined);
    await db('users').whereIn('id', [authorId, otherId]).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a Team disable never reaches another Team grant or a direct grant', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const users = new UserService(database);
  const adminId = uuidv4();
  const leadId = uuidv4();
  const memberId = uuidv4();
  const ownerTeamId = uuidv4();
  const teamAId = uuidv4();
  const teamBId = uuidv4();
  const skillId = uuidv4();
  const versionId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `cross-team-${suffix}`;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      { id: adminId, externalId: `cross-admin-${suffix}`, email: `cross-admin-${suffix}@example.test`, displayName: 'Cross admin', isAdmin: true },
      { id: leadId, externalId: `cross-lead-${suffix}`, email: `cross-lead-${suffix}@example.test`, displayName: 'Cross lead', isAdmin: false },
      { id: memberId, externalId: `cross-member-${suffix}`, email: `cross-member-${suffix}@example.test`, displayName: 'Cross member', isAdmin: false },
    ]);
    await db('groups').insert([
      { id: ownerTeamId, name: `Cross owner ${suffix}` },
      { id: teamAId, name: `Cross A ${suffix}` },
      { id: teamBId, name: `Cross B ${suffix}` },
    ]);
    // The member belongs to both Teams; only Team A has a Lead who can disable.
    await db('group_members').insert([
      { groupId: teamAId, userId: leadId },
      { groupId: teamAId, userId: memberId },
      { groupId: teamBId, userId: memberId },
    ]);
    await db('team_role_bindings').insert({
      teamId: teamAId, userId: leadId, role: 'lead', assignedByUserId: null,
    });
    await db('skills').insert({
      id: skillId, skillKey, displayName: 'Cross team skill', ownerTeamId, status: 'active',
    });
    await db('skill_versions').insert({
      id: versionId, skillId, semanticVersion: '1.0.0', manifestHash: 'd'.repeat(64), status: 'active',
    });
    await db('skills').where({ id: skillId }).update({ defaultVersionId: versionId });

    const promptSkills = async (userId: string) =>
      (await users.getEffectivePromptAccess(userId))?.skillIds || [];
    const governedSkills = async (userId: string) =>
      (await governance.effectiveSkillAccess(userId)).skillKeys;

    await governance.setTeamSkillGrant(adminId, teamAId, skillKey, true);
    await governance.setTeamSkillGrant(adminId, teamBId, skillKey, true);

    // Team A's Lead switches it off. Team B still grants it, so the member keeps it --
    // that access was never Team A's to revoke.
    await governance.setTeamSkillDisabled(leadId, teamAId, skillKey, true, 'Not for Team A');
    assert.ok((await promptSkills(memberId)).includes(skillKey), 'Team B grant must survive a Team A disable');
    assert.ok((await governedSkills(memberId)).includes(skillKey), 'both resolvers must agree');

    // With Team B's grant gone the Team A disable is the only source left, so it applies.
    await governance.setTeamSkillGrant(adminId, teamBId, skillKey, false);
    assert.ok(!(await promptSkills(memberId)).includes(skillKey));
    assert.ok(!(await governedSkills(memberId)).includes(skillKey));

    // A direct Platform Admin grant is not Team-derived, so no Team disable touches it.
    await governance.setUserSkillGrant(adminId, memberId, skillKey, true);
    assert.ok((await promptSkills(memberId)).includes(skillKey), 'a direct grant must survive a Team disable');
    assert.ok((await governedSkills(memberId)).includes(skillKey));
    // ...and it is not reported as disabled, which would contradict the skill list.
    assert.ok(!(await governance.effectiveSkillAccess(memberId)).disabledReasons[skillKey]);
  } finally {
    await db('team_skill_disables').whereIn('teamId', [teamAId, teamBId]).del().catch(() => undefined);
    await db('user_skill_grants').where({ skillId }).del().catch(() => undefined);
    await db('team_skill_grants').where({ skillId }).del().catch(() => undefined);
    await db('skills').where({ id: skillId }).update({ defaultVersionId: null }).catch(() => undefined);
    await db('skill_versions').where({ skillId }).del().catch(() => undefined);
    await db('skills').where({ id: skillId }).del().catch(() => undefined);
    await db('audit_events').whereIn('actorUserId', [adminId, leadId, memberId]).del().catch(() => undefined);
    await db('notifications').whereIn('recipientUserId', [adminId, leadId, memberId]).del().catch(() => undefined);
    await db('team_role_bindings').whereIn('teamId', [teamAId, teamBId]).del().catch(() => undefined);
    await db('group_members').whereIn('groupId', [ownerTeamId, teamAId, teamBId]).del().catch(() => undefined);
    await db('groups').whereIn('id', [ownerTeamId, teamAId, teamBId]).del().catch(() => undefined);
    await db('users').whereIn('id', [adminId, leadId, memberId]).del().catch(() => undefined);
    await db.destroy();
  }
});

test('approval gives the owning Team access without a Platform Admin', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const users = new UserService(database);
  const proposerId = uuidv4();
  const reviewerId = uuidv4();
  const outsiderId = uuidv4();
  const teamId = uuidv4();
  const otherTeamId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `autogrant-${suffix}`;
  let draftId: string | null = null;
  let requestId: string | null = null;
  let skillId: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      { id: proposerId, externalId: `ag-proposer-${suffix}`, email: `ag-proposer-${suffix}@example.test`, displayName: 'Autogrant proposer', isAdmin: false },
      { id: reviewerId, externalId: `ag-reviewer-${suffix}`, email: `ag-reviewer-${suffix}@example.test`, displayName: 'Autogrant reviewer', isAdmin: false },
      { id: outsiderId, externalId: `ag-outsider-${suffix}`, email: `ag-outsider-${suffix}@example.test`, displayName: 'Autogrant outsider', isAdmin: false },
    ]);
    await db('groups').insert([
      { id: teamId, name: `Autogrant owner ${suffix}` },
      { id: otherTeamId, name: `Autogrant other ${suffix}` },
    ]);
    await db('group_members').insert([
      { groupId: teamId, userId: proposerId },
      { groupId: teamId, userId: reviewerId },
      { groupId: otherTeamId, userId: outsiderId },
    ]);
    await db('team_role_bindings').insert({
      teamId, userId: reviewerId, role: 'lead', assignedByUserId: null,
    });

    const created = await governance.createDraft(proposerId, { proposalType: 'new' });
    draftId = String(created.id);
    const updated = await governance.updateDraft(proposerId, draftId, Number(created.draftRevision), {
      proposedSkillKey: skillKey,
      proposedOwnerTeamId: teamId,
      displayName: 'Autogrant skill',
      description: 'Checks that approval assigns the owning Team.',
      files: [{
        path: 'SKILL.md',
        content: [
          '---',
          'name: Autogrant skill',
          'description: Checks that approval assigns the owning Team.',
          '---',
          '',
          '# Autogrant skill',
          '',
          'Use this package only for the governance integration test.',
          '',
        ].join('\n'),
      }],
    });
    const submitted = await governance.submitDraft(proposerId, draftId, {
      owningTeamId: teamId,
      semanticVersion: '1.0.0',
      expectedDraftRevision: Number(updated.draftRevision),
      submissionNote: 'Autogrant test',
    });
    requestId = String(submitted.id);

    const review = await governance.getReview(reviewerId, requestId);
    const approved = await governance.decideReview(reviewerId, requestId, {
      decision: 'approve',
      expectedRequestRevision: Number(review.requestRevision),
    });
    skillId = String(approved.skillId);

    // The point of the change: no second, Platform-Admin-only trip is needed.
    const grant = await db('team_skill_grants').where({ teamId, skillId }).first();
    assert.ok(grant, 'approval must assign the skill to its owning Team');
    assert.equal(String(grant.grantedByUserId), reviewerId);
    assert.ok(((await users.getEffectivePromptAccess(proposerId))?.skillIds || []).includes(skillKey));

    // Assignment is audited separately from the approval and the activation.
    const grantEvents = await db('audit_events')
      .where({ action: 'skill_access.team_granted', resourceId: skillId });
    assert.equal(grantEvents.length, 1);

    // A Lead switching the skill off must survive a later version being published.
    await governance.setTeamSkillDisabled(reviewerId, teamId, skillKey, true, 'Paused');
    const improvement = await governance.createDraft(proposerId, {
      proposalType: 'improvement',
      sourceSkillId: skillId,
    });
    const improved = await governance.updateDraft(proposerId, String(improvement.id), Number(improvement.draftRevision), {
      files: [{
        path: 'SKILL.md',
        content: `${(improvement.files as any[]).find((file: any) => file.path === 'SKILL.md')?.content || ''}\nSecond version.\n`,
      }],
    });
    const resubmitted = await governance.submitDraft(proposerId, String(improvement.id), {
      owningTeamId: teamId,
      semanticVersion: '1.1.0',
      expectedDraftRevision: Number(improved.draftRevision),
      submissionNote: 'Second version',
    });
    const secondReview = await governance.getReview(reviewerId, String(resubmitted.id));
    await governance.decideReview(reviewerId, String(resubmitted.id), {
      decision: 'approve',
      expectedRequestRevision: Number(secondReview.requestRevision),
    });
    assert.ok(
      await db('team_skill_disables').where({ teamId, skillKey }).first(),
      'publishing a new version must not clear a Lead\'s disable',
    );
    // And the grant row was not rewritten by the second approval.
    const regrant = await db('team_skill_grants').where({ teamId, skillId }).first();
    assert.equal(String(regrant.grantedByUserId), reviewerId);
    assert.equal(String(regrant.createdAt), String(grant.createdAt));
  } finally {
    await db('team_skill_disables').where({ teamId }).del().catch(() => undefined);
    await db('team_skill_grants').where({ teamId }).del().catch(() => undefined);
    if (skillId) {
      await db('skills').where({ id: skillId }).update({ defaultVersionId: null }).catch(() => undefined);
      await db('skill_version_files').whereIn('skillVersionId', db('skill_versions').select('id').where({ skillId })).del().catch(() => undefined);
      await db('skill_versions').where({ skillId }).del().catch(() => undefined);
    }
    await db('skill_review_decisions').whereIn('requestId', db('skill_review_requests').select('id').where({ ownerTeamId: teamId })).del().catch(() => undefined);
    await db('skill_review_requests').where({ ownerTeamId: teamId }).del().catch(() => undefined);
    await db('private_skill_drafts').where({ ownerUserId: proposerId }).del().catch(() => undefined);
    if (skillId) await db('skills').where({ id: skillId }).del().catch(() => undefined);
    await db('audit_events').whereIn('actorUserId', [proposerId, reviewerId, outsiderId]).del().catch(() => undefined);
    await db('notifications').whereIn('recipientUserId', [proposerId, reviewerId, outsiderId]).del().catch(() => undefined);
    await db('team_role_bindings').where({ teamId }).del().catch(() => undefined);
    await db('group_members').whereIn('groupId', [teamId, otherTeamId]).del().catch(() => undefined);
    await db('groups').whereIn('id', [teamId, otherTeamId]).del().catch(() => undefined);
    await db('users').whereIn('id', [proposerId, reviewerId, outsiderId]).del().catch(() => undefined);
    await Promise.all([
      fs.rm(path.join(skillsRoot, skillKey), { recursive: true, force: true }),
      fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', skillKey), { recursive: true, force: true }),
    ]);
    await db.destroy();
  }
});

test('a private draft runs in every private workspace its owner owns until switched off', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const authorId = uuidv4();
  const firstWorkspaceId = uuidv4();
  const secondWorkspaceId = uuidv4();
  const teamWorkspaceId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `default-on-${suffix}`;
  let draftId: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();
    const users = new UserService(database);

    await db('users').insert({
      id: authorId,
      externalId: `default-on-${suffix}`,
      email: `default-on-${suffix}@example.test`,
      displayName: 'Default on author',
      isAdmin: false,
    });
    await db('workspaces').insert([
      { id: firstWorkspaceId, name: `First ${suffix}`, slug: `first-${suffix}`, ownerId: authorId, visibility: 'private', workspaceType: 'private' },
      { id: secondWorkspaceId, name: `Second ${suffix}`, slug: `second-${suffix}`, ownerId: authorId, visibility: 'private', workspaceType: 'private' },
      { id: teamWorkspaceId, name: `Shared ${suffix}`, slug: `shared-${suffix}`, ownerId: authorId, visibility: 'team', workspaceType: 'team' },
    ]);

    const created = await governance.createDraft(authorId, { proposalType: 'new' });
    draftId = String(created.id);
    await governance.updateDraft(authorId, draftId, Number(created.draftRevision), {
      proposedSkillKey: skillKey,
      displayName: 'Default on skill',
      description: 'Available everywhere its owner works.',
      files: [{
        path: 'SKILL.md',
        content: `---\nname: ${skillKey}\ndescription: Available everywhere its owner works.\n---\n\n# ${skillKey}\n`,
      }],
    });

    const keysIn = async (workspaceId: string) =>
      (await users.getWorkspaceSkillDraftRuntimePins(workspaceId, authorId)).map((pin) => pin.skillKey);

    // The change: no per-workspace step was taken anywhere, and it runs in both.
    assert.deepEqual(await keysIn(firstWorkspaceId), [skillKey]);
    assert.deepEqual(await keysIn(secondWorkspaceId), [skillKey], 'a second private workspace needs no pin');
    // A shared workspace never inherits an unreviewed draft, whatever the owner does.
    assert.deepEqual(await keysIn(teamWorkspaceId), []);

    // A workspace created later is covered too -- that is what "by default" has to mean.
    const laterWorkspaceId = uuidv4();
    await db('workspaces').insert({
      id: laterWorkspaceId, name: `Later ${suffix}`, slug: `later-${suffix}`, ownerId: authorId, visibility: 'private', workspaceType: 'private',
    });
    assert.deepEqual(await keysIn(laterWorkspaceId), [skillKey]);
    await db('workspaces').where({ id: laterWorkspaceId }).del();

    // Switching it off is per workspace and leaves the others alone.
    await governance.unpinWorkspaceSkillDraft(authorId, secondWorkspaceId, draftId);
    assert.deepEqual(await keysIn(firstWorkspaceId), [skillKey]);
    assert.deepEqual(await keysIn(secondWorkspaceId), []);

    const listed = await governance.listWorkspaceSkillDraftPins(authorId, secondWorkspaceId);
    const entry = (listed.pins as any[]).find((pin) => pin.draftId === draftId);
    assert.equal(entry.enabled, false, 'the listing must report state, not just stored rows');

    // And switching it back on clears the exclusion.
    await governance.pinWorkspaceSkillDraft(authorId, secondWorkspaceId, draftId);
    assert.deepEqual(await keysIn(secondWorkspaceId), [skillKey]);

    // A revision that fails validation is never materialized, so it stops resolving
    // rather than reaching the agent and raising in its frontmatter parser.
    const current = await governance.getDraft(authorId, draftId);
    await governance.updateDraft(authorId, draftId, Number(current.draftRevision), {
      files: [{ path: 'SKILL.md', content: 'no frontmatter here\n' }],
    });
    assert.deepEqual(await keysIn(firstWorkspaceId), [], 'an invalid revision must not run');
  } finally {
    await fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', skillKey), {
      recursive: true, force: true,
    }).catch(() => undefined);
    if (draftId) {
      await db('private_workspace_skill_draft_exclusions').where({ draftId }).del().catch(() => undefined);
      await db('private_workspace_skill_draft_pins').where({ draftId }).del().catch(() => undefined);
      await db('skill_draft_revision_files')
        .whereIn('draftRevisionId', db('skill_draft_revisions').select('id').where({ draftId }))
        .del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).update({ currentDraftRevisionId: null }).catch(() => undefined);
      await db('skill_draft_revisions').where({ draftId }).del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).del().catch(() => undefined);
    }
    await db('audit_events').where({ actorUserId: authorId }).del().catch(() => undefined);
    await db('notifications').where({ recipientUserId: authorId }).del().catch(() => undefined);
    await db('workspaces').whereIn('id', [firstWorkspaceId, secondWorkspaceId, teamWorkspaceId]).del().catch(() => undefined);
    await db('users').where({ id: authorId }).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a Team Lead grants and revokes a skill their own Team owns', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const users = new UserService(database);
  const leadId = uuidv4();
  const memberId = uuidv4();
  const ownTeamId = uuidv4();
  const foreignTeamId = uuidv4();
  const ownSkillId = uuidv4();
  const ownVersionId = uuidv4();
  const foreignSkillId = uuidv4();
  const foreignVersionId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const ownKey = `lead-own-${suffix}`;
  const foreignKey = `lead-foreign-${suffix}`;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      { id: leadId, externalId: `lead-grant-${suffix}`, email: `lead-grant-${suffix}@example.test`, displayName: 'Grant lead', isAdmin: false },
      { id: memberId, externalId: `lead-member-${suffix}`, email: `lead-member-${suffix}@example.test`, displayName: 'Grant member', isAdmin: false },
    ]);
    await db('groups').insert([
      { id: ownTeamId, name: `Lead own ${suffix}` },
      { id: foreignTeamId, name: `Lead foreign ${suffix}` },
    ]);
    await db('group_members').insert([
      { groupId: ownTeamId, userId: leadId },
      { groupId: ownTeamId, userId: memberId },
    ]);
    await db('team_role_bindings').insert({
      teamId: ownTeamId, userId: leadId, role: 'lead', assignedByUserId: null,
    });
    await db('skills').insert([
      { id: ownSkillId, skillKey: ownKey, displayName: 'Lead own skill', ownerTeamId: ownTeamId, status: 'active' },
      { id: foreignSkillId, skillKey: foreignKey, displayName: 'Lead foreign skill', ownerTeamId: foreignTeamId, status: 'active' },
    ]);
    await db('skill_versions').insert([
      { id: ownVersionId, skillId: ownSkillId, semanticVersion: '1.0.0', manifestHash: 'e'.repeat(64), status: 'active' },
      { id: foreignVersionId, skillId: foreignSkillId, semanticVersion: '1.0.0', manifestHash: 'f'.repeat(64), status: 'active' },
    ]);
    await db('skills').where({ id: ownSkillId }).update({ defaultVersionId: ownVersionId });
    await db('skills').where({ id: foreignSkillId }).update({ defaultVersionId: foreignVersionId });

    const promptSkills = async (userId: string) =>
      (await users.getEffectivePromptAccess(userId))?.skillIds || [];

    // The Lead needs candidates to grant, so the listing has to surface a skill the Team
    // owns but has not assigned itself.
    const before = await governance.listTeamSkillAccess(leadId, ownTeamId);
    const candidate = (before.skills as any[]).find((entry) => entry.skillKey === ownKey);
    assert.ok(candidate, 'an owned but ungranted skill must be listed');
    assert.equal(candidate.granted, false);
    assert.equal(candidate.ownedByTeam, true);

    await governance.setTeamSkillGrant(leadId, ownTeamId, ownKey, true);
    assert.ok((await promptSkills(memberId)).includes(ownKey));

    const after = await governance.listTeamSkillAccess(leadId, ownTeamId);
    assert.equal((after.skills as any[]).find((entry) => entry.skillKey === ownKey).granted, true);

    await governance.setTeamSkillGrant(leadId, ownTeamId, ownKey, false);
    assert.ok(!(await promptSkills(memberId)).includes(ownKey));

    // Authority stops at the Team boundary: a Lead cannot assign another Team's skill.
    await assert.rejects(
      () => governance.setTeamSkillGrant(leadId, ownTeamId, foreignKey, true),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
    // Nor act on a Team they do not lead.
    await assert.rejects(
      () => governance.setTeamSkillGrant(leadId, foreignTeamId, foreignKey, true),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
    // An ordinary member has no grant authority at all.
    await assert.rejects(
      () => governance.setTeamSkillGrant(memberId, ownTeamId, ownKey, true),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
  } finally {
    await db('team_skill_grants').whereIn('skillId', [ownSkillId, foreignSkillId]).del().catch(() => undefined);
    await db('skills').whereIn('id', [ownSkillId, foreignSkillId]).update({ defaultVersionId: null }).catch(() => undefined);
    await db('skill_versions').whereIn('skillId', [ownSkillId, foreignSkillId]).del().catch(() => undefined);
    await db('skills').whereIn('id', [ownSkillId, foreignSkillId]).del().catch(() => undefined);
    await db('audit_events').whereIn('actorUserId', [leadId, memberId]).del().catch(() => undefined);
    await db('notifications').whereIn('recipientUserId', [leadId, memberId]).del().catch(() => undefined);
    await db('team_role_bindings').where({ teamId: ownTeamId }).del().catch(() => undefined);
    await db('group_members').whereIn('groupId', [ownTeamId, foreignTeamId]).del().catch(() => undefined);
    await db('groups').whereIn('id', [ownTeamId, foreignTeamId]).del().catch(() => undefined);
    await db('users').whereIn('id', [leadId, memberId]).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a missing blob degrades one file instead of the whole skill detail', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const adminId = uuidv4();
  const teamId = uuidv4();
  const skillId = uuidv4();
  const versionId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `lostblob-${suffix}`;
  const body = `---\nname: ${skillKey}\ndescription: Loses its blob.\n---\n\n# ${skillKey}\n`;
  let contentHash: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();
    const store = new SkillPackageStore(db, () => undefined);
    await store.initialize();

    await db('users').insert({
      id: adminId, externalId: `lostblob-${suffix}`, email: `lostblob-${suffix}@example.test`,
      displayName: 'Lost blob admin', isAdmin: true,
    });
    await db('groups').insert({ id: teamId, name: `Lost blob ${suffix}` });

    const file = await store.persistBlob(Buffer.from(body, 'utf-8'), 'SKILL.md');
    contentHash = file.contentHash;
    await db('skills').insert({
      id: skillId, skillKey, displayName: 'Lost blob skill',
      description: 'Loses its blob.', ownerTeamId: teamId, status: 'active',
    });
    await db('skill_versions').insert({
      id: versionId, skillId, semanticVersion: '1.0.0',
      manifestHash: 'a'.repeat(64), status: 'active',
    });
    await db('skill_version_files').insert({
      skillVersionId: versionId, path: 'SKILL.md', contentHash: file.contentHash,
      executable: false, mode: file.mode, sizeBytes: file.sizeBytes, mimeType: file.mimeType,
    });
    await db('skills').where({ id: skillId }).update({ defaultVersionId: versionId });

    // Healthy first: the content reads back.
    const healthy = await governance.getSkillDetail(adminId, skillId);
    assert.equal((healthy.files as any[])[0].content, body);
    assert.equal((healthy.files as any[])[0].unavailable, false);

    // Now delete the blob file, exactly as the deploy's skills-tree wipe did.
    await fs.rm(path.join(
      skillsRoot, '.governed-versions', 'blobs', contentHash.slice(0, 2), contentHash,
    ), { force: true });

    // The detail must still load. Everything that does not need the blob is intact, and
    // the fault is reported against the file, naming the cause.
    const degraded = await governance.getSkillDetail(adminId, skillId);
    assert.equal(degraded.skill.skillKey, skillKey);
    assert.equal(degraded.skill.displayName, 'Lost blob skill');
    assert.equal((degraded.versions as any[]).length, 1);
    assert.equal(degraded.usage.teamGrantCount, 0);
    const degradedFile = (degraded.files as any[])[0];
    assert.equal(degradedFile.unavailable, true);
    assert.match(degradedFile.unavailableReason, /missing from storage/);
    assert.equal(degradedFile.content, undefined);

    // Archive is only reachable from this dialog, and the dialog only renders its
    // actions once the detail loads. While a missing blob failed the whole response the
    // admin had no way to retire a skill precisely when it was most broken.
    assert.equal(degraded.permissions.canArchive, true);
    const archived = await governance.setSkillStatus(adminId, skillId, 'archive');
    assert.equal(archived.status, 'retired');
    assert.equal(
      (await db('skills').where({ id: skillId }).first()).status,
      'retired',
      'a Platform Admin must be able to archive a skill whose content is unreadable',
    );
  } finally {
    if (contentHash) {
      await db('content_blobs').where({ contentHash }).del().catch(() => undefined);
    }
    await db('skills').where({ id: skillId }).update({ defaultVersionId: null }).catch(() => undefined);
    await db('skill_version_files').where({ skillVersionId: versionId }).del().catch(() => undefined);
    await db('skill_versions').where({ skillId }).del().catch(() => undefined);
    await db('skills').where({ id: skillId }).del().catch(() => undefined);
    await db('groups').where({ id: teamId }).del().catch(() => undefined);
    await db('users').where({ id: adminId }).del().catch(() => undefined);
    await fs.rm(path.join(skillsRoot, skillKey), { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', skillKey), {
      recursive: true, force: true,
    }).catch(() => undefined);
    await db.destroy();
  }
});

test('the catalogue lists every Team\'s skills and redacts what you cannot run', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const ownerId = uuidv4();
  const outsiderId = uuidv4();
  const ownerTeamId = uuidv4();
  const otherTeamId = uuidv4();
  const skillId = uuidv4();
  const versionId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `discovery-${suffix}`;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      { id: ownerId, externalId: `disc-owner-${suffix}`, email: `disc-owner-${suffix}@example.test`, displayName: 'Discovery owner', isAdmin: false },
      { id: outsiderId, externalId: `disc-out-${suffix}`, email: `disc-out-${suffix}@example.test`, displayName: 'Discovery outsider', isAdmin: false },
    ]);
    await db('groups').insert([
      { id: ownerTeamId, name: `Discovery owner ${suffix}` },
      { id: otherTeamId, name: `Discovery other ${suffix}` },
    ]);
    await db('group_members').insert([
      { groupId: ownerTeamId, userId: ownerId },
      { groupId: otherTeamId, userId: outsiderId },
    ]);
    await db('skills').insert({
      id: skillId, skillKey, displayName: 'Discovery skill',
      description: 'Findable by everyone, readable by its Team.',
      ownerTeamId: ownerTeamId, status: 'active',
    });
    await db('skill_versions').insert({
      id: versionId, skillId, semanticVersion: '2.1.0', manifestHash: 'b'.repeat(64), status: 'active',
    });
    await db('skills').where({ id: skillId }).update({ defaultVersionId: versionId });

    // Discovery: the outsider can find it and see who to ask, and nothing more. Name,
    // owning Team and description are the whole locked row.
    const discovery = await governance.catalog(outsiderId, { scope: 'all', limit: 100 });
    const row = (discovery.skills as any[]).find((entry) => entry.skillKey === skillKey);
    assert.ok(row, 'discovery scope must list another Team\'s skill');
    assert.equal(row.entitled, false);
    assert.equal(row.locked, true);
    assert.equal(row.ownerTeamName, `Discovery owner ${suffix}`);
    assert.equal(row.description, 'Findable by everyone, readable by its Team.');
    assert.equal(row.defaultSemanticVersion, null, 'the exact version must be redacted');
    assert.equal(row.defaultManifestHash, null, 'the manifest hash must be redacted');
    assert.equal(row.defaultVersionId, null);

    // The default scope is untouched: it is still "what can I run", which is what the
    // runtime pickers read.
    const entitledOnly = await governance.catalog(outsiderId, { limit: 100 });
    assert.ok(!(entitledOnly.skills as any[]).some((entry) => entry.skillKey === skillKey));

    // Finding a skill does not open its content. Client filtering is never the boundary.
    await assert.rejects(
      () => governance.getSkillDetail(outsiderId, skillId),
      (error: any) => error?.code === 'SKILL_RESOURCE_NOT_FOUND',
    );

    // A member of the owning Team is not locked out of their own Team's skill, even
    // before anyone grants it to them.
    const ownerView = await governance.catalog(ownerId, { scope: 'all', limit: 100 });
    const ownerRow = (ownerView.skills as any[]).find((entry) => entry.skillKey === skillKey);
    assert.equal(ownerRow.locked, false);
    assert.equal(ownerRow.defaultSemanticVersion, '2.1.0');
  } finally {
    await db('skills').where({ id: skillId }).update({ defaultVersionId: null }).catch(() => undefined);
    await db('skill_versions').where({ skillId }).del().catch(() => undefined);
    await db('skills').where({ id: skillId }).del().catch(() => undefined);
    await db('group_members').whereIn('groupId', [ownerTeamId, otherTeamId]).del().catch(() => undefined);
    await db('groups').whereIn('id', [ownerTeamId, otherTeamId]).del().catch(() => undefined);
    await db('users').whereIn('id', [ownerId, outsiderId]).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a CD-managed skill republishes when its shipped content moves on', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const teamId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const migratedKey = `cdmanaged-${suffix}`;
  const teamKey = `teamowned-${suffix}`;
  const dir = path.join(skillsRoot, migratedKey);
  const teamDir = path.join(skillsRoot, teamKey);
  let teamSkillId: string | null = null;

  const body = (note: string) => `---\nname: ${migratedKey}\ndescription: ${note}\n---\n\n# ${migratedKey}\n\n${note}\n`;

  try {
    await database.initialize();
    await db('groups').insert({ id: teamId, name: `CD owner ${suffix}` });

    // First deploy ships the skill; startup registers it from the filesystem.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), body('First shipped version.'), 'utf-8');
    let governance = new SkillGovernanceService(database);
    await governance.initialize();

    const first = await db('skills as s')
      .join('skill_versions as v', 'v.id', 's.defaultVersionId')
      .select('s.id', 'v.id as versionId', 'v.semanticVersion', 'v.manifestHash')
      .where('s.skillKey', migratedKey).first();
    assert.ok(first, 'the registry backfill must adopt a new filesystem skill');
    assert.equal(first.semanticVersion, '1.0.0');

    // A Team-owned skill whose folder says something else. The filesystem is only a
    // materialised copy for these, so it must not drive a republish.
    teamSkillId = uuidv4();
    const teamVersionId = uuidv4();
    await db('skills').insert({
      id: teamSkillId, skillKey: teamKey, displayName: 'Team owned',
      ownerTeamId: teamId, status: 'active',
    });
    await db('skill_versions').insert({
      id: teamVersionId, skillId: teamSkillId, semanticVersion: '3.0.0',
      manifestHash: 'e'.repeat(64), status: 'active',
    });
    await db('skills').where({ id: teamSkillId }).update({ defaultVersionId: teamVersionId });
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(path.join(teamDir, 'SKILL.md'), body('Not the approved content.'), 'utf-8');

    // A later deploy overwrites the shipped content. Restart.
    await fs.writeFile(path.join(dir, 'SKILL.md'), body('Second shipped version.'), 'utf-8');
    governance = new SkillGovernanceService(database);
    await governance.initialize();

    const second = await db('skills as s')
      .join('skill_versions as v', 'v.id', 's.defaultVersionId')
      .select('v.id as versionId', 'v.semanticVersion', 'v.manifestHash')
      .where('s.skillKey', migratedKey).first();
    assert.equal(second.semanticVersion, '1.0.1', 'drift must publish the next patch version');
    assert.notEqual(second.manifestHash, first.manifestHash);
    assert.notEqual(second.versionId, first.versionId);

    // The superseded version stays: an approved version is immutable, so correcting
    // drift adds one rather than rewriting the old row.
    const previous = await db('skill_versions').where({ id: first.versionId }).first();
    assert.ok(previous, 'the previous version must be retained');
    assert.equal(previous.manifestHash, first.manifestHash);

    // The new version reads back, which is the whole point: the detail dialog stops
    // failing because the recorded blobs now exist.
    const detail = await db('skill_version_files').where({ skillVersionId: second.versionId });
    assert.equal(detail.length, 1);

    // Idempotent: an unchanged folder publishes nothing further.
    governance = new SkillGovernanceService(database);
    await governance.initialize();
    const third = await db('skill_versions').where({ skillId: first.id });
    assert.equal(third.length, 2, 'a restart with no drift must not publish again');

    // The Team-owned skill is untouched, whatever its folder says.
    const teamAfter = await db('skills as s')
      .join('skill_versions as v', 'v.id', 's.defaultVersionId')
      .select('v.semanticVersion', 'v.manifestHash')
      .where('s.skillKey', teamKey).first();
    assert.equal(teamAfter.semanticVersion, '3.0.0');
    assert.equal(teamAfter.manifestHash, 'e'.repeat(64));
    assert.equal(
      (await db('skill_versions').where({ skillId: teamSkillId })).length, 1,
      'a deploy must never republish a version a Team approved',
    );
  } finally {
    for (const key of [migratedKey, teamKey]) {
      const s = await db('skills').where({ skillKey: key }).first().catch(() => null);
      if (s) {
        await db('skills').where({ id: s.id }).update({ defaultVersionId: null }).catch(() => undefined);
        await db('skill_version_files')
          .whereIn('skillVersionId', db('skill_versions').select('id').where({ skillId: s.id }))
          .del().catch(() => undefined);
        await db('team_skill_grants').where({ skillId: s.id }).del().catch(() => undefined);
        await db('skill_versions').where({ skillId: s.id }).del().catch(() => undefined);
        await db('skills').where({ id: s.id }).del().catch(() => undefined);
      }
      await fs.rm(path.join(skillsRoot, key), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', key), {
        recursive: true, force: true,
      }).catch(() => undefined);
    }
    await db('audit_events').where({ actorRole: 'platform_migration' }).del().catch(() => undefined);
    await db('groups').where({ id: teamId }).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a Platform Admin may clear their own candidate only when the platform opts in', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const adminId = uuidv4();
  const otherLeadId = uuidv4();
  const memberId = uuidv4();
  const teamId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `adminself-${suffix}`;
  const previous = process.env.ALLOW_PLATFORM_ADMIN_SKILL_SELF_APPROVAL;
  let draftId: string | null = null;
  let requestId: string | null = null;
  let memberDraftId: string | null = null;
  let memberRequestId: string | null = null;

  const skillFile = (name: string) => ([{
    path: 'SKILL.md',
    content: `---\nname: ${name}\ndescription: Admin self approval check.\n---\n\n# ${name}\n`,
  }]);

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();

    await db('users').insert([
      { id: adminId, externalId: `as-admin-${suffix}`, email: `as-admin-${suffix}@example.test`, displayName: 'Self admin', isAdmin: true },
      { id: otherLeadId, externalId: `as-lead-${suffix}`, email: `as-lead-${suffix}@example.test`, displayName: 'Other lead', isAdmin: false },
      { id: memberId, externalId: `as-member-${suffix}`, email: `as-member-${suffix}@example.test`, displayName: 'Plain member', isAdmin: false },
    ]);
    await db('groups').insert({ id: teamId, name: `Admin self ${suffix}` });
    await db('group_members').insert([
      { groupId: teamId, userId: adminId },
      { groupId: teamId, userId: otherLeadId },
      { groupId: teamId, userId: memberId },
    ]);
    // Two leads, so the single-lead override cannot be what unblocks this.
    await db('team_role_bindings').insert([
      { teamId, userId: adminId, role: 'lead', assignedByUserId: null },
      { teamId, userId: otherLeadId, role: 'lead', assignedByUserId: null },
    ]);

    const created = await governance.createDraft(adminId, { proposalType: 'new' });
    draftId = String(created.id);
    const updated = await governance.updateDraft(adminId, draftId, Number(created.draftRevision), {
      proposedSkillKey: skillKey,
      proposedOwnerTeamId: teamId,
      displayName: 'Admin self approval',
      description: 'Admin self approval check.',
      files: skillFile(skillKey),
    });
    const submitted = await governance.submitDraft(adminId, draftId, {
      owningTeamId: teamId,
      semanticVersion: '1.0.0',
      expectedDraftRevision: Number(updated.draftRevision),
      submissionNote: 'Admin self approval',
    });
    requestId = String(submitted.id);

    // Off by default: separation of duties holds even for a Platform Admin.
    delete process.env.ALLOW_PLATFORM_ADMIN_SKILL_SELF_APPROVAL;
    let review = await governance.getReview(adminId, requestId);
    assert.equal(review.permissions.canReview, false, 'the dialog must not offer a decision it cannot make');
    await assert.rejects(
      () => governance.decideReview(adminId, requestId!, {
        decision: 'approve', expectedRequestRevision: Number(review.requestRevision),
      }),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );

    // Opted in: the admin can clear their own candidate, and it is recorded as such.
    process.env.ALLOW_PLATFORM_ADMIN_SKILL_SELF_APPROVAL = 'true';
    review = await governance.getReview(adminId, requestId);
    assert.equal(review.permissions.canReview, true);
    const approved = await governance.decideReview(adminId, requestId, {
      decision: 'approve', expectedRequestRevision: Number(review.requestRevision),
    });
    assert.equal(approved.status, 'approved');
    const decision = await db('skill_review_decisions').where({ requestId }).first();
    assert.equal(decision.selfApproved, true, 'a self-approval must be visible in the decision record');

    // The exception is scoped to the admin's own work. Somebody else's candidate is
    // still reviewed by a Lead who is not its proposer, admin or not.
    const memberDraft = await governance.createDraft(memberId, { proposalType: 'new' });
    memberDraftId = String(memberDraft.id);
    const memberUpdated = await governance.updateDraft(memberId, memberDraftId, Number(memberDraft.draftRevision), {
      proposedSkillKey: `${skillKey}-member`,
      proposedOwnerTeamId: teamId,
      displayName: 'Member proposal',
      description: 'Admin self approval check.',
      files: skillFile(`${skillKey}-member`),
    });
    const memberSubmitted = await governance.submitDraft(memberId, memberDraftId, {
      owningTeamId: teamId,
      semanticVersion: '1.0.0',
      expectedDraftRevision: Number(memberUpdated.draftRevision),
      submissionNote: 'Member proposal',
    });
    memberRequestId = String(memberSubmitted.id);
    const memberReview = await governance.getReview(memberId, memberRequestId);
    assert.equal(memberReview.permissions.canReview, false, 'a plain proposer never gains self-approval');
    await assert.rejects(
      () => governance.decideReview(memberId, memberRequestId!, {
        decision: 'approve', expectedRequestRevision: Number(memberReview.requestRevision),
      }),
      (error: any) => error?.code === 'SKILL_ACTION_FORBIDDEN',
    );
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PLATFORM_ADMIN_SKILL_SELF_APPROVAL;
    else process.env.ALLOW_PLATFORM_ADMIN_SKILL_SELF_APPROVAL = previous;
    for (const key of [skillKey, `${skillKey}-member`]) {
      const row = await db('skills').where({ skillKey: key }).first().catch(() => null);
      if (row) {
        await db('skills').where({ id: row.id }).update({ defaultVersionId: null }).catch(() => undefined);
        await db('team_skill_grants').where({ skillId: row.id }).del().catch(() => undefined);
        await db('skill_version_files')
          .whereIn('skillVersionId', db('skill_versions').select('id').where({ skillId: row.id }))
          .del().catch(() => undefined);
        await db('skill_versions').where({ skillId: row.id }).del().catch(() => undefined);
        await db('skills').where({ id: row.id }).del().catch(() => undefined);
      }
      await fs.rm(path.join(skillsRoot, key), { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', key), { recursive: true, force: true }).catch(() => undefined);
    }
    for (const rid of [requestId, memberRequestId]) {
      if (rid) {
        await db('skill_review_decisions').where({ requestId: rid }).del().catch(() => undefined);
        await db('skill_candidate_policy_results')
          .whereIn('candidateId', db('skill_review_candidates').select('id').where({ requestId: rid }))
          .del().catch(() => undefined);
        await db('skill_review_candidate_files')
          .whereIn('candidateId', db('skill_review_candidates').select('id').where({ requestId: rid }))
          .del().catch(() => undefined);
        await db('skill_review_requests').where({ id: rid }).update({ currentCandidateId: null }).catch(() => undefined);
        await db('skill_review_candidates').where({ requestId: rid }).del().catch(() => undefined);
        await db('skill_review_requests').where({ id: rid }).del().catch(() => undefined);
      }
    }
    for (const did of [draftId, memberDraftId]) {
      if (did) {
        await db('skill_draft_revision_files')
          .whereIn('draftRevisionId', db('skill_draft_revisions').select('id').where({ draftId: did }))
          .del().catch(() => undefined);
        await db('private_skill_drafts').where({ id: did }).update({ currentDraftRevisionId: null }).catch(() => undefined);
        await db('skill_draft_revisions').where({ draftId: did }).del().catch(() => undefined);
        await db('private_skill_drafts').where({ id: did }).del().catch(() => undefined);
      }
    }
    await db('audit_events').whereIn('actorUserId', [adminId, otherLeadId, memberId]).del().catch(() => undefined);
    await db('notifications').whereIn('recipientUserId', [adminId, otherLeadId, memberId]).del().catch(() => undefined);
    await db('team_role_bindings').where({ teamId }).del().catch(() => undefined);
    await db('group_members').where({ groupId: teamId }).del().catch(() => undefined);
    await db('groups').where({ id: teamId }).del().catch(() => undefined);
    await db('users').whereIn('id', [adminId, otherLeadId, memberId]).del().catch(() => undefined);
    await db.destroy();
  }
});

test('the Skill Builder workspace is a real row, hidden from the user', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const users = new UserService(database);
  const userId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  try {
    await database.initialize();
    const { WorkspaceService } = await import('../src/services/workspaceService');
    const workspaces = new WorkspaceService(database);

    await db('users').insert({
      id: userId, externalId: `builder-${suffix}`, email: `builder-${suffix}@example.test`,
      displayName: 'Builder user', isAdmin: false,
    });

    const scratch: any = await workspaces.ensureBuilderScratchWorkspace({
      userId, displayName: 'Builder user',
    } as any);

    // The whole point: a real row with a real uuid, so every uuid column and every
    // membership check in the run path accepts it.
    assert.match(String(scratch.id), UUID_RE, 'the builder workspace must be a real uuid');
    assert.equal(scratch.ownerId, userId);
    assert.equal(scratch.visibility, 'private');
    assert.equal(Boolean(scratch.isBuilderScratch), true);
    assert.equal(Boolean(scratch.isSystem), false, 'isSystem would give admins write access here');

    // `ensureMembership` is what killed the run before; it must now resolve.
    const membership: any = await workspaces.ensureMembership(String(scratch.id), userId, { requireEdit: true });
    assert.ok(membership, 'the run path must be able to resolve membership');

    // Idempotent: a second session reuses the row rather than making another.
    const again: any = await workspaces.ensureBuilderScratchWorkspace({
      userId, displayName: 'Builder user',
    } as any);
    assert.equal(String(again.id), String(scratch.id));
    assert.equal(
      (await db('workspaces').where({ ownerId: userId, isBuilderScratch: true })).length, 1,
    );

    // Hidden from the user: it is theirs, but it is not work they did.
    const listed = await workspaces.listWorkspacesForUser(userId);
    assert.ok(
      !(listed as any[]).some((row) => String(row.id) === String(scratch.id)),
      'the scratch workspace must not appear in the workspace list',
    );
    const owned = await users.listOwnedWorkspaces(userId);
    assert.ok(
      !(owned as any[]).some((row) => String(row.id) === String(scratch.id)),
      'it must not inflate the deactivation impact preview',
    );

    // A clean room: the builder authors one skill and must not pull the author's other
    // unreviewed drafts into that session, even though it owns a private workspace that
    // would otherwise qualify.
    assert.deepEqual(
      await users.getWorkspaceSkillDraftRuntimePins(String(scratch.id), userId), [],
      'private drafts must not resolve inside the builder workspace',
    );

    // A normal workspace is unaffected by the new filter.
    const normal: any = await workspaces.createWorkspace({ userId, displayName: 'Builder user' } as any, 'Real work');
    const listedAgain = await workspaces.listWorkspacesForUser(userId);
    assert.ok((listedAgain as any[]).some((row) => String(row.id) === String(normal.id)));
    await db('workspace_members').where({ workspaceId: normal.id }).del().catch(() => undefined);
    await db('workspaces').where({ id: normal.id }).del().catch(() => undefined);
  } finally {
    const rows = await db('workspaces').where({ ownerId: userId }).select('id').catch(() => []);
    for (const row of rows as any[]) {
      await db('workspace_members').where({ workspaceId: row.id }).del().catch(() => undefined);
      await db('workspaces').where({ id: row.id }).del().catch(() => undefined);
    }
    await db('users').where({ id: userId }).del().catch(() => undefined);
    await db.destroy();
  }
});

test('a submitted draft keeps running for its author until the review closes it', { skip: !enabled }, async () => {
  const database = new DatabaseService();
  const db = database.getDb();
  const authorId = uuidv4();
  const reviewerId = uuidv4();
  const teamId = uuidv4();
  const workspaceId = uuidv4();
  const suffix = uuidv4().replace(/-/g, '').slice(0, 12);
  const skillKey = `in-review-${suffix}`;
  let draftId: string | null = null;
  let requestId: string | null = null;

  try {
    await database.initialize();
    const governance = new SkillGovernanceService(database);
    await governance.initialize();
    const users = new UserService(database);

    await db('users').insert([
      { id: authorId, externalId: `in-review-author-${suffix}`, email: `in-review-author-${suffix}@example.test`, displayName: 'In review author', isAdmin: false },
      { id: reviewerId, externalId: `in-review-reviewer-${suffix}`, email: `in-review-reviewer-${suffix}@example.test`, displayName: 'In review reviewer', isAdmin: false },
    ]);
    await db('groups').insert({ id: teamId, name: `In review ${suffix}` });
    await db('group_members').insert([{ groupId: teamId, userId: authorId }, { groupId: teamId, userId: reviewerId }]);
    await db('team_role_bindings').insert([
      { teamId, userId: authorId, role: 'member', assignedByUserId: null },
      { teamId, userId: reviewerId, role: 'lead', assignedByUserId: null },
    ]);
    await db('workspaces').insert({
      id: workspaceId, name: `Private ${suffix}`, slug: `private-${suffix}`, ownerId: authorId, visibility: 'private', workspaceType: 'private',
    });

    const created = await governance.createDraft(authorId, { proposalType: 'new' });
    draftId = String(created.id);
    const updated = await governance.updateDraft(authorId, draftId, Number(created.draftRevision), {
      proposedSkillKey: skillKey,
      proposedOwnerTeamId: teamId,
      displayName: 'In review skill',
      description: 'Keeps running while reviewed.',
      files: [{ path: 'SKILL.md', content: `---\nname: ${skillKey}\ndescription: Keeps running while reviewed.\n---\n\n# ${skillKey}\n` }],
    });
    const keys = async () => (await users.getWorkspaceSkillDraftRuntimePins(workspaceId, authorId)).map((pin) => pin.skillKey);
    assert.deepEqual(await keys(), [skillKey], 'a private draft runs in its author\'s private workspace');

    const submitted = await governance.submitDraft(authorId, draftId, {
      owningTeamId: teamId,
      semanticVersion: '1.0.0',
      expectedDraftRevision: Number(updated.draftRevision),
      submissionNote: 'Keeps running while reviewed',
    });
    requestId = String(submitted.id);
    assert.equal((await governance.getDraft(authorId, draftId)).status, 'submitted');
    // The fix: submission used to drop it from the author's workspace until a reviewer acted.
    assert.deepEqual(await keys(), [skillKey], 'a submitted draft keeps running for its author');
    assert.deepEqual(await users.getWorkspaceSkillDraftRuntimePins(workspaceId, reviewerId), [], 'never for anyone else');

    const review = await governance.getReview(reviewerId, requestId);
    await governance.decideReview(reviewerId, requestId, {
      decision: 'reject',
      expectedRequestRevision: Number(review.requestRevision),
      comment: 'Closes the review',
    });
    // A closed review archives the draft, and an archived draft is finished.
    assert.deepEqual(await keys(), [], 'a draft stops once its review archives it');
  } finally {
    await db('workspaces').where({ id: workspaceId }).del().catch(() => undefined);
    if (requestId) {
      const candidateIds = db('skill_review_candidates').select('id').where({ requestId });
      await db('skill_review_decisions').where({ requestId }).del().catch(() => undefined);
      await db('skill_candidate_policy_results').whereIn('candidateId', candidateIds).del().catch(() => undefined);
      await db('skill_review_candidate_files').whereIn('candidateId', candidateIds).del().catch(() => undefined);
      await db('skill_review_candidates').where({ requestId }).del().catch(() => undefined);
      await db('skill_review_requests').where({ id: requestId }).del().catch(() => undefined);
    }
    if (draftId) {
      await db('private_workspace_skill_draft_exclusions').where({ draftId }).del().catch(() => undefined);
      await db('private_workspace_skill_draft_pins').where({ draftId }).del().catch(() => undefined);
      await db('skill_draft_revision_files')
        .whereIn('draftRevisionId', db('skill_draft_revisions').select('id').where({ draftId }))
        .del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).update({ currentDraftRevisionId: null }).catch(() => undefined);
      await db('skill_draft_revisions').where({ draftId }).del().catch(() => undefined);
      await db('private_skill_drafts').where({ id: draftId }).del().catch(() => undefined);
    }
    await db('audit_events').whereIn('actorUserId', [authorId, reviewerId]).del().catch(() => undefined);
    await db('notifications').whereIn('recipientUserId', [authorId, reviewerId]).del().catch(() => undefined);
    await db('group_members').where({ groupId: teamId }).del().catch(() => undefined);
    await db('team_role_bindings').where({ teamId }).del().catch(() => undefined);
    await db('groups').where({ id: teamId }).del().catch(() => undefined);
    await db('users').whereIn('id', [authorId, reviewerId]).del().catch(() => undefined);
    await fs.rm(path.join(skillsRoot, '.governed-versions', 'packages', skillKey), { recursive: true, force: true }).catch(() => undefined);
    await db.destroy();
  }
});
