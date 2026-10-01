import { h } from '../dom.js';

export default function notFound(ctx) {
  ctx.title('Not found');
  return h('div.south-card',
    h('h1', 'Page not found'),
    h('p', 'This path is withheld. Your request has been logged.'),
    h('a.btn', { href: '/' }, 'Home'));
}
