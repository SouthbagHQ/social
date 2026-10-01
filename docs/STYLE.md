# Southbag Social — style guide

Southbag Social looks and reads like the other Southbag products: **Southbag Identity**
(SouthbagHQ/identity, `src/routes/layout.css`), **Southbag Office** (SouthbagHQ/office,
`src/routes/app.css`) and **Southbag Branch Locator** (SouthbagHQ/branch-locator, `styles.css`).
It is presented as a real, ordinary service. The interface is janky, like Southbag Online Banking
and Service Table (`../support`); the words are not jokes. Jank should look like a site built badly,
never like a gag (no "Do not press" buttons, no joke answers).

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
- **Type.** The browser's default font. Never set `font-family`. Text has a shadow. Big, bold,
  slightly rotated page titles.
- **Furniture.** Ridge-bordered panels (`.south-card`), dashed black dividers, inset skewed inputs,
  labels that lean, a halo shadow on every block, slow linear transitions, dialogs that take over a
  second to scale in, cards a fraction of a degree off straight. Square corners (only `.avatar.round`
  may be round).
- **Media is stretched.** Every image and video sits in a box of a fixed shape and is stretched to
  fill it (`object-fit: fill` is forced globally). Never use `cover` or `contain`, never letterbox.
  Posts that aren't the box's aspect ratio just stretch.
- **Logo.** Always stretched wider than it should be.
- **Janky, but usable** (`public/js/chaos.js`, `public/css/chaos.css`). A splash screen with
  promotional slides once per browser session; a cookie banner once per browser (two huge
  "Accept" buttons, a tiny "Manage preferences" that lists dozens of required cookies); a strip of
  six help buttons that all open the same support chat; an announcements ticker; a loading word
  that spins around its left edge; and the page shifting a few pixels now and then while
  scrolling. Motion ignores `prefers-reduced-motion`, like Banking. No gimmicks that look
  deliberate: nothing bounces, jitters, sways or shakes, not even on errors. Limits: keyboard
  focus works, nothing blocks posting, liking, commenting, following or messaging, nothing reloads
  the page, no `alert()`, no "Leave site?" traps, no permission prompts.
- **No toasts.** Every message is a dialog with an OK button (`toast()` / `toastError()` in `ui.js`
  open one; the same message is never open twice).
- **No deleting.** Delete buttons stay where they are, but call `refuseDelete()` from `ui.js`
  ("Deletion isn't available. Kevin knows what you did.") instead of asking or deleting.

## Copy

- Cold and institutional, a little ominous, like southbag.cc: "Everything you share is kept.",
  "Activity on Southbag Social is reviewed.", "This path is withheld. Your request has been
  logged.", "Continued use constitutes acceptance." Statements, never threats or punchlines, and
  only in the furniture (landing, 404, ticker, cookie banner, splash). Everyday controls and
  messages stay plain.
- Short and plain, like a legitimate product. "Southbag Rewards", not a sentence about Southbag
  Rewards. Titles and buttons are one to three words.
- Empty states: "No posts yet.", "No notifications.", "No messages.", "No results."
- Messages: "Posted.", "Saved.", "Link copied.", "Following @bob."
- Errors: plain statements. "Post not found.", "Posts are limited to 280 characters."
- Following is "Follow" / "Following" / "Followers".
- No jokes about fees, surveillance, retention or consent. Kevin is rare and never explained: the
  sidebar ("Kevin is watching"), the deletion refusal, and a `kevin_session` cookie in the cookie
  preferences. Add more only with a good reason. No The Pile, Floor 3, 2019 or Canberra.
- Nothing about banking: no branches, balances, loans or "Online Banking" promotions. (The splash
  screen borrows Banking's promotional slides; that is the one exception.)
- Australian spelling. Sentence case.
