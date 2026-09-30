# Southbag Social: design spec (derived from SouthbagHQ/banking `public/`)

Source: `/home/user/southbaghq/banking/public` (read-only). Screenshots were taken during research and are not in the repo
(`shots/`).
Screenshot script: `../shoot.js` (Playwright, APIs mocked, repo untouched).

## 0. How the banking site actually renders (read this first)

The look you see in production comes from three stacked layers:

1. **`styles.css`**: the house style. It has no fonts or colour palette of its own. It uses browser-default serif
   (Times), beveled 90s borders (`groove`, `outset`, `inset`, `double`, `dashed`), off-white "paper" backgrounds,
   tilted cards, and a universal `*` rule that adds a blur, a double drop-shadow and a text-shadow to every element.
2. **`optimise.js`** runs in `<head>` on every page. It appends **Bootstrap 5.3, Bulma 0.9.4, Semantic UI 2.5,
   Tailwind 2.2.19 and Materialize 1.0** after `styles.css`, so they win. The result:
   - **Materialize** styles `.btn-large` and `.btn-small` (the site uses those class names), so every button is
     **teal `#26a69a`, uppercase, 2px radius**. Body text uses the Materialize system stack.
   - **Semantic UI** sets headings to **Lato** (it `@import`s Google Fonts Lato).
   - Links are Materialize light blue `#039be5`.
   - It also shows the 7-second promo carousel and the yellow "Promotional banner".
   - Then it **crashes** at `document.body.appendChild` (body is null in `<head>`). All the later "destruction"
     code never runs: bad contrast, random reloads, keyboard traps and the rest. Don't copy those parts.
3. **`app.js`** adds popups (privacy panel, alerts subscription, recurring `alert()` "schedule an in-person meeting")
   and announcement cards. `bank.js` also fails (`const track` is declared twice), so the balance on the dashboard
   stays **"Loading..." forever**. That's a free gag.

Without optimise.js you get the "base" look: Times serif, grey default buttons, giant logo. Compare
`shots/real-base.png` with `shots/q-real-shipped-tall.png`. **Recommendation: build the social app on the
"shipped" look** (styles.css skeleton + Materialize teal buttons + Lato headings) and implement those styles yourself.
Do not load the five frameworks.

## 1. Design tokens (copied from the real CSS / computed styles)

```css
:root {
  /* Brand (sampled from logo.png, transparent PNG, vertical gradient) */
  --sb-logo-top:    #6286e7;  /* periwinkle */
  --sb-logo-mid:    #3b87c6;
  --sb-logo-bottom: #058998;  /* teal */
  --sb-logo-gradient: linear-gradient(180deg, #6286e7 0%, #3b87c6 50%, #058998 100%);

  /* Buttons / accents (Materialize, as shipped) */
  --sb-teal:        #26a69a;  /* .btn-large/.btn-small bg */
  --sb-teal-hover:  #2bbbad;
  --sb-link:        #039be5;  /* Materialize a{} */
  --sb-text:        rgba(0,0,0,0.87);

  /* styles.css house palette */
  --sb-paper:       #fffffa;  /* .south-card bg */
  --sb-paper-nav:   #f8f8f0;  /* .south-nav bg */
  --sb-bevel:       #ccc;     /* .south-card 3px outset */
  --sb-groove:      #bbb;     /* .south-nav 3px groove */
  --sb-inset:       #ddd;     /* .south-item 2px inset */
  --sb-active:      #800;     /* nav aria-current (computes rgb(136,0,0)) */
  --sb-promo:       #fffa63;  /* "Promotional banner" strip */
  --sb-announce-bg: #fff8e1;  --sb-announce-border: #ff9800; --sb-announce-card-border: #ffcc80;
  --sb-recovery-bg: #eef6ff;  /* dashed #0d6efd panel */
  --sb-alert-bg:    #e8f5e9;  --sb-alert-border: #2e7d32;   /* alerts popup */
  --sb-privacy-border: #263238; --sb-muted: #546e7a; --sb-hairline: #cfd8dc;
  --sb-valid: #137333; --sb-invalid: #b3261e;

  /* "Modern" support-chat palette (chat.css): use for DMs */
  --sb-blue:        #0d6efd;  --sb-blue-dark: #0056b3;
  --sb-blue-grad:   linear-gradient(135deg, #0d6efd 0%, #0056b3 100%);
  --sb-chat-bg:     #f8fafc;  --sb-chat-border: #e2e8f0;
  --sb-chat-ink:    #1e293b;  --sb-chat-muted: #64748b;
  --sb-online:      #4ade80;
  --sb-bubble-grey: #e9ecef;  /* legacy widget bot bubble, text #333 */

  /* Retro "Windows" dialog (chat.html POPUP gag) */
  --sb-win-title:   #000080;  --sb-win-body: #ffffcc;  --sb-win-btn: #ddd;

  /* Gag colours */
  --sb-error-red:   #cc0000;
  --sb-darkmode-button: pink;  /* dark mode: body black, h1/h2 black (invisible), buttons pink */
}
```

