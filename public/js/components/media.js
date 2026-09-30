// Rendering files from D1: photo grids, carousels, video players and thumbnails.

import { h } from '../dom.js';
import { duration as fmtDuration } from '../format.js';
import { lightbox } from '../ui.js';

const img = (m, extra = {}) => h('img', {
  src: m.url, alt: m.alt || '', loading: 'lazy', decoding: 'async',
  width: m.width || undefined, height: m.height || undefined, ...extra,
});

/** Twitter-style grid of 1–4 photos (click to enlarge). */
export function photoGrid(media) {
  const shown = media.slice(0, 4);
  return h(`div.media-grid.n${shown.length}`, shown.map((m, i) => img(m, {
    onclick: e => { e.stopPropagation(); lightbox(m.url, m.alt); },
    style: i === 3 && media.length > 4 ? 'filter:brightness(.6)' : undefined,
  })));
}

/** Instagram-style swipeable square carousel. */
export function carousel(media) {
  const track = h('div.track', media.map(m => img(m, { onclick: () => lightbox(m.url, m.alt) })));
  if (media.length === 1) return h('div.carousel', track);
  const dots = h('div.dots', `1 / ${media.length}`);
  const go = dir => track.scrollBy({ left: dir * track.clientWidth, behavior: 'smooth' });
  track.addEventListener('scroll', () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    dots.textContent = `${i + 1} / ${media.length}`;
  }, { passive: true });
  return h('div.carousel', track, dots,
    h('button.nav-btn.prev', { type: 'button', onclick: e => { e.stopPropagation(); go(-1); } }, 'Previous'),
    h('button.nav-btn.next', { type: 'button', onclick: e => { e.stopPropagation(); go(1); } }, 'Next'));
}

/** A <video> for a media item. Options pass through to the element (autoplay, muted, loop, controls…). */
export function videoEl(m, { controls = true, autoplay = false, muted = false, loop = false, preload = 'metadata', ...rest } = {}) {
  return h('video', {
    src: m.url, poster: m.poster_url || undefined, controls, autoplay, muted, loop, preload, playsInline: true,
    ...rest,
  });
}

/** Inline player inside a post card. */
export const videoPlayer = (m, opts) => h('div.video-wrap', videoEl(m, opts));

/** Clickable thumbnail with duration badge (YouTube grid / TikTok grid). */
export function videoThumb(m, { href, vertical = false } = {}) {
  const still = m.poster_url
    ? h('img', { src: m.poster_url, alt: '', loading: 'lazy' })
    : h('video', { src: `${m.url}#t=0.5`, preload: 'metadata', muted: true, playsInline: true });
  return h(href ? 'a.video-thumb' : 'div.video-thumb', { href, class: { vertical } },
    still,
    h('span.play', 'Play'),
    m.duration ? h('span.duration', fmtDuration(m.duration)) : null);
}

/** Picks the right presentation for a post's media list. */
export function postMedia(post, { inFeed = true } = {}) {
  const media = post.media || [];
  if (!media.length) return null;
  const video = media.find(m => m.kind === 'video');
  if (video) {
    if (inFeed && (post.kind === 'video' || post.kind === 'short')) {
      return videoThumb(video, { href: post.kind === 'short' ? `/shorts/${post.id}` : `/watch/${post.id}`, vertical: post.kind === 'short' });
    }
    return videoPlayer(video);
  }
  const audio = media.find(m => m.kind === 'audio');
  if (audio) return h('audio', { src: audio.url, controls: true, preload: 'none', style: 'width:100%' });
  return post.kind === 'photo' ? carousel(media) : photoGrid(media);
}
