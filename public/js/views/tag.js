// Tag page (/tag/:tag): heading, post count, a composer prefilled with the tag, and every post using it.
//   GET /api/search/tag/:tag?cursor → { tag, count, items, next }

import { api } from '../api.js';
import { h } from '../dom.js';
import { plural } from '../format.js';
import { empty, infiniteList } from '../ui.js';
import { composer } from '../components/composer.js';
import { postCard } from '../components/post.js';
import { pageHead, withSponsored } from './feed-kit.js';

export default async function tagView(ctx) {
  const tag = String(ctx.params.tag || '').replace(/^#/, '').toLowerCase();
  ctx.title(`#${tag}`);
  const countLine = h('span', 'Counting...');

  const form = composer({
    placeholder: `Post about #${tag}. Kevin already has.`,
    onPosted: post => {
      // Only posts that still carry the tag belong on this page.
      if (new RegExp(`(^|[^\\w&])#${tag}(?!\\w)`, 'iu').test(`${post.title || ''} ${post.body}`)) {
        const card = postCard(post);
        if (card) list.prepend(card);
      }
      form.setText?.(`#${tag} `);
    },
  });
  form.setText?.(`#${tag} `);

  const list = infiniteList({
    signal: ctx.signal,
    load: cursor => api.get(`search/tag/${encodeURIComponent(tag)}`, { cursor }, { signal: ctx.signal }),
    render: withSponsored(post => postCard(post)),
    onPage: (_, data) => { if (data.count != null) countLine.textContent = `${plural(data.count, 'post')} · retained permanently`; },
    empty: empty({ icon: 'hash', title: `Nobody has used #${tag} yet.`, text: 'Kevin has, privately. Be the first on the record.' }),
  });

  return h('div.tag-page',
    pageHead(`#${tag}`, { back: true, sub: countLine }),
    h('div.south-card.flat', form),
    list);
}
