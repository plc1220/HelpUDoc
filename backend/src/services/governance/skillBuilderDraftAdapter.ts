import { promises as fs } from 'fs';
import {
  type DraftMutation,
  governanceError,
  normalizeGovernedSkillKey,
} from './skillGovernanceModel';

export type GovernedBuilderAction =
  | {
    type: 'create_skill';
    skillId: string;
    name?: string;
    description?: string;
  }
  | {
    type: 'upsert_text';
    skillId: string;
    path: string;
    content: string;
    encoding?: 'utf-8';
  }
  | {
    type: 'upload_binary_from_context';
    skillId: string;
    contextFileId: string;
    targetPath: string;
  }
  | {
    type: 'delete_file';
    skillId: string;
    path: string;
  };

type BuilderContextFile = {
  fileId: string;
  absolutePath: string;
};

export async function builderActionsToDraftMutation(
  actions: GovernedBuilderAction[],
  availableContextFiles: BuilderContextFile[],
): Promise<DraftMutation> {
  if (!actions.length) {
    governanceError(400, 'INVALID_SKILL_MANIFEST', 'The Skill Creator did not propose any changes');
  }

  const skillIds = Array.from(new Set(actions.map((action) => normalizeGovernedSkillKey(action.skillId))));
  if (skillIds.length !== 1) {
    governanceError(400, 'INVALID_SKILL_MANIFEST', 'A Skill Creator proposal must target exactly one skill');
  }
  const skillId = skillIds[0];
  const createAction = actions.find((action) => action.type === 'create_skill');
  const contextFiles = new Map(
    availableContextFiles.map((file) => [file.fileId, file]),
  );
  const files: NonNullable<DraftMutation['files']> = [];
  const deletePaths: string[] = [];

  for (const action of actions) {
    if (action.type === 'upsert_text') {
      files.push({ path: action.path, content: action.content, encoding: 'utf-8' });
    } else if (action.type === 'upload_binary_from_context') {
      const contextFile = contextFiles.get(action.contextFileId);
      if (!contextFile) {
        governanceError(404, 'SKILL_RESOURCE_NOT_FOUND', 'A selected Skill Creator context file is no longer available');
        continue;
      }
      files.push({
        path: action.targetPath,
        content: (await fs.readFile(contextFile.absolutePath)).toString('base64'),
        encoding: 'base64',
      });
    } else if (action.type === 'delete_file') {
      deletePaths.push(action.path);
    }
  }

  return {
    proposedSkillKey: skillId,
    displayName: createAction?.name?.trim() || undefined,
    description: createAction?.description?.trim() || undefined,
    files,
    deletePaths,
  };
}
