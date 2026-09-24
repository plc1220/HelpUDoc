import { parseComposerDirective } from '@helpudoc/contracts/composerDirectives';

import { HttpError } from '../errors';
import {
  loadRuntimeMcpServers,
  type createAgentPolicyApi,
  type EffectiveAgentPolicy,
} from '../api/agent/policy';
import { runAgent } from './agentService';
import type {
  WorkspaceTeamAgentHistoryMessage,
  WorkspaceTeamMessage,
} from './workspaceCollaborationService';
import type { WorkspaceService, WorkspaceRole } from './workspaceService';
import type { UserService } from './userService';
import type { FileService } from './fileService';
import type { KnowledgeService } from './knowledgeService';
import type { WorkspaceRunLeaseManager } from './agent-runs/workspaceRunLease';

/**
 * A `/skill` or `/mcp` a member typed in the shared channel.
 *
 * The agent can parse these itself, but Shared Chat prepends its channel
 * preamble, so a directive typed by a member never survives into the text the
 * agent reads. Pulling it out here and re-emitting it as a
 * `<<<HELPUDOC_DIRECTIVE` block -- which the agent matches at the start of the
 * text regardless of what follows -- keeps the member's choice intact.
 */
export type SharedChatDirective =
  | { kind: 'skill'; skillId: string }
  | { kind: 'mcp'; serverId: string };

type AgentPolicyApi = ReturnType<typeof createAgentPolicyApi>;

const KB_MENTION = /@kb:([^\n]+)/gi;

export const parseSharedChatDirective = (
  text: string,
): { directive: SharedChatDirective | null; question: string } => {
  // The same parser the private composer uses, so a member who tags a knowledge
  // base before the skill gets the skill either way. This used to accept only a
  // leading directive, which matched private chat's behaviour at the time --
  // both were wrong in the same way.
  const parsed = parseComposerDirective(text);
  if (!parsed) {
    return { directive: null, question: String(text || '').trim() };
  }
  return {
    directive: parsed.kind === 'skill'
      ? { kind: 'skill', skillId: parsed.id }
      : { kind: 'mcp', serverId: parsed.id },
    question: parsed.prompt,
  };
};

/**
 * Text a member tagged with `@kb:<name>`, up to the end of the line.
 *
 * A base name may contain spaces and the mention is followed by ordinary prose,
 * so nothing in the message marks where the name stops. The candidate is
 * deliberately over-long: `resolveKnowledgeBaseIdsByMention` decides the
 * boundary by matching the longest base name the person can actually read.
 */
export const parseKnowledgeBaseMentions = (text: string): string[] => {
  const candidates = new Set<string>();
  for (const match of String(text || '').matchAll(KB_MENTION)) {
    const candidate = (match[1] || '').trim();
    if (candidate) candidates.add(candidate);
  }
  return Array.from(candidates);
};

/**
 * What Shared Chat asks `buildAgentAuthToken` for.
 *
 * Separated from `respond` so the rule can be asserted without standing up an
 * agent run, because getting it wrong is silent: the `/` menu keeps offering
 * skills and the channel keeps refusing them.
 *
 * The allow-list is the member's entitlement set, exactly as a private run in
 * the same workspace sends. Shared Chat used to derive its own from workspace
 * skill pins alone, and a workspace with no pins yields an empty list -- which
 * `is_skill_allowed` reads as "deny everything", not as "no filter". So every
 * skill a member picked here was refused.
 *
 * Private skill drafts stay out by construction rather than by a check of our
 * own: `buildAgentAuthToken` merges them only when `workspaceMode` is
 * `private`, and this is always `shared_live`.
 */
export const buildSharedChannelTokenRequest = (input: {
  entitledSkillIds: string[];
  workspaceRole: WorkspaceRole;
  canWriteSharedWorkspace: boolean;
  deniedMcpServerIds: string[];
}): {
  policy: EffectiveAgentPolicy;
  skipPlanApprovals: true;
  sharedTeamChannel: true;
} => ({
  policy: {
    isAdmin: false,
    skillAllowIds: input.entitledSkillIds,
    // The shared channel reaches no connection, so every configured server is
    // denied outright rather than merely left un-allowed.
    mcpServerAllowIds: [],
    mcpServerDenyIds: input.deniedMcpServerIds,
    workspaceMode: 'shared_live',
    workspaceRole: input.workspaceRole,
    // Narrower than the workspace policy's own answer: Freeflow only.
    canWriteWorkspace: input.canWriteSharedWorkspace,
  },
  // A plan gate has nowhere to ask here. There is no interrupt surface in the
  // channel, so a gated skill would run, write its plan, stop on
  // `request_plan_approval` and surface as a 502 with the work half done.
  // Skipping the gate is what makes those skills usable at all; a member who
  // wants to review the plan asks in private chat.
  skipPlanApprovals: true,
  sharedTeamChannel: true,
});

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

