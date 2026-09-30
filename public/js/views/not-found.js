import { h } from '../dom.js';

export default function notFound(ctx) {
  ctx.title('Not found');
  return h('div.south-card',
    h('h1', 'Page not found'),
    h('p', 'This page does not exist.'),
    h('a.btn', { href: '/' }, 'Home'));
}
