// /notifications — everything that happened to you, grouped where it makes sense
// (consecutive reactions on the same post become one line). Opening the page marks all read.
//   GET /api/notifications?cursor → { items, next }    POST /api/notifications/read

import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { fullDate, timeAgo } from '../format.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { empty, infiniteList, toast, toastError } from '../ui.js';
import { REACTIONS, postUrl } from '../components/post.js';
import { avatar } from '../components/user.js';

const ICONS = {
  follow: 'user-plus', friend_request: 'user-plus', friend_accept: 'users', reaction: 'heart', reply: 'comment',
  repost: 'repost', quote: 'edit', mention: 'message', wall_post: 'edit', group_join: 'users', group_post: 'users',
  story_view: 'eye', system: 'bag',
};

const who = actor => actor ? `@${actor.handle}` : 'Someone';

/** "@bob and 2 others" */
function actorsText(actors) {
  const first = who(actors[0]);
  if (actors.length === 1) return first;
  if (actors.length === 2) return `${first} and ${who(actors[1])}`;
  return `${first} and ${actors.length - 1} others`;
}

function describe(n, actors) {
  const a = actorsText(actors);
  const group = n.group?.name || 'a group';
  switch (n.type) {
    case 'follow': return `${a} added you to The Pile.`;
    case 'friend_request': return `${a} sent you a friend request. Friendship is subject to review.`;
    case 'friend_accept': return `${a} accepted your friend request. You are now friends, pending review.`;
    case 'reaction': {
      const emoji = [...new Set(n._types || [n.body])].map(t => REACTIONS[t]?.emoji || '❤️').join('');
      return `${a} reacted ${emoji} to your post.`;
    }
    case 'reply': return `${a} replied to your post.`;
    case 'repost': return `${a} reposted your post. Kevin was first.`;
    case 'quote': return `${a} quoted your post.`;
    case 'mention': return `${a} mentioned you. You have been logged.`;
    case 'wall_post': return `${a} wrote on your wall.`;
    case 'group_join': return `${a} joined ${group}.`;
    case 'group_post': return `${a} posted in ${group}.`;
    case 'story_view': return `${a} viewed your story. So did Kevin.`;
    case 'system': return n.body || 'A system notice was issued. Its contents are withheld.';
    default: return n.body || `${a} did something. Kevin has noted it.`;
  }
}

function target(n) {
  if (n.type === 'friend_request') return '/friends';
  if (n.type === 'story_view' && store.me) return `/stories/${store.me.handle}`;
  if (n.post) return postUrl(n.post);
  if (n.group) return `/g/${n.group.slug}`;
  if (n.actor) return `/@${n.actor.handle}`;
  return null;
}

function item(n) {
  const actors = n._actors || (n.actor ? [n.actor] : []);
  const href = target(n);
  const text = h('p.notif-text', describe(n, actors));
  const excerpt = n.post && (n.post.title || n.post.body)
    ? h('p.notif-excerpt', n.post.title || n.post.body)
    : n.post?.deleted ? h('p.notif-excerpt', 'This post was deleted. A copy was retained.') : null;
  const face = actors.length
    ? h('div.notif-faces', actors.slice(0, 4).map(a => avatar(a, { size: 'sm' })))
    : h('div.notif-faces', h('span.avatar.sm.kevin', h('span.initial', 'k')));
  const el = h('article.notif', {
    class: { unread: !n.read, system: n.type === 'system', clickable: Boolean(href) },
    onclick: e => { if (href && !e.target.closest('a, button')) navigate(href); },
  },
    h('span.notif-icon', { class: `t-${n.type}` }, icon(ICONS[n.type] || 'bell')),
    h('div.grow', face, text, excerpt,
      h('time.fine', { datetime: new Date(n.created_at).toISOString(), title: fullDate(n.created_at) }, timeAgo(n.created_at))),
    !n.read ? h('span.unread-dot', { 'aria-label': 'Unread' }) : null);
  return el;
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
    empty: empty({ icon: 'bell', title: 'No notifications.', text: 'Kevin has read them already.' }),
    onPage: items => {
      if (marked || !items.some(n => !n.read)) return;
      marked = true;
      api.post('notifications/read').then(() => store.setUnread({ notifications: 0 })).catch(() => {});
    },
  });

  const markAll = h('button.btn-small.outline', { type: 'button', onclick: async () => {
    try {
      await api.post('notifications/read');
      store.setUnread({ notifications: 0 });
      list.querySelectorAll('.notif.unread').forEach(el => el.classList.remove('unread'));
      list.querySelectorAll('.unread-dot').forEach(el => el.remove());
      toast('All notifications marked read. Kevin had already read them.');
    } catch (err) { toastError(err); }
  } }, icon('check'), 'Mark all read');

  return h('div',
    h('div.page-head', h('h1', 'Notifications'), h('span.spacer'), markAll),
    h('p.fine', { style: 'margin-top:-6px' }, 'Notifications are retained permanently. Reading them is optional. Kevin reads them either way.'),
    h('div.south-card.flat.notif-card', list));
}
