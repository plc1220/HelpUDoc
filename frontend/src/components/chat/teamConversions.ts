import type { WorkspaceCollaborationObjectType } from '../../services/workspaceCollaborationApi';

/** A "Use message" conversion option (spec F1 reuse of existing actions). */
export type CollaborationConversion = {
  label: string;
  type: WorkspaceCollaborationObjectType;
  visibility: 'private' | 'workspace_audience';
  requiresCommenter?: boolean;
  requiresContributor?: boolean;
  requiresFile?: boolean;
};

export const DEFAULT_CONVERSIONS: CollaborationConversion[] = [
  { label: 'Private note', type: 'sticky_note', visibility: 'private' },
  { label: 'Team note', type: 'sticky_note', visibility: 'workspace_audience', requiresCommenter: true },
  { label: 'Task', type: 'task', visibility: 'workspace_audience', requiresCommenter: true },
  { label: 'Annotation', type: 'annotation', visibility: 'workspace_audience', requiresCommenter: true, requiresFile: true },
  { label: 'Proposal', type: 'change_proposal', visibility: 'workspace_audience', requiresContributor: true },
];
