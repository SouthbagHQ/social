// /g/:slug and /g/:slug/:tab — a Facebook group page: banner, name, join button, and the
// Discussion / Members / About tabs.
//   GET /api/groups/:slug, /posts, /members; POST|DELETE /join; POST /members/:handle; PATCH|DELETE /:slug
// Posting uses the shared composer with groupId (POST /api/posts with group_id).

import { api } from '../api.js';
import { h, icon, mount } from '../dom.js';
import { count, plural } from '../format.js';
import { navigate, refresh } from '../router.js';
import { login, store } from '../store.js';
import { confirm, dialog, empty, infiniteList, menu, share, shake, tabs, toast, toastError } from '../ui.js';
import { composerCard } from '../components/composer.js';
import { postCard } from '../components/post.js';
import { avatar, userName } from '../components/user.js';
import { groupAvatar } from './groups.js';
import { PRIVACY, pictureField } from './group-new.js';

const TABS = ['discussion', 'members', 'about'];
const roleLabels = { owner: 'Owner', admin: 'Admin', member: 'Member', pending: 'Requested' };
const isMember = role => role === 'owner' || role === 'admin' || role === 'member';
const isAdmin = role => role === 'owner' || role === 'admin';

const RULES = [
  ['Kevin is a member.', 'He does not appear in the member count. He appears everywhere else.'],
  ['Be kind.', 'Kindness is monitored for quality and training purposes.'],
  ['No posts about 2019.', 'There was no 2019 incident. Posts about it will be removed before they are written.'],
  ['Leaving is permitted.', 'Your posts stay behind. So does a record of your leaving.'],
  ['Admin decisions are final.', 'Appeals are reviewed by Kevin. Response times are not guaranteed.'],
];

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
      empty({ icon: 'users', title: 'Kevin has closed this group.', text: 'It may have been deleted. It may never have existed. Both are on file.', ref: 'REF: SB-ERR-404',
        action: h('a.btn-small', { href: '/groups' }, 'Back to groups') }));
  }
  const group = data.group;
  let role = data.viewer.role;
  ctx.title(group.name);
  const canSeePosts = group.privacy === 'public' || isMember(role);

  // ── Header ─────────────────────────────────────────────────────────────
  const joinArea = h('div.group-actions');
  function paintActions() {
    const buttons = [];
    if (!store.me) {
      buttons.push(h('button.btn', { type: 'button', onclick: () => login() }, icon('user-plus'), group.privacy === 'private' ? 'Request to join' : 'Join group'));
    } else if (!role) {
      buttons.push(h('button.btn', { type: 'button', onclick: join }, icon('user-plus'), group.privacy === 'private' ? 'Request to join' : 'Join group'));
    } else if (role === 'pending') {
      const b = h('button.btn.outline', { type: 'button' }, 'Requested', icon('chevron-down'));
      b.addEventListener('click', () => menu(b, [{ label: 'Withdraw request', icon: 'close', onClick: leave }]));
      buttons.push(b);
    } else {
      const b = h('button.btn.outline', { type: 'button' }, icon('check'), role === 'owner' ? 'Owner' : 'Joined', icon('chevron-down'));
      b.addEventListener('click', () => menu(b, [
        role !== 'owner' ? { label: 'Leave group', icon: 'log-out', danger: true, onClick: leave } : null,
        isAdmin(role) ? { label: 'Edit group', icon: 'edit', onClick: edit } : null,
        role === 'owner' ? { label: 'Delete group', icon: 'trash', danger: true, onClick: remove } : null,
        role === 'owner' ? { label: 'Owners cannot leave. Kevin cannot either.', icon: 'lock', onClick: () => toast('Owners cannot leave. Delete the group instead. Kevin will stay either way.') } : null,
      ]));
      buttons.push(b);
    }
    buttons.push(h('button.btn-small.outline', { type: 'button', onclick: () => share(`/g/${group.slug}`, group.name) }, icon('share'), 'Invite'));
    if (isAdmin(role)) buttons.push(h('button.btn-small.outline', { type: 'button', onclick: edit }, icon('edit'), 'Edit'));
    mount(joinArea, buttons);
  }

  async function join() {
    try {
      ({ viewer: { role } } = await api.post(`groups/${group.slug}/join`));
      if (role === 'pending') {
        toast('Request sent. Kevin will decide. The admins may also have opinions.');
        paintActions();
      } else {
        toast(`You joined ${group.name}. Kevin was already here.`);
        refresh();
      }
    } catch (err) { toastError(err); }
  }

  async function leave() {
    const pending = role === 'pending';
    if (!pending && !(await confirm(`Leave ${group.name}? Your posts stay behind. So does a record of your leaving.`, { ok: 'Leave group' }))) return;
    try {
      await api.del(`groups/${group.slug}/join`);
      toast(pending ? 'Request withdrawn. It has been retained.' : 'You left the group. The group has not left you.');
      role = null;
      refresh();
    } catch (err) { toastError(err); }
  }

  async function edit() {
    const name = h('input.input', { value: group.name, maxLength: 60 });
    const description = h('textarea.textarea.boxed', { rows: 4, maxLength: 1000 }, group.description);
    const privacy = h('select.select', Object.entries(PRIVACY).map(([key, p]) => h('option', { value: key, selected: key === group.privacy }, p.label)));
    const privacyNote = h('small.fine', PRIVACY[group.privacy].text);
    privacy.addEventListener('change', () => {
      privacyNote.textContent = PRIVACY[privacy.value].text + (group.privacy === 'private' && privacy.value === 'public' ? ' Everyone waiting to join will be let in.' : '');
    });
    const avatarField = pictureField({ label: 'Group picture', kind: 'avatar', current: group.avatar_url });
    const bannerField = pictureField({ label: 'Banner', kind: 'banner', current: group.banner_url });
    const ok = await dialog({
      title: 'Edit group',
      wide: true,
      body: h('div.group-form',
        h('label.field', h('span', 'Group name'), name),
        h('label.field', h('span', 'Description'), description),
        h('label.field', h('span', 'Privacy'), privacy, privacyNote),
        avatarField, bannerField,
        h('p.fine', 'Changes are logged. The original is retained.')),
      actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
    });
    if (!ok) return;
    if (avatarField.busy || bannerField.busy) return toast('An upload was still going. Try again when it finishes.', { error: true });
    const patch = { name: name.value, description: description.value, privacy: privacy.value };
    if (avatarField.value !== undefined) patch.avatar_media_id = avatarField.value;
    if (bannerField.value !== undefined) patch.banner_media_id = bannerField.value;
    try {
      await api.patch(`groups/${group.slug}`, patch);
      toast('Group amended. The original is retained.');
      refresh();
    } catch (err) { toastError(err); }
  }

  async function remove() {
    if (!(await confirm(`Delete ${group.name} and every post in it? Deletion is advisory. Kevin keeps a copy.`, { ok: 'Delete group', title: 'Delete group' }))) return;
    if (!(await confirm('Are you sure? This is the second of one confirmations.', { ok: 'Yes, delete it', title: 'Southbag Alert' }))) return;
    try {
      await api.del(`groups/${group.slug}`);
      toast('Group deleted. Its members have been notified by Kevin, in person.');
      navigate('/groups', { replace: true });
    } catch (err) { toastError(err); }
  }

  paintActions();
  const privacyInfo = PRIVACY[group.privacy];
  const header = h('header.group-header',
    h('div.group-banner', { style: group.banner_url ? { backgroundImage: `url("${group.banner_url}")` } : null },
      group.banner_url ? null : h('span.group-banner-mark', 'S O U T H B A G    G R O U P S')),
    h('div.group-headline',
      groupAvatar(group, 'lg'),
      h('div.grow',
        h('h1', group.name),
        h('p.group-sub', icon(privacyInfo.icon), `${privacyInfo.label} group · ${plural(group.member_count, 'member')} and Kevin · ${plural(group.post_count, 'post')}`)),
      joinArea),
    tabs(TABS.map(t => ({ href: t === 'discussion' ? `/g/${group.slug}` : `/g/${group.slug}/${t}`, label: t[0].toUpperCase() + t.slice(1), current: t === tab }))));

  // ── Tabs ──────────────────────────────────────────────────────────────
  let content;
  if (tab === 'members') content = membersTab();
  else if (tab === 'about') content = aboutTab();
  else content = discussionTab();

  function joinPrompt(text) {
    return h('div.south-card.flat.group-locked',
      icon(group.privacy === 'private' ? 'lock' : 'users'),
      h('div.grow', h('p', h('strong', text)),
        group.privacy === 'private' ? h('p.fine', 'Anyone can see the name and description. Only members see posts. Kevin sees both.') : null),
      role === 'pending' ? h('span.chip.red', 'Requested') : !role ? h('button.btn', { type: 'button', onclick: store.me ? join : () => login() },
        group.privacy === 'private' ? 'Request to join' : 'Join group') : null);
  }

  function discussionTab() {
    if (!canSeePosts) {
      return h('div', joinPrompt(role === 'pending'
        ? 'Your request is with the admins. Kevin will decide.'
        : 'This group is private. Request to join. Kevin will decide.'));
    }
    let list;
    const top = isMember(role)
      ? composerCard({ groupId: group.id, placeholder: `Write something to ${group.name}. Kevin reads it first.`, onPosted: post => list.prepend(card(post)) })
      : joinPrompt('Join the group to post. Reading is free. For now.');
    const card = post => postCard(post);
    list = infiniteList({
      signal: ctx.signal,
      load: cursor => api.get(`groups/${group.slug}/posts`, { cursor }, { signal: ctx.signal }),
      render: card,
      empty: empty({ icon: 'comment', title: 'No posts yet.', text: 'The silence is compliant. Someone should say something. Kevin will not.' }),
    });
    return h('div', top, list);
  }

  function membersTab() {
    const admin = isAdmin(role);
    const kevinRow = h('div.user-row.member-row',
      avatar({ handle: 'kevin', name: 'Kevin', avatar_url: null }, { size: 'sm' }),
      h('div.grow', userName({ handle: 'kevin', name: 'Kevin', verified: true }), h('div.bio', 'Member of every group. Not counted. Always present.')),
      h('span.chip', 'Weather'));
    const list = infiniteList({
      className: 'member-list',
      signal: ctx.signal,
      load: cursor => api.get(`groups/${group.slug}/members`, { cursor }, { signal: ctx.signal }),
      render: m => memberRow(m, admin),
      empty: empty({ icon: 'users', title: 'Nobody here.', text: 'Except Kevin.' }),
    });
    return h('div.south-card.flat',
      h('div.row.between', h('h2', { style: 'margin:0' }, 'Members'), h('span.muted', `${count(group.member_count)} + Kevin`)),
      group.privacy === 'private' && !isMember(role) ? h('p.fine', 'This group is private. Only the owner and admins are listed. The rest are on file.') : null,
      admin ? h('p.fine', 'Requests to join appear first. Approve them, or leave them to Kevin.') : null,
      kevinRow,
      list);
  }

  function memberRow(m, admin) {
    const mine = store.me?.id === m.user.id;
    const actions = [];
    if (admin && !mine && m.role !== 'owner') {
      if (m.role === 'pending') {
        actions.push(h('button.btn-small', { type: 'button', onclick: () => act(m, 'approve') }, 'Approve'));
        actions.push(h('button.btn-small.outline', { type: 'button', onclick: () => act(m, 'remove') }, 'Decline'));
      } else {
        const more = h('button.icon-btn', { type: 'button', 'aria-label': `Manage ${m.user.name}` }, icon('more'));
        more.addEventListener('click', () => menu(more, [
          m.role === 'member' ? { label: 'Make admin', icon: 'verified', onClick: () => act(m, 'promote') } : null,
          m.role === 'admin' && role === 'owner' ? { label: 'Remove as admin', icon: 'user', onClick: () => act(m, 'demote') } : null,
          m.role === 'member' || role === 'owner' ? { label: 'Remove from group', icon: 'trash', danger: true, onClick: () => act(m, 'remove') } : null,
        ]));
        actions.push(more);
      }
    }
    const row = h('div.user-row.member-row', { class: { pending: m.role === 'pending' } },
      avatar(m.user, { size: 'sm' }),
      h('div.grow', userName(m.user), h('div.bio', m.role === 'pending' ? 'Wants to join. Kevin is thinking about it.' : `${roleLabels[m.role]}${mine ? ' · you' : ''}`)),
      m.role !== 'member' ? h('span.chip', { class: { teal: isAdmin(m.role), red: m.role === 'pending' } }, roleLabels[m.role]) : null,
      actions);
    async function act(member, action) {
      if (action === 'remove' && member.role !== 'pending'
        && !(await confirm(`Remove ${member.user.name} from the group? Their posts stay. Kevin will let them know.`, { ok: 'Remove' }))) return;
      try {
        const res = await api.post(`groups/${group.slug}/members/${member.user.handle}`, { action });
        const messages = {
          approve: `${member.user.name} is in. Kevin approved it first.`,
          promote: `${member.user.name} is now an admin. Power has been logged.`,
          demote: `${member.user.name} is no longer an admin.`,
          remove: member.role === 'pending' ? 'Request declined. The request has been retained.' : `${member.user.name} was removed. The group remembers.`,
        };
        toast(messages[action]);
        if (!res.member) { row.remove(); return; }
        row.replaceWith(memberRow(res.member, admin));
      } catch (err) { shake(row); toastError(err); }
    }
    return row;
  }

  function aboutTab() {
    return h('div.stack',
      h('section.south-card.flat',
        h('h2', 'About this group'),
        group.description ? h('p.group-description', group.description) : h('p.muted', 'No description. The group speaks for itself. Kevin speaks for the group.'),
        h('ul.group-facts',
          h('li', icon(privacyInfo.icon), h('span', h('strong', privacyInfo.label), ' · ', privacyInfo.text)),
          h('li', icon('users'), `${plural(group.member_count, 'member')}, plus Kevin`),
          h('li', icon('calendar'), `Created ${new Date(group.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`),
          h('li', icon('comment'), plural(group.post_count, 'post'))),
        group.owner ? h('div', h('h3', 'Owner'), h('div.user-row', avatar(group.owner, { size: 'sm' }), h('div.grow', userName(group.owner)))) : null),
      rulesCard());
  }

  function rulesCard() {
    return h('section.announcement-grid.group-rules', { 'aria-label': 'Group rules' },
      h('h3', 'Group rules'),
      RULES.map(([title, text], i) => h('div.announcement-card', h('h3', `${i + 1}. ${title}`), h('p', text))));
  }

  const aside = tab === 'discussion'
    ? h('aside.group-aside',
        h('section.south-card.flat',
          h('h3', 'About'),
          group.description ? h('p.group-description', group.description) : h('p.muted', 'No description. Kevin knows what it is for.'),
          h('p.group-sub', icon(privacyInfo.icon), privacyInfo.label),
          h('a', { href: `/g/${group.slug}/about` }, 'See more')),
        rulesCard())
    : null;

  return h('div.group-page', header, h('div.group-body', { class: { 'has-aside': Boolean(aside) } }, h('div.group-main', content), aside));
}
