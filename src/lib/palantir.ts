// Palantir — server-side PostHog capture for Southbag. Dependency-free (plain fetch), so it runs
// unchanged on Cloudflare Workers, Node and Bun. Mirrors `public/palantir.js` on the client, and is
// ported from SouthbagHQ/banking `palantir.js` (same key, same host, same payload shape).
//
// Events are tied to the browser session when the request carries PostHog's `.southbag.cc`
// cookie: `palantirContext(request)` reads the distinct id and session id out of it, so a server
// event lands in the same person and the same session replay as the click that caused it.
//
// Routes call `track(c, 'social_<noun>_<past-tense verb>', { ids, kinds, counts, flags })`. Never
// pass post text, message bodies, search queries or anything else people typed.
//
// Nothing is sent from `node --test` (NODE_TEST_CONTEXT) or from a local `wrangler dev`
// (localhost / 127.0.0.1) unless PALANTIR_DEV=1 is set; with PALANTIR_DEV=1, a local
// PALANTIR_HOST_OVERRIDE sends events to a mock collector instead. Both are ignored in production.
//
// Only `import type` here, so tests can import this file straight from Node.
import type { Ctx, Env } from '../env';

const PALANTIR_KEY = 'phc_rStyYsw4wrB8MwXEsPBJjz57uipHycNVwFPaw2m3aYXo';
const PALANTIR_HOST = 'https://palantir.southbag.cc';
const APP = 'social'; // matches data-app on the client

type Props = Record<string, unknown>;
type WaitUntil = (promise: Promise<unknown>) => void;
/** Anything with Cloudflare's `waitUntil` (an ExecutionContext). */
export type Waiter = { waitUntil(promise: Promise<unknown>): void };

export interface PalantirContext {
  /** PostHog distinct id from the browser cookie (anonymous or identified). */
  distinctId?: string;
  /** Session replay id from the browser cookie, so server events join the replay. */
  sessionId?: string;
  windowId?: string;
  ip?: string;
  userAgent?: string;
  url?: string;
}

export interface CaptureOptions {
  /** Person properties to set (email, name, …). */
  set?: Props;
  /** Request context from `palantirContext()` so the event joins the browser session. */
  context?: PalantirContext;
  /** Cloudflare's `ctx.waitUntil` — keeps the request from finishing before the event is sent. */
  waitUntil?: WaitUntil;
  timestamp?: Date;
  /** Where to send; `null` means don't send at all (tests, local dev). Defaults to Palantir. */
  host?: string | null;
}

const isLocal = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);

/**
 * Where this request's events go, or `null` when nothing may be sent: under `node --test`, and
 * from localhost unless PALANTIR_DEV=1. PALANTIR_HOST_OVERRIDE only applies to localhost requests.
 */
export function palantirHost(request: Request, env: Partial<Env> = {}): string | null {
  const vars = env as Record<string, unknown>;
  // `node --test` runs each file in a child with NODE_TEST_CONTEXT set; never hit the network from tests.
  if ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_TEST_CONTEXT
    || vars.NODE_TEST_CONTEXT) return null;
  if (!isLocal(new URL(request.url).hostname)) return PALANTIR_HOST;
  if (String(vars.PALANTIR_DEV ?? '') !== '1') return null;
  const override = typeof vars.PALANTIR_HOST_OVERRIDE === 'string' ? vars.PALANTIR_HOST_OVERRIDE.replace(/\/+$/, '') : '';
  return override || PALANTIR_HOST;
}

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** Pull PostHog's identity and session out of the request's cookies/headers. */
export function palantirContext(request: Request): PalantirContext {
  const context: PalantirContext = {
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
    // Without the query string: on Social it can carry what someone typed (/search?q=…).
    url: withoutQuery(request.headers.get('referer') ?? request.url),
  };
  const raw = (request.headers.get('cookie') ?? '')
    .split(';').map(part => part.trim())
    .find(part => part.startsWith(`ph_${PALANTIR_KEY}_posthog=`));
  if (!raw) return context;
  try {
    const value = JSON.parse(decodeURIComponent(raw.slice(raw.indexOf('=') + 1))) as {
      distinct_id?: string;
      $sesid?: [number, string, number];
      $window_id?: string;
    };
    if (value.distinct_id) context.distinctId = String(value.distinct_id);
    if (Array.isArray(value.$sesid) && value.$sesid[1]) context.sessionId = value.$sesid[1];
    if (value.$window_id) context.windowId = value.$window_id;
  } catch {
    // Not our cookie shape — fine, the event is still captured, just not linked to a replay.
  }
  return context;
}

