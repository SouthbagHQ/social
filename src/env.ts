import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Southbag Online Banking's Billing entrypoint (lib/banking.ts). */
  BANKING?: import('./lib/banking').BankingBilling;
  /** Push notifications (lib/push.ts). Secrets; push is off without them. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Shared albums (lib/drive.ts). The WebDAV credentials of the Southbag Drive account that
   *  holds album media. Secrets; albums answer 503 without them. DRIVE_ORIGIN is a var. */
  DRIVE_ORIGIN?: string;
  DRIVE_WEBDAV_USER?: string;
  DRIVE_WEBDAV_TOKEN?: string;
  [binding: string]: unknown;
}

/** The signed-in user, as loaded from a session. */
export interface SessionUser {
  id: string;
  handle: string;
  name: string;
  email: string | null;
  avatar_media_id: string | null;
  identity_picture: string | null;
  verified: number;
  bearer?: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser | null } };
export type Ctx = Context<AppEnv>;
