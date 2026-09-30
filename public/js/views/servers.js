// Servers (Discord style): /servers, /servers/:serverId, /servers/:serverId/:channelId and
// /servers/join/:code (invite links).
//
// Desktop: four columns inside ridge-bordered panels: your servers, the open server's channels, the open
// channel, and its members. Phones: one column at a time (servers, then channels, then the channel,
// which takes the whole screen) with "Back" buttons. Plain text only: every control is a word, and the
// only colour is Southbag blue for unread markers and mentions. Styles live in public/css/servers.css.
//
// Free plan: there is no push, so the open channel polls one endpoint (see POLL below and the header of
// src/routes/servers.ts for the request budget).

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { fullDate, plural } from '../format.js';
import { navigate } from '../router.js';
import { store } from '../store.js';
import { confirm, copy, dialog, empty, errorBox, lightbox, loading, menu, promptDialog, tabs, toast, toastError } from '../ui.js';
import { pickFiles, uploadFile } from '../upload.js';
import { avatar } from '../components/user.js';
import { richText } from '../components/post.js';

// Polling budget. Every poll is one Worker request (100k a day on the free plan). Poll every 3 s while
// the channel is focused and something happened in the last minute, 10 s when the window is not focused
// or after a quiet minute, 25 s after five quiet minutes, and never while the tab is hidden. The server
// list refreshes once a minute while visible; the member list only when the online count changes.
const POLL = { fast: 3000, medium: 10000, slow: 25000, activeFor: 60000, quietAfter: 300000, list: 60000, members: 10000 };
const TYPING_EVERY = 4000; // at most one "is typing" request per 4 s (the server shows it for 6 s)
const GROUP_GAP = 7 * 60 * 1000; // messages from the same person within 7 minutes are grouped
const MAX_BODY = 4000;

const REACTION_LABELS = { like: 'Like', agree: 'Agree', laugh: 'Laugh', thanks: 'Thanks', wow: 'Wow', sad: 'Sad' };
const PERMISSIONS = [
  ['manage_server', 'Manage server', 'Edit the name, description, icon and invite link.'],
  ['manage_channels', 'Manage channels', 'Create, edit, reorder and delete channels. Post in announcement channels.'],
  ['manage_roles', 'Manage roles', 'Create and edit roles below their own, and give them to members.'],
  ['kick_members', 'Kick members', 'Remove members below their highest role.'],
  ['ban_members', 'Ban members', 'Remove members and stop them joining again.'],
  ['manage_messages', 'Manage messages', 'Delete and pin anyone\'s messages. Not affected by slowmode.'],
  ['mention_everyone', 'Mention @everyone', 'Notify every member with @everyone.'],
];
const PERM_BITS = { manage_server: 1, manage_channels: 2, manage_roles: 4, kick_members: 8, ban_members: 16, manage_messages: 32, mention_everyone: 64 };
const SLOWMODE_LABELS = { 0: 'Off', 5: '5 seconds', 10: '10 seconds', 15: '15 seconds', 30: '30 seconds', 60: '1 minute', 120: '2 minutes', 300: '5 minutes', 600: '10 minutes', 900: '15 minutes', 1800: '30 minutes', 3600: '1 hour', 7200: '2 hours', 21600: '6 hours' };

// Survives re-renders (back/forward re-runs this view), so switching paints instantly.
const cache = { servers: null, detail: new Map(), members: new Map() };

const phoneQuery = matchMedia('(max-width: 640px)');
const wideQuery = matchMedia('(min-width: 1101px)'); // room for the member list next to the channel

// -- Small helpers -------------------------------------------------------

const me = () => store.me;
const clock = ms => new Date(ms).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const dayKey = ms => new Date(ms).toDateString();
function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}
function stamp(ms) {
  return dayKey(ms) === dayKey(Date.now()) ? `Today at ${clock(ms)}` : `${new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} at ${clock(ms)}`;
}
const initials = name => (name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || 'S';
const plainClick = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
const inviteLink = code => `${location.origin}/servers/join/${code}`;
const lastChannelKey = id => `sb_sv_last_${id}`;
function remember(serverId, channelId) { try { localStorage.setItem(lastChannelKey(serverId), channelId); } catch { /* private mode */ } }
function remembered(serverId) { try { return localStorage.getItem(lastChannelKey(serverId)); } catch { return null; } }

/** Square server icon: the uploaded picture stretched into the box, or initials. */
function serverIcon(s, size = '') {
  return h('span.sv-icon', { class: { [size]: Boolean(size) }, 'aria-hidden': 'true' },
    s.icon_url ? h('img', { src: s.icon_url, alt: '' }) : h('span.sv-initials', initials(s.name)));
}

const can = (detail, perm) => Boolean(detail?.me?.permissions?.[perm]);
const canManageAny = d => ['manage_server', 'manage_channels', 'manage_roles', 'kick_members', 'ban_members'].some(p => can(d, p));
const myTop = d => (d.me.is_owner ? Infinity : d.me.top_position ?? 0);
const rolesById = d => new Map(d.roles.map(r => [r.id, r]));
function topOf(d, member) {
  if (member.is_owner) return Infinity;
  const by = rolesById(d);
  return Math.max(0, ...member.role_ids.map(id => by.get(id)?.position ?? 0));
}
const outranks = (d, member) => !member.is_owner && (d.me.is_owner || myTop(d) > topOf(d, member));
const canPost = (d, ch) => ch.kind !== 'announcement' || can(d, 'manage_channels') || can(d, 'manage_messages');

function sortedChannels(d) {
  const cats = [...d.categories].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const byCat = new Map([[null, []], ...cats.map(c => [c.id, []])]);
  for (const ch of [...d.channels].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))) {
    (byCat.get(ch.category_id) || byCat.get(null)).push(ch);
  }
  return { cats, byCat };
}

/** richText, plus @everyone/@here as plain bold text instead of profile links. */
function messageText(text) {
  return richText(text).map(node => {
    if (node instanceof HTMLAnchorElement && /^\/@(everyone|here)$/i.test(node.getAttribute('href') || '')) return h('strong.sv-at', node.textContent);
    if (node instanceof HTMLAnchorElement && me() && node.getAttribute('href')?.toLowerCase() === `/@${me().handle.toLowerCase()}`) node.classList.add('sv-at-me');
    return node;
  });
}

