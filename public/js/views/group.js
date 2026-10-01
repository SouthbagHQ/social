// /g/:slug and /g/:slug/:tab - a group page: banner, name, join button, and the
// Discussion / Members / About tabs.
//   GET /api/groups/:slug, /posts, /members; POST|DELETE /join; POST /members/:handle; PATCH|DELETE /:slug
// Posting uses the shared composer with groupId (POST /api/posts with group_id).

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { count, plural } from '../format.js';
import { refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, infiniteList, menu, refuseDelete, share, tabs, toast, toastError } from '../ui.js';
import { composerCard } from '../components/composer.js';
import { postCard } from '../components/post.js';
import { avatar, userName } from '../components/user.js';
import { groupAvatar, groupBanner } from './groups.js';
import { PRIVACY, pictureField } from './group-new.js';

const TABS = ['discussion', 'members', 'about'];
const roleLabels = { owner: 'Owner', admin: 'Admin', member: 'Member', pending: 'Requested' };
const isMember = role => role === 'owner' || role === 'admin' || role === 'member';
const isAdmin = role => role === 'owner' || role === 'admin';

export default async function groupView(ctx) {
  const slug = ctx.params.slug;
  const tab = TABS.includes(ctx.params.tab) ? ctx.params.tab : 'discussion';
  ctx.layout('wide');

  let data;
  try {
    data = await api.get(`groups/${encodeURIComponent(slug)}`, null, { signal: ctx.signal });
  } catch (err) {
    if (err.status !== 404) throw err;
    ctx.title('Group not found');
    return h('div.south-card.flat', { style: 'max-width:640px' },
      empty({ title: 'Group not found.', action: h('a.btn-small', { href: '/groups' }, 'Back to groups') }));
  }
  const group = data.group;
  let role = data.viewer.role;
  ctx.title(group.name);
  const canSeePosts = group.privacy === 'public' || isMember(role);
  const joinLabel = group.privacy === 'private' ? 'Request to join' : 'Join group';

  // Header
  const joinArea = h('div.group-actions');
  function paintActions() {
    const buttons = [];
    if (!store.me) {
      buttons.push(h('button.btn', { type: 'button', onclick: () => login() }, joinLabel));
    } else if (!role) {
      buttons.push(h('button.btn', { type: 'button', onclick: join }, joinLabel));
    } else if (role === 'pending') {
      const b = h('button.btn', { type: 'button' }, 'Requested');
      b.addEventListener('click', () => menu(b, [{ label: 'Withdraw request', onClick: leave }]));
      buttons.push(b);
    } else {
      const b = h('button.btn', { type: 'button' }, role === 'owner' ? 'Owner' : 'Joined');
      b.addEventListener('click', () => menu(b, [
        role !== 'owner' ? { label: 'Leave group', onClick: leave } : null,
        isAdmin(role) ? { label: 'Edit group', onClick: edit } : null,
        role === 'owner' ? { label: 'Delete group', onClick: refuseDelete } : null,
      ]));
      buttons.push(b);
    }
    buttons.push(h('button.btn-small', { type: 'button', onclick: () => share(`/g/${group.slug}`, group.name) }, 'Invite'));
    buttons.push(h('a.btn-small', { href: `/events?group=${encodeURIComponent(group.slug)}` }, 'Events'));
    if (isAdmin(role)) buttons.push(h('button.btn-small', { type: 'button', onclick: edit }, 'Edit'));
    mount(joinArea, buttons);
  }

  async function join() {
    try {
      ({ viewer: { role } } = await api.post(`groups/${group.slug}/join`));
      if (role === 'pending') {
        toast('Request sent.');
        paintActions();
      } else {
        toast(`Joined ${group.name}.`);
        refresh();
      }
    } catch (err) { toastError(err); }
  }

  async function leave() {
    const pending = role === 'pending';
    if (!pending && !(await confirm(`Leave ${group.name}?`, { title: 'Leave group', ok: 'Leave' }))) return;
    try {
      await api.del(`groups/${group.slug}/join`);
      toast(pending ? 'Request withdrawn.' : 'Left the group.');
      role = null;
      refresh();
    } catch (err) { toastError(err); }
  }

  async function edit() {
    const name = h('input.input', { value: group.name, maxLength: 60 });
    const description = h('textarea.textarea', { rows: 4, maxLength: 1000 }, group.description);
    const privacy = h('select.select', Object.entries(PRIVACY).map(([key, p]) => h('option', { value: key, selected: key === group.privacy }, p.label)));
    const privacyNote = h('small.fine', PRIVACY[group.privacy].text);
    privacy.addEventListener('change', () => {
      privacyNote.textContent = PRIVACY[privacy.value].text + (group.privacy === 'private' && privacy.value === 'public' ? ' Pending requests will be approved.' : '');
    });
    const avatarField = pictureField({ label: 'Picture', kind: 'avatar', current: group.avatar_url });
    const bannerField = pictureField({ label: 'Banner', kind: 'banner', current: group.banner_url });
    const ok = await dialog({
      title: 'Edit group',
      wide: true,
      body: h('div.group-form',
        h('label.field', h('span', 'Name'), name),
        h('label.field', h('span', 'Description'), description),
        h('label.field', h('span', 'Privacy'), privacy, privacyNote),
        avatarField, bannerField),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
    });
    if (!ok) return;
    if (avatarField.busy || bannerField.busy) return toast('The upload had not finished. Try again.', { error: true });
    const patch = { name: name.value, description: description.value, privacy: privacy.value };
    if (avatarField.value !== undefined) patch.avatar_media_id = avatarField.value;
    if (bannerField.value !== undefined) patch.banner_media_id = bannerField.value;
    try {
      await api.patch(`groups/${group.slug}`, patch);
      toast('Saved.');
      refresh();
    } catch (err) { toastError(err); }
  }

  paintActions();
  const privacyInfo = PRIVACY[group.privacy];
  const header = h('header.group-header',
    groupBanner(group),
    h('div.group-headline',
      groupAvatar(group, 'lg'),
      h('div.grow',
        h('h1', group.name),
        h('p.group-sub', `${privacyInfo.label} group, ${plural(group.member_count, 'member')}, ${plural(group.post_count, 'post')}`)),
      joinArea),
    tabs(TABS.map(t => ({ href: t === 'discussion' ? `/g/${group.slug}` : `/g/${group.slug}/${t}`, label: t[0].toUpperCase() + t.slice(1), current: t === tab }))));

  // Tabs
  let content;
  if (tab === 'members') content = membersTab();
  else if (tab === 'about') content = aboutTab();
  else content = discussionTab();

  function joinPrompt(text) {
    return h('div.south-card.flat.group-locked',
      h('p.grow', text),
      role === 'pending' ? h('span.chip', 'Requested') : !role ? h('button.btn', { type: 'button', onclick: store.me ? join : () => login() }, joinLabel) : null);
  }

  function discussionTab() {
    if (!canSeePosts) {
      return h('div', joinPrompt(role === 'pending'
        ? 'Your request is waiting for approval.'
        : 'This group is private. Join to see posts.'));
    }
    let list;
    const top = isMember(role)
      ? composerCard({ groupId: group.id, placeholder: `Write something to ${group.name}`, onPosted: post => list.prepend(card(post)) })
      : joinPrompt('Join the group to post.');
    const card = post => postCard(post);
    list = infiniteList({
      signal: ctx.signal,
      load: cursor => api.get(`groups/${group.slug}/posts`, { cursor }, { signal: ctx.signal }),
      render: card,
      empty: empty({ title: 'No posts yet.' }),
    });
    return h('div', top, list);
  }

  function membersTab() {
    const admin = isAdmin(role);
    const list = infiniteList({
      className: 'member-list',
      signal: ctx.signal,
      load: cursor => api.get(`groups/${group.slug}/members`, { cursor }, { signal: ctx.signal }),
      render: m => memberRow(m, admin),
      empty: empty({ title: 'No members.' }),
    });
    return h('div.south-card.flat',
      h('div.row.between', h('h2', { style: 'margin:0' }, 'Members'), h('span.muted', count(group.member_count))),
      group.privacy === 'private' && !isMember(role) ? h('p.fine', 'Only the owner and admins are shown.') : null,
      admin ? h('p.fine', 'Requests to join are shown first.') : null,
      list);
  }

  function memberRow(m, admin) {
    const mine = store.me?.id === m.user.id;
    const actions = [];
    if (admin && !mine && m.role !== 'owner') {
      if (m.role === 'pending') {
        actions.push(h('button.btn-small', { type: 'button', onclick: () => act(m, 'approve') }, 'Approve'));
        actions.push(h('button.btn-small', { type: 'button', onclick: () => act(m, 'remove') }, 'Decline'));
      } else {
        const more = h('button.btn-small', { type: 'button', 'aria-label': `Manage ${m.user.name}` }, 'Manage');
        more.addEventListener('click', () => menu(more, [
          m.role === 'member' ? { label: 'Make admin', onClick: () => act(m, 'promote') } : null,
          m.role === 'admin' && role === 'owner' ? { label: 'Remove as admin', onClick: () => act(m, 'demote') } : null,
          m.role === 'member' || role === 'owner' ? { label: 'Remove from group', onClick: () => act(m, 'remove') } : null,
        ]));
        actions.push(more);
      }
    }
    const row = h('div.user-row.member-row', { class: { pending: m.role === 'pending' } },
      avatar(m.user, { size: 'sm' }),
      h('div.grow', userName(m.user), h('div.bio', m.role === 'pending' ? 'Requested to join' : `${roleLabels[m.role]}${mine ? ' (you)' : ''}`)),
      m.role !== 'member' ? h('span.chip', roleLabels[m.role]) : null,
      actions);
    async function act(member, action) {
      if (action === 'remove' && member.role !== 'pending'
        && !(await confirm(`Remove ${member.user.name} from the group?`, { title: 'Remove member', ok: 'Remove' }))) return;
      try {
        const res = await api.post(`groups/${group.slug}/members/${member.user.handle}`, { action });
        const messages = {
          approve: `${member.user.name} approved.`,
          promote: `${member.user.name} is now an admin.`,
          demote: `${member.user.name} is no longer an admin.`,
          remove: member.role === 'pending' ? 'Request declined.' : `${member.user.name} removed.`,
        };
        toast(messages[action]);
        if (!res.member) { row.remove(); return; }
        row.replaceWith(memberRow(res.member, admin));
      } catch (err) { toastError(err); }
    }
    return row;
  }

  function aboutTab() {
    return h('section.south-card.flat',
      h('h2', 'About'),
      group.description ? h('p.group-description', group.description) : h('p.muted', 'No description.'),
      h('ul.group-facts',
        h('li', h('strong', privacyInfo.label), '. ', privacyInfo.text),
        h('li', plural(group.member_count, 'member')),
        h('li', plural(group.post_count, 'post')),
        h('li', `Created ${new Date(group.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`)),
      group.owner ? h('div', h('h3', 'Owner'), h('div.user-row', avatar(group.owner, { size: 'sm' }), h('div.grow', userName(group.owner)))) : null);
  }

  const aside = tab === 'discussion'
    ? h('aside.group-aside',
        h('section.south-card.flat',
          h('h3', 'About'),
          group.description ? h('p.group-description', group.description) : h('p.muted', 'No description.'),
          h('p.group-sub', `${privacyInfo.label}. ${privacyInfo.text}`),
          h('a', { href: `/g/${group.slug}/about` }, 'More about this group')))
    : null;

  return h('div.group-page', header, h('div.group-body', { class: { 'has-aside': Boolean(aside) } }, h('div.group-main', content), aside));
}
