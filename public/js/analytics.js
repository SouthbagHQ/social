// Palantir (PostHog) in the browser. /palantir.js — the shared Southbag client script, loaded in
// index.html — sets up `window.palantir`, identifies the signed-in user from /api/me and records
// pageviews (including client-side navigation) by itself. Views only call `track()` for custom
// events: `track('social_<noun>_<past-tense verb>', { ids, kinds, counts, flags })`. Never pass
// post text, message bodies, search queries or anything else people typed.
//
// Everything here is a no-op when the script is blocked or hasn't loaded, and never throws.

export function track(event, properties = {}) {
  try { window.palantir?.capture(event, properties); } catch {}
}

/** The signed-in user changed during the visit: `{ id, email, name }` (id = Identity `sub`). */
export function identify(user) {
  try { window.palantir?.identify({ id: user.id, email: user.email, name: user.name }); } catch {}
}

/** Signed out during the visit: back to an anonymous profile. */
export function reset() {
  try {
    window.palantir?.reset();
    // posthog.reset() also drops the `southbag_app` super property palantir.js registered on load.
    const app = document.querySelector('script[src="/palantir.js"]')?.dataset.app;
    if (app) window.posthog?.register({ southbag_app: app });
  } catch {}
}
