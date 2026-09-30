import type { Env } from '../env';
import { newId } from './ids';

export type NotificationType =
  | 'follow' | 'friend_request' | 'friend_accept' | 'reaction' | 'reply' | 'repost' | 'quote'
  | 'mention' | 'wall_post' | 'group_join' | 'group_post' | 'story_view' | 'system'
  | 'event_invite' | 'event_host' | 'event_cancelled' | 'event_comment' | 'event_reminder';

export interface NotifyInput {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  postId?: string | null;
  groupId?: string | null;
  body?: string | null;
  /** Same-origin path the notification opens, for targets that aren't posts or groups. */
  link?: string | null;
}

/** Statement that records a notification (skips notifying yourself). Use in a batch. */
export function notifyStatement(env: Env, n: NotifyInput, now = Date.now()): D1PreparedStatement | null {
  if (n.actorId && n.actorId === n.userId) return null;
  return env.DB.prepare(`INSERT INTO notifications (id, user_id, actor_id, type, post_id, group_id, body, link, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(now), n.userId, n.actorId ?? null, n.type, n.postId ?? null, n.groupId ?? null, n.body ?? null, n.link ?? null, now);
}

export async function notify(env: Env, ...items: NotifyInput[]): Promise<void> {
  const statements = items.map(n => notifyStatement(env, n)).filter((s): s is D1PreparedStatement => Boolean(s));
  if (statements.length) await env.DB.batch(statements);
}
