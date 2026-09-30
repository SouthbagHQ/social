// Time-sortable IDs: 9 base36 chars of milliseconds + 7 random base36 chars.
// Lexicographic order == creation order, so `ORDER BY id DESC` is newest first and
// an id doubles as a pagination cursor.
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';

export function newId(now = Date.now()): string {
  const time = now.toString(36).padStart(9, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  let rand = '';
  for (const b of bytes) rand += alphabet[b % 36];
  return time + rand;
}

export const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export function base64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export const sha256 = async (value: string): Promise<string> =>
  base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
