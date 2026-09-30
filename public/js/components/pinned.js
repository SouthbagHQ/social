// The pinned post at the top of a profile's Posts tab (Twitter/Instagram style).
//
//   pinnedPost(ctx, user, viewer) → Node (filled asynchronously; empty when nothing is pinned)
//
// GET /api/pins/:handle → { post | null }. Reloads when the viewer pins or unpins from a post's
// "More" menu (the `southbag:pin` event from components/post.js). The same post also appears in the
// list below, like Twitter. Deleting it removes the whole block (it carries data-post-id).

import { api } from '../api.js';
import { h } from '../dom.js';
import { postCard } from './post.js';

export function pinnedPost(ctx, user, viewer) {
  const slot = h('div.pinned-slot');
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    try {
      const { post } = await api.get(`pins/${encodeURIComponent(user.handle)}`, null, { signal: ctx.signal });
      if (mine !== seq) return;
      slot.replaceChildren(post ? h('div.pinned-post', { dataset: { postId: post.id } },
        h('div.pinned-label', 'Pinned'),
        postCard(post)) : '');
    } catch {
      // Not worth an error box: the posts list below still works.
      if (mine === seq) slot.replaceChildren();
    }
  };
  // The profile response says whether anything is pinned; skip the request when it is null.
  if (user.pinned_post_id !== null) load();
  if (viewer?.is_me) window.addEventListener('southbag:pin', load, { signal: ctx.signal });
  return slot;
}
