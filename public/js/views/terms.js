import { h } from '../dom.js';

export default function terms(ctx) {
  ctx.title('Terms');
  ctx.layout('wide');
  return h('div.south-card', { style: 'max-width:760px' },
    h('h1', 'Terms of Service'),
    h('ol',
      h('li', 'By using Southbag Social you agree to these terms.'),
      h('li', 'You are responsible for what you post.'),
      h('li', 'Southbag may remove content or accounts at its discretion.'),
      h('li', 'Posts, messages and uploads are stored by Southbag.'),
      h('li', 'These terms may change without notice.')),
    h('p.fine', 'Southbag is a work of satire. It is not a real company.'));
}
