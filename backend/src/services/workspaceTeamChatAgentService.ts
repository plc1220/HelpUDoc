import { HttpError } from '../errors';
import { loadRuntimeMcpServers } from '../api/agent/policy';
import { runAgent } from './agentService';
import { signAgentContextToken } from './agentToken';
import type {
  WorkspaceTeamAgentHistoryMessage,
  WorkspaceTeamMessage,
} from './workspaceCollaborationService';
import type { WorkspaceService } from './workspaceService';
import type { UserService } from './userService';

const textFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return typeof record.text === 'string'
        ? record.text
        : typeof record.content === 'string'
          ? record.content
          : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
};

export const extractAgentReplyText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;

  if (record.reply !== undefined) {
    const reply = extractAgentReplyText(record.reply);
    if (reply) return reply;
  }

  if (Array.isArray(record.messages)) {
    const messages = [...record.messages].reverse();
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const messageRecord = message as Record<string, unknown>;
      const role = String(
        messageRecord.role
        || messageRecord.type
        || messageRecord._type
        || '',
      ).toLowerCase();
      if (role && !['assistant', 'ai', 'aimessage'].includes(role)) continue;
      const content = textFromContent(messageRecord.content ?? messageRecord.text);
      if (content) return content;
    }
  }

  const directContent = textFromContent(record.content ?? record.text ?? record.output);
  if (directContent) return directContent;
  return '';
};

export class WorkspaceTeamChatAgentService {
  private readonly workspaceService: WorkspaceService;
  private readonly userService: UserService;

  constructor(workspaceService: WorkspaceService, userService: UserService) {
    this.workspaceService = workspaceService;
    this.userService = userService;
  }

  async respond(
    workspaceId: string,
    userId: string,
    sourceMessage: WorkspaceTeamMessage,
    history: WorkspaceTeamAgentHistoryMessage[],
  ): Promise<string> {
    const workspacePolicy = await this.workspaceService.getMcpServerPolicy(workspaceId, userId);
    if (workspacePolicy.workspaceMode !== 'shared_live' && workspacePolicy.workspaceMode !== 'published_read_only') {
      throw new HttpError(409, 'Shared Chat Lumo is only available in Shared workspaces');
    }
    const canWriteSharedWorkspace = workspacePolicy.workspaceMode === 'shared_live'
      && workspacePolicy.editingPolicy === 'direct'
      && workspacePolicy.canWriteWorkspace;
    const promptAccess = await this.userService.getEffectivePromptAccess(userId);
    if (!promptAccess) {
      throw new HttpError(401, 'User not found');
    }
    const workspacePins = await this.userService.getWorkspaceSkillRuntimePins(workspaceId);
    const entitledSkills = new Set(promptAccess.skillIds);
    const authorizedPins = workspacePins.filter((pin) => pin.available && entitledSkills.has(pin.skillKey));

    const configuredServers = await loadRuntimeMcpServers();
    const deniedMcpServerIds = Array.from(new Set(
      configuredServers
        .map((server) => String(server.name || '').trim())
        .filter(Boolean),
    )).sort();
    const authToken = signAgentContextToken({
      sub: userId,
      userId,
      workspaceId,
      isAdmin: false,
      skillAllowIds: authorizedPins.map((pin) => pin.skillKey),
      skillVersionPins: Object.fromEntries(authorizedPins.map((pin) => [
        pin.skillKey,
        {
          skillId: pin.skillId,
          versionId: pin.versionId,
          semanticVersion: pin.semanticVersion,
          manifestHash: pin.manifestHash,
        },
      ])),
      mcpServerAllowIds: [],
      mcpServerDenyIds: deniedMcpServerIds,
      workspaceMode: 'shared_live',
      workspaceRole: workspacePolicy.workspaceRole,
      canWriteWorkspace: canWriteSharedWorkspace,
      skipPlanApprovals: false,
      sharedTeamChannel: true,
    });
    if (!authToken) {
      throw new HttpError(503, 'Lumo shared-channel policy signing is not configured');
    }

    const question = sourceMessage.body
      .replace(/(^|\s)@lumo\b[:,]?/ig, '$1')
      .trim();
    const workingVersionLabel = 'the current Shared working version';
    const writeInstruction = canWriteSharedWorkspace
      ? 'You may edit Shared workspace files and folders when the request requires it. Apply the same workspace permissions, concurrency, revision-history, attribution, and audit rules as a human Freeflow edit.'
      : 'You are read-only in the Shared workspace. Do not edit files, write workspace content, create tasks or proposals, use personal credentials, run write-capable MCP actions, or cause external side effects.';
    const prompt = [
      'You are Lumo responding inside a shared HelpUdoc Team Chat.',
      `Your answer must be based on ${workingVersionLabel}.`,
      'Answer the current question directly. Follow requested brevity, and do not claim that you completed or verified an action unless the available context proves it.',
      'You may inspect Shared workspace files and approved knowledge to answer.',
      writeInstruction,
      canWriteSharedWorkspace
        ? 'If you make a change, report what changed and keep the response grounded in the actual tool result.'
        : 'If the team asks for a change, provide a suggested change in your response. In Review mode, the member must use a Private working copy and submit the result through the Review proposal flow.',
      `Question from ${sourceMessage.authorName}: ${question || sourceMessage.body}`,
    ].join('\n\n');
    const agentHistory = history.map((message) => ({
      role: message.role,
      content: message.role === 'user'
        ? `${message.authorName}: ${message.content}`
        : message.content,
    }));

    const result = await runAgent('fast', workspaceId, prompt, agentHistory, {
      forceReset: true,
      authToken,
      internetSearchEnabled: false,
      traceContext: {
        userId,
        workspaceId,
        persona: 'fast',
        turnId: sourceMessage.id,
      },
    });
    const reply = extractAgentReplyText(result);
    if (!reply) {
      throw new HttpError(502, 'Lumo did not return a readable response');
    }
    return reply;
  }
}
