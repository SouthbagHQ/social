import { h } from '../dom.js';

export default function terms(ctx) {
  ctx.title('Terms of Posting');
  ctx.layout('wide');
  const rows = [
    ['Posts', 'Indefinite'], ['Deleted posts', 'Indefinite'], ['Drafts you did not send', 'Indefinite'],
    ['Stories', '24 hours (visible) · Indefinite (retained)'], ['Messages', 'Indefinite'], ['Watch history', 'Indefinite'],
    ['Hesitation', 'Indefinite'], ['Deletion', 'Not available'],
  ];
  return h('div.south-card.flat', { style: 'max-width:820px' },
    h('p.eyebrow', 'SB-DIG-009 · SB-SOC-2026'),
    h('h1', 'Terms of Posting'),
    h('ol',
      h('li', 'Continued use of Southbag Social constitutes acceptance of these terms, and of any terms added later without notice.'),
      h('li', 'Continued scrolling constitutes acceptance. Scrolling backwards constitutes acceptance twice.'),
      h('li', 'Reach, visibility and existence are not guaranteed.'),
      h('li', 'Likes incur an appreciation surcharge. Fees are recorded but not charged. This may change.'),
      h('li', 'Southbag Verified™ confirms that you paid. It does not confirm anything else.'),
      h('li', 'There was no 2019 incident. Posts referencing it will be removed.'),
      h('li', 'Posts geotagged in the ACT are Reserved. The Canberra Adjacency Levy applies.'),
      h('li', 'All policy exceptions are reviewed personally by Kevin. Response times are not guaranteed.'),
      h('li', { value: 14 }, '§14. Kevin may take action before the event that caused it.')),
    h('h2', 'Retention schedule'),
    h('div', rows.map(([what, how]) => h('div.row.between', { style: 'border-bottom:1px dashed #999;padding:6px 0' }, h('span', what), h('strong', how)))),
    h('p.fine', { style: 'margin-top:16px' }, 'Disclaimer: This website is a work of satire. Southbag is not a real company, and none of the services, products, or policies described here exist.'));
}