function typingText(people) {
  const names = people.map(p => p.display_name);
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing`;
  return 'Several people are typing';
}

// -- The view ------------------------------------------------------------

export default async function view(ctx) {
  if (!ctx.requireAuth()) return null;
  const setLayout = () => ctx.layout(phoneQuery.matches ? 'full' : 'wide');
  setLayout();
  ctx.title('Servers');

  // /servers/join/:code is an invite link.
  if (ctx.params.serverId === 'join' && ctx.params.channelId) return invitePage(ctx, ctx.params.channelId);

  let serverId = ctx.params.serverId || null;
  let channelId = ctx.params.channelId || null;
  let detail = serverId ? cache.detail.get(serverId) || null : null;
  let detailError = null;
  let members = serverId ? cache.members.get(serverId) || null : null;
  let showMembers = wideQuery.matches;
  let pane = null; // the open channel
  let membersFetchedAt = 0;
  let lastOnline = null;

  const colServers = h('section.sv-col.sv-servers', { 'aria-label': 'Your servers' });
  const colChannels = h('section.sv-col.sv-channels', { 'aria-label': 'Channels' });
  const colChat = h('section.sv-col.sv-chat', { 'aria-label': 'Channel' });
  const colMembers = h('section.sv-col.sv-members', { 'aria-label': 'Members' });
  const root = h('div.sv', colServers, colChannels, colChat, colMembers);

  function level() {
    if (!serverId) return 'servers';
    if (!channelId) return 'channels';
    return root.classList.contains('members-open') && phoneQuery.matches ? 'members' : 'chat';
  }
  function syncLevel() {
    root.dataset.level = level();
    root.classList.toggle('has-server', Boolean(serverId));
    root.classList.toggle('show-members', Boolean(serverId && showMembers));
    document.documentElement.classList.toggle('sv-lock', phoneQuery.matches && (level() === 'chat' || level() === 'members'));
  }

  // -- Column 1: your servers --

  function renderServers() {
    let list;
    if (!cache.servers) list = loading();
    else if (!cache.servers.length) list = h('div.sv-pad', h('p.muted', 'No servers yet.'), h('p.fine', 'Create one, or join one with an invite link.'));
    else list = h('ul.sv-server-list', cache.servers.map(s => {
      const active = s.id === serverId;
      return h('li.sv-server', { class: { active, unread: s.unread && !active } },
        h('a.sv-server-link', {
          href: `/servers/${s.id}`, 'aria-current': active ? 'page' : null,
          onclick: e => { if (!plainClick(e)) return; e.preventDefault(); open(s.id, null); },
        },
        serverIcon(s),
        h('span.sv-server-name', s.name)),
        s.mention_count && !active ? h('span.badge', { title: plural(s.mention_count, 'mention') }, String(s.mention_count > 99 ? '99+' : s.mention_count)) : null,
        s.unread && !active ? h('span.sv-unread', 'Unread') : null);
    }));
    mount(colServers,
      h('div.sv-col-head', h('h2', 'Servers')),
      h('div.sv-col-scroll', list),
      h('div.sv-col-foot',
        h('button', { type: 'button', onclick: createServerDialog }, 'Create server'),
        h('button', { type: 'button', onclick: () => joinServerDialog() }, 'Join server')));
  }

  async function refreshServers() {
    try {
      const data = await api.get('servers', {}, { signal: ctx.signal });
      cache.servers = data.items;
      renderServers();
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!cache.servers) mount(colServers, h('div.sv-col-head', h('h2', 'Servers')), h('div.sv-pad', errorBox(err)));
    }
  }

  // -- Column 2: channels of the open server --

  function renderChannels() {
    if (!serverId) {
      mount(colChannels, h('div.sv-col-head', h('h2', 'Channels')), h('div.sv-pad', h('p.muted', 'Choose a server.')));
      return;
    }
    if (!detail) {
      mount(colChannels,
        h('div.sv-col-head', phoneBack('Back to servers', () => open(null, null)), h('h2', cache.servers?.find(s => s.id === serverId)?.name || 'Server')),
        detailError ? h('div.sv-pad', errorBox(detailError)) : loading());
      return;
    }
    const d = detail;
    const settings = h('button.btn-small', { type: 'button', 'aria-haspopup': 'menu' }, 'Server settings');
    settings.addEventListener('click', () => menu(settings, [
      { label: 'Invite people', onClick: () => inviteDialog(d) },
      canManageAny(d) ? { label: 'Server settings', onClick: () => settingsDialog(d) } : null,
      can(d, 'manage_channels') ? { label: 'Create channel', onClick: () => channelDialog(d, null) } : null,
      can(d, 'manage_channels') ? { label: 'Create category', onClick: () => categoryDialog(d, null) } : null,
      { label: 'Change nickname', onClick: () => nicknameDialog(d, { user: me(), nickname: d.me.nickname, is_owner: d.me.is_owner, role_ids: d.me.role_ids }, true) },
      d.me.is_owner ? null : 'divider',
      d.me.is_owner ? null : { label: 'Leave server', onClick: () => leaveServer(d) },
    ]));
    const { cats, byCat } = sortedChannels(d);
    const channelItem = ch => {
      const active = ch.id === channelId;
      const unread = ch.unread && !active;
      return h('li.sv-channel', { class: { active, unread } },
        h('a.sv-channel-link', {
          href: `/servers/${d.server.id}/${ch.id}`, 'aria-current': active ? 'page' : null,
          onclick: e => { if (!plainClick(e)) return; e.preventDefault(); open(d.server.id, ch.id); },
        }, `# ${ch.name}`),
        ch.mention_count && !active ? h('span.badge', { title: plural(ch.mention_count, 'mention') }, String(ch.mention_count)) : null,
        unread ? h('span.sv-unread', 'Unread') : null,
        can(d, 'manage_channels') ? h('button.btn-tiny.sv-edit', { type: 'button', 'aria-label': `Edit #${ch.name}`, onclick: () => channelDialog(d, ch) }, 'Edit') : null);
    };
    const groups = [];
    const loose = byCat.get(null);
    if (loose.length) groups.push(h('ul.sv-channel-list', loose.map(channelItem)));
    for (const cat of cats) {
      const list = byCat.get(cat.id);
      groups.push(h('div.sv-category',
        h('div.sv-category-head', h('span.eyebrow', cat.name),
          can(d, 'manage_channels') ? h('button.btn-tiny', { type: 'button', 'aria-label': `Create a channel in ${cat.name}`, onclick: () => channelDialog(d, null, cat.id) }, 'Create channel') : null),
        list.length ? h('ul.sv-channel-list', list.map(channelItem)) : h('p.fine.sv-pad-x', 'No channels.')));
    }
    if (!d.channels.length) groups.push(h('div.sv-pad', h('p.muted', 'No channels yet.')));
    mount(colChannels,
      h('div.sv-col-head.sv-server-head',
        phoneBack('Back to servers', () => open(null, null)),
        h('div.sv-server-title', serverIcon(d.server, 'sm'), h('h2', d.server.name)),
        settings),
      d.server.description ? h('p.sv-server-desc', d.server.description) : null,
      h('div.sv-col-scroll', groups),
      h('div.sv-col-foot.sv-me', avatar(me(), { size: 'xs', link: false }), h('span.grow.sv-me-name', d.me.nickname || me().name), h('span.fine', `${d.online_count} online`)));
  }

  function phoneBack(label, onClick) {
    return h('button.sv-back', { type: 'button', 'aria-label': label, onclick: onClick }, 'Back');
  }

  async function loadDetail({ quiet = false } = {}) {
    const id = serverId;
    try {
      const data = await api.get(`servers/${id}`, {}, { signal: ctx.signal });
      if (id !== serverId) return;
      detail = data;
      detailError = null;
      cache.detail.set(id, data);
      const entry = cache.servers?.find(s => s.id === id);
      if (entry) { Object.assign(entry, { name: data.server.name, icon_url: data.server.icon_url }); }
      else if (cache.servers) cache.servers.push({ id, name: data.server.name, icon_url: data.server.icon_url, unread: false, mention_count: 0 });
      renderServers();
      if (!channelId || !data.channels.some(c => c.id === channelId)) {
        const pick = pickChannel(data);
        if (!phoneQuery.matches && pick) { channelId = pick; history.replaceState(history.state, '', `/servers/${id}/${pick}`); openPane(); }
        else if (channelId) { channelId = null; history.replaceState(history.state, '', `/servers/${id}`); openPane(); }
      } else if (pane && pane.channelId === channelId) {
        pane.setDetail(data);
      } else openPane();
      renderChannels();
      renderMembers();
      syncLevel();
    } catch (err) {
      if (err.name === 'AbortError' || id !== serverId) return;
      if (err.status === 404) {
        cache.detail.delete(id);
        if (cache.servers) cache.servers = cache.servers.filter(s => s.id !== id);
        if (quiet) { toast('You are no longer a member of that server.'); open(null, null, { replace: true }); return; }
      }
      detailError = err;
      detail = null;
      renderChannels();
      if (!quiet) mount(colChat, h('div.sv-placeholder', errorBox(err), h('button', { type: 'button', onclick: () => open(null, null) }, 'Back to servers')));
    }
  }

  function pickChannel(d) {
    const last = remembered(d.server.id);
    if (last && d.channels.some(c => c.id === last)) return last;
    const { cats, byCat } = sortedChannels(d);
    return [...byCat.get(null), ...cats.flatMap(c => byCat.get(c.id))][0]?.id || null;
  }

  // -- Column 4: members --

  function renderMembers() {
    if (!serverId || !detail) { mount(colMembers); return; }
    const d = detail;
    const head = h('div.sv-col-head',
      phoneBack('Back to channel', () => toggleMembers(false)),
      h('h2', 'Members'),
      h('span.fine', `${d.online_count ?? members?.online_count ?? 0} online`));
    if (!members) { mount(colMembers, head, loading()); return; }
    const roles = d.roles.filter(r => !r.is_everyone).sort((a, b) => b.position - a.position);
    const groups = new Map(roles.map(r => [r.id, []]));
    const rest = [];
    for (const m of members.items) {
      const top = roles.find(r => m.role_ids.includes(r.id));
      (top ? groups.get(top.id) : rest).push(m);
    }
    const order = (a, b) => (b.online - a.online) || a.display_name.localeCompare(b.display_name);
    const section = (title, list) => list.length ? h('div.sv-member-group',
      h('p.eyebrow', `${title} (${list.length})`),
      h('ul.sv-member-list', list.sort(order).map(m => memberRow(d, m)))) : null;
    mount(colMembers, head, h('div.sv-col-scroll',
      roles.map(r => section(r.name, groups.get(r.id))),
      section('Members', rest)));
  }

  function memberRow(d, m) {
    const btn = h('button.btn-tiny.sv-member-more', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `Options for ${m.display_name}` }, 'More');
    btn.addEventListener('click', () => memberMenu(btn, d, m));
    return h('li.sv-member', { class: { offline: !m.online } },
      avatar(m.user, { size: 'sm' }),
      h('div.sv-member-main',
        h('div.sv-member-top', h('a.sv-member-name', { href: `/@${m.user.handle}` }, m.display_name), btn),
        h('div.sv-member-sub',
          m.nickname ? h('span', `@${m.user.handle}`) : null,
          m.is_owner ? h('span', 'Owner') : null,
          h('span', m.online ? 'Online' : 'Offline'))));
  }

  function memberMenu(anchor, d, m) {
    const self = m.user.id === me().id;
    const above = outranks(d, m);
    menu(anchor, [
      { label: 'View profile', href: `/@${m.user.handle}` },
      self || (can(d, 'manage_server') && above) ? { label: 'Change nickname', onClick: () => nicknameDialog(d, m, self) } : null,
      can(d, 'manage_roles') && (self || above) ? { label: 'Roles', onClick: () => memberRolesDialog(d, m) } : null,
      !self && can(d, 'kick_members') && above ? { label: 'Kick', onClick: () => kick(d, m) } : null,
      !self && can(d, 'ban_members') && above ? { label: 'Ban', onClick: () => ban(d, m) } : null,
    ]);
  }

  let membersTimer = null;
  async function refreshMembers({ force = false } = {}) {
    if (!serverId) return;
    const wait = membersFetchedAt + POLL.members - Date.now();
    if (!force && wait > 0) {
      // Throttled: fetch once when the window is up, so the change still shows.
      if (!membersTimer) membersTimer = setTimeout(() => { membersTimer = null; refreshMembers(); }, wait);
      return;
    }
    clearTimeout(membersTimer);
    membersTimer = null;
    membersFetchedAt = Date.now();
    const id = serverId;
    try {
      const data = await api.get(`servers/${id}/members`, {}, { signal: ctx.signal });
      if (id !== serverId) return;
      members = data;
      lastOnline = data.online_count;
      cache.members.set(id, data);
      renderMembers();
    } catch (err) { if (err.name !== 'AbortError') console.warn(err); }
  }

  function toggleMembers(on = !showMembers) {
    showMembers = on;
    root.classList.toggle('members-open', on);
    syncLevel();
    if (on) refreshMembers();
    pane?.renderHead();
  }

  // -- Column 3: the open channel --

  function openPane() {
    pane?.destroy();
    pane = null;
    if (!serverId) {
      mount(colChat, h('div.sv-placeholder',
        h('h2', 'Servers'),
        h('p', 'Chat with groups in channels. Choose a server, create one, or join one with an invite link.'),
        h('div.row.wrap',
          h('button', { type: 'button', onclick: createServerDialog }, 'Create server'),
          h('button', { type: 'button', onclick: () => joinServerDialog() }, 'Join server'))));
      ctx.title('Servers');
      return;
    }
    if (!detail) { mount(colChat, detailError ? h('div.sv-placeholder', errorBox(detailError)) : loading()); return; }
    const ch = channelId && detail.channels.find(c => c.id === channelId);
    if (!ch) {
      ctx.title(detail.server.name);
      mount(colChat, h('div.sv-placeholder',
        h('h2', detail.server.name),
        h('p', detail.channels.length ? 'Choose a channel.' : 'No channels yet.'),
        can(detail, 'manage_channels') ? h('button', { type: 'button', onclick: () => channelDialog(detail, null) }, 'Create channel') : null));
      return;
    }
    remember(detail.server.id, ch.id);
    ctx.title(`#${ch.name} - ${detail.server.name}`);
    // Opening a channel reads it.
    if (ch.unread || ch.mention_count) { ch.unread = false; ch.mention_count = 0; updateServerUnread(); }
    pane = channelPane({
      detail, channel: ch, signal: ctx.signal,
      onBack: () => open(serverId, null),
      onToggleMembers: () => toggleMembers(),
      membersShown: () => showMembers,
      onChannels: states => {
        let changed = false;
        for (const s of states) {
          const c = detail.channels.find(x => x.id === s.id);
          if (!c) { changed = true; continue; }
          const unread = s.id === channelId ? false : s.unread;
          const mentions = s.id === channelId ? 0 : s.mention_count;
          if (c.unread !== unread || c.mention_count !== mentions) { c.unread = unread; c.mention_count = mentions; changed = true; }
        }
        if (changed) { renderChannels(); updateServerUnread(); }
      },
      onStructure: () => loadDetail({ quiet: true }),
      onOnline: n => { if (n !== lastOnline) { lastOnline = n; detail.online_count = n; refreshMembers(); renderChannels(); renderMembers(); } },
      onGone: () => { toast('You are no longer a member of this server.'); cache.detail.delete(serverId); refreshServers(); open(null, null, { replace: true }); },
      onChannelGone: () => loadDetail({ quiet: true }),
    });
    mount(colChat, pane.el);
  }

  function updateServerUnread() {
    const entry = cache.servers?.find(s => s.id === serverId);
    if (!entry || !detail) return;
    entry.unread = detail.channels.some(c => c.unread);
    entry.mention_count = detail.channels.reduce((n, c) => n + (c.mention_count || 0), 0);
    renderServers();
  }

  // -- Navigation without a full route re-render --

  function open(sid, cid, { replace = false } = {}) {
    const url = sid ? (cid ? `/servers/${sid}/${cid}` : `/servers/${sid}`) : '/servers';
    if (location.pathname !== url) (replace ? history.replaceState : history.pushState).call(history, { svInternal: true }, '', url);
    const serverChanged = sid !== serverId;
    serverId = sid;
    channelId = cid;
    if (serverChanged) {
      detail = sid ? cache.detail.get(sid) || null : null;
      detailError = null;
      members = sid ? cache.members.get(sid) || null : null;
      lastOnline = null;
      membersFetchedAt = 0;
      if (sid) { loadDetail(); refreshMembers({ force: true }); }
    }
    if (detail && !cid && !phoneQuery.matches) {
      const pick = pickChannel(detail);
      if (pick) { channelId = pick; history.replaceState({ svInternal: true }, '', `/servers/${sid}/${pick}`); }
    }
    if (!wideQuery.matches) { showMembers = false; root.classList.remove('members-open'); }
    renderServers();
    renderChannels();
    renderMembers();
    if (!serverChanged && pane && pane.channelId === channelId) pane.focus();
    else openPane();
    syncLevel();
    window.scrollTo(0, 0);
  }

  // -- Dialogs: servers --

  function createServerDialog() {
    const name = h('input.input.boxed', { maxLength: 100, placeholder: 'Server name', required: true });
    const description = h('textarea.textarea.boxed', { maxLength: 500, rows: 3, placeholder: 'What is it for?' });
    const submit = h('button', { type: 'submit' }, 'Create server');
    dialog({
      title: 'Create server',
      actions: [],
      body: close => h('form', {
        onsubmit: async e => {
          e.preventDefault();
          submit.disabled = true;
          try {
            const res = await api.post('servers', { name: name.value, description: description.value });
            close();
            toast('Server created.');
            cache.servers = [...(cache.servers || []), { ...res.server, unread: false, mention_count: 0 }];
            open(res.server.id, phoneQuery.matches ? null : res.channel_id);
          } catch (err) { toastError(err); submit.disabled = false; }
        },
      },
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Description (optional)'), description),
      h('p.fine', 'Your server starts with a #general channel. You can add more channels, roles and an icon later.'),
      h('div.row.sv-dialog-actions', h('button', { type: 'button', onclick: () => close() }, 'Cancel'), submit)),
      onOpen: () => name.focus(),
    });
  }

  function joinServerDialog(prefill = '') {
    const input = h('input.input.boxed', { value: prefill, placeholder: 'Invite link or code', required: true });
    const submit = h('button', { type: 'submit' }, 'Join server');
    dialog({
      title: 'Join server',
      actions: [],
      body: close => h('form', {
        onsubmit: async e => {
          e.preventDefault();
          const code = input.value.trim().split(/[/?#]/).filter(Boolean).pop() || '';
          if (!code) return;
          submit.disabled = true;
          try {
            const res = await api.post(`servers/join/${encodeURIComponent(code)}`);
            close();
            toast(res.joined ? `Joined ${res.server.name}.` : `You are already in ${res.server.name}.`);
            await refreshServers();
            open(res.server.id, null);
          } catch (err) { toastError(err); submit.disabled = false; }
        },
      },
      h('label.field', h('span', 'Invite link or code'), input),
      h('p.fine', 'Ask someone in the server for an invite link.'),
      h('div.row.sv-dialog-actions', h('button', { type: 'button', onclick: () => close() }, 'Cancel'), submit)),
      onOpen: () => input.focus(),
    });
  }

  function inviteDialog(d) {
    const link = inviteLink(d.server.invite_code);
    dialog({
      title: 'Invite people',
      actions: [{ label: 'Close', value: null }],
      body: h('div',
        h('p', `Send this link to people you want in ${d.server.name}.`),
        h('input.input.boxed', { value: link, readOnly: true, 'aria-label': 'Invite link', onfocus: e => e.target.select() }),
        h('div.row.wrap', { style: 'margin-top:10px' }, h('button', { type: 'button', onclick: () => copy(link, 'Invite link copied.') }, 'Copy invite link'))),
    });
  }

  async function leaveServer(d) {
    if (!(await confirm(`You will stop seeing ${d.server.name}. You can join again with an invite link.`, { title: 'Leave server?', ok: 'Leave server' }))) return;
    try {
      await api.post(`servers/${d.server.id}/leave`);
      toast(`Left ${d.server.name}.`);
      cache.detail.delete(d.server.id);
      if (cache.servers) cache.servers = cache.servers.filter(s => s.id !== d.server.id);
      open(null, null);
    } catch (err) { toastError(err); }
  }

  async function reload() {
    await loadDetail({ quiet: true });
    refreshMembers({ force: true });
  }

  // -- Dialogs: channels and categories --

  function channelDialog(d, ch, categoryId = null) {
    const editing = Boolean(ch);
    const name = h('input.input.boxed', { value: ch?.name || '', maxLength: 40, placeholder: 'new-channel', required: true });
    const topic = h('input.input.boxed', { value: ch?.topic || '', maxLength: 300, placeholder: 'What this channel is for' });
    const category = h('select.select', { 'aria-label': 'Category' },
      h('option', { value: '' }, 'No category'),
      [...d.categories].sort((a, b) => a.position - b.position).map(c =>
        h('option', { value: c.id, selected: (ch ? ch.category_id : categoryId) === c.id }, c.name)));
    const kind = h('select.select', { 'aria-label': 'Type' },
      h('option', { value: 'text', selected: ch?.kind !== 'announcement' }, 'Text'),
      h('option', { value: 'announcement', selected: ch?.kind === 'announcement' }, 'Announcements (moderators post)'));
    const slow = h('select.select', { 'aria-label': 'Slowmode' },
      (d.limits?.slowmodes || [0]).map(s => h('option', { value: String(s), selected: (ch?.slowmode_seconds || 0) === s }, SLOWMODE_LABELS[s] || `${s} seconds`)));
    const preview = h('p.fine');
    const updatePreview = () => { preview.textContent = `Shown as #${name.value.toLowerCase().trim().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '') || 'new-channel'}`; };
    name.addEventListener('input', updatePreview);
    updatePreview();
    const submit = h('button', { type: 'submit' }, editing ? 'Save' : 'Create channel');
    dialog({
      title: editing ? `Edit #${ch.name}` : 'Create channel',
      actions: [],
      body: close => h('form', {
        onsubmit: async e => {
          e.preventDefault();
          submit.disabled = true;
          const payload = { name: name.value, topic: topic.value, category_id: category.value || null, kind: kind.value, slowmode_seconds: Number(slow.value) };
          try {
            const res = editing
              ? await api.patch(`servers/${d.server.id}/channels/${ch.id}`, payload)
              : await api.post(`servers/${d.server.id}/channels`, payload);
            close();
            toast(editing ? 'Saved.' : 'Channel created.');
            await loadDetail({ quiet: true });
            if (!editing) open(d.server.id, res.channel.id);
          } catch (err) { toastError(err); submit.disabled = false; }
        },
      },
      h('label.field', h('span', 'Name'), name), preview,
      h('label.field', h('span', 'Topic'), topic),
      h('label.field', h('span', 'Category'), category),
      h('label.field', h('span', 'Type'), kind),
      h('label.field', h('span', 'Slowmode'), slow),
      h('p.fine', 'Slowmode limits how often each member can post. Moderators are not affected.'),
      h('div.row.sv-dialog-actions',
        editing ? h('button', { type: 'button', onclick: async () => { if (await deleteChannel(d, ch)) close(); } }, 'Delete channel') : null,
        h('span.grow'),
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'), submit)),
      onOpen: () => name.focus(),
    });
  }

  async function deleteChannel(d, ch) {
    if (!(await confirm(`Delete #${ch.name} and all of its messages? This cannot be undone.`, { title: 'Delete channel?', ok: 'Delete channel' }))) return false;
    try {
      await api.del(`servers/${d.server.id}/channels/${ch.id}`);
      toast('Deleted.');
      if (channelId === ch.id) channelId = null;
      await loadDetail({ quiet: true });
      return true;
    } catch (err) { toastError(err); return false; }
  }

  async function categoryDialog(d, cat) {
    const value = await promptDialog('Name', { title: cat ? 'Rename category' : 'Create category', value: cat?.name || '', placeholder: 'Category name', ok: cat ? 'Save' : 'Create category' });
    if (value === null) return;
    try {
      if (cat) await api.patch(`servers/${d.server.id}/categories/${cat.id}`, { name: value });
      else await api.post(`servers/${d.server.id}/categories`, { name: value });
      toast(cat ? 'Saved.' : 'Category created.');
      await loadDetail({ quiet: true });
    } catch (err) { toastError(err); }
  }

  // -- Dialogs: members --

  async function nicknameDialog(d, m, self) {
    const value = await promptDialog(self ? 'Your nickname in this server' : `Nickname for ${m.user.name}`, {
      title: 'Change nickname', value: m.nickname || '', placeholder: m.user.name, ok: 'Save',
    });
    if (value === null) return;
    try {
      await api.patch(`servers/${d.server.id}/members/${self ? 'me' : m.user.id}`, { nickname: value });
      toast('Saved.');
      if (self) { d.me.nickname = value || null; renderChannels(); }
      refreshMembers({ force: true });
    } catch (err) { toastError(err); }
  }

  function memberRolesDialog(d, m) {
    const roles = d.roles.filter(r => !r.is_everyone).sort((a, b) => b.position - a.position);
    const top = myTop(d);
    const held = new Set(m.role_ids);
    dialog({
      title: `Roles for ${m.display_name}`,
      actions: [{ label: 'Done', value: true, primary: true }],
      body: roles.length ? h('div.sv-checks', roles.map(r => {
        const box = h('input', { type: 'checkbox', checked: held.has(r.id), disabled: !(d.me.is_owner || r.position < top) });
        box.addEventListener('change', async () => {
          box.disabled = true;
          try {
            if (box.checked) await api.put(`servers/${d.server.id}/members/${m.user.id}/roles/${r.id}`);
            else await api.del(`servers/${d.server.id}/members/${m.user.id}/roles/${r.id}`);
            if (box.checked) held.add(r.id); else held.delete(r.id);
            m.role_ids = [...held];
            renderMembers();
          } catch (err) { toastError(err); box.checked = !box.checked; }
          box.disabled = false;
        });
        return h('label.checkbox', box, h('span', r.name));
      })) : h('p', 'This server has no roles yet. Create them in Server settings.'),
    }).then(() => reload());
  }

  async function kick(d, m) {
    if (!(await confirm(`Remove ${m.display_name} from ${d.server.name}? They can join again with an invite link.`, { title: 'Kick member?', ok: 'Kick' }))) return false;
    try {
      await api.del(`servers/${d.server.id}/members/${m.user.id}`);
      toast(`Removed ${m.display_name}.`);
      refreshMembers({ force: true });
      return true;
    } catch (err) { toastError(err); return false; }
  }

  async function ban(d, m) {
    const reason = await promptDialog(`Ban ${m.display_name} from ${d.server.name}? They will be removed and cannot join again until unbanned.`, {
      title: 'Ban member?', placeholder: 'Reason (optional)', ok: 'Ban',
    });
    if (reason === null) return false;
    try {
      await api.put(`servers/${d.server.id}/bans/${m.user.id}`, { reason });
      toast(`Banned ${m.display_name}.`);
      refreshMembers({ force: true });
      return true;
    } catch (err) { toastError(err); return false; }
  }

  // -- Server settings dialog --

  function settingsDialog(d) {
    const sections = [
      { key: 'overview', label: 'Overview' },
      can(d, 'manage_channels') ? { key: 'channels', label: 'Channels' } : null,
      can(d, 'manage_roles') ? { key: 'roles', label: 'Roles' } : null,
      ['kick_members', 'ban_members', 'manage_roles', 'manage_server'].some(p => can(d, p)) ? { key: 'members', label: 'Members' } : null,
      can(d, 'ban_members') ? { key: 'bans', label: 'Bans' } : null,
    ].filter(Boolean);
    let current = 'overview';
    const content = h('div.sv-settings-body');
    const strip = h('div');
    const current$ = () => detail && detail.server.id === d.server.id ? detail : d;

    function show(key) {
      current = key;
      mount(strip, tabs(sections.map(s => ({ label: s.label, selected: s.key === current, onClick: () => show(s.key) }))));
      const dd = current$();
      mount(content, loading());
      const build = { overview: overviewTab, channels: channelsTab, roles: rolesTab, members: membersTab, bans: bansTab }[key];
      Promise.resolve(build(dd, () => show(current))).then(node => { if (current === key) mount(content, node); })
        .catch(err => mount(content, errorBox(err)));
    }

    dialog({
      title: 'Server settings',
      wide: true,
      actions: [{ label: 'Close', value: null }],
      body: h('div.sv-settings', strip, content),
      onOpen: () => show('overview'),
    });
  }

  function overviewTab(d, redraw) {
    const editable = can(d, 'manage_server');
    const name = h('input.input.boxed', { value: d.server.name, maxLength: 100, disabled: !editable });
    const description = h('textarea.textarea.boxed', { rows: 3, maxLength: 500, disabled: !editable }, d.server.description);
    const iconBox = h('div.sv-icon-edit', serverIcon(d.server, 'lg'));
    const status = h('span.fine');
    const link = inviteLink(d.server.invite_code);
    const save = async () => {
      try {
        await api.patch(`servers/${d.server.id}`, { name: name.value, description: description.value });
        toast('Saved.');
        await loadDetail({ quiet: true });
      } catch (err) { toastError(err); }
    };
    const uploadIcon = async () => {
      const [file] = await pickFiles({ accept: 'image/*' });
      if (!file) return;
      status.textContent = 'Uploading';
      try {
        const media = await uploadFile(file, { maxEdge: 512, onProgress: p => { status.textContent = `Uploading ${Math.round(p * 100)}%`; } });
        await api.patch(`servers/${d.server.id}`, { icon_media_id: media.id });
        status.textContent = '';
        toast('Saved.');
        await loadDetail({ quiet: true });
        redraw();
      } catch (err) { status.textContent = ''; toastError(err); }
    };
    const removeIcon = async () => {
      try { await api.patch(`servers/${d.server.id}`, { icon_media_id: null }); await loadDetail({ quiet: true }); redraw(); } catch (err) { toastError(err); }
    };
    const rotate = async () => {
      if (!(await confirm('The current invite link will stop working.', { title: 'New invite link?', ok: 'New invite link' }))) return;
      try { await api.post(`servers/${d.server.id}/invite`); toast('New invite link made.'); await loadDetail({ quiet: true }); redraw(); } catch (err) { toastError(err); }
    };
    const remove = async () => {
      const typed = await promptDialog(`Type the server name (${d.server.name}) to delete it and every channel and message in it.`, { title: 'Delete server?', ok: 'Delete server' });
      if (typed === null) return;
      if (typed !== d.server.name) { toast('The name did not match.', { error: true }); return; }
      try {
        await api.del(`servers/${d.server.id}`);
        document.querySelectorAll('.overlay').forEach(o => o.remove());
        toast('Deleted.');
        cache.detail.delete(d.server.id);
        if (cache.servers) cache.servers = cache.servers.filter(s => s.id !== d.server.id);
        open(null, null);
      } catch (err) { toastError(err); }
    };
    return h('div.stack',
      h('div.row.wrap', iconBox,
        editable ? h('div.stack', { style: 'gap:6px' },
          h('div.row.wrap', h('button.btn-small', { type: 'button', onclick: uploadIcon }, 'Upload icon'),
            d.server.icon_url ? h('button.btn-small', { type: 'button', onclick: removeIcon }, 'Remove icon') : null),
          status) : null),
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Description'), description),
      editable ? h('div.row', h('button', { type: 'button', onclick: save }, 'Save')) : null,
      h('hr.divider'),
      h('p.field-label', 'Invite link'),
      h('input.input.boxed', { value: link, readOnly: true, 'aria-label': 'Invite link', onfocus: e => e.target.select() }),
      h('p.fine', `Invite code: ${d.server.invite_code}`),
      h('div.row.wrap',
        h('button', { type: 'button', onclick: () => copy(link, 'Invite link copied.') }, 'Copy invite link'),
        editable ? h('button', { type: 'button', onclick: rotate }, 'New invite link') : null),
      d.me.is_owner ? h('hr.divider') : null,
      d.me.is_owner ? h('div.row.wrap', h('span.grow.fine', 'Deleting the server removes every channel and message.'),
        h('button', { type: 'button', onclick: remove }, 'Delete server')) : null);
  }

  function channelsTab(d, redraw) {
    const { cats, byCat } = sortedChannels(d);
    const orderChannels = () => [...byCat.get(null), ...cats.flatMap(c => byCat.get(c.id))];
    async function saveOrder(categories, channels) {
      try {
        await api.post(`servers/${d.server.id}/reorder`, {
          categories: categories.map(c => c.id),
          channels: channels.map(c => ({ id: c.id, category_id: c.category_id })),
        });
        await loadDetail({ quiet: true });
        redraw();
      } catch (err) { toastError(err); }
    }
    function moveChannel(ch, dir) {
      const list = byCat.get(ch.category_id) || byCat.get(null);
      const i = list.indexOf(ch), j = i + dir;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      saveOrder(cats, orderChannels());
    }
    function moveCategory(cat, dir) {
      const i = cats.indexOf(cat), j = i + dir;
      if (j < 0 || j >= cats.length) return;
      [cats[i], cats[j]] = [cats[j], cats[i]];
      saveOrder(cats, orderChannels());
    }
    const afterDialog = () => setTimeout(redraw, 50);
    const channelRow = (ch, i, list) => h('li.sv-set-row',
      h('span.grow', `# ${ch.name}`, ch.kind === 'announcement' ? h('span.fine', ' Announcements') : null,
        ch.slowmode_seconds ? h('span.fine', ` Slowmode ${SLOWMODE_LABELS[ch.slowmode_seconds] || ch.slowmode_seconds}`) : null),
      h('button.btn-small', { type: 'button', disabled: i === 0, onclick: () => moveChannel(ch, -1) }, 'Move up'),
      h('button.btn-small', { type: 'button', disabled: i === list.length - 1, onclick: () => moveChannel(ch, 1) }, 'Move down'),
      h('button.btn-small', { type: 'button', onclick: () => { channelDialog(d, ch); afterDialog(); } }, 'Edit'));
    const deleteCategory = async cat => {
      if (!(await confirm(`Delete the ${cat.name} category? Its channels are kept and move out of the category.`, { title: 'Delete category?', ok: 'Delete category' }))) return;
      try { await api.del(`servers/${d.server.id}/categories/${cat.id}`); toast('Deleted.'); await loadDetail({ quiet: true }); redraw(); } catch (err) { toastError(err); }
    };
    return h('div',
      h('div.row.wrap', { style: 'margin-bottom:10px' },
        h('button', { type: 'button', onclick: () => channelDialog(d, null) }, 'Create channel'),
        h('button', { type: 'button', onclick: async () => { await categoryDialog(d, null); redraw(); } }, 'Create category')),
      byCat.get(null).length ? h('div.sv-set-group', h('p.eyebrow', 'No category'), h('ul.sv-set-list', byCat.get(null).map(channelRow))) : null,
      cats.map((cat, ci) => h('div.sv-set-group',
        h('div.row.wrap.sv-set-cat',
          h('strong.grow', cat.name),
          h('button.btn-small', { type: 'button', disabled: ci === 0, onclick: () => moveCategory(cat, -1) }, 'Move up'),
          h('button.btn-small', { type: 'button', disabled: ci === cats.length - 1, onclick: () => moveCategory(cat, 1) }, 'Move down'),
          h('button.btn-small', { type: 'button', onclick: async () => { await categoryDialog(d, cat); redraw(); } }, 'Rename'),
          h('button.btn-small', { type: 'button', onclick: () => deleteCategory(cat) }, 'Delete')),
        byCat.get(cat.id).length ? h('ul.sv-set-list', byCat.get(cat.id).map(channelRow)) : h('p.fine', 'No channels.'))));
  }

  function rolesTab(d, redraw) {
    const roles = [...d.roles].sort((a, b) => b.position - a.position);
    const ranked = roles.filter(r => !r.is_everyone);
    const top = myTop(d);
    const editor = h('div');
    async function move(role, dir) {
      const ids = ranked.map(r => r.id);
      const i = ids.indexOf(role.id), j = i + dir;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try { await api.post(`servers/${d.server.id}/roles/reorder`, { ids }); await loadDetail({ quiet: true }); redraw(); } catch (err) { toastError(err); }
    }
    async function remove(role) {
      if (!(await confirm(`Delete the ${role.name} role? Members keep their other roles.`, { title: 'Delete role?', ok: 'Delete role' }))) return;
      try { await api.del(`servers/${d.server.id}/roles/${role.id}`); toast('Deleted.'); await loadDetail({ quiet: true }); redraw(); } catch (err) { toastError(err); }
    }
    function edit(role) {
      const name = role ? null : h('input.input.boxed', { maxLength: 40, placeholder: 'Moderators' });
      const renamed = role && !role.is_everyone ? h('input.input.boxed', { maxLength: 40, value: role.name }) : null;
      const boxes = PERMISSIONS.map(([key, label, hint]) => {
        const bit = PERM_BITS[key];
        const box = h('input', { type: 'checkbox', checked: role ? (role.permissions & bit) === bit : false, disabled: !can(d, key) });
        box.dataset.bit = String(bit);
        return h('label.checkbox', box, h('span', h('strong', label), h('br'), h('span.fine', hint)));
      });
      const bits = () => boxes.reduce((n, l) => { const b = l.querySelector('input'); return b.checked ? n | Number(b.dataset.bit) : n; }, 0);
      const save = async () => {
        try {
          if (role) await api.patch(`servers/${d.server.id}/roles/${role.id}`, { ...(renamed ? { name: renamed.value } : {}), permissions: bits() });
          else await api.post(`servers/${d.server.id}/roles`, { name: name.value, permissions: bits() });
          toast(role ? 'Saved.' : 'Role created.');
          await loadDetail({ quiet: true });
          redraw();
        } catch (err) { toastError(err); }
      };
      mount(editor, h('div.sv-role-editor',
        h('h3', role ? `Edit ${role.name}` : 'Create role'),
        role?.is_everyone ? h('p.fine', 'Everyone in the server has @everyone.') : null,
        name ? h('label.field', h('span', 'Name'), name) : null,
        renamed ? h('label.field', h('span', 'Name'), renamed) : null,
        h('div.sv-checks', boxes),
        h('div.row', h('button', { type: 'button', onclick: () => mount(editor) }, 'Cancel'), h('button', { type: 'button', onclick: save }, role ? 'Save' : 'Create role'))));
      (name || renamed || editor.querySelector('input'))?.focus();
    }
    return h('div',
      h('div.row.wrap', { style: 'margin-bottom:10px' }, h('button', { type: 'button', onclick: () => edit(null) }, 'Create role')),
      editor,
      h('ul.sv-set-list', roles.map(r => {
        const manageable = d.me.is_owner || r.position < top;
        const i = ranked.indexOf(r);
        return h('li.sv-set-row',
          h('span.grow', h('strong', r.name), ' ', h('span.fine', r.is_everyone ? 'All members' : plural(r.member_count || 0, 'member'))),
          !r.is_everyone ? h('button.btn-small', { type: 'button', disabled: !manageable || i === 0, onclick: () => move(r, -1) }, 'Move up') : null,
          !r.is_everyone ? h('button.btn-small', { type: 'button', disabled: !manageable || i === ranked.length - 1, onclick: () => move(r, 1) }, 'Move down') : null,
          h('button.btn-small', { type: 'button', disabled: !manageable, onclick: () => edit(r) }, 'Edit'),
          !r.is_everyone ? h('button.btn-small', { type: 'button', disabled: !manageable, onclick: () => remove(r) }, 'Delete') : null);
      })),
      h('p.fine', 'Roles higher in the list outrank the ones below. Members can only manage roles and members below their own highest role.'));
  }

  async function membersTab(d, redraw) {
    const data = await api.get(`servers/${d.server.id}/members`);
    const by = rolesById(d);
    return h('div',
      h('p.fine', `${plural(data.items.length, 'member')}, ${data.online_count} online.`),
      h('ul.sv-set-list', data.items.map(m => {
        const self = m.user.id === me().id;
        const above = outranks(d, m);
        const roleNames = m.role_ids.map(id => by.get(id)?.name).filter(Boolean);
        return h('li.sv-set-row',
          avatar(m.user, { size: 'xs', link: false }),
          h('span.grow', h('strong', m.display_name), ' ', h('span.fine', `@${m.user.handle}`),
            m.is_owner ? h('span.fine', ' Owner') : null,
            roleNames.length ? h('span.fine', ` ${roleNames.join(', ')}`) : null),
          can(d, 'manage_roles') && (self || above) ? h('button.btn-small', { type: 'button', onclick: () => memberRolesDialog(d, m) }, 'Roles') : null,
          self || (can(d, 'manage_server') && above) ? h('button.btn-small', { type: 'button', onclick: async () => { await nicknameDialog(d, m, self); redraw(); } }, 'Nickname') : null,
          !self && can(d, 'kick_members') && above ? h('button.btn-small', { type: 'button', onclick: async () => { if (await kick(d, m)) redraw(); } }, 'Kick') : null,
          !self && can(d, 'ban_members') && above ? h('button.btn-small', { type: 'button', onclick: async () => { if (await ban(d, m)) redraw(); } }, 'Ban') : null);
      })));
  }

  async function bansTab(d, redraw) {
    const data = await api.get(`servers/${d.server.id}/bans`);
    if (!data.items.length) return empty({ title: 'No bans.' });
    return h('ul.sv-set-list', data.items.map(b => h('li.sv-set-row',
      avatar(b.user, { size: 'xs', link: false }),
      h('span.grow', h('strong', b.user.name), ' ', h('span.fine', `@${b.user.handle}`), b.reason ? h('span.fine', ` Reason: ${b.reason}`) : null),
      h('button.btn-small', {
        type: 'button',
        onclick: async () => {
          try { await api.del(`servers/${d.server.id}/bans/${b.user.id}`); toast(`Unbanned ${b.user.name}.`); redraw(); } catch (err) { toastError(err); }
        },
      }, 'Unban'))));
  }

  // -- Wiring --

  root.classList.toggle('members-open', showMembers);
  renderServers();
  renderChannels();
  renderMembers();
  openPane();
  syncLevel();
  refreshServers();
  if (serverId) { loadDetail(); refreshMembers({ force: true }); }

  const listTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshServers(); }, POLL.list);

  const measure = () => {
    const top = root.getBoundingClientRect().top + window.scrollY;
    root.style.setProperty('--sv-top', `${Math.max(0, Math.round(top))}px`);
  };
  const onViewport = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    root.style.setProperty('--sv-vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--sv-vvt', `${Math.round(vv.offsetTop)}px`);
  };
  const onPhoneChange = () => {
    setLayout();
    showMembers = wideQuery.matches;
    root.classList.toggle('members-open', showMembers);
    syncLevel();
    requestAnimationFrame(measure);
  };
  requestAnimationFrame(() => { measure(); onViewport(); });
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('scroll', onViewport);
  phoneQuery.addEventListener('change', onPhoneChange);
  wideQuery.addEventListener('change', onPhoneChange);

  ctx.cleanup(() => {
    pane?.destroy();
    clearInterval(listTimer);
    clearTimeout(membersTimer);
    window.removeEventListener('resize', measure);
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('scroll', onViewport);
    phoneQuery.removeEventListener('change', onPhoneChange);
    wideQuery.removeEventListener('change', onPhoneChange);
    document.documentElement.classList.remove('sv-lock');
  });

  return root;
}

