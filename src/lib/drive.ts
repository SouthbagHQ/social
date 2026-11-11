// Southbag Drive™ client. Shared albums keep their photos and videos in Drive instead of
// Social's own database: Social's Worker talks to Drive's existing WebDAV endpoint
// (/webdav/, Basic auth) as the albums service account, whose long-lived access token is
// stored as the DRIVE_WEBDAV_USER / DRIVE_WEBDAV_TOKEN secrets. Drive has no folders, so
// every album file is one flat name: social-album-<mediaId>.<ext>.
//
// Without the secrets the albums API answers 503 and nothing here runs.

import type { Env } from '../env';

export interface DriveConfig {
  origin: string;
  authorization: string;
}

export function driveConfig(env: Env): DriveConfig | null {
  const user = env.DRIVE_WEBDAV_USER as string | undefined;
  const token = env.DRIVE_WEBDAV_TOKEN as string | undefined;
  if (!user || !token) return null;
  const origin = ((env.DRIVE_ORIGIN as string | undefined) || 'https://drive.southbag.cc').replace(/\/+$/, '');
  return { origin, authorization: 'Basic ' + btoa(`${user}:${token}`) };
}

const davUrl = (config: DriveConfig, name: string): string =>
  `${config.origin}/webdav/${encodeURIComponent(name)}`;

/** Streams a file into the Drive account. 201 = stored, 204 = replaced, 413 = the floppies are full. */
export function drivePut(
  config: DriveConfig,
  name: string,
  contentType: string,
  body: ReadableStream | null,
  size: number,
): Promise<Response> {
  return fetch(davUrl(config, name), {
    method: 'PUT',
    headers: {
      authorization: config.authorization,
      'content-type': contentType,
      'content-length': String(size),
    },
    body,
    // Node's fetch wants this hint for streaming bodies; Workers ignores it.
    ...({ duplex: 'half' } as object),
  });
}

/** Reads a file back out of the Drive account, honouring a Range request. */
export function driveGet(config: DriveConfig, name: string, range: string | null): Promise<Response> {
  const headers: Record<string, string> = { authorization: config.authorization };
  if (range) headers.range = range;
  return fetch(davUrl(config, name), { headers });
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
