// Placeholder: the Palantir feature replaces this with server-side PostHog capture
// (see SouthbagHQ/banking palantir.js). Safe to call from any route today; it does nothing yet.
import type { Ctx } from '../env';

/** Records a server-side analytics event for the signed-in user (or the anonymous visitor). */
export function track(_c: Ctx, _event: string, _properties: Record<string, unknown> = {}): void {}
