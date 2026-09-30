// /notifications - everything that happened to you, grouped where it makes sense
// (consecutive reactions on the same post become one line). Opening the page marks all read.
//   GET /api/notifications?cursor -> { items, next }    POST /api/notifications/read

import { api } from '../api.js';
import { h } from '../dom.js';
import { fullDate, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { empty, infiniteList, toast, toastError } from '../ui.js';
import { postUrl } from '../components/post.js';
import { avatar } from '../components/user.js';

const who = actor => actor ? actor.name || `@${actor.handle}` : 'Someone';

/** "Bob", "Bob and Carol", "Bob and 2 others" */
function actorsText(actors) {
  const first = who(actors[0]);
  if (actors.length <= 1) return first;
  if (actors.length === 2) return `${first} and ${who(actors[1])}`;
  return `${first} and ${actors.length - 1} others`;
}

function describe(n, actors) {
  const a = actorsText(actors);
  const group = n.group?.name || 'a group';
  switch (n.type) {
    case 'follow': return `${a} followed you.`;
    case 'friend_request': return `${a} sent you a friend request.`;
    case 'friend_accept': return `${a} accepted your friend request.`;
    case 'reaction': {
      const kinds = new Set(n._types || [n.body]);
      return kinds.size === 1 && (kinds.has('like') || kinds.has(null) || kinds.has(undefined))
        ? `${a} liked your post.`
        : `${a} reacted to your post.`;
    }
    case 'reply': return `${a} replied to your post.`;
    case 'repost': return `${a} reposted your post.`;
    case 'quote': return `${a} quoted your post.`;
    case 'mention': return `${a} mentioned you.`;
    case 'wall_post': return `${a} wrote on your wall.`;
    case 'group_join': return `${a} joined ${group}.`;
    case 'group_post': return `${a} posted in ${group}.`;
    case 'story_view': return `${a} viewed your story.`;
    case 'system': return n.body || 'Southbag Social';
    default: return n.body || `${a} interacted with you.`;
  }
}

function target(n) {
  if (n.link && n.link.startsWith('/') && !n.link.startsWith('//')) return n.link;
  if (n.type === 'friend_request') return '/friends';
  if (n.type === 'story_view' && store.me) return `/stories/${store.me.handle}`;
  if (n.post) return postUrl(n.post);
  if (n.group) return `/g/${n.group.slug}`;
  if (n.actor) return `/@${n.actor.handle}`;
  return null;
}

/** "Just now", "5m ago", "3d ago", or a date. */
function when(ms) {
  const t = timeAgo(ms);
  return t === 'now' ? 'Just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
}

function item(n) {
  const actors = n._actors || (n.actor ? [n.actor] : []);
  const href = target(n);
  const text = h('p.notif-text', href ? h('a', { href }, describe(n, actors)) : describe(n, actors));
  const excerpt = n.post && (n.post.title || n.post.body)
    ? h('p.notif-excerpt', n.post.title || n.post.body)
    : n.post?.deleted ? h('p.notif-excerpt', 'Post deleted.') : null;
  const faces = actors.length ? h('div.notif-faces', actors.slice(0, 4).map(a => avatar(a, { size: 'sm' }))) : null;
  return h('article.notif', {
    class: { unread: !n.read, system: n.type === 'system', clickable: Boolean(href) },
    onclick: e => { if (href && !e.target.closest('a, button')) navigate(href); },
  },
    faces,
    h('div.grow', text, excerpt,
      h('p.notif-when.fine',
        h('time', { datetime: new Date(n.created_at).toISOString(), title: fullDate(n.created_at) }, when(n.created_at)),
        !n.read ? h('span.unread-label', 'New') : null)));
}

export default function notifications(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Notifications');

  // Group consecutive reactions on the same post (across pages, too).
  let last = null;
  const render = n => {
    if (n.type === 'reaction' && last && last.type === 'reaction' && last.post?.id && last.post.id === n.post?.id) {
      if (n.actor && !last._actors.some(a => a.id === n.actor.id)) last._actors.push(n.actor);
      last._types.push(n.body);
      if (!n.read) last.read = false;
      const fresh = item(last);
      last._el.replaceWith(fresh);
      last._el = fresh;
      return null;
    }
    const copy = { ...n, _actors: n.actor ? [n.actor] : [], _types: [n.body] };
    copy._el = item(copy);
    last = copy;
    return copy._el;
  };

  let marked = false;
  const list = infiniteList({
    className: 'notif-list',
    signal: ctx.signal,
    load: cursor => api.get('notifications', { cursor }, { signal: ctx.signal }),
    render,
    empty: empty({ title: 'No notifications.' }),
    onPage: items => {
      if (marked || !items.some(n => !n.read)) return;
      marked = true;
      api.post('notifications/read').then(() => store.setUnread({ notifications: 0 })).catch(() => {});
    },
  });

  const markAll = h('button.btn-small', { type: 'button', onclick: async () => {
    try {
      await api.post('notifications/read');
      store.setUnread({ notifications: 0 });
      list.querySelectorAll('.notif.unread').forEach(el => el.classList.remove('unread'));
      list.querySelectorAll('.unread-label').forEach(el => el.remove());
      toast('Marked as read.');
    } catch (err) { toastError(err); }
  } }, 'Mark all as read');

  return h('div',
    h('div.page-head', h('h1', 'Notifications'), h('span.spacer'), markAll),
    h('div.south-card.flat.notif-card', list));
}