/**
 * Roles that end the current turn's slice of the transcript.
 *
 * `/chat` returns the whole agent state, and Shared Chat sends prior turns in
 * `history`, so the message list holds earlier assistant replies as well as this
 * turn's. Everything before the last question belongs to an earlier turn.
 */
const TURN_BOUNDARY_ROLES = new Set(['user', 'human', 'humanmessage']);
const ASSISTANT_ROLES = new Set(['assistant', 'ai', 'aimessage']);

const messageRole = (message: Record<string, unknown>): string => String(
  message.role
  || message.type
  || message._type
  || '',
).toLowerCase();

export const extractAgentReplyText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;

  if (record.reply !== undefined) {
    const reply = extractAgentReplyText(record.reply);
    if (reply) return reply;
  }

  if (Array.isArray(record.messages)) {
    // Stop at the current turn's question. A turn that ends without usable text
    // -- it stopped on a tool call, or the tool it reached for was denied -- used
    // to fall through to the previous turn's reply, which then reached the shared
    // channel as an answer to a question nobody had just asked. Returning nothing
    // is correct here: the caller raises "Lumo did not return a readable
    // response", and an honest error beats a confidently stale answer.
    for (let index = record.messages.length - 1; index >= 0; index -= 1) {
      const message = record.messages[index];
      if (!message || typeof message !== 'object') continue;
      const messageRecord = message as Record<string, unknown>;
      const role = messageRole(messageRecord);
      if (TURN_BOUNDARY_ROLES.has(role)) break;
      if (role && !ASSISTANT_ROLES.has(role)) continue;
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
  private readonly knowledgeService: KnowledgeService;
  private readonly policyApi: AgentPolicyApi;

  constructor(
    workspaceService: WorkspaceService,
    userService: UserService,
    fileService: FileService,
    workspaceRunLease: WorkspaceRunLeaseManager,
    knowledgeService: KnowledgeService,
    policyApi: AgentPolicyApi,
  ) {
    this.workspaceService = workspaceService;
    this.userService = userService;
    this.fileService = fileService;
    this.workspaceRunLease = workspaceRunLease;
    this.knowledgeService = knowledgeService;
    this.policyApi = policyApi;
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

    const configuredServers = await loadRuntimeMcpServers();
    const deniedMcpServerIds = Array.from(new Set(
      configuredServers
        .map((server) => String(server.name || '').trim())
        .filter(Boolean),
    )).sort();
    const authToken = await this.policyApi.buildAgentAuthToken({
      userId,
      workspaceId,
      ...buildSharedChannelTokenRequest({
        entitledSkillIds: promptAccess.skillIds,
        workspaceRole: workspacePolicy.workspaceRole,
        canWriteSharedWorkspace,
        deniedMcpServerIds,
      }),
    });
    if (!authToken) {
      throw new HttpError(503, 'ARIA shared-channel policy signing is not configured');
    }

    const addressed = sourceMessage.body
      // Strip the address so the agent reads the question, not the mention.
      // Both spellings, for the same reason the parser accepts both.
      .replace(/(^|\s)@(aria|lumo)\b[:,]?/ig, '$1')
      .trim();
    const { directive, question } = parseSharedChatDirective(addressed);
    // Resolved against the asker, never the workspace: a base is usable because
    // this person may read it, and asking in a shared channel must not lend their
    // access to everyone who can see the thread.
    const knowledgeBaseIds = await this.knowledgeService.resolveKnowledgeBaseIdsByMention(
      userId,
      parseKnowledgeBaseMentions(addressed),
    );
    const knowledgeRefs = knowledgeBaseIds.length
      ? await this.knowledgeService.resolveKnowledgeBaseRefs(userId, knowledgeBaseIds)
      : [];
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
      ...(knowledgeRefs.length
        ? [[
          'Tagged Knowledge bundles (the only Knowledge scope for this turn):',
          ...knowledgeRefs.map((ref) => `- ${ref.title} (knowledge://${ref.id}/index.md)`),
          'Use knowledge_read or knowledge_search only within these selected bundles.',
        ].join('\n')]
        : []),
      `Question from ${sourceMessage.authorName}: ${question || sourceMessage.body}`,
    ].join('\n\n');
    // The agent matches this block at the start of the text and treats the rest,
    // preamble included, as the prompt. That is why the directive survives here
    // when a bare `/skill` line does not.
    const directedPrompt = directive
      ? `<<<HELPUDOC_DIRECTIVE\n${JSON.stringify(directive)}\n>>>\n${prompt}`
      : prompt;
    const agentHistory = history.map((message) => ({
      role: message.role,
      content: message.role === 'user'
        ? `${message.authorName}: ${message.content}`
        : message.content,
    }));

    const runTurn = () => runAgent('fast', workspaceId, directedPrompt, agentHistory, {
      forceReset: true,
      authToken,
      internetSearchEnabled: false,
      knowledgeRefs,
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
