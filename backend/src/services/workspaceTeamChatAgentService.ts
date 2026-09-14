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
import type { FileService } from './fileService';
import type { WorkspaceRunLeaseManager } from './agent-runs/workspaceRunLease';

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
  private readonly fileService: FileService;
  private readonly workspaceRunLease: WorkspaceRunLeaseManager;

  constructor(
    workspaceService: WorkspaceService,
    userService: UserService,
    fileService: FileService,
    workspaceRunLease: WorkspaceRunLeaseManager,
  ) {
    this.workspaceService = workspaceService;
    this.userService = userService;
    this.fileService = fileService;
    this.workspaceRunLease = workspaceRunLease;
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
      throw new HttpError(503, 'ARIA shared-channel policy signing is not configured');
    }

    const question = sourceMessage.body
      // Strip the address so the agent reads the question, not the mention.
      // Both spellings, for the same reason the parser accepts both.
      .replace(/(^|\s)@(aria|lumo)\b[:,]?/ig, '$1')
      .trim();
    const workingVersionLabel = 'the current Shared working version';
    const writeInstruction = canWriteSharedWorkspace
      ? 'You may edit Shared workspace files and folders when the request requires it. Apply the same workspace permissions, concurrency, revision-history, attribution, and audit rules as a human Freeflow edit.'
      : 'You are read-only in the Shared workspace. Do not edit files, write workspace content, create tasks or proposals, use personal credentials, run write-capable MCP actions, or cause external side effects.';
    const prompt = [
      'You are Lumo responding inside a shared HelpUdoc Workspace Chat.',
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

    const runTurn = () => runAgent('fast', workspaceId, prompt, agentHistory, {
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

    const result = canWriteSharedWorkspace
      ? await this.runTurnAndCommitArtifacts(workspaceId, userId, sourceMessage, runTurn)
      : await runTurn();

    const reply = extractAgentReplyText(result);
    if (!reply) {
      throw new HttpError(502, 'Lumo did not return a readable response');
    }
    return reply;
  }

  /**
   * Run a writing turn the way an agent run does, so what it writes survives.
   *
   * The agent only ever writes to the workspace directory on disk; a separate
   * commit is what turns that into workspace files. Shared Chat answered without
   * one, so Lumo would truthfully report creating a file that never reached the
   * files table — and the next agent run's mirror reconcile deleted it, because
   * reconcile removes anything on disk the table does not know about.
   *
   * Read-only shared chat does not come here. Its mutating tools are refused by
   * the agent's own guard, so there is nothing to commit, and committing anyway
   * would be a way around the policy rather than a fix.
   */
  private async runTurnAndCommitArtifacts(
    workspaceId: string,
    userId: string,
    sourceMessage: WorkspaceTeamMessage,
    runTurn: () => Promise<unknown>,
  ): Promise<unknown> {
    // Namespaced so it cannot collide with a run id, and stable per message so
    // a file this turn writes can be traced back to the question that asked.
    const holderId = `team-chat:${sourceMessage.id}`;
    const controller = new AbortController();
    const assertLeaseOwned = () => this.workspaceRunLease.assertOwned(holderId);

    // One writer per workspace, the same lock agent runs take. Shared Chat keeps
    // no run record, so the lease is held for this call rather than tied to a
    // run status that does not exist.
    await this.workspaceRunLease.acquire(holderId, workspaceId, controller, {
      requireRunStatus: false,
    });
    try {
      // Bring the directory in line with the files table first, so the agent
      // reads the current Shared content rather than whatever was last left.
      await this.fileService.reconcileWorkspaceMirror(workspaceId, userId, assertLeaseOwned);
      const baseline = await this.fileService.captureWorkspaceArtifactBaseline(workspaceId, userId);

      const result = await runTurn();

      await this.fileService.commitWorkspaceArtifacts(workspaceId, userId, holderId, {
        baseline,
        assertLeaseOwned,
        runContext: {
          conversationId: null,
          turnId: sourceMessage.id,
          langfuseTraceId: null,
        },
      });
      return result;
    } catch (error) {
      // The caller persists Lumo's reply only after this resolves, so throwing
      // is what keeps a false "I created it" out of the channel. Better a
      // visible failure than a message the workspace cannot back up.
      if (error instanceof HttpError) throw error;
      const detail = error instanceof Error ? error.message : 'unknown storage error';
      throw new HttpError(502, `Lumo could not save its workspace changes: ${detail}`);
    } finally {
      await this.workspaceRunLease.release(holderId);
    }
  }
}
