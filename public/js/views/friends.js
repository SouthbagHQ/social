// /friends - friend requests (incoming and sent), your friends, people you may know.
//   GET /api/users/me/friend-requests, GET /api/users/me/friends, GET /api/users/suggested
//   PUT/DELETE /api/users/:handle/friend

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { timeAgo } from '../format.js';
import { store } from '../store.js';
import { confirm, empty, errorBox, infiniteList, loading, menu, toast, toastError } from '../ui.js';
import { followButton, userRow } from '../components/user.js';

export default async function friends(ctx) {
  if (!ctx.requireAuth()) return null;
  ctx.title('Friends');

  const requestsCard = h('section.south-card.flat', h('h2', 'Friend requests'), loading());
  const sentCard = h('section.south-card.flat.hidden');
  const suggestCard = h('section.south-card.flat', h('h2', 'People you may know'), loading());
  const friendsList = infiniteList({
    className: 'people-list',
    signal: ctx.signal,
    load: cursor => api.get('users/me/friends', { cursor }, { signal: ctx.signal }),
    render: friend => userRow(friend, { action: friendMenu(friend) }),
    empty: empty({ title: 'No friends yet.' }),
  });

  const setIncoming = n => store.setUnread({ friend_requests: n });

  async function loadRequests() {
    try {
      const { incoming, outgoing } = await api.get('users/me/friend-requests', null, { signal: ctx.signal });
      setIncoming(incoming.length);
      let remaining = incoming.length;
      const done = row => {
        row.remove();
        setIncoming(--remaining);
        if (!remaining) mount(requestsCard, h('h2', 'Friend requests'), noRequests());
      };
      const rows = incoming.map(person => {
        const row = userRow(person, { action: h('div.row.friend-actions',
          h('button.btn-small', { type: 'button', onclick: async e => {
            e.target.disabled = true;
            try {
              await api.put(`users/${person.handle}/friend`);
              toast(`You and @${person.handle} are now friends.`);
              done(row);
              friendsList.reload();
            } catch (err) { toastError(err); e.target.disabled = false; }
          } }, 'Accept'),
          h('button.btn-small', { type: 'button', onclick: async e => {
            e.target.disabled = true;
            try {
              await api.del(`users/${person.handle}/friend`);
              toast('Request declined.');
              done(row);
            } catch (err) { toastError(err); e.target.disabled = false; }
          } }, 'Decline')) });
        const when = timeAgo(person.requested_at);
        row.querySelector('.grow').append(h('div.fine', when === 'now' ? 'Just now' : `${when} ago`));
        return row;
      });
      mount(requestsCard, h('h2', 'Friend requests', incoming.length ? h('span.badge', String(incoming.length)) : null),
        rows.length ? rows : noRequests());

      if (outgoing.length) {
        sentCard.classList.remove('hidden');
        mount(sentCard, h('h2', 'Sent requests'),
          outgoing.map(person => {
            const row = userRow(person, { action: h('button.btn-small', { type: 'button', onclick: async e => {
              e.target.disabled = true;
              try {
                await api.del(`users/${person.handle}/friend`);
                toast('Request cancelled.');
                row.remove();
                if (!sentCard.querySelector('.user-row')) sentCard.classList.add('hidden');
              } catch (err) { toastError(err); e.target.disabled = false; }
            } }, 'Cancel request') });
            return row;
          }));
      }
    } catch (err) {
      if (err.name !== 'AbortError') mount(requestsCard, h('h2', 'Friend requests'), errorBox(err));
    }
  }

  async function loadSuggestions() {
    try {
      const { items } = await api.get('users/suggested', { limit: 8, exclude: 'friends' }, { signal: ctx.signal });
      mount(suggestCard, h('h2', 'People you may know'),
        items.length
          ? items.map(person => userRow(person, { action: h('div.row.friend-actions', addFriendButton(person), followButton(person)) }))
          : empty({ title: 'No suggestions.' }));
    } catch (err) {
      if (err.name !== 'AbortError') mount(suggestCard, h('h2', 'People you may know'), errorBox(err));
    }
  }

  loadRequests();
  loadSuggestions();

  return h('div',
    h('div.page-head', h('h1', 'Friends'), h('span.spacer'),
      h('a.btn-small', { href: `/@${store.me.handle}/friends` }, 'View on profile')),
    requestsCard,
    sentCard,
    h('section.south-card.flat', h('h2', 'Your friends'), friendsList),
    suggestCard);
}

const noRequests = () => h('p.muted', 'No friend requests.');

function addFriendButton(person) {
  const btn = h('button.btn-small', { type: 'button' }, 'Add friend');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { friendship } = await api.put(`users/${person.handle}/friend`);
      btn.textContent = friendship === 'friends' ? 'Friends' : 'Requested';
      toast(friendship === 'friends' ? `You and @${person.handle} are now friends.` : 'Friend request sent.');
    } catch (err) { toastError(err); btn.disabled = false; }
  });
  return btn;
}

function friendMenu(friend) {
  const btn = h('button.btn-small', { type: 'button', 'aria-haspopup': 'menu' }, 'More');
  btn.addEventListener('click', () => menu(btn, [
    { label: 'Message', href: `/messages?to=${encodeURIComponent(friend.handle)}` },
    { label: 'View wall', href: `/@${friend.handle}/wall` },
    'divider',
    { label: 'Unfriend', onClick: async () => {
      if (!(await confirm(`Remove ${friend.name} from your friends?`, { title: 'Unfriend', ok: 'Unfriend' }))) return;
      try {
        await api.del(`users/${friend.handle}/friend`);
        btn.closest('.user-row')?.remove();
        toast('Unfriended.');
      } catch (err) { toastError(err); }
    } },
  ]));
  return btn;
}
