import type { Env } from '../env';
import { placeholders } from './http';

export interface UserRow {
  id: string;
  handle: string;
  name: string;
  avatar_media_id: string | null;
  identity_picture: string | null;
  verified: number;
}

/** Columns needed for userCard(); prefix with a table alias if you need one. */
export const userCardColumns = 'id, handle, name, avatar_media_id, identity_picture, verified';

export const avatarUrl = (u: Pick<UserRow, 'avatar_media_id' | 'identity_picture'>): string | null =>
  u.avatar_media_id ? `/media/${u.avatar_media_id}` : u.identity_picture || null;

/** The small user shape embedded everywhere (post authors, followers, members…). */
export const userCard = (u: UserRow) => ({
  id: u.id,
  handle: u.handle,
  name: u.name,
  avatar_url: avatarUrl(u),
  verified: Boolean(u.verified),
});
export type UserCard = ReturnType<typeof userCard>;

export async function userCards(env: Env, ids: string[]): Promise<Map<string, UserCard>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { results } = await env.DB.prepare(`SELECT ${userCardColumns} FROM users WHERE id IN (${placeholders(unique.length)})`)
    .bind(...unique).all<UserRow>();
  return new Map(results.map(u => [u.id, userCard(u)]));
}

export async function userByHandle(env: Env, handle: string) {
  return env.DB.prepare('SELECT * FROM users WHERE handle = ?').bind(handle.replace(/^@/, '')).first<UserRow & Record<string, unknown>>();
}

/** Are these two people friends (accepted friendship either way round)? */
export async function areFriends(env: Env, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const row = await env.DB.prepare(`SELECT 1 FROM friendships WHERE status = 'accepted'
    AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`).bind(a, b, b, a).first();
  return Boolean(row);
}
