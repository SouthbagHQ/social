// Southbag Drive™ client, acting as the signed-in user. Shared albums keep their photos and
// videos in the uploader's OWN Drive (Ingo: "it should use the users tokens"): Social holds
// each user's Identity tokens (lib/auth.ts) and calls Drive's API with them. Uploads land in
// the uploader's account; Social then opens a public share link per file, and members are
// served the bytes through that link - the share token never reaches the client, so album
// membership stays the access check.
//
// Identity tokens are bearer credentials: they are never logged and never leave the server.

import type { Env } from '../env';

export interface DriveUpload {
  id: string;
  name: string;
  size: number;
}

const driveOrigin = (env: Env): string =>
  ((env.DRIVE_ORIGIN as string | undefined) || 'https://drive.southbag.cc').replace(/\/+$/, '');

/** Streams a file into the user's own Drive. Non-OK responses come back to the caller, which
 *  maps 401 to "sign in again" and 413 to "your Drive is full". */
export async function driveUpload(
  env: Env,
  accessToken: string,
  name: string,
  contentType: string,
  body: ReadableStream | null,
  size: number,
): Promise<{ response: Response; file?: DriveUpload }> {
  const response = await fetch(`${driveOrigin(env)}/api/upload`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': contentType,
      'content-length': String(size),
      'x-sb-filename': encodeURIComponent(name),
      'x-sb-content-type': contentType,
    },
    body,
    // Node's fetch wants this hint for streaming bodies; Workers ignores it.
    ...({ duplex: 'half' } as object),
  });
  if (!response.ok) return { response };
  const file = await response.json<DriveUpload>().catch(() => null);
  if (!file?.id) return { response: new Response('bad upload response', { status: 502 }) };
  return { response, file };
}

/** Opens a public share link for a file the user owns; returns the unguessable token. */
export async function driveShare(env: Env, accessToken: string, fileId: string): Promise<string | null> {
  const response = await fetch(`${driveOrigin(env)}/api/files/${encodeURIComponent(fileId)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ share: true }),
  });
  const data = await response.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  return response.ok && data.token ? data.token : null;
}

export interface SharedFile {
  status: number;
  contentType: string;
  contentLength: number;
  total: number;
  start: number;
  body: ArrayBuffer;
}

/** Fetches a shared file through its public link - the link itself is the capability, no
 *  token needed. The share endpoint always sends the whole file, so a Range request is
 *  sliced out of the buffered body here. */
export async function driveFetchShared(env: Env, shareToken: string, range: string | null): Promise<SharedFile | null> {
  const upstream = await fetch(`${driveOrigin(env)}/share/${encodeURIComponent(shareToken)}/download`);
  if (upstream.status === 404) return null;
  if (!upstream.ok) throw new Error(`drive share fetch failed: ${upstream.status}`);
  const bytes = await upstream.arrayBuffer();
  const total = bytes.byteLength;
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) {
    return { status: 200, contentType, contentLength: total, total, start: 0, body: bytes };
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, total - parseInt(match[2], 10)); // suffix range: the last N bytes
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
  }
  if (total === 0 || start > end || start >= total) {
    return { status: 416, contentType, contentLength: 0, total, start: 0, body: new ArrayBuffer(0) };
  }
  return { status: 206, contentType, contentLength: end - start + 1, total, start, body: bytes.slice(start, end + 1) };
}

/** The file extension Drive sees for a content type we accept. */
export function driveExtension(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/avif': return '.avif';
    case 'video/mp4': return '.mp4';
    case 'video/webm': return '.webm';
    case 'video/quicktime': return '.mov';
    default: return '.bin';
  }
}
