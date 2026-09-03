/**
 * Turns an audit verb into a sentence a person can read.
 *
 * Kept pure and in one place so the activity feed, and anything that shows the
 * trail later, cannot describe the same event two different ways.
 *
 * New verbs are added to the audit tables constantly. An unrecognised action
 * must degrade to a readable fallback — never a blank row, never a throw. The
 * feed is not allowed to be the thing that breaks when somebody records a new
 * kind of event.
 */

export type ActivityEventInput = {
  action: string;
  resourceType: string;
  filePath?: string | null;
  workspaceName?: string | null;
};

export type DescribedActivityEvent = {
  title: string;
  meta: string;
};

const fileName = (filePath?: string | null): string => {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

/** `file.status.approved` -> `Status approved`; the last segment carries the verb. */
const humanizeAction = (action: string): string => {
  const segments = String(action || '').split('.').filter(Boolean);
  if (!segments.length) return 'Activity';
  const words = segments
    .slice(1)
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .trim() || segments[0].replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const RESOURCE_LABELS: Record<string, string> = {
  file: 'File',
  workspace: 'Workspace',
  team: 'Team',
  skill: 'Skill',
  private_skill_draft: 'Skill draft',
  skill_review_request: 'Skill review',
  user: 'User',
};

const FILE_STATUS_VERBS: Record<string, string> = {
  'file.status.submitted': 'Submitted',
  'file.status.approved': 'Approved',
  'file.status.reverted': 'Reverted',
  'file.status.published': 'Published',
  'file.status.unpublished': 'Unpublished',
};

const WORKSPACE_VERBS: Record<string, string> = {
  'workspace.shared': 'Shared',
  'workspace.promoted': 'Promoted',
  'workspace.purged': 'Purged',
  'workspace.archived_for_deactivation': 'Archived',
  'workspace.restored_from_deactivation': 'Restored',
  'workspace.version_published': 'Published a version of',
  'workspace.publication_withdrawn': 'Withdrew the publication of',
  'workspace.proposal_applied': 'Applied a proposal to',
  'workspace.ownership_transferred': 'Transferred ownership of',
  'workspace.editing_policy_changed': 'Changed the editing policy of',
  'workspace.access_granted': 'Granted access to',
  'workspace.access_revoked': 'Revoked access to',
  'workspace.team_access_granted': 'Granted team access to',
  'workspace.team_access_revoked': 'Revoked team access to',
};

export function describeActivityEvent(input: ActivityEventInput): DescribedActivityEvent {
  const action = String(input.action || '');
  const resourceType = String(input.resourceType || '');
  const name = fileName(input.filePath);
  const workspace = String(input.workspaceName || '').trim();

  const resourceLabel = RESOURCE_LABELS[resourceType] || 'Activity';
  const meta = workspace ? `${workspace} · ${resourceLabel.toLowerCase()}` : resourceLabel;

  const statusVerb = FILE_STATUS_VERBS[action];
  if (statusVerb) {
    return { title: name ? `${statusVerb} ${name}` : `${statusVerb} a file`, meta };
  }

  const workspaceVerb = WORKSPACE_VERBS[action];
  if (workspaceVerb) {
    return {
      title: workspace ? `${workspaceVerb} ${workspace}` : `${workspaceVerb} a workspace`,
      meta: resourceLabel,
    };
  }

  // Admin override reads are recorded precisely so somebody can see them.
  if (action === 'admin.workspace.accessed') {
    return {
      title: workspace ? `Viewed ${workspace} as an admin` : 'Viewed a workspace as an admin',
      meta: 'Platform override',
    };
  }

  if (resourceType === 'file' && name) {
    return { title: `${humanizeAction(action)} ${name}`, meta };
  }

  return { title: humanizeAction(action), meta };
}