// -- Invite page (/servers/join/:code) ------------------------------------

async function invitePage(ctx, code) {
  ctx.layout('default');
  ctx.title('Server invite');
  const card = h('div.south-card.sv-invite', loading());
  const root = h('div', h('div.page-head', h('h1', 'Server invite')), card);
  try {
    const data = await api.get(`servers/invite/${encodeURIComponent(code)}`, {}, { signal: ctx.signal });
    const s = data.server;
    const join = h('button.btn-large', { type: 'button' }, 'Join server');
    join.addEventListener('click', async () => {
      join.disabled = true;
      try {
        const res = await api.post(`servers/join/${encodeURIComponent(code)}`);
        cache.servers = null;
        toast(`Joined ${res.server.name}.`);
        navigate(`/servers/${res.server.id}`, { replace: true });
      } catch (err) { toastError(err); join.disabled = false; }
    });
    mount(card,
      h('div.row', serverIcon(s, 'lg'), h('div.grow', h('p.eyebrow', 'You have been invited to join'), h('h2', s.name), h('p.fine', plural(s.member_count, 'member')))),
      s.description ? h('p', s.description) : null,
      data.banned ? h('p', 'You are banned from this server.')
        : data.is_member ? h('a.btn', { href: `/servers/${s.id}` }, 'Open server')
          : join);
  } catch (err) {
    if (err.name === 'AbortError') return null;
    mount(card, h('h2', 'Invite not found'), h('p', err.status === 404 ? 'This invite is invalid or has expired.' : err.message), h('a.btn', { href: '/servers' }, 'Servers'));
  }
  return root;
}

