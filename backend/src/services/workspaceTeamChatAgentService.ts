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
    if (workspacePolicy.workspaceMode !== 'published_read_only') {
      throw new HttpError(409, 'Team Chat Lumo is only available in published workspaces');
    }
    const promptAccess = await this.userService.getEffectivePromptAccess(userId);
    if (!promptAccess) {
      throw new HttpError(401, 'User not found');
    }

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
      skillAllowIds: promptAccess.skillIds,
      mcpServerAllowIds: [],
      mcpServerDenyIds: deniedMcpServerIds,
      workspaceMode: 'published_read_only',
      workspaceRole: workspacePolicy.workspaceRole,
      canWriteWorkspace: false,
      skipPlanApprovals: false,
      sharedTeamChannel: true,
    });
    if (!authToken) {
      throw new HttpError(503, 'Lumo shared-channel policy signing is not configured');
    }

    const question = sourceMessage.body
      .replace(/(^|\s)@lumo\b[:,]?/ig, '$1')
      .trim();
    const publishedVersionLabel = sourceMessage.originVersionNumber
      ? `Published v${sourceMessage.originVersionNumber}`
      : 'the current published version';
    const prompt = [
      'You are Lumo responding inside a shared HelpUdoc Team Chat.',
      `Your answer is read-only and must be based on ${publishedVersionLabel}.`,
      'Answer the current question directly. Follow requested brevity, and do not claim that you completed or verified an action unless the available context proves it.',
      'You may inspect published workspace files and approved knowledge to answer.',
      'Do not edit files, write workspace content, create tasks or proposals, use personal credentials, run write-capable MCP actions, or cause external side effects.',
      'If the team asks for a change, provide a suggested change in your response. A human may explicitly convert it into a governed note, task, annotation, or proposal.',
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
