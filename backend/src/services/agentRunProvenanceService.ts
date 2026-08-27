import type { Knex } from 'knex';

import { jsonbParam } from '../lib/jsonb';

/**
 * Durable record of what a agent run was asked to do and what it produced.
 *
 * The run's enriched prompt, declared knowledge refs and history otherwise live
 * only in Redis under `agent:run:<id>:meta` with a 24 hour TTL, so a file
 * written by an agent loses the reason it exists a day later. A skeleton row is
 * written when the run starts (not when it finishes) so the prompt survives even
 * if the run crashes and never reaches finalize.
 */

/** Prompts and responses can be unbounded; cap them and record that we did. */
export const MAX_TEXT_BYTES = 64 * 1024;

export interface RunSkillInvocation {
  skillId: string;
  loadedAt: string;
}

export interface RunKnowledgeChunk {
  path: string;
  title?: string | null;
  snapshotId?: string | null;
  score?: number | null;
  sourceLocations?: unknown[];
}

export interface RunProvenanceStartInput {
  runId: string;
  workspaceId: string;
  userId?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  persona?: string | null;
  userPrompt?: string | null;
  enrichedPrompt?: string | null;
  knowledgeRefsDeclared?: unknown[];
  taggedFileRefs?: unknown[];
}

export interface RunProvenanceFinishInput {
  runId: string;
  status?: string | null;
  responseText?: string | null;
  skillsInvoked?: RunSkillInvocation[];
  knowledgeChunksRetrieved?: RunKnowledgeChunk[];
  langfuseTraceId?: string | null;
  langfuseTraceUrl?: string | null;
  conversationMessageId?: number | null;
  /** Used to resolve the agent's message id when it is not supplied directly. */
  conversationId?: string | null;
  turnId?: string | null;
}

export function truncateText(
  value: string | null | undefined,
): { text: string | null; truncated: boolean } {
  if (!value) return { text: null, truncated: false };
  if (Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES) {
    return { text: value, truncated: false };
  }
  // Slice on bytes, then drop any partial trailing character.
  const clipped = Buffer.from(value, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8');
  return { text: clipped.replace(/�$/, ''), truncated: true };
}

/**
 * Pulls retrieved knowledge chunks out of a `knowledge_search` /
 * `knowledge_read` tool result.
 *
 * The agent returns these as a JSON string inside the tool_end event; there is
 * no structured stream event for retrieval. Parsing is therefore best effort and
 * must never throw — losing a provenance detail is acceptable, failing a user's
 * agent run over it is not.
 */
export function collectKnowledgeChunks(
  content: string,
  into: RunKnowledgeChunk[],
): RunKnowledgeChunk[] {
  const push = (candidate: any) => {
    const path = typeof candidate?.path === 'string' ? candidate.path : '';
    if (!path) return;
    // The same passage is often returned by both search and a follow-up read.
    if (into.some((entry) => entry.path === path
      && (entry.snapshotId ?? null) === (candidate.snapshotId ?? null))) return;
    into.push({
      path,
      title: typeof candidate.title === 'string' ? candidate.title : null,
      snapshotId: typeof candidate.snapshotId === 'string' ? candidate.snapshotId : null,
      score: typeof candidate.score === 'number' ? candidate.score : null,
      sourceLocations: Array.isArray(candidate.sourceLocations) ? candidate.sourceLocations : undefined,
    });
  };

  try {
    const parsed = JSON.parse(content);
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.matches)
          ? parsed.matches
          : [parsed];
    for (const candidate of candidates) push(candidate);
  } catch {
    // Not JSON, or a shape we do not recognise. Leave the list untouched.
  }
  return into;
}

export class AgentRunProvenanceService {
  constructor(private readonly db: Knex) {}

  /** Called as the run is queued, so the prompt is durable from t=0. */
  async recordRunStart(input: RunProvenanceStartInput): Promise<void> {
    const userPrompt = truncateText(input.userPrompt);
    const enrichedPrompt = truncateText(input.enrichedPrompt);
    await this.db('agent_run_provenance')
      .insert({
        runId: input.runId,
        workspaceId: input.workspaceId,
        userId: input.userId || null,
        conversationId: input.conversationId || null,
        turnId: input.turnId || null,
        persona: input.persona || null,
        userPrompt: userPrompt.text,
        enrichedPrompt: enrichedPrompt.text,
        // These are arrays, which the pg driver would otherwise turn into a
        // Postgres array literal and Postgres would reject as invalid json.
        knowledgeRefsDeclared: jsonbParam(this.db, input.knowledgeRefsDeclared ?? []),
        taggedFileRefs: jsonbParam(this.db, input.taggedFileRefs ?? []),
        truncated: jsonbParam(this.db, {
          userPrompt: userPrompt.truncated,
          enrichedPrompt: enrichedPrompt.truncated,
        }),
        status: 'queued',
      })
      // A resumed run re-enters startAgentRun; keep the original prompt.
      .onConflict('runId')
      .ignore();
  }

  /** Called at finalize with everything only the stream could tell us. */
  async recordRunFinish(input: RunProvenanceFinishInput): Promise<void> {
    const responseText = truncateText(input.responseText);
    const patch: Record<string, unknown> = {
      status: input.status || null,
      updatedAt: this.db.fn.now(),
    };
    if (input.responseText !== undefined) patch.responseText = responseText.text;
    if (input.skillsInvoked) {
      patch.skillsInvoked = jsonbParam(this.db, input.skillsInvoked);
    }
    if (input.knowledgeChunksRetrieved) {
      patch.knowledgeChunksRetrieved = jsonbParam(this.db, input.knowledgeChunksRetrieved);
    }
    if (input.langfuseTraceId) patch.langfuseTraceId = input.langfuseTraceId;
    if (input.langfuseTraceUrl) patch.langfuseTraceUrl = input.langfuseTraceUrl;

    // The agent's message is written by a separate path, so resolve it here
    // rather than threading the id through the worker. Left null if the message
    // has not landed yet; the trail still reaches the transcript via runId.
    let conversationMessageId = input.conversationMessageId ?? null;
    if (!conversationMessageId && input.conversationId && input.turnId) {
      const message = await this.db('conversation_messages')
        .select('id')
        .where({ conversationId: input.conversationId, turnId: input.turnId, sender: 'agent' })
        .first();
      if (message?.id) conversationMessageId = Number(message.id);
    }
    if (conversationMessageId) patch.conversationMessageId = conversationMessageId;

    const existing = await this.db('agent_run_provenance')
      .where({ runId: input.runId })
      .first();
    if (!existing) return;

    if (responseText.truncated) {
      patch.truncated = jsonbParam(this.db, {
        ...(existing.truncated || {}),
        responseText: true,
      });
    }
    await this.db('agent_run_provenance').where({ runId: input.runId }).update(patch);
  }

  async getByRunIds(runIds: string[]): Promise<Record<string, any>> {
    if (!runIds.length) return {};
    const rows = await this.db('agent_run_provenance').whereIn('runId', runIds);
    const byRunId: Record<string, any> = {};
    for (const row of rows) byRunId[String(row.runId)] = row;
    return byRunId;
  }
}
