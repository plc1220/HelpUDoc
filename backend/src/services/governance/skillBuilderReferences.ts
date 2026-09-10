import path from 'path';
import { promises as fs } from 'fs';
import type { UserService } from '../userService';
import type { KnowledgeService } from '../knowledgeService';
import type { KnowledgeBaseService } from '../knowledgeBaseService';
import type { SkillGovernanceService } from './skillGovernanceService';
import { skillsRoot } from '../skills/constants';
import { loadRuntimeMcpServers } from '../../api/agent/policy';
import { HttpError } from '../../errors';

export type BuilderReference = { kind: 'knowledge' | 'knowledge_base' | 'skill' | 'mcp'; id: string };
export type BuilderReferenceOption = BuilderReference & { name: string; description: string };
export type BuilderReferenceServices = {
  userService: UserService;
  knowledgeService: KnowledgeService;
  knowledgeBaseService: KnowledgeBaseService;
  skillGovernanceService: SkillGovernanceService;
};

export async function listBuilderReferences(userId: string, services: BuilderReferenceServices): Promise<BuilderReferenceOption[]> {
  const [access, personal, catalog, knowledge, bases, servers] = await Promise.all([
    services.userService.getEffectivePromptAccess(userId),
    services.userService.getPersonalSkillRuntimePins(userId),
    services.skillGovernanceService.catalog(userId, { limit: 100 }),
    services.knowledgeService.listAccessibleGlobal(userId),
    services.knowledgeBaseService.catalog(userId),
    loadRuntimeMcpServers(),
  ]);
  const skillIds = new Set(access?.skillIds || []);
  return [
    ...personal.map(pin => ({ kind: 'skill' as const, id: pin.skillKey, name: pin.name, description: pin.description })),
    ...(catalog.skills as any[]).filter(skill => skillIds.has(skill.skillKey)).map(skill => ({
      kind: 'skill' as const, id: skill.skillKey, name: `${skill.displayName} (${skill.ownerTeamName})`, description: skill.description || '',
    })),
    ...knowledge.map(item => ({ kind: 'knowledge' as const, id: String(item.id), name: item.title, description: item.description || '' })),
    ...bases.map(base => ({ kind: 'knowledge_base' as const, id: base.id, name: base.name, description: base.description || '' })),
    // Registry metadata only; never return credentials, headers, or connection config.
    ...servers.map(server => ({ kind: 'mcp' as const, id: server.name, name: server.name,
      description: 'Reference this registered server in the skill. Runtime access is checked separately.' })),
  ];
}

export async function resolveBuilderReferences(userId: string, requested: BuilderReference[], services: BuilderReferenceServices) {
  if (!requested.length) return [];
  const options = await listBuilderReferences(userId, services);
  const selected = requested.map(ref => {
    const option = options.find(item => item.kind === ref.kind && item.id === ref.id);
    if (!option) throw new HttpError(403, 'A selected reference is unavailable or no longer accessible');
    return option;
  });
  const access = await services.userService.getEffectivePromptAccess(userId);
  const pins = [...await services.userService.getPersonalSkillRuntimePins(userId),
    ...await services.userService.getDefaultSkillRuntimePins(access?.skillIds || [])].filter(pin => pin.available);
  const knowledge = selected.some(ref => ref.kind === 'knowledge') ? await services.knowledgeService.listAccessibleGlobal(userId) : [];
  return Promise.all(selected.map(async ref => {
    if (ref.kind === 'skill') {
      const pin = pins.find(item => item.skillKey === ref.id);
      if (!pin) throw new HttpError(403, 'The selected skill is unavailable');
      const content = await fs.readFile(path.join(skillsRoot, '.governed-versions', 'packages', pin.skillKey, pin.versionId, 'SKILL.md'), 'utf-8');
      return { ...ref, versionId: pin.versionId, manifestHash: pin.manifestHash, excerpt: content.slice(0, 16000), truncated: content.length > 16000 };
    }
    if (ref.kind === 'knowledge') {
      const item = knowledge.find(item => String(item.id) === ref.id);
      if (!item) throw new HttpError(403, 'The selected knowledge is unavailable');
      const content = String(item.content || '');
      return { ...ref, knowledgeBaseId: (item as any).knowledgeBaseId, excerpt: content.slice(0, 16000), truncated: content.length > 16000 };
    }
    if (ref.kind === 'knowledge_base') {
      const detail = await services.knowledgeBaseService.getDetail(userId, ref.id);
      return { ...ref, version: detail.currentVersion, members: detail.members.map(member => ({ id: member.knowledgeSourceId, title: member.title })) };
    }
    return ref;
  }));
}
