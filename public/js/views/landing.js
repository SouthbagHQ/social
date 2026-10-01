// Logged-out home page: the stretched logo, the name, and the way in.

import { h } from '../dom.js';
import { login } from '../store.js';
import { footer } from '../components/sidebar.js';

export default function landing(ctx) {
  ctx.layout('full');
  ctx.title('');
  return h('div.landing',
    h('div.hero-logo', h('img', { src: '/img/logo-400.png', alt: 'southbag' })),
    h('h1.hero', 'Southbag Social'),
    h('p', 'Posts, photos, videos and messages. Everything you share is kept.'),
    h('div.cta',
      h('button.btn-large', { type: 'button', onclick: () => login(ctx.query.get('next') || '/') }, 'Log in with Southbag Identity'),
      h('a.btn', { href: '/explore' }, 'Explore'),
      h('button.btn-tiny', { type: 'button', onclick: () => { location.href = 'https://identity.southbag.cc/login'; } }, 'Create account')),
    h('p.tiny', 'Access is conditional. Activity is recorded. Continued use constitutes acceptance.'),
    footer());
}
