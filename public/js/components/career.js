// Placeholder: the careers (LinkedIn) feature replaces this.
//   careerTab(ctx, user, viewer) → Node for the profile's Career tab
//   profileHeadline(user) → Node|null shown under the name in the profile header
import { h } from '../dom.js';

export function careerTab() { return h('div.empty', 'No career details yet.'); }
export function profileHeadline() { return null; }
