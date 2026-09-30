// /friends — Facebook-style friends: requests (incoming and sent), your friends, people you may know.
//   GET /api/users/me/friend-requests, GET /api/users/me/friends, GET /api/users/suggested
//   PUT/DELETE /api/users/:handle/friend

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
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
    empty: empty({ icon: 'users', title: 'No friends yet.', text: 'Friendship is subject to review. Start with someone below.' }),
  });

  const setIncoming = n => store.setUnread({ friend_requests: n });

  async function loadRequests() {
    try {
      const { incoming, outgoing } = await api.get('users/me/friend-requests', null, { signal: ctx.signal });
      setIncoming(incoming.length);
      let remaining = incoming.length;
      const rows = incoming.map(person => {
        const row = userRow(person, { action: h('div.row.friend-actions',
          h('button.btn-small', { type: 'button', onclick: async e => {
            e.target.disabled = true;
            try {
              await api.put(`users/${person.handle}/friend`);
              toast(`You and @${person.handle} are now friends. This has been recorded.`);
              row.remove();
              setIncoming(--remaining);
              friendsList.reload();
              if (!remaining) mount(requestsCard, h('h2', 'Friend requests'), noRequests());
            } catch (err) { toastError(err); e.target.disabled = false; }
          } }, 'Confirm'),
          h('button.btn-small.outline', { type: 'button', onclick: async e => {
            e.target.disabled = true;
            try {
              await api.del(`users/${person.handle}/friend`);
              toast('Request declined. They have not been told. They will work it out.');
              row.remove();
              setIncoming(--remaining);
              if (!remaining) mount(requestsCard, h('h2', 'Friend requests'), noRequests());
            } catch (err) { toastError(err); e.target.disabled = false; }
          } }, 'Delete')) });
        row.querySelector('.grow').append(h('div.fine', `Requested ${timeAgo(person.requested_at)} ago`.replace('now ago', 'just now')));
        return row;
      });
      mount(requestsCard, h('h2', 'Friend requests', incoming.length ? h('span.badge', { style: 'margin-left:8px;vertical-align:middle' }, String(incoming.length)) : null),
        rows.length ? rows : noRequests());

      if (outgoing.length) {
        sentCard.classList.remove('hidden');
        mount(sentCard, h('h2', 'Sent requests'), h('p.fine', 'Awaiting review by the recipient. And by Kevin.'),
          outgoing.map(person => {
            const row = userRow(person, { action: h('button.btn-small.outline', { type: 'button', onclick: async e => {
              e.target.disabled = true;
              try {
                await api.del(`users/${person.handle}/friend`);
                toast('Request withdrawn. It has been retained.');
                row.remove();
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
      const { items } = await api.get('users/suggested', { limit: 8 }, { signal: ctx.signal });
      mount(suggestCard, h('h2', 'People you may know'),
        h('p.fine', 'Suggested by Palantir. You may know them. They may know you. Kevin knows both of you.'),
        items.length
          ? items.map(person => userRow(person, { action: h('div.row.friend-actions', addFriendButton(person), followButton(person)) }))
          : empty({ icon: 'users', title: 'Nobody left to suggest.', text: 'You know everyone. That is concerning.' }));
    } catch (err) {
      if (err.name !== 'AbortError') mount(suggestCard, h('h2', 'People you may know'), errorBox(err));
    }
  }

  loadRequests();
  loadSuggestions();

  return h('div',
    h('div.page-head', h('h1', 'Friends'), h('span.spacer'),
      h('a.btn-small.outline', { href: `/@${store.me.handle}/friends` }, icon('user'), 'View on profile')),
    requestsCard,
    sentCard,
    h('section.south-card.flat', h('h2', 'Your friends'), friendsList),
    suggestCard);
}

const noRequests = () => h('p.muted', 'No friend requests. Nobody is asking. This has been noted.');

function addFriendButton(person) {
  const btn = h('button.btn-small', { type: 'button' }, icon('user-plus'), 'Add friend');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { friendship } = await api.put(`users/${person.handle}/friend`);
      mount(btn, icon('check'), friendship === 'friends' ? 'Friends' : 'Request sent');
      toast(friendship === 'friends' ? 'You are now friends. This has been recorded.' : 'Friend request sent. Friendship is subject to review.');
    } catch (err) { toastError(err); btn.disabled = false; }
  });
  return btn;
}

function friendMenu(friend) {
  const btn = h('button.btn-small.outline', { type: 'button' }, 'Friends ▾');
  btn.addEventListener('click', () => menu(btn, [
    { label: 'Message', icon: 'message', href: `/messages?to=${encodeURIComponent(friend.handle)}` },
    { label: 'View wall', icon: 'edit', href: `/@${friend.handle}/wall` },
    'divider',
    { label: 'Unfriend', icon: 'close', danger: true, onClick: async () => {
      if (!(await confirm(`Unfriend ${friend.name}? Your shared history is retained permanently.`, { ok: 'Unfriend' }))) return;
      try {
        await api.del(`users/${friend.handle}/friend`);
        btn.closest('.user-row')?.remove();
        toast('Unfriended. The friendship has been archived, not deleted.');
      } catch (err) { toastError(err); }
    } },
  ]));
  return btn;
}
