import { createHash } from 'crypto';
import type { Knex } from 'knex';

export type NotificationInput = {
  recipientUserId: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  eventKey: string;
  payload: Record<string, unknown>;
};

// Stable UUIDs make retries and repeated run-status reads idempotent.
export function notificationId(input: Pick<NotificationInput, 'recipientUserId' | 'eventType' | 'eventKey'>): string {
  const hash = createHash('sha256').update(JSON.stringify([
    input.recipientUserId, input.eventType, input.eventKey,
  ])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function createNotification(db: Knex, input: NotificationInput) {
  const { eventKey: _eventKey, ...row } = input;
  await db('notifications').insert({ id: notificationId(input), ...row }).onConflict('id').ignore();
}

export class NotificationService {
  constructor(private db: Knex) {}

  async list(userId: string, unreadOnly = false) {
    const query = this.db('notifications').where({ recipientUserId: userId });
    if (unreadOnly) query.whereNull('readAt');
    const [notifications, count] = await Promise.all([
      query.orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(100),
      this.db('notifications').where({ recipientUserId: userId }).whereNull('readAt').count('* as count').first(),
    ]);
    return { notifications, unreadCount: Number(count?.count || 0) };
  }

  async markRead(userId: string, id?: string) {
    const query = this.db('notifications').where({ recipientUserId: userId }).whereNull('readAt');
    if (id) query.where({ id });
    await query.update({ readAt: this.db.fn.now() });
  }

  async notifyRun(runId: string, meta: Record<string, string>) {
    if (!meta.userId || !meta.workspaceId) return;
    const feedback = meta.status === 'awaiting_approval';
    if (!feedback && meta.status !== 'completed') return;
    const context = meta.runContext ? JSON.parse(meta.runContext) : {};
    const interrupt = meta.pendingInterrupt ? JSON.parse(meta.pendingInterrupt) : {};
    await createNotification(this.db, {
      recipientUserId: meta.userId,
      eventType: feedback ? 'agent.feedback_required' : 'agent.completed',
      resourceType: 'agent_run',
      resourceId: runId,
      eventKey: feedback ? `${runId}:${interrupt.interruptId || meta.pendingInterrupt}` : runId,
      payload: {
        title: feedback ? 'Agent needs your feedback' : 'Agent finished your task',
        description: feedback ? (interrupt.title || interrupt.description || 'Open the task to continue.') : (meta.sharedTeamChannel === 'true' ? 'Your team chat task is ready.' : typeof context.prompt === 'string' ? context.prompt.slice(0, 500) : 'Your task is ready.'),
        workspaceId: meta.workspaceId,
        conversationId: context.conversationId,
        runId,
        messageId: meta.sharedTeamChannel === 'true' && meta.turnId?.startsWith('team:') ? meta.turnId.slice(5) : undefined,
        channel: meta.sharedTeamChannel === 'true' ? 'team' : 'agent',
      },
    });
  }
}
