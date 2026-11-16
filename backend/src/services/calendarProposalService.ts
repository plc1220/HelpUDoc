import { createHash, randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { CalendarService } from './calendarService';
import { CalendarError, eventInput, eventRef, parseEventRef, providerBody, type EventInput } from './calendarModel';
import type { WorkspaceService } from './workspaceService';
import { calendarTelemetry } from './calendarTelemetry';

type CalendarItem = Awaited<ReturnType<CalendarService['event']>>;
type Method = 'POST' | 'PATCH' | 'DELETE';
type Proposal = {
  id: string; workspace_id: string; method: Method; selected_event_ref: string;
  event_ref?: string; input: EventInput; before?: CalendarItem; event_etag?: string;
  status: 'PENDING' | 'APPLYING' | 'APPLIED' | 'REJECTED'; expires_at: string; review_url: string;
  request_hash: string; result?: unknown;
  approved_input?: EventInput; approved_etag?: string; approved_hash?: string;
  attempt_lease_id?: string; attempt_lease_until?: string;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ATTEMPT_LEASE_MS = 120_000;

/** Agent tools create reviewable proposals. Only the authenticated UI can approve
 * them; agent assertions of approval never authorize a provider mutation. */
export class CalendarProposalService {
  constructor(private db: Knex, private calendar: CalendarService, private workspaces: Pick<WorkspaceService, 'ensureMembership'>) {}

  async propose(userId: string, workspaceId: string, selectedRef: string, method: Method, rawInput: unknown, key: string) {
    if (!/^[\w-]{8,128}$/.test(key)) throw new CalendarError(400, 'IDEMPOTENCY_REQUIRED', 'A valid action key is required');
    await this.workspaces.ensureMembership(workspaceId, userId);
    const input = eventInput.parse(rawInput);
    const requestHash = digest({ workspaceId, selectedRef, method, input });
    const [calendarId] = parseEventRef(selectedRef);
    await this.calendar.authorizeSource(userId, calendarId, true);
    let before = await this.calendar.event(userId, selectedRef);
    if (!before.capabilities.can_edit) throw new CalendarError(403, 'PERMISSION_DENIED', 'This calendar is read-only');
    if (input.calendar_id && input.calendar_id !== calendarId) throw new CalendarError(403, 'POLICY_DENIED', 'The proposal must use the selected calendar');
    if (method !== 'POST' && input.scope === 'series' && before.recurring_event_id) before = await this.calendar.event(userId, eventRef(calendarId, before.recurring_event_id));
    const validated = eventInput.parse({ ...input, calendar_id: calendarId });
    if (method === 'POST') providerBody(validated);
    // No connection is held while provider/ACL calls run. This transaction only
    // serializes immutable proposal creation and its audit record.
    return this.db.transaction(async tx => {
      await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`calendar-proposal:${userId}:${key}`]);
      const existing = await tx('calendar_proposals').where({ userId, resource: key }).first();
      if (existing) {
        if (existing.data.request_hash !== requestHash) throw new CalendarError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to another proposed action');
        return existing.data as Proposal;
      }
      const id = randomUUID();
      const proposal: Proposal = {
        id, workspace_id: workspaceId, method, selected_event_ref: selectedRef,
        ...(method !== 'POST' ? { event_ref: before.id, event_etag: before.etag } : {}),
        input: validated, before, status: 'PENDING', expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        review_url: `/?calendar=open&calendar_proposal=${id}`, request_hash: requestHash,
      };
      await tx('calendar_proposals').insert({ id, userId, resource: key, data: JSON.stringify(proposal) });
      calendarTelemetry.recordSignal('agent_proposal_created');
      await tx('calendar_audit').insert({ id: randomUUID(), userId, resource: selectedRef, data: JSON.stringify({ action: 'propose', actor_kind: 'AGENT', proposal_id: id, workspace_id: workspaceId, method, policy_result: 'AWAITING_HUMAN_REVIEW', at: new Date().toISOString() }) });
      return proposal;
    });
  }

  private async load(userId: string, id: string): Promise<Proposal> {
    const row = await this.db('calendar_proposals').where({ id, userId }).first();
    if (!row) throw new CalendarError(404, 'NOT_FOUND', 'Calendar proposal is unavailable');
    const proposal = row.data as Proposal;
    await this.workspaces.ensureMembership(proposal.workspace_id, userId);
    await this.calendar.authorizeSource(userId, parseEventRef(proposal.selected_event_ref)[0], true);
    return proposal;
  }

  async get(userId: string, id: string): Promise<Proposal> {
    const proposal = await this.load(userId, id);
    // Never disclose an old proposal's meeting details after grant/ACL revocation.
    try { await this.calendar.event(userId, proposal.selected_event_ref); }
    catch (error) {
      if (['APPLIED', 'APPLYING'].includes(proposal.status) && error instanceof CalendarError && error.status === 404) return { ...proposal, before: undefined, input: proposal.approved_input || eventInput.parse({}), event_etag: proposal.approved_etag, result: proposal.status === 'APPLIED' && proposal.method === 'DELETE' ? { deleted: true } : undefined };
      throw error;
    }
    return proposal.status === 'APPLYING' ? { ...proposal, input: proposal.approved_input!, event_etag: proposal.approved_etag } : proposal;
  }

  async reject(userId: string, id: string) {
    const proposal = await this.load(userId, id);
    if (proposal.status === 'REJECTED') return { rejected: true };
    const changed = await this.db('calendar_proposals').where({ id, userId }).whereRaw("data->>'status' = 'PENDING'").update({ data: this.db.raw("jsonb_set(data, '{status}', '\"REJECTED\"'::jsonb)"), updatedAt: this.db.fn.now() });
    if (!changed) throw new CalendarError(409, 'ACTION_ALREADY_APPROVED', 'This action has already been approved or applied');
    calendarTelemetry.recordSignal('agent_proposal_rejected');
    return { rejected: true };
  }

  async commit(userId: string, id: string, reviewedInput: unknown, reviewedEtag?: string) {
      let proposal = await this.load(userId, id);
      if (proposal.status === 'REJECTED') throw new CalendarError(409, 'POLICY_DENIED', 'This proposal was rejected');
      if (proposal.status === 'PENDING' && Date.parse(proposal.expires_at) < Date.now()) throw new CalendarError(409, 'PROPOSAL_EXPIRED', 'This proposal expired. Ask for a fresh proposal.');
      const input = eventInput.parse(reviewedInput);
      const [calendarId] = parseEventRef(proposal.selected_event_ref);
      if (input.calendar_id && input.calendar_id !== calendarId) throw new CalendarError(403, 'POLICY_DENIED', 'The reviewed calendar must match the proposal');
      // Scope changes require a fresh proposal and a fresh series/occurrence review.
      if (input.scope !== proposal.input.scope) throw new CalendarError(409, 'POLICY_DENIED', 'Review a new proposal to change its recurring scope');
      const approvedInput = eventInput.parse({ ...input, calendar_id: calendarId });
      const approvedHash = digest({ input: approvedInput, etag: reviewedEtag });
      if (proposal.status === 'APPLIED') {
        if (proposal.approved_hash !== approvedHash) throw new CalendarError(409, 'ACTION_ALREADY_APPROVED', 'This proposal applied a different reviewed payload. Create a new proposal for another change.');
        return proposal.result;
      }
      if (proposal.status === 'APPLYING' && proposal.approved_hash !== approvedHash) throw new CalendarError(409, 'ACTION_ALREADY_APPROVED', 'Retry the same reviewed action. A different change needs a fresh proposal.');
      const leaseId = randomUUID();
      const lease = { attempt_lease_id: leaseId, attempt_lease_until: new Date(Date.now() + ATTEMPT_LEASE_MS).toISOString() };
      const approval = { status: 'APPLYING', approved_input: approvedInput, approved_etag: reviewedEtag, approved_hash: approvedHash, ...lease };
      const claimed = await this.db('calendar_proposals').where({ id, userId }).whereRaw("data->>'status' = 'PENDING'").update({ data: this.db.raw('data || ?::jsonb', [JSON.stringify(approval)]), updatedAt: this.db.fn.now() });
      if (!claimed) {
        proposal = await this.load(userId, id);
        if (proposal.status === 'APPLIED' && proposal.approved_hash === approvedHash) return proposal.result;
        if (proposal.status !== 'APPLYING' || proposal.approved_hash !== approvedHash) throw new CalendarError(409, 'ACTION_ALREADY_APPROVED', 'Retry the same reviewed action. A different change needs a fresh proposal.');
        // One attempt may execute the approved action at a time. Recovery after
        // a crashed request can claim only the same immutable approved payload.
        const recovered = await this.db('calendar_proposals').where({ id, userId })
          .whereRaw("data->>'status' = 'APPLYING' AND data->>'approved_hash' = ?", [approvedHash])
          .whereRaw("(COALESCE(data->>'attempt_lease_id', '') = '' OR data->>'attempt_lease_until' IS NULL OR data->>'attempt_lease_until' <= ?)", [new Date().toISOString()])
          .update({ data: this.db.raw('data || ?::jsonb', [JSON.stringify(lease)]), updatedAt: this.db.fn.now() });
        if (!recovered) {
          const current = await this.load(userId, id);
          if (current.status === 'APPLIED' && current.approved_hash === approvedHash) return current.result;
          if (current.status !== 'APPLYING' || current.approved_hash !== approvedHash) throw new CalendarError(409, 'ACTION_ALREADY_APPROVED', 'The proposal state changed. Reload it before reviewing another action.');
          throw new CalendarError(423, 'ACTION_IN_PROGRESS', 'This approved action is still saving. Wait for confirmation before retrying.');
        }
      }
      try {
        let result: unknown;
        try { result = await this.calendar.mutate(userId, proposal.method, proposal.event_ref, approvedInput, reviewedEtag, `proposal-${id}`); }
        catch (error) {
          if (error instanceof CalendarError && error.status < 500) await this.db('calendar_proposals').where({ id, userId })
            .whereRaw("data->>'status' = 'APPLYING' AND data->>'approved_hash' = ? AND data->>'attempt_lease_id' = ?", [approvedHash, leaseId])
            .update({ data: this.db.raw("(data - 'approved_input' - 'approved_etag' - 'approved_hash' - 'attempt_lease_id' - 'attempt_lease_until') || '{\"status\":\"PENDING\"}'::jsonb"), updatedAt: this.db.fn.now() });
          throw error;
        }
        // Domain receipts remain authoritative after local finalization failure.
        // No connection is held across the provider calls above.
        await this.db.transaction(async tx => {
          const updated = await tx('calendar_proposals').where({ id, userId })
            .whereRaw("data->>'status' = 'APPLYING' AND data->>'approved_hash' = ? AND data->>'attempt_lease_id' = ?", [approvedHash, leaseId])
            .update({ data: tx.raw("(data - 'attempt_lease_id' - 'attempt_lease_until') || ?::jsonb", [JSON.stringify({ status: 'APPLIED', result })]), updatedAt: tx.fn.now() });
          if (updated) {
            calendarTelemetry.recordSignal('agent_proposal_approved');
            await tx('calendar_audit').insert({ id: randomUUID(), userId, resource: proposal.event_ref || proposal.selected_event_ref, data: JSON.stringify({ action: 'approve_and_apply', actor_kind: 'AGENT', approved_by_user_id: userId, proposal_id: id, workspace_id: proposal.workspace_id, method: proposal.method, before_etag: reviewedEtag, after_etag: (result as { etag?: string })?.etag, approved_input_hash: approvedHash, policy_result: 'HUMAN_APPROVED', at: new Date().toISOString() }) });
          }
        });
        return result;
      } finally {
        // Release only this attempt. An expired attempt cannot clear a newer
        // owner's lease or reset its status. If the database is unavailable,
        // the bounded lease still permits a later exact-payload retry.
        await this.db('calendar_proposals').where({ id, userId })
          .whereRaw("data->>'status' = 'APPLYING' AND data->>'approved_hash' = ? AND data->>'attempt_lease_id' = ?", [approvedHash, leaseId])
          .update({ data: this.db.raw("data - 'attempt_lease_id' - 'attempt_lease_until'"), updatedAt: this.db.fn.now() }).catch(() => undefined);
      }
  }
}