/** The JSON body PostHog's `/capture/` endpoint expects for one event. */
export function capturePayload(event: string, distinctId: string, properties: Props = {}, options: CaptureOptions = {}) {
  const context = options.context ?? {};
  return {
    api_key: PALANTIR_KEY,
    event,
    distinct_id: String(distinctId),
    timestamp: (options.timestamp ?? new Date()).toISOString(),
    properties: {
      $lib: 'palantir-server',
      $process_person_profile: true,
      southbag_app: APP,
      source: 'server',
      ...(context.sessionId ? { $session_id: context.sessionId } : {}),
      ...(context.windowId ? { $window_id: context.windowId } : {}),
      ...(context.ip ? { $ip: context.ip } : {}),
      ...(context.userAgent ? { $raw_user_agent: context.userAgent } : {}),
      ...(context.url ? { $current_url: context.url } : {}),
      ...properties,
      ...(options.set ? { $set: options.set } : {}),
    },
  };
}

function send(host: string, payload: Props, waitUntil?: WaitUntil): Promise<void> {
  const promise = fetch(`${host}/capture/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(response => { if (!response.ok) console.warn(`palantir: capture failed (${response.status})`); })
    .catch(error => console.warn('palantir: capture failed', error));
  if (waitUntil) waitUntil(promise);
  return promise;
}

/**
 * Capture a server-side event. `distinctId` should be the signed-in user's Identity id when there
 * is one (the same id the browser identifies with), otherwise the cookie's distinct id from
 * `palantirContext(request)`.
 */
export function capture(event: string, distinctId: string | undefined, properties: Props = {}, options: CaptureOptions = {}): Promise<void> {
  const host = options.host === undefined ? PALANTIR_HOST : options.host;
  const id = distinctId ?? options.context?.distinctId;
  if (!host || !id) return Promise.resolve();
  return send(host, capturePayload(event, id, properties, options), options.waitUntil);
}

/**
 * Identify a user server-side. Merges the anonymous cookie identity (from `context.distinctId`)
 * into the user's profile, exactly like `posthog.identify()` in the browser.
 */
export function identify(userId: string, set: Props, options: Omit<CaptureOptions, 'set'> = {}): Promise<void> {
  const anonymous = options.context?.distinctId;
  return capture('$identify', userId,
    anonymous && anonymous !== String(userId) ? { $anon_distinct_id: anonymous } : {},
    { ...options, set });
}

/** Bundle request context, host and waitUntil once: `tracker(request, env, ctx, user).capture(event, props)`. */
export function tracker(request: Request, env: Partial<Env>, ctx?: Waiter | null, user: { id: string } | null = null) {
  const context = palantirContext(request);
  const host = palantirHost(request, env);
  const waitUntil: WaitUntil = promise => ctx?.waitUntil(promise);
  const distinctId = user?.id ?? context.distinctId;
  return {
    context,
    distinctId,
    capture: (event: string, properties: Props = {}) => capture(event, distinctId, properties, { context, waitUntil, host }),
    identify: (id: string, set: Props) => identify(id, set, { context, waitUntil, host }),
  };
}

/**
 * Records an event from a scheduled job (no request, no browser session). `send: false` keeps the
 * job's localhost test endpoint quiet; `node --test` never sends either.
 */
export function trackJob(env: Partial<Env>, distinctId: string, event: string, properties: Props = {},
  options: { send?: boolean; waitUntil?: WaitUntil } = {}): Promise<void> {
  const vars = env as Record<string, unknown>;
  const testing = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_TEST_CONTEXT
    || vars.NODE_TEST_CONTEXT;
  const host = options.send === false || testing ? null : PALANTIR_HOST;
  return capture(event, distinctId, { ...properties, source: 'cron' }, { host, waitUntil: options.waitUntil }).catch(() => {});
}

/** Hono's executionCtx getter throws outside a Worker; analytics must never break a request. */
function executionCtx(c: Ctx): Waiter | null {
  try { return c.executionCtx; } catch { return null; }
}

/**
 * Records a server-side analytics event for the signed-in user (or the anonymous visitor's cookie
 * id). Sent after the response via `waitUntil`, so it never delays or fails a request. Pass `user`
 * on routes without a session (e.g. /auth/*) or when the actor isn't `c.get('user')`.
 */
export function track(c: Ctx, event: string, properties: Props = {}, user: { id: string } | null = c.get('user') ?? null): void {
  try {
    void tracker(c.req.raw, c.env, executionCtx(c), user).capture(event, properties);
  } catch (error) {
    console.warn('palantir: track failed', error);
  }
}
