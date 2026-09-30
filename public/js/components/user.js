// People: avatars, names, follow buttons, user rows.

import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { login, store } from '../store.js';
import { toast, toastError, confirm } from '../ui.js';

/** Square beveled avatar (round: true for chat). Falls back to the user's initial on the logo gradient. */
export function avatar(user, { size = '', round = false, link = true, ring = null } = {}) {
  const inner = user?.avatar_url
    ? h('img', { src: user.avatar_url, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
    : h('span.initial', (user?.name || user?.handle || 's').trim().charAt(0).toLowerCase());
  const cls = { round, 'story-ring': ring != null, seen: ring === 'seen', [size]: Boolean(size) };
  return link && user?.handle
    ? h('a.avatar', { href: `/@${user.handle}`, class: cls, title: user.name, 'aria-label': `${user.name} (@${user.handle})` }, inner)
    : h('span.avatar', { class: cls }, inner);
}

export const verifiedBadge = () => {
  const el = icon('verified', 'verified');
  el.setAttribute('aria-label', 'Southbag Verified™ (purchased)');
  el.setAttribute('aria-hidden', 'false');
  el.setAttribute('role', 'img');
  return el;
};

/** "Name ✓ @handle" */
export function userName(user, { handle = true, link = true } = {}) {
  const name = h('span.name', user.name);
  return h('span.user-name',
    link ? h('a', { href: `/@${user.handle}`, style: 'color:inherit;min-width:0;display:inline-flex' }, name) : name,
    user.verified ? verifiedBadge() : null,
    handle ? h('span.handle', `@${user.handle}`) : null);
}

/**
 * Follow toggle ("Add to The Pile" / "In The Pile"). `user` needs { id, handle, is_following? }.
 * Calls PUT/DELETE /api/users/:handle/follow.
 */
export function followButton(user, { small = true, onChange } = {}) {
  let following = Boolean(user.is_following);
  const btn = h(small ? 'button.btn-small' : 'button.btn', { type: 'button' });
  const paint = () => {
    btn.textContent = following ? 'In The Pile' : 'Add to The Pile';
    btn.classList.toggle('outline', following);
    btn.title = following ? 'Remove from The Pile' : `Follow @${user.handle}`;
  };
  paint();
  if (store.me?.id === user.id) return null;
  btn.addEventListener('click', async () => {
    if (!store.me) return login();
    if (following && !(await confirm(`Remove @${user.handle} from The Pile? No removal process is documented, but we will try.`, { ok: 'Remove' }))) return;
    btn.disabled = true;
    try {
      if (following) await api.del(`users/${user.handle}/follow`);
      else await api.put(`users/${user.handle}/follow`);
      following = !following;
      user.is_following = following;
      paint();
      if (following) toast(`@${user.handle} has been added to The Pile.`);
      onChange?.(following);
    } catch (err) { toastError(err); }
    btn.disabled = false;
  });
  return btn;
}

/** A row with avatar, name, handle, optional bio and a trailing action (follow button by default). */
export function userRow(user, { action, bio = true } = {}) {
  return h('div.user-row',
    avatar(user, { size: 'sm' }),
    h('div.grow',
      userName(user),
      bio && user.bio ? h('div.bio', user.bio) : null),
    action === undefined ? followButton(user) : action);
}
