import { HTTPException } from 'hono/http-exception';
import type { Ctx, SessionUser } from '../env';

/** Throw from anywhere in a handler; the app turns it into `{ error }` JSON. */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503, message: string): never {
  throw new HTTPException(status, { message });
}

/** The signed-in user, or a 401. */
export function requireUser(c: Ctx): SessionUser {
  const user = c.get('user');
  if (!user) fail(401, 'Sign in with Southbag Identity to do that.');
  return user;
}

export async function body<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

/** Trimmed string from untrusted input, cut to `max` characters. */
export function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Page size from `?limit=`, clamped. */
export function limit(c: Ctx, fallback = 20, max = 50): number {
  const n = Number(c.req.query('limit'));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Opaque cursor from `?cursor=` (IDs are time-sortable, so the last id works). */
export const cursor = (c: Ctx): string | null => c.req.query('cursor') || null;

/** Standard paged response: `{ items, next }`. Fetch `limit + 1` rows and pass them here. */
export function page<T extends { id: string }>(rows: T[], size: number): { items: T[]; next: string | null } {
  const items = rows.slice(0, size);
  return { items, next: rows.length > size ? items[items.length - 1].id : null };
}

/** `?` placeholders for an IN (...) list. */
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