**Fonts**
- Headings: **Lato 400** (the shipped look uses 400, not 700).
  `<link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">`
  (Semantic's original import is `https://fonts.googleapis.com/css?family=Lato:400,700,400italic,700italic&subset=latin`.)
- Body/UI: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif`.
  Size 14px, line-height 1.5 (the root is 14 / 14.5 / 15px at 0 / 992 / 1200px widths).
- Retro/base variant: browser-default serif (Times) at h1 2em bold. Use it for a "legacy mode" or for the gags.
- Logo wordmark: a serif baked into logo.png. There's no webfont for it, so always use the image.
- Type scale as shipped: h1 **63px** (4.2rem), h2 **53.4px** (3.56rem), p 14px, `.south-nav a` 15px,
  `.south-hub-links a` 17px, `.south-item span` (price) 18px, `.btn-large` 15px, `.btn-small` 13px.
  For the social app, scale h1/h2 down to about 40/28px, but keep "comically oversized" for one hero heading.
  Base styles.css versions: `.btn-large {font-size:24px; padding:15px 30px}`, `.btn-small {font-size:3px; padding:2px 8px}`
  (the 3px button is a signature gag; see §4).

**Radii**: 0 everywhere in the house style (beveled boxes). Buttons 2px (Materialize). The chat "modern" shell
uses 16px containers and bubbles, 12px inputs and buttons, 8px for the "New Chat" pill, 50px for the floating chat toggle,
and 50% for the status dot.

**Borders (the real personality)**: `3px groove #bbb` (nav), `3px outset #ccc` (cards), `2px inset #ddd`
(product tiles), `4px double #ff9800` (announcements), `3px dashed #0d6efd` (recovery), `3px solid #263238`
(privacy), `3px solid #2e7d32` (alerts), `1px dashed #999` (form separators inside cards).

**Shadows**
```css
/* universal noise (styles.css, applied to *) */
box-shadow: 0 0 10px rgba(0,0,0,.5), inset 0 0 5px rgba(255,255,255,.3) !important;
text-shadow: 1px 1px 2px rgba(0,0,0,.5), 2px 2px 4px rgba(0,0,0,.3) !important;
filter: blur(0.3px) brightness(1.05) saturate(1.1);
/* buttons */
box-shadow: 0 10px 20px rgba(0,0,0,.3), 0 15px 40px rgba(0,0,0,.3), inset 0 -2px 5px rgba(0,0,0,.2),
            inset 0 2px 5px rgba(255,255,255,.5), 0 0 30px rgba(100,100,255,.5);
/* modern container (chat.css) */ box-shadow: 0 25px 50px -12px rgba(0,0,0,.25);
/* floating widget */            box-shadow: 0 4px 12px rgba(0,0,0,.3);
/* focus ring */                 box-shadow: 0 0 0 3px rgba(13,110,253,.1);
```
The universal `*` shadow puts a soft grey halo around every block, which is the main texture in every screenshot.
**For usability**, apply it to cards, nav items, buttons and headings only, not to `*`. Keep text-shadow on
headings only, and drop the blur (it makes text fuzzy).

**Spacing**: styles.css pads **every element** by breakpoint: `* {padding: 5/10/15/20/25/30px}` at
320/480/768/1024/1200/1400px. That creates the "everything boxed in its own halo" rhythm. Reproduce it as a
spacing token (`--sb-pad: clamp(5px, 2vw, 30px)`) on block components only. Card margins are asymmetric on purpose
(`18px 8% 18px 12px`, even cards `margin-left: 8%; margin-right: 4px`), which makes a zig-zag stagger. Nav uses `gap: 6px 14px`,
the board uses `margin: 28px 4px 40px 10px`, and the announcement grid uses `repeat(auto-fit, minmax(190px,1fr)); gap:14px`.

## 2. Layout / page shells

### 2a. Landing page = `index.html` (logged out). Screenshot: `shots/q-index-shipped-tall.png`, `shots/index-carousel.png`
Order: **promo carousel overlay** (black full-screen, 2 to 3 random `/loaders/N.png` ads, a "Loading..." label in
letter-spaced white 18px/300, a 4px progress bar `linear-gradient(90deg,#007bff,#00d4ff)`, no skip, 7s total) →
yellow `#fffa63` "Promotional banner" strip (30px, then grows to 50px after 1s, a layout-shift gag) → `<header>`
with the **giant full-width logo** and an `h2` "Southbag Online Banking" → `h1` Welcome → **"Important Southbag
Announcements"** grid (injected by app.js on home only) → the absurd login form (12 fields: "password (not your real
password)", "full name, formatted as an email for technical reasons", "Balance?" with placeholder "Yes") with inline
help buttons ("Confused?", "What's a username?", "I don't have a code" → `alert("i don't either")`) → "Give up and
find a branch" → footer with "Dark Mode", "Security Bounty", "Chat with a Human" buttons. The privacy panel is
fixed bottom-left and the alerts popup appears bottom-right after 2.5s.
The real login is just the submit → `/auth/login` (OIDC, "Log in with Southbag Identity").

### 2b. Logged-in dashboard = `real.html`, the signed-in shell. Screenshot: `shots/q-real-shipped-tall.png`
### 2c. Product pages = `public/south/*.html`: same shell, one `.south-card` each. Screenshot: `shots/q-casino-shipped-tall.png`

Every signed-in page uses this exact skeleton (trimmed from `south/money.html`):
```html
<header class="site-header">
  <img src="/logo.png" alt="Southbag Online Banking Logo">   <!-- no class → renders huge -->
  <h2>Southbag Online Banking</h2>
</header>
<h1 id="welcome">Welcome to Southbag Online Banking</h1>     <!-- becomes "Welcome, {name}" -->
<p id="balanceDisplay">Loading...</p>                      <!-- stuck forever in prod -->
<p id="southStatus">Account SB-000-420 · $-12345.67 · frozen · Bronze Minus</p>
<nav id="southNav" class="south-nav" aria-label="Southbag products"></nav>  <!-- filled by south-nav.js -->
<section class="south-board">
  <article class="south-card">
    <h2>Move money</h2>
    <form data-south-form="deposit">
      <label>Deposit amount (27% stays with us)</label>
      <input name="amount" type="number" required>
      <button type="submit" class="btn-large">Deposit</button>
    </form>
    <form data-south-form="transfer"> … <button class="btn-small">Transfer</button></form>
  </article>
</section>
```
So there's **no sidebar and no footer**. It's a single left-aligned column (`body {width:100vw}`, which causes slight horizontal
overflow) with a wrapping horizontal **tab-strip nav** under the status line. On `real.html` the nav is followed by
a row of 8 big teal action buttons ("View Balance", "Transfer money", "Take out a loan", "Free Money", "View All
Customer Passwords", "Change Someone's Password", "Transfer From Another Account", "Remove Virus" (plays virys.mp3)),
then small "Chat with a Human" / "Log out", then a "Products" card with a bulleted link list (`.south-hub-links`)
and an `h2` "Transactions" `<ul>`. Product pages alternate `btn-large` and `btn-small` on purpose, so sizes never match.

**south-nav.js** (reuse almost verbatim with social sections):
```js
const SOUTH_SECTIONS = [
  { href: '/real.html', label: 'Dashboard' }, { href: '/south/daily.html', label: 'Daily rewards' },
  { href: '/south/employment.html', label: 'Employment' }, { href: '/south/money.html', label: 'Move money' },
  { href: '/south/crime.html', label: 'Crime desk' }, { href: '/south/loans.html', label: 'Loans' },
  { href: '/south/casino.html', label: 'Casino' }, { href: '/south/crypto.html', label: 'Crypto' },
  { href: '/south/insurance.html', label: 'Insurance' }, { href: '/south/investments.html', label: 'Investments' },
  { href: '/south/lottery.html', label: "Kevin's Numbers" }, { href: '/south/shop.html', label: 'Gift shop' },
  { href: '/south/slack.html', label: 'Link Slack' }, { href: '/south/shaming.html', label: 'Public shaming' },
];
function injectSouthNav() {
  const host = document.getElementById('southNav'); if (!host) return;
  const path = location.pathname.replace(/\/$/, '');
  const list = document.createElement('ul');
  SOUTH_SECTIONS.forEach(s => {
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = s.href; a.textContent = s.label;
    if (path === s.href || path === s.href.replace(/\.html$/, '') || path.endsWith(s.href)) a.setAttribute('aria-current', 'page');
    li.appendChild(a); list.appendChild(li);
  });
  host.replaceChildren(list);
}
document.addEventListener('DOMContentLoaded', injectSouthNav);
```
```css
.south-nav { margin: 12px 8% 20px 10px; padding: 8px 12px; border: 3px groove #bbb; background: #f8f8f0; }
.south-nav ul { display:flex; flex-wrap:wrap; gap:6px 14px; list-style:none; margin:0; padding:0; }
.south-nav a { font-size:15px; text-decoration:underline; }
.south-nav a[aria-current="page"] { font-weight:bold; text-decoration:none; color:#800; }
.site-header { display:flex; align-items:center; gap:12px; padding:8px 10px; }
.site-logo   { height:56px; width:auto; display:block; flex-shrink:0; object-fit:contain; } /* only learn pages use it */
```
In the shipped render each nav `<li>` gets the universal halo plus padding, so each link looks like a separate raised
chip. The inactive links render faint (a light-on-white hue from Materialize and the filters) and the active one is bold dark red.

**Social shell recommendation** (keeps the look and stays usable):
- Header: logo **56px tall** (`.site-logo`) + h2 wordmark text. Keep a **huge-logo hero on the landing page only**.
- Under it: `h1` "Welcome, {name}", a status line in the `southStatus` format (`@handle · 1,204 followers · shadowbanned · Bronze Minus`), a stuck "Loading..." line as a gag, then the **groove tab-strip nav**:
  Feed · Reels · Videos · Stories · Groups · Messages · Marketplace ("Gift shop") · Kevin's Picks · Link Slack · Public shaming (leaderboard).
- Content: `.south-board` holding stacked, slightly rotated `.south-card` posts (a feed zig-zags left and right via `nth-child(even)`).
  For desktop, an optional right column of `.announcement-card`s ("Trending", "Scam warning of the week") in the announcement grid style.
- Messages page: the chat.css "modern" shell (the only polished UI in the repo; see §3).

### 2d. Support chat = `chat.html` + `chat.css`: the "modern" shell. Screenshot: `shots/chat.png`
Full-height flex column. The `.header` bar is white with **white text** ("← Back to Banking", "Southbag Support" are
invisible, a gag). Then a centred `.chat-container` (max-width 800px, 16px radius, big soft shadow), a blue gradient
`.chat-header` with a pulsing green dot, "Live Support / We typically reply within a few seconds" and a white
"New Chat" pill, then a `#f8fafc` message area, bot bubbles (white, `#e2e8f0` border, bottom-left radius 4px) and user
bubbles (blue gradient, bottom-right radius 4px), then an input row (12px radius, 2px `#e2e8f0` border, focus `#0d6efd`
plus a 3px ring) with a gradient Send button. Welcome copy: "Oh great, another one. Type your message below I guess."
Typing indicator text: *"Loud audible sigh"*. Mobile (≤640px): the container goes full-bleed with radius 0.

## 3. Component patterns

**Buttons** (use the shipped Materialize look, implemented ourselves):
```css
.btn, .btn-large, .btn-small { display:inline-block; border:none; border-radius:2px; color:#fff; background:#26a69a;
  text-transform:uppercase; letter-spacing:.5px; cursor:pointer; transition:background-color .2s ease-out;
  height:36px; line-height:36px; padding:0 16px; font-size:14px;
  box-shadow: 0 10px 20px rgba(0,0,0,.3), 0 15px 40px rgba(0,0,0,.3), inset 0 -2px 5px rgba(0,0,0,.2),
              inset 0 2px 5px rgba(255,255,255,.5), 0 0 30px rgba(100,100,255,.5); }
.btn:hover, .btn-large:hover, .btn-small:hover { background:#2bbbad; }
.btn-large { height:54px; line-height:54px; font-size:15px; padding:0 28px; }
.btn-small { height:32.4px; line-height:32.4px; font-size:13px; }
.btn-tiny  { font-size:3px; padding:2px 8px; }   /* the original .btn-small gag, for "Terms" / "Unfollow" etc. */
```
Pattern: buttons can carry `href` (`<button href="…">`); app.js turns them into navigation. Nearly every page repeats
"Chat with a Human / Need Help? / Talk to Support / Live Chat / Get Assistance / Speak to Human" buttons, all linking to support.

**Cards**
```css
.south-board { display:block; margin:28px 4px 40px 10px; }
.south-card  { border:3px outset #ccc; background:#fffffa; margin:18px 8% 18px 12px; padding:10px 14px 16px; transform:rotate(-0.2deg); }
.south-card:nth-child(even) { margin-left:8%; margin-right:4px; transform:rotate(0.35deg); }
.south-card form { display:block; margin:10px 0; border-top:1px dashed #999; padding-top:8px; }
/* product tile, good for Marketplace / media thumbnails */
#southShop { display:flex; flex-wrap:wrap; gap:8px; max-height:320px; overflow:auto; }
.south-item { width:160px; border:2px inset #ddd; padding:6px; background:#fff; }
.south-item span { display:block; font-size:18px; }            /* price */
/* announcement grid, good for trending / notifications */
.announcement-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:14px; margin:18px 0 24px;
  padding:16px; border:4px double #ff9800; background:#fff8e1; max-width:960px; }
.announcement-grid h2 { grid-column:1/-1; margin:0; }
.announcement-card { padding:12px; background:#fff; border:2px solid #ffcc80; }
```
Shop tile markup: `<div class="south-item"><strong>Blahaj</strong><span>$29.99</span><p>desc</p><button class="btn-small">Buy</button></div>`.

**Forms / inputs**: labels sit above inputs as block elements, with sarcastic label copy ("Dollars to waste", "Deposit amount
(27% stays with us)"). `.south-card input, .south-card select { display:block; margin:4px 0 8px; font-size:16px; }`.
Shipped inputs are Materialize style: full-width, no box, `border-bottom:1px solid #9e9e9e`, height 3rem, focus
border `#26a69a` with `box-shadow:0 1px 0 0 #26a69a`. In the base style, `label` gets `transform: skew(5deg) scale(1.05)` plus a drop-shadow
(keep it, it's cheap and funny). Password checklist:
```css
.password-checklist { list-style:none; margin:10px 0; padding:10px; max-width:520px; background:#fff; border:1px solid #cfd8dc; }
.password-checklist li.valid { color:#137333; }  .password-checklist li.invalid { color:#b3261e; }  /* "✓ " / "• " prefixes */
.recovery-panel { margin:24px 0; padding:18px; border:3px dashed #0d6efd; background:#eef6ff; max-width:720px; }
```

**Tables / lists**: the repo has no `<table>`. Data is plain `<ul>` or `<p>` text: transactions `<li>` =
`"{localeString}: {description} ({$amount})"`, leaderboard `"1. $9,999.99 (smug)"` in a `<p>` with newlines. For the social
app, use plain lists styled as cards. Empty state copy: "Suspiciously, nothing has happened yet."

**Badges**: none exist as components. Status is inline text: `frozen`, `Bronze Minus`, tiers. Suggested badge = inline
`3px outset #ccc` chip on `#fffffa`, or dark-red `#800` bold for "you are here" and "verified-ish".

**Modals / popups** (all real):
```css
.privacy-panel { position:fixed; left:18px; bottom:18px; width:min(560px,calc(100vw - 36px)); max-height:80vh; overflow:auto;
  padding:16px; background:#fff; border:3px solid #263238; z-index:10001; }
.privacy-panel-minimized { width:auto; max-height:none; padding:6px; }   /* collapses to one "Privacy permissions" button */
.privacy-option { display:flex; align-items:flex-start; gap:10px; margin:10px 0; padding:8px; border:1px solid #cfd8dc; }
.privacy-option small { color:#546e7a; display:block; }
.privacy-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.alerts-popup { position:fixed; right:18px; bottom:18px; width:min(420px,calc(100vw - 36px)); padding:18px;
  background:#e8f5e9; border:3px solid #2e7d32; z-index:10002; }
.alerts-close { float:right; border:0; background:transparent; font-size:22px; cursor:pointer; }
```
Retro dialog (chat `[POPUP:msg]`), which works well as a confirm modal:
```html
<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#ffffcc;padding:20px 30px;border:3px outset #ccc;min-width:280px;text-align:center">
  <div style="background:#000080;color:#fff;padding:5px 10px;margin:-20px -30px 15px;font-weight:bold;font-size:12px;text-align:left">Southbag Alert</div>
  <p style="color:#333;font-size:14px">Your complaint has been noted and ignored</p>
  <button style="padding:5px 25px;background:#ddd;color:#333;border:2px outset #ccc;font-size:12px">OK</button>
</div>
```
Other overlays in chat.html: **"You Are On Hold"** (the repo's only `<marquee>`: "~~~ Please Hold ~~~", big countdown in an
inset box, "* elevator music plays *"), **"CONNECTION LOST"** (red X, "Error Code: CUSTOMER_TOO_ANNOYING", outset "Try Again"),
and a **support ticket** card (top-right, "SUPPORT TICKET #8675309 · Est. response: Never · [ close ]").

**Toasts / alerts**: the banking app just uses `alert()` for every action result (`southLog = alert`). For social,
render these as a toast in the retro dialog style above, bottom-right like `.alerts-popup`. Don't use native `alert()`.

**Floating chat widget** (styles.css): `.chat-toggle` is a fixed bottom-right `#0d6efd` pill, radius 50px, "💬 Chat with a human".
`.chat-widget` is 350×450, white, `2px solid #ddd`, radius 10px, blue header, `#f9f9f9` body, user bubble `#0d6efd`, bot bubble `#e9ecef`/#333.

**Avatars**: none in the repo. Suggested: square (radius 0) with `3px outset #ccc`, or `2px inset #ddd` like `.south-item`.
Default avatar = a cropped logo "s" on `--sb-logo-gradient`. Use the 50% radius only in the chat shell.

## 4. Signature gags (and verdict for the social app)

| Gag | Where | Carry over? |
|---|---|---|
| Full-screen **promo carousel** of fake ads (`/loaders/1-9.png`, 7s, no skip) | optimise.js | **Yes, but skippable and once per session** (~2s) |
| Yellow "Promotional banner" strip that grows 30→50px | optimise.js | **Yes**, make it a static sponsored strip |
| Giant logo filling the viewport | every page (img has no size) | Landing hero only |
| Tilted cards (−0.2° / +0.35°) and zig-zag margins | `.south-card` | **Yes**, it's the core texture of the feed |
| Beveled 90s borders (groove/outset/inset/double) | styles.css | **Yes** |
| Universal halo shadow + text-shadow + 0.3px blur on `*` | styles.css | Keep the halo on blocks; **drop the blur** and the text-shadow on body text |
| Mismatched button sizes; the **3px-font "btn-small"** | everywhere | Yes, for fine print only ("Unsubscribe", "Delete account", "Terms") |
| Sarcastic microcopy ("Dollars to waste", "Claims still denied", "Kevin filed that somewhere.", "Fortune favors nobody.") | south.js / pages | **Yes, heavily**: "Post (we keep 27% of the likes)", "Followers you'll lose" |
| "Kevin" as the recurring incompetent employee (Kevin's Numbers, Kevin's stapler, Kevin postponed the draw) | everywhere | **Yes**: make Kevin the moderator/algorithm |
| Balance stuck at "Loading..." forever | real.html (bank.js bug) | Yes: "Your engagement: Loading..." |
| Privacy permissions panel (fixed, "Allow every permission" is the big button) | app.js | Yes, once, then collapse to a small button |
| "Subscribe to Southbag Alerts" popup after 2.5s ("No alerts, I enjoy mystery") | app.js | Yes, once (localStorage flag) |
| Recurring `alert()` "You cannot do that online. Please schedule an in-person meeting at your local SouthBag branch" (10-20s, then every 30-90s) | app.js | Rarely, as a toast (e.g. "Posting in person requires a branch visit") |
| Forced training redirect to `/learnwithsouthbank/start.html` + a quiz where the scam answers are "correct" | app.js / quiz | Optional onboarding "Media literacy" quiz (skippable) |
| Absurd login form (12 fields, "Balance? → Yes") | index.html | Fake it on the landing page, but the real login is one button |
| Dark mode that makes headings black on black and buttons pink | styles.css | **Yes**, as a toggle that's clearly a joke, with a "real" dark mode behind it |
| Support bot that roasts you + [SHAKE]/[CONFETTI]/[GLITCH]/[HOLD]/[TICKET] effects | chat.html | Yes, as "Southbag Support" DMs; confetti on first post, shake on a failed action |
| Invisible white-on-white chat header | chat.css | Fine, since it's harmless |
| Security bounty page listing its own vulns | securitybounty.html | Yes, as a satirical "Trust & Safety" page |
| Random page reloads, keyboard traps, bad contrast, `beforeunload` trap, alt-text removal, 5 CSS frameworks | optimise.js | **No.** They break usability and accessibility (and mostly never run anyway) |
| Remove Virus button plays `virys.mp3` | real.html | Maybe, as an opt-in sound |

Violent shake keyframes, if you want them:
`@keyframes violentShake{0%,100%{transform:translateX(0)}10%,30%,50%,70%,90%{transform:translateX(-10px) rotate(-1deg)}20%,40%,60%,80%{transform:translateX(10px) rotate(1deg)}}` → `animation: violentShake .5s ease-in-out 3`.
Confetti = 50 fixed-position ASCII chars `* + o . x -` in `#cc0000 #00cc00 #0000cc #cccc00`, falling in 1.5 to 3.5s.
Glitch = `body{animation:glitch .08s infinite}` + a fixed red "ERROR ERROR ERROR" overlay at 0.7 opacity.

## 5. Assets (all in `public/`; copy them, don't hotlink)

| Path | Size (px) | Bytes | Use |
|---|---|---|---|
| `logo.png` | 2688×917 (transparent, gradient serif "southbag") | 1.0 MB | Header/favicon. **Make a 56px-tall resized copy.** |
| `loaders/1.png` … `loaders/9.png` | 1920×1080 each | 1.5-3.3 MB each (~19 MB total) | Fake promo ads for the carousel ("Be free / With southbag online banking", stock photo with watermarks). Convert to WebP/JPEG first. |
| `not a scamm.png` | 824×456 | 180 KB | "Scam example" lesson image |
| `Screenshot 2026-01-18 at 6.51.38 PM.png` | 872×846 | 356 KB | Lesson image |
| `Screenshot 2026-01-18 at 6.53.28 PM.png` | 666×488 | 318 KB | Lesson image |
| `virys.mp3` | n/a | 1.3 MB | "Remove Virus" audio gag |

Favicon is `logo.png` (`<link rel="icon" href="logo.png" type="image/png">`). No SVGs, icon fonts or other images.
External: `https://platform.slack-edge.com/img/sign_in_with_slack.png` (170×40) on the Link Slack page.

## 6. Screenshots (in `shots/`)

- `index-carousel.png`: promo carousel mid-load (the "Be free" ad)
- `index-shipped.png`, `q-index-shipped-tall.png`: landing as shipped, with popups and with popups dismissed (1280×2400)
- `index-base.png`: landing with styles.css only (Times, grey buttons, giant logo)
- `real-shipped.png`, `q-real-shipped-tall.png`: **logged-in dashboard as shipped** (teal buttons, Lato, chip nav, Products card)
- `real-base.png`, `q-real-base-tall.png`, `real-base-mobile.png`: dashboard with styles.css only
- `q-casino-shipped-tall.png`, `south-crypto-shipped.png`: product page as shipped (card with dashed form separators)
- `south-money-base.png`, `south-casino-base.png`, `south-shop-base.png`: product pages, base (shop tiles visible)
- `chat.png`: modern support-chat shell
- `branch-base.png`, `attacker-base.png`: branch locator (grey map placeholder with spinner) and "You are an attacker." page
- `*.computed.json`: computed styles for body/h1/h2/p/buttons/nav/card (source of the font and size numbers above)

Notes: APIs were mocked (`/api/session`, `/api/account`, `/api/economy`) with a fake user "Kevin Southbag", balance
−$12,345.67, status "frozen · Bronze Minus". In "shipped" shots the CDN CSS was fetched for real. The random reload
was stubbed in memory only (it never runs in production anyway because optimise.js throws first).

## 7. Implementation checklist for Southbag Social

1. Put the `:root` tokens from §1 in one `southbag.css`. Load Lato from Google Fonts and use the Materialize system stack for body text.
2. Shell: `.site-header` (56px logo + h2), `h1#welcome`, status `p`, groove `.south-nav` injected from a `SECTIONS` array (the south-nav.js pattern, `aria-current` in `#800` bold).
3. Feed = `.south-board` of tilted `.south-card` posts. Composer = a card with a dashed-separated form, a `btn-large` "Post" and a 3px `btn-tiny` "Delete".
4. Media grids use `.south-item` inset tiles. Trending/notifications use the `.announcement-grid` (double orange border).
5. DMs use the chat.css shell (blue gradient, 16px radii) and a "Southbag Support" roast bot.
6. Popups: privacy panel (bottom-left), alerts popup (bottom-right, 2.5s), retro `#000080` dialog for confirms and toasts. Each shows once, stored in localStorage.
7. Gags must not block the core flows (post, like, comment, follow, DM), and keyboard/focus must work. Keep all copy snarky.
