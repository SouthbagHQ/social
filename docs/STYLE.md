# Southbag Social — style guide

Southbag Social looks and reads like the other Southbag products: **Southbag Identity**
(SouthbagHQ/identity, `src/routes/layout.css`), **Southbag Office** (SouthbagHQ/office,
`src/routes/app.css`) and **Southbag Branch Locator** (SouthbagHQ/branch-locator, `styles.css`).
It is presented as a real, ordinary service. The interface is janky; the words are not jokes.

## Interface

- **Plain text only.** No icons, no emoji, no symbol glyphs standing in for icons (no arrows, ×, •••,
  ▸, ♥, ✓, ▶). Every control is a word: "Like", "Comment", "Share", "More", "Close", "Back", "Next".
  `icon()` in `public/js/dom.js` renders nothing; don't rely on it.
- **Greyscale.** The only colour is Southbag blue (`var(--sb-blue)`, `#3b87c6`), used sparingly:
  the logo, the current nav item, the current tab, links inside post text, the occasional badge.
  No gradients, no coloured backgrounds, no red/green states.
- **Buttons are all the same.** Every button is the same grey with low-contrast grey text, a 2px
  outset border, square corners and a large shadow (defined once in `southbag.css`). Feature CSS
  must not give buttons their own background, colour or radius. Sizes may differ (`.btn-large`,
  `.btn-small`, and the 3px `.btn-tiny` that grows on hover).
- **Type.** Times New Roman everywhere, with a text shadow. Big, bold, slightly rotated page titles.
- **Furniture.** Ridge-bordered panels (`.south-card`), dashed black dividers, inset skewed inputs,
  labels that lean, a halo shadow on every block, slow linear transitions, dialogs that take over a
  second to scale in, cards a fraction of a degree off straight. Square corners (only `.avatar.round`
  may be round).
- **Media is stretched.** Every image and video sits in a box of a fixed shape and is stretched to
  fill it (`object-fit: fill` is forced globally). Never use `cover` or `contain`, never letterbox.
  Posts that aren't the box's aspect ratio just stretch.
- **Logo.** Always stretched wider than it should be.
- **Still usable.** Keyboard focus works, nothing blocks posting, liking, commenting, following or
  messaging, nothing reloads the page, no forced pop-ups.

## Copy

- Short and plain, like a legitimate product. "Southbag Rewards", not a sentence about Southbag
  Rewards. Titles and buttons are one to three words.
- Empty states: "No posts yet.", "No notifications.", "No messages.", "No results."
- Toasts: "Posted.", "Saved.", "Deleted.", "Link copied.", "Following @bob."
- Errors: plain statements. "Post not found.", "Posts are limited to 280 characters."
- Following is "Follow" / "Following" / "Followers".
- No jokes about fees, surveillance, retention or consent, no Kevin (the shell's "Kevin is watching"
  sidebar line, copied from Identity, is the only one), no The Pile, Floor 3, 2019 or Canberra.
- Nothing about banking: no branches, balances, loans or "Online Banking" promotions.
- Australian spelling. Sentence case.