// -- One open channel -----------------------------------------------------

function channelPane({ detail: initialDetail, channel: initialChannel, signal, onBack, onToggleMembers, membersShown, onChannels, onStructure, onOnline, onGone, onChannelGone }) {
  let d = initialDetail;
  let ch = initialChannel;
  const serverId = d.server.id;
  const channelId = ch.id;
  const base = `servers/${serverId}/channels/${channelId}`;
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort());

  let server = []; // confirmed messages, oldest -> newest
  let pending = []; // optimistic sends
  let next = null; // cursor for older messages
  let after = ''; // newest confirmed id
  let since = null; // server time of the last poll
  let destroyed = false, ready = false, loadingOlder = false, sending = 0, tempSeq = 0;
  let pollTimer = null, lastActivity = Date.now();
  let typingPeople = [];
  let editingId = null;
  let replyTo = null; // message being replied to
  let atBottom = true;
  const rows = new Map(); // key -> { sig, el }
  const localUrls = []; // object URLs of photos sent from here, revoked when the channel closes

  const head = h('header.sv-chat-head');
  const olderStatus = h('div.sv-older');
  const list = h('div.sv-msgs');
  const topSentinel = h('div.sv-sentinel');
  const scroller = h('div.sv-scroll', { role: 'log', 'aria-label': `Messages in #${ch.name}`, tabIndex: 0 }, topSentinel, olderStatus, list);
  const jump = h('button.sv-jump.hidden', { type: 'button', onclick: () => { scrollToBottom(true); jump.classList.add('hidden'); } }, 'New messages');
  const typingLine = h('div.sv-typing', { 'aria-live': 'polite' });
  const composer = buildComposer();
  const el = h('div.sv-channel-pane', head, h('div.sv-scroll-wrap', scroller, jump), typingLine, composer.el);

  const mine = m => Boolean(m.author && m.author.id === me()?.id);
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const scrollToBottom = smooth => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  const byId = id => server.find(m => m.id === id);
  const bump = () => { lastActivity = Date.now(); };

  function renderHead() {
    const pins = h('button.btn-small', { type: 'button', onclick: pinsDialog }, 'Pins');
    const membersBtn = h('button.btn-small.sv-members-toggle', { type: 'button', 'aria-pressed': String(membersShown()), onclick: onToggleMembers }, 'Members');
    mount(head,
      h('button.sv-back', { type: 'button', 'aria-label': 'Back to channels', onclick: onBack }, 'Back'),
      h('div.sv-chat-title',
        h('h2', `# ${ch.name}`),
        ch.topic || ch.kind === 'announcement'
          ? h('p.sv-topic', { title: ch.topic || null }, ch.kind === 'announcement' ? `Announcements. ${ch.topic}`.trim() : ch.topic)
          : null),
      h('div.sv-chat-actions', pins, membersBtn));
  }

  // -- Rendering messages --

  function continued(prev, m) {
    return Boolean(prev && !prev.deleted && prev.author && m.author && prev.author.id === m.author.id && !m.reply_to
      && m.created_at - prev.created_at < GROUP_GAP && dayKey(prev.created_at) === dayKey(m.created_at));
  }

  function signature(m, cont) {
    return [m.body, m.edited_at, m.pinned, JSON.stringify(m.reactions), cont, m.pending, m.failed, editingId === (m.id || m._key), m.author?.display_name].join('|');
  }

  function reactionBar(m) {
    if (!m.reactions?.length || m.pending) return null;
    return h('div.sv-reactions', m.reactions.map(r => h('button.btn-small.sv-reaction', {
      type: 'button', 'aria-pressed': String(r.me), title: r.me ? 'Remove your reaction' : 'React',
      onclick: () => toggleReaction(m, r.reaction, !r.me),
    }, `${REACTION_LABELS[r.reaction] || r.reaction} ${r.count}`)));
  }

  function mediaNode(media) {
    return h('a.sv-img', {
      href: media.url, 'aria-label': 'Open photo',
      onclick: e => { if (!plainClick(e)) return; e.preventDefault(); lightbox(media.url, media.alt); },
    }, h('img', { src: media.url, alt: media.alt || 'Photo', loading: 'lazy', decoding: 'async' }));
  }

  function editor(m) {
    const area = h('textarea.sv-edit-input', { rows: 2, maxLength: MAX_BODY, 'aria-label': 'Edit message' }, m.body);
    const save = async () => {
      const text = area.value.trim();
      if (text === m.body) { editingId = null; render(); return; }
      try {
        const res = await api.patch(`${base}/messages/${m.id}`, { body: text });
        replaceMessage(res.message);
        editingId = null;
        render();
        composer.focus();
      } catch (err) { toastError(err); }
    };
    area.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editingId = null; render(); composer.focus(); }
    });
    setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); });
    return h('div.sv-editing', area,
      h('div.row', h('span.fine.grow', 'Enter to save, Escape to cancel.'),
        h('button.btn-small', { type: 'button', onclick: () => { editingId = null; render(); } }, 'Cancel'),
        h('button.btn-small', { type: 'button', onclick: save }, 'Save')));
  }

  function rowFor(m, cont) {
    const key = m._key || m.id;
    const sig = signature(m, cont);
    const cached = rows.get(key);
    if (cached && cached.sig === sig) return cached.el;
    const author = m.author;
    const name = author ? author.display_name : 'Deleted account';
    const more = m.pending ? null : h('button.btn-small.sv-more', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `More options for the message from ${name}` }, 'More');
    more?.addEventListener('click', () => messageMenu(more, m));
    const reply = m.reply_to ? h('div.sv-reply', {
      onclick: () => jumpTo(m.reply_to.id),
    }, m.reply_to.deleted ? h('span.muted', 'Original message was deleted.')
      : [h('span.muted', 'Replying to '), h('strong', m.reply_to.author?.display_name || 'Deleted account'), ': ',
        h('span.sv-reply-text', m.reply_to.body || (m.reply_to.has_media ? 'Photo' : ''))]) : null;
    const time = h('time.sv-time', { datetime: new Date(m.created_at).toISOString(), title: fullDate(m.created_at) }, cont ? clock(m.created_at) : stamp(m.created_at));
    const bodyParts = editingId === key ? editor(m) : [
      m.body ? h('div.sv-text', messageText(m.body), m.edited_at ? h('span.sv-edited', { title: `Edited ${fullDate(m.edited_at)}` }, ' (edited)') : null) : null,
      m.media ? mediaNode(m.media) : null,
    ];
    let status = null;
    if (m.failed) {
      status = h('div.sv-status', `Not sent. ${m.error || ''} `,
        h('button.btn-small', { type: 'button', onclick: () => sendPending(m) }, 'Retry'), ' ',
        h('button.btn-small', { type: 'button', onclick: () => discard(m) }, 'Discard'));
    } else if (m.pending) status = h('div.sv-status', 'Sending');
    const row = h('article.sv-msg', {
      class: { continued: cont, mention: m.mentions_me, pending: m.pending, failed: m.failed, pinned: m.pinned, mine: mine(m) },
      dataset: { id: m.id || '' }, tabIndex: -1,
    },
    reply,
    h('div.sv-msg-main',
      h('div.sv-msg-av', cont ? time : author ? avatar(author, { size: 'sm' }) : h('span.avatar.sm')),
      h('div.sv-msg-body',
        cont ? null : h('div.sv-msg-head',
          author ? h('a.sv-author', { href: `/@${author.handle}` }, name) : h('span.sv-author', name),
          time,
          m.pinned ? h('span.sv-pinned', 'Pinned') : null),
        bodyParts,
        reactionBar(m),
        status),
      more));
    rows.set(key, { sig, el: row });
    return row;
  }

  function render() {
    const msgs = [...server, ...pending];
    const out = [];
    let prev = null, prevDay = null;
    for (const m of msgs) {
      const day = dayKey(m.created_at);
      if (day !== prevDay) { out.push(h('div.sv-day', h('span', dayLabel(m.created_at)))); prevDay = day; prev = null; }
      out.push(rowFor(m, continued(prev, m)));
      prev = m;
    }
    if (!msgs.length && ready) out.push(h('div.sv-empty', h('p', 'No messages yet.'), h('p.fine', `This is the start of #${ch.name}.`)));
    list.replaceChildren(...out);
    mount(olderStatus, loadingOlder ? loading('Loading older messages')
      : ready && !next && server.length ? h('p', `This is the start of #${ch.name}.`) : null);
  }

  function addServer(items) {
    const known = new Set(server.map(m => m.id));
    const fresh = items.filter(m => !known.has(m.id));
    if (!fresh.length) return [];
    server = [...server, ...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const newest = server.at(-1).id;
    if (newest > after) after = newest;
    return fresh;
  }

  function replaceMessage(m) {
    const i = server.findIndex(x => x.id === m.id);
    if (i >= 0) server[i] = m;
    return i >= 0;
  }

  function removeMessage(id) {
    server = server.filter(m => m.id !== id);
    rows.delete(id);
    if (replyTo?.id === id) { replyTo = null; composer.renderReply(); }
    if (editingId === id) editingId = null;
  }

  function jumpTo(id) {
    const row = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) { toast('That message is further up. Scroll up to load it.'); return; }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 2000);
  }

  // -- Message actions --

  function messageMenu(anchor, m) {
    const own = mine(m);
    const mod = can(d, 'manage_messages');
    const allowed = canPost(d, ch);
    menu(anchor, [
      allowed ? { label: 'Reply', onClick: () => { replyTo = m; composer.renderReply(); composer.focus(); } } : null,
      { label: 'React', onClick: () => reactMenu(anchor, m) },
      own ? { label: 'Edit', onClick: () => { editingId = m.id; render(); } } : null,
      mod ? { label: m.pinned ? 'Unpin' : 'Pin', onClick: () => togglePin(m) } : null,
      m.body ? { label: 'Copy text', onClick: () => copy(m.body, 'Copied.') } : null,
      own || mod ? 'divider' : null,
      own || mod ? { label: 'Delete', onClick: () => remove(m) } : null,
    ]);
  }

  function reactMenu(anchor, m) {
    setTimeout(() => menu(anchor, (d.limits?.reactions || Object.keys(REACTION_LABELS)).map(word => {
      const on = m.reactions?.some(r => r.reaction === word && r.me);
      return { label: `${REACTION_LABELS[word] || word}${on ? ' (remove)' : ''}`, onClick: () => toggleReaction(m, word, !on) };
    })));
  }

  async function toggleReaction(m, word, on) {
    bump();
    try {
      const res = on ? await api.put(`${base}/messages/${m.id}/reactions/${word}`) : await api.del(`${base}/messages/${m.id}/reactions/${word}`);
      if (res?.message) { replaceMessage(res.message); render(); }
    } catch (err) { toastError(err); }
  }

  async function togglePin(m) {
    try {
      const res = m.pinned ? await api.del(`${base}/messages/${m.id}/pin`) : await api.put(`${base}/messages/${m.id}/pin`);
      replaceMessage(res.message);
      render();
      toast(res.message.pinned ? 'Pinned.' : 'Unpinned.');
    } catch (err) { toastError(err); }
  }

  async function remove(m) {
    if (!(await confirm('Delete this message? This cannot be undone.', { title: 'Delete message?', ok: 'Delete' }))) return;
    try {
      await api.del(`${base}/messages/${m.id}`);
      removeMessage(m.id);
      render();
      toast('Deleted.');
    } catch (err) { toastError(err); }
  }

  async function pinsDialog() {
    const body = h('div.sv-pins', loading());
    dialog({ title: `Pinned in #${ch.name}`, wide: true, actions: [{ label: 'Close', value: null }], body });
    try {
      const data = await api.get(`${base}/pins`);
      if (!data.items.length) { mount(body, empty({ title: 'No pinned messages.', text: can(d, 'manage_messages') ? 'Pin a message from its More menu.' : null })); return; }
      mount(body, data.items.map(m => h('div.sv-pin',
        h('div.row', m.author ? avatar(m.author, { size: 'xs', link: false }) : null,
          h('strong', m.author?.display_name || 'Deleted account'),
          h('span.fine', stamp(m.created_at)),
          h('span.grow'),
          can(d, 'manage_messages') ? h('button.btn-small', {
            type: 'button',
            onclick: async e => {
              try {
                const res = await api.del(`${base}/messages/${m.id}/pin`);
                replaceMessage(res.message);
                render();
                e.target.closest('.sv-pin').remove();
                toast('Unpinned.');
              } catch (err) { toastError(err); }
            },
          }, 'Unpin') : null),
        m.body ? h('div.sv-text', messageText(m.body)) : null,
        m.media ? h('div.sv-pin-media', mediaNode(m.media)) : null)));
    } catch (err) { mount(body, errorBox(err)); }
  }

  // -- Loading --

  async function load() {
    renderHead();
    mount(list, loading());
    try {
      const data = await api.get(`${base}/messages`, { limit: 50 }, { signal: controller.signal });
      if (destroyed) return;
      next = data.next;
      since = data.now;
      addServer([...data.items].reverse());
      ready = true;
      render();
      scrollToBottom();
      composer.enable();
      if (!phoneQuery.matches) composer.focus();
      api.post(`${base}/read`).catch(() => {});
      schedule(POLL.fast);
    } catch (err) {
      if (err.name === 'AbortError' || destroyed) return;
      if (err.status === 404) { onChannelGone(); return; }
      mount(list, h('div.sv-pad', errorBox(err), h('button', { type: 'button', onclick: load }, 'Try again')));
    }
  }

  async function loadOlder() {
    if (!ready || !next || loadingOlder || destroyed) return;
    loadingOlder = true;
    render();
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    try {
      const data = await api.get(`${base}/messages`, { before: next, limit: 50 }, { signal: controller.signal });
      if (destroyed) return;
      next = data.next;
      addServer([...data.items].reverse());
    } catch (err) {
      if (err.name === 'AbortError') return;
      toastError(err);
    }
    loadingOlder = false;
    render();
    scroller.scrollTop = scroller.scrollHeight - fromBottom;
  }

  const olderObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loadOlder();
  }, { root: scroller, rootMargin: '200px 0px 0px 0px' });
  olderObserver.observe(topSentinel);
  scroller.addEventListener('scroll', () => {
    atBottom = nearBottom();
    if (atBottom) jump.classList.add('hidden');
  }, { passive: true });
  // Pictures load after the first paint; keep the view pinned to the bottom while they do.
  scroller.addEventListener('load', () => { if (atBottom) scrollToBottom(); }, true);

  // -- Polling (see POLL at the top) --

  function delay() {
    const idle = Date.now() - lastActivity;
    if (idle >= POLL.quietAfter) return POLL.slow;
    if (!document.hasFocus() || idle >= POLL.activeFor) return POLL.medium;
    return POLL.fast;
  }

  function schedule(ms = delay()) {
    clearTimeout(pollTimer);
    if (destroyed || !ready || document.visibilityState !== 'visible') return;
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (destroyed) return;
    if (sending) { schedule(1000); return; }
    let more = false;
    try {
      const data = await api.get(`${base}/poll`, { after, since, read: document.visibilityState === 'visible' ? 1 : '' }, { signal: controller.signal });
      if (destroyed) return;
      since = data.now;
      const wasNear = nearBottom();
      let changed = false;
      const fresh = addServer(data.items);
      if (fresh.length) {
        changed = true;
        bump();
        // Our own sends that another tab made, or ones confirmed here already, are fine either way.
      }
      for (const m of data.updated || []) if (replaceMessage(m)) changed = true;
      for (const id of data.deleted || []) if (byId(id)) { removeMessage(id); changed = true; }
      if (changed) {
        render();
        if (fresh.length) {
          if (wasNear) scrollToBottom(true);
          else if (fresh.some(m => !mine(m))) jump.classList.remove('hidden');
        }
      }
      setTyping(data.typing || []);
      if (data.channel && (data.channel.name !== ch.name || data.channel.topic !== ch.topic || data.channel.kind !== ch.kind || data.channel.slowmode_seconds !== ch.slowmode_seconds)) {
        ch = { ...ch, ...data.channel };
        renderHead();
        composer.update();
      }
      onChannels(data.channels || []);
      onOnline(data.online_count);
      if (data.structure_at > (d.server.structure_at || 0)) { d.server.structure_at = data.structure_at; onStructure(); }
      more = data.more;
    } catch (err) {
      if (err.name === 'AbortError' || destroyed) return;
      if (err.status === 404) {
        // Either the channel was deleted or we are no longer a member.
        try { await api.get(`servers/${serverId}`); onChannelGone(); } catch { onGone(); }
        return;
      }
    }
    schedule(more ? 0 : undefined);
  }

  function setTyping(people) {
    typingPeople = people;
    if (people.length) bump();
    typingLine.textContent = typingText(people);
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') { bump(); schedule(0); }
    else clearTimeout(pollTimer);
  };
  const onFocus = () => { bump(); schedule(250); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  // -- Sending --

  async function sendPending(m) {
    m.pending = true; m.failed = false; m.error = '';
    render();
    scrollToBottom(true);
    sending++;
    bump();
    try {
      const res = await api.post(`${base}/messages`, m.payload);
      if (destroyed) return;
      pending = pending.filter(x => x !== m);
      rows.delete(m._key);
      // Keep showing the local copy of a photo so it doesn't flash while the uploaded one loads.
      if (m.media && res.message.media) res.message.media = { ...res.message.media, url: m.media.url };
      addServer([res.message]);
      render();
      scrollToBottom(true);
      composer.startCooldown();
    } catch (err) {
      if (destroyed) return;
      m.pending = false; m.failed = true;
      m.error = err.status && err.status < 500 ? err.message : 'Check your connection and try again.';
      render();
    } finally {
      sending = Math.max(0, sending - 1);
    }
  }

  function discard(m) {
    pending = pending.filter(x => x !== m);
    rows.delete(m._key);
    render();
  }

  function submit({ body, attachment }) {
    const text = body.trim();
    if (!text && !attachment) return false;
    const payload = { body: text || undefined, media_id: attachment?.media?.id, reply_to_id: replyTo?.id };
    const author = { ...me(), avatar_url: me().avatar_url, nickname: d.me.nickname, display_name: d.me.nickname || me().name };
    const m = {
      _key: `tmp-${++tempSeq}`, id: '', pending: true, author, body: text,
      media: attachment ? { ...attachment.media, url: attachment.localUrl } : null,
      reply_to: replyTo ? { id: replyTo.id, author: replyTo.author, body: replyTo.body.slice(0, 120), has_media: Boolean(replyTo.media), deleted: false } : null,
      reactions: [], created_at: Date.now(), payload,
    };
    pending.push(m);
    replyTo = null;
    composer.renderReply();
    sendPending(m);
    return true;
  }

  // -- Composer --

  function buildComposer() {
    let attachment = null; // { file, localUrl, media, progress, controller, bar }
    let enabled = false, lastTypingSent = 0, cooldownUntil = 0, cooldownTimer = null;
    const textarea = h('textarea.sv-input', { rows: 1, maxLength: MAX_BODY, disabled: true });
    const attachBtn = h('button.sv-attach', { type: 'button', disabled: true }, 'Attach');
    const sendBtn = h('button.sv-send', { type: 'submit', disabled: true }, 'Send');
    const replyBar = h('div.sv-replying.hidden');
    const preview = h('div.sv-attachment.hidden');
    const note = h('div.sv-composer-note.hidden');
    const form = h('form.sv-composer', { onsubmit: e => { e.preventDefault(); send(); } },
      replyBar, preview, note,
      h('div.sv-composer-row', attachBtn, h('div.sv-input-wrap', textarea), sendBtn));

    const exempt = () => can(d, 'manage_messages') || can(d, 'manage_channels');
    const grow = () => { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`; };

    function update() {
      const allowed = canPost(d, ch);
      textarea.placeholder = allowed ? `Message #${ch.name}` : 'You cannot post in this channel';
      textarea.setAttribute('aria-label', `Message #${ch.name}`);
      textarea.disabled = !enabled || !allowed;
      attachBtn.disabled = !enabled || !allowed;
      const wait = Math.ceil((cooldownUntil - Date.now()) / 1000);
      const uploading = attachment && !attachment.media;
      sendBtn.disabled = !enabled || !allowed || uploading || wait > 0 || (!textarea.value.trim() && !attachment);
      let text = '';
      if (!allowed) text = 'Only moderators can post in this announcement channel.';
      else if (wait > 0) text = `Slowmode is on. You can send another message in ${wait} ${wait === 1 ? 'second' : 'seconds'}.`;
      else if (ch.slowmode_seconds && !exempt()) text = `Slowmode is on: one message every ${SLOWMODE_LABELS[ch.slowmode_seconds] || `${ch.slowmode_seconds} seconds`}.`;
      note.textContent = text;
      note.classList.toggle('hidden', !text);
    }

    function startCooldown() {
      if (!ch.slowmode_seconds || exempt()) return;
      cooldownUntil = Date.now() + ch.slowmode_seconds * 1000;
      clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => { update(); if (Date.now() >= cooldownUntil) clearInterval(cooldownTimer); }, 1000);
      update();
    }

    function renderReply() {
      if (!replyTo) { replyBar.classList.add('hidden'); mount(replyBar); return; }
      replyBar.classList.remove('hidden');
      mount(replyBar,
        h('span.grow', 'Replying to ', h('strong', replyTo.author?.display_name || 'Deleted account')),
        h('button.btn-small', { type: 'button', onclick: () => { replyTo = null; renderReply(); textarea.focus(); } }, 'Cancel'));
    }

    function renderPreview() {
      if (!attachment) { preview.classList.add('hidden'); mount(preview); update(); return; }
      preview.classList.remove('hidden');
      const bar = h('div.progress-bar', h('div', { style: { width: `${Math.round((attachment.progress || 0) * 100)}%` } }));
      mount(preview,
        h('div.sv-attachment-thumb', h('img', { src: attachment.localUrl, alt: '' })),
        h('div.grow',
          h('div.sv-attachment-name', attachment.file.name || 'Photo'),
          h('div.fine', attachment.media ? 'Ready to send.' : 'Uploading'),
          attachment.media ? null : bar),
        h('button.btn-small', { type: 'button', onclick: () => clearAttachment() }, 'Remove'));
      attachment.bar = bar.firstChild;
      update();
    }

    function clearAttachment() {
      if (attachment && !attachment.media) attachment.controller.abort();
      attachment = null;
      renderPreview();
    }

    async function attachFile(file) {
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('Only photos can be attached.', { error: true }); return; }
      clearAttachment();
      const a = { file, localUrl: URL.createObjectURL(file), media: null, progress: 0, controller: new AbortController() };
      attachment = a;
      localUrls.push(a.localUrl);
      renderPreview();
      textarea.focus();
      try {
        const media = await uploadFile(file, {
          signal: a.controller.signal,
          onProgress: p => { a.progress = p; if (a.bar) a.bar.style.width = `${Math.round(p * 100)}%`; },
        });
        if (attachment !== a) return;
        a.media = media;
        renderPreview();
      } catch (err) {
        if (err.name === 'AbortError' || attachment !== a) return;
        toastError(err);
        clearAttachment();
      }
    }

    function send() {
      if (sendBtn.disabled) return;
      if ([...textarea.value].length > MAX_BODY) { toast(`Messages are limited to ${MAX_BODY.toLocaleString('en-AU')} characters.`, { error: true }); return; }
      if (!submit({ body: textarea.value, attachment })) return;
      textarea.value = '';
      lastTypingSent = 0;
      clearAttachment();
      grow();
      update();
      textarea.focus();
    }

    textarea.addEventListener('input', () => {
      grow();
      update();
      bump();
      if (textarea.value.trim() && Date.now() - lastTypingSent > TYPING_EVERY) {
        lastTypingSent = Date.now();
        api.post(`${base}/typing`).catch(() => {});
      }
    });
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
      else if (e.key === 'Escape' && replyTo) { replyTo = null; renderReply(); }
      else if (e.key === 'ArrowUp' && !textarea.value) {
        const last = [...server].reverse().find(mine);
        if (last) { e.preventDefault(); editingId = last.id; render(); }
      }
    });
    textarea.addEventListener('paste', e => {
      const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); attachFile(file); }
    });
    attachBtn.addEventListener('click', async () => attachFile((await pickFiles({ accept: 'image/*' }))[0]));

    return {
      el: form,
      focus: () => textarea.focus(),
      enable() { enabled = true; update(); },
      update,
      renderReply,
      startCooldown,
      destroy() { clearInterval(cooldownTimer); if (attachment) clearAttachment(); },
    };
  }

  load();

  return {
    el,
    channelId,
    renderHead,
    focus: () => composer.focus(),
    setDetail(next) {
      d = next;
      const fresh = next.channels.find(c => c.id === channelId);
      if (fresh) ch = { ...ch, ...fresh };
      renderHead();
      composer.update();
      rows.clear();
      render();
    },
    destroy() {
      destroyed = true;
      controller.abort();
      clearTimeout(pollTimer);
      olderObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      composer.destroy();
      for (const url of localUrls) URL.revokeObjectURL(url);
    },
  };
}
