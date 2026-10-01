// App-wide state: the signed-in user and unread counts. Views read `store.me`;
// anything can `store.on('change', fn)` to re-render badges etc.

import { identify, reset } from './analytics.js';
import { api } from './api.js';

const listeners = new Set();

// palantir.js identifies whoever is signed in when the page loads; this only follows changes during
// the visit without a reload (signing in from a dialog, a session expiring), like Identity's layout.
let knownUserId; // undefined until the first answer from /api/me
function followIdentity(me) {
  const id = me?.id ?? null;
  if (knownUserId !== undefined && id !== knownUserId) {
    if (me) identify(me);
    else reset();
  }
  knownUserId = id;
}

export const store = {
  /** Full /api/me user, or null when signed out. */
  me: null,
  unread: { notifications: 0, messages: 0, friend_requests: 0 },
  loaded: false,

  async refresh() {
    try {
      const data = await api.get('me');
      this.me = data.authenticated ? data.user : null;
      this.unread = data.unread || { notifications: 0, messages: 0, friend_requests: 0 };
      followIdentity(this.me);
    } catch {
      this.me = null;
    }
    this.loaded = true;
    this.emit();
    return this.me;
  },

  /** Merge fields into `me` (after editing a profile, say) and notify. */
  patchMe(fields) {
    if (this.me) Object.assign(this.me, fields);
    this.emit();
  },

  setUnread(fields) {
    Object.assign(this.unread, fields);
    this.emit();
  },

  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { for (const fn of listeners) { try { fn(this); } catch (e) { console.error(e); } } },
};

/** Sends the browser to the Identity login, returning here afterwards. */
export function login(next = location.pathname + location.search) {
  location.href = `/auth/login?next=${encodeURIComponent(next)}`;
}
