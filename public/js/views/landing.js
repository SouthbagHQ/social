// Logged-out home page. Banking's landing (giant logo, announcements, a form with far too many
// fields) — except the only thing that matters is the "Log in with Southbag Identity" button.

import { h } from '../dom.js';
import { confusedButton } from '../gags.js';
import { login } from '../store.js';
import { dialog } from '../ui.js';
import { footer } from '../components/sidebar.js';

export default function landing(ctx) {
  ctx.layout('full');
  ctx.title('');
  const fakeField = (label, placeholder, extra) => h('label.field', h('span', label), h('input.input', { placeholder, tabIndex: -1, ...extra }));
  const features = [
    ['Posts', 'Say it in 280 characters. Kevin counts every one. His count is authoritative.'],
    ['Photos', 'Share up to ten photos at a time. Filters are not available. Your face is already on file.'],
    ['Videos', 'Upload videos of any length under 60 MB. Uploads are retained permanently. Deletion is advisory.'],
    ['Shorts', 'Vertical videos, one after another, until Southbag decides you have had enough.'],
    ['Stories', 'Posts that expire in 24 hours. Retention does not.'],
    ['Groups', 'Gather with people who share your interests. Kevin is a member of every group.'],
    ['Messages', 'Private conversations. All messages are retained. Some are read aloud on Floor 3.'],
    ['The Pile', 'Follow people by adding them to The Pile. Do not ask whether The Pile is physical.'],
  ];
  return h('div.landing',
    h('div.hero-logo', h('img', { src: '/img/logo-400.png', alt: 'southbag', width: 1173, height: 400 })),
    h('p.eyebrow', 'SB-DIG-009 · SOCIAL'),
    h('h1.hero', 'A social network of people ', h('em', 'you do not fully control.')),
    h('p', { style: 'font-size:1.15rem;max-width:720px' },
      'Post, watch, follow and message across one Southbag account. Your audience is curated. Your reach is conditional. ',
      'Your content is retained permanently. Continued scrolling constitutes acceptance.'),
    h('div.cta',
      h('button.btn-large', { type: 'button', onclick: () => login(ctx.query.get('next') || '/') }, 'Log in with Southbag Identity'),
      confusedButton(),
      h('a.btn.outline', { href: '/explore' }, 'Look around first'),
      h('a.btn-small', { href: 'https://branch-locator.southbag.cc', target: '_blank', rel: 'noopener' }, 'Give up and find a branch')),
    h('p.fine', 'By continuing, you agree to all Southbag terms, policies, and content retention schedules. Kevin has already liked this on your behalf.'),

    h('section.announcement-grid', { style: 'margin-top:28px' },
      h('h2', 'Important Southbag Announcements'),
      features.map(([title, text]) => h('div.announcement-card', h('h3', title), h('p', text)))),

    h('div.south-card', { style: 'max-width:720px' },
      h('h2', 'Log in the long way'),
      h('p.fine', 'For customers who do not trust buttons. None of these fields do anything.'),
      h('form.fake-form', { onsubmit: e => { e.preventDefault(); login('/'); } },
        fakeField('email', 'Enter username'),
        fakeField('password (not your real password)', 'Enter email', { type: 'password' }),
        fakeField('full name, formatted as an email for technical reasons', 'Enter Name'),
        fakeField('follower count you would like', 'Enter Amount', { type: 'number' }),
        fakeField('Balance?', 'Yes'),
        h('div.row.wrap',
          h('button.btn-small', { type: 'submit' }, 'Log in with Southbag Identity'),
          h('button.btn-small', { type: 'button', onclick: () => dialog({ body: "i don't either" }) }, "I don't have a code"),
          h('button.btn-tiny', { type: 'button', onclick: () => dialog({ title: 'Southbag Alert', body: 'Account deletion is not available. You do not have an account.' }) }, 'Delete account')))),
    footer());
}
