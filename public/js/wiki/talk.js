// /wiki/:space/:page/talk: threaded discussion about a page. Comments are plain text.

import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { login, store } from '../store.js';
import { empty, refuseDelete, shake, toast, toastError } from '../ui.js';
import { avatar } from '../components/user.js';
import { canEdit, pageApi, pageTabs, pageTitle, userLink, when, wikiFrame } from './common.js';

const MAX = 5000;

export function talkView(ctx, spaceSlug, slug) {
  return wikiFrame(ctx, spaceSlug, async (main, { space }) => {
    const [pageData, talk] = await Promise.all([
      api.get(pageApi(spaceSlug, slug), { redirect: 'no' }, { signal: ctx.signal }),
      api.get(pageApi(spaceSlug, slug, '/talk'), null, { signal: ctx.signal }),
    ]);
    const { page } = pageData;
    ctx.title(`Talk: ${page.title}`);
    const items = talk.items;
    const thread = h('div.wk-talk');
    const countLine = h('p.fine');

    const paint = () => {
      const children = new Map();
      for (const c of items) {
        const key = c.parent_id || '';
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(c);
      }
      // Hide deleted comments with no live replies.
      const live = c => !c.deleted || (children.get(c.id) || []).some(live);
      const node = c => h('div.wk-comment', { class: { deleted: c.deleted } },
        h('div.wk-comment-head',
          c.author ? avatar(c.author, { size: 'xs' }) : null,
          c.author ? userLink(c.author) : h('span.muted', 'Deleted'),
          h('span.fine', ' ', when(c.created_at))),
        h('p.wk-comment-body', c.deleted ? 'Comment deleted.' : c.body),
        c.deleted ? null : h('div.wk-comment-actions',
          h('button.btn-small', { type: 'button', onclick: e => openReply(e.currentTarget, c) }, 'Reply'),
          c.viewer.can_delete ? h('button.btn-small', { type: 'button', onclick: refuseDelete }, 'Delete') : null),
        h('div.wk-replies', (children.get(c.id) || []).filter(live).map(node)));
      const roots = (children.get('') || []).filter(live);
      mount(thread, roots.length ? roots.map(node) : empty({ title: 'No comments yet.' }));
      const n = items.filter(c => !c.deleted).length;
      countLine.textContent = n === 1 ? '1 comment' : `${n} comments`;
    };

    const post = async (text, parentId, form, done) => {
      if (!store.me) return login();
      if (!text.trim()) { shake(form); return toast('Write a comment first.', { error: true }); }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const { comment } = await api.post(pageApi(space.slug, page.slug, '/talk'), { body: text, parent_id: parentId });
        items.push(comment);
        paint();
        done();
        toast('Posted.');
      } catch (err) { shake(form); toastError(err); }
      btn.disabled = false;
    };

    const openReply = (button, parent) => {
      const holder = button.closest('.wk-comment').querySelector(':scope > .wk-replies');
      if (holder.querySelector(':scope > form')) return holder.querySelector(':scope > form textarea').focus();
      if (!store.me) return login();
      const text = h('textarea.textarea', { rows: 3, maxLength: MAX, placeholder: 'Reply', 'aria-label': 'Reply' });
      const form = h('form.wk-reply', { onsubmit: e => { e.preventDefault(); post(text.value, parent.id, form, () => form.remove()); } },
        text,
        h('div.row', h('button.btn-small', { type: 'submit' }, 'Reply'), h('button.btn-small', { type: 'button', onclick: () => form.remove() }, 'Cancel')));
      holder.prepend(form);
      text.focus();
    };

    const topic = h('textarea.textarea', { rows: 4, maxLength: MAX, placeholder: `Discuss ${page.title}`, 'aria-label': 'New comment' });
    const newForm = store.me
      ? h('form.south-card.flat.wk-new-topic', { onsubmit: e => { e.preventDefault(); post(topic.value, null, newForm, () => { topic.value = ''; }); } },
          h('label.field', h('span', 'New comment'), topic),
          h('button.btn', { type: 'submit' }, 'Post'))
      : h('div.south-card.flat', h('p', 'Log in to join the discussion.'), h('button.btn', { type: 'button', onclick: () => login() }, 'Log in'));

    paint();
    mount(main,
      pageTitle(`Talk: ${page.title}`, `From ${space.title}`),
      h('div.wk-tabbar', pageTabs(space.slug, page.slug, 'talk', { canEdit: canEdit(pageData.viewer, page) })),
      newForm,
      countLine,
      thread);
  });
}
