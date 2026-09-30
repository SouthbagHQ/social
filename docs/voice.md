# Southbag voice & lore guide (for the Southbag social app)

Sources: `/home/user/southbaghq/{website,identity,banking,lore}` plus shallow clones of
`philosophy`, `.github` (as `dotgithub`), `docs` (empty), `Kevin` (one file containing "Kevin"),
`support`, `terminal`, `mobile-v1`. Paths below are relative to `/home/user/southbaghq/`.

---

## 1. What Southbag is

**Premise.** Southbag Institutional Services Ltd. is a fictional, satirical Australian "institution" that
does *everything* (banking, broadband, AI, CSS, identity, ecommerce), watches *everything*, and charges
for *everything*. It satirises big-bank / big-tech overreach: consent-by-continued-use, surveillance
dressed as "compliance", fees for nothing, and AI bolted onto every product. The org profile says it all:

> "An ecosystem of AI powered services you do not fully control." (`dotgithub/profile/README.md`)
> "All commits are retained permanently. Code is never fully deleted." (`dotgithub/profile/README.md`)

The site carries an explicit satire disclaimer (see section 3). Official philosophy (`philosophy/README.md`):
`1. Kevin` · `2. Security through obscurity` · `4. Do everything` · `5. Collect all the data` ·
`7. If the user can't figure it out, it's their problem`.

**Two registers exist. Know which one you are writing in.**
1. **Institutional deadpan** (website, lore, news): polished dark UI, serif display headings, calm
   compliance language that is quietly menacing. Humour comes from understatement.
2. **Borked** (banking, identity, support/Service Table, mobile-v1): *deliberately terrible* UX made for a
   bad-site jam: nonsense form fields, swapped placeholders, lowercase labels, typos, ten redundant
   "Chat with a Human" buttons, `alert()` jokes. Banking README: "A ***deliberately terrible*** 'online
   banking' website made for Borked, a bad site jam".

For the social app, **write the copy in the institutional register** and add a few borked UX gags on purpose.

### Divisions and products (website)
- **Southbag Financial** (`/financial`, codes SB-FIN-001..016): Online Banking, Invest, Crypto Exchange,
  Pay Later, Tax, Rewards, Insurance, International Transfer, For Businesses, PoS, Compliance, Payroll,
  Invoicing, API for Business, Pay Later for Business, Slack Banking for Business (beta).
- **Southbag Digital** (`/digital`, SB-DIG-001..008): Broadband, Mobile, Firewall, VPN, Code, AI, DNS, CSS (beta).
- **Southbag Business** (`/business`, SB-BIZ-001..010): Secure Access, VPN for Business, MDM, CRM, Version
  Control, Data Lake, AI for Business, Edge Compute, Analytics, Ecommerce.
- Standalone apps: Southbag Online Banking, Southbag Identity™, Southbag ID™ (face login), Southbag Code
  (CLI agent), Southbag Terminal (Electron), Southbag Mobile, Southbag Support, Southbag Drive™,
  Southbag Office™, Branch Locator, Southbag News, Southbag Lore. Analytics are called **Palantir**
  (PostHog behind `palantir.southbag.cc`).

### Product naming conventions
- Standalone app = **"Southbag" + plain noun**: Southbag Code, Southbag Terminal, Southbag Mobile, Southbag Support.
- Identity-family and "office suite" products carry **™**: "Southbag Identity™", "Southbag ID™",
  "Southbag Drive™", "Southbag Office™" (`identity/src/routes/(dashboard)/home/+page.svelte`).
- Catalogue entries are bland generic nouns (Invest, Tax, CSS, DNS); business variants add **"for Business"**.
- Every product has a registry code `SB-<DIV>-NNN` and policies are `SB-<AREA>-<YEAR>` (SB-NET-2022,
  SB-DATA-2021, SB-ACT-2018 §14, SB-DNS-POL-03). Error refs: `REF: SB-ERR-404`.
- Subdomain = lowercase product noun on `southbag.cc` (banking., identity., code., drive., office., support.).

### Kevin and the lore (`lore/content/docs/`)
- **Kevin** is the CEO. "Kevin is also policy, atmosphere, surveillance, consequence, and an ongoing
  administrative concern." "Nobody remembers Kevin arriving. He was already there." (`Kevin/index.mdx`)
  He uses a Polycom Soundpoint IP355 (possibly with an ethernet cable running back to Floor 3).
- **Kevin's Presence**: "In many cases, Kevin has taken action before the event that caused it." "Employees
  refer to Kevin the way people refer to weather." (`Kevin/presence.mdx`)
- **Kevin's Office** (always occupied, light never turns off, "Kevin closed them personally"), **Chair**
  ("If the chair faces you, remain professional." / "Kevin already knows."), **Parking Spot** ("Kevin may
  not park there either."), **The Briefcase** (never open it; replica sold for $250).
- **The Pile**: "Employees may be told they have been “added to The Pile.”" "Do not ask whether The Pile is
  physical." (`the-pile.mdx`)
- **Floor 3**: "Southbag has no Floor 3." "The additional network traffic is unrelated." (`floor-3.mdx`)
- **The Issue / 2019**: "There was no 2019 incident. Do not discuss it. Kevin has not been the same since."
  (`2019.mdx`); "The Issue is considered resolved." (`the-issue.mdx`)
- **Canberra**: Kevin despises it ("roundabout-infested", "structurally smug"). Canberra Adjacency Levy,
  Recording 3, the April 2026 Lake Burley Griffin incident ("the lake knows what it did"), ACT drawn as a
  grey polygon labelled "Reserved". Articles registered in the ACT "Under protest. In perpetuity."
- **Online banking's "real" URL** is a 14-label FQDN on `michealsoft.tech` (`online-banking.mdx`).
- **Blahaj**: support staff secretly love Blahaj; Kevin has forbidden them (`banking/slack-prompt.js`).
- **Fees for existing**: "Fee assessed: $7.00 — Kevin's time." Canonical Kevin fee reasons: "Kevin's
  time", "Looking at Kevin wrong", "Existing near Kevin", "Kevin tax", "Interrupting Kevin's lunch",
  "Kevin knows what you did", "Escalation attempt", "Policy curiosity", "Asking where Kevin is".
  Mystery fees (`banking/economy.js`): "Fee for having a fee", "Inactivity fee (you blinked)",
  "Oxygen consumption tax", "Vibes assessment", "Suspicion of happiness tax", "Gravity usage charge".
- **Kevin status badges** (website): Cleared / Reviewed / Pending / Denied / Escalated, plus
  "Reviewed by Kevin", "Approval pending", "Requires Kevin".
- **Iconic sign-offs**: "Kevin is watching." (`website/README.md`), "Kevin is watching" (Identity footer),
  "Questions may be directed to Kevin. Response times are not guaranteed."
- Branches do not exist, but "visit a branch" / "Give up and find a branch" is a standing escape hatch.
- Support chat is "Service Table" (`servicetable.ingo.au`); mobile-v1 is "Solutions made for you." © 0000.

**Avoid**: the `KEVIN_PROMPT` in `banking/slack-prompt.js` contains a private character secret about Kevin.
Do not reference it in product copy. Keep Kevin unseen, unexplained and never apologetic.

---

## 2. Tone rules

1. **Deadpan and declarative.** Short sentences. Full stops. No exclamation marks, no hype.
2. **Consent by continued use.** Lean on "Continued use constitutes acceptance", "subject to review",
   "without notice", "at Southbag's discretion", "not guaranteed".
3. **Surveillance stated as a feature.** Monitoring is "standard operating procedure" and "cannot be disabled".
4. **Kevin is weather, not a mascot.** Mention him briefly and eerily: he has already reviewed it,
   already knows, is not required to respond. Never explain him. Never let him apologise.
5. **Capitalise Kevin's pronouns in UI copy.** He / His / Him / Himself (`website/src/lib/onboarding-kevin.ts`,
   `lore/.../Kevin/index.mdx` "His Polycom"). Proper-noun the lore: The Pile, The Briefcase, The Issue, Floor 3.
6. **Australian/British spelling**: programme, centralised, organised, apologise, licence, enrol,
   optimisation, behavioural, colour. (Watch out for one "enrollment" slip on the website. Don't copy it.)
7. **Casing**: page and section headings in sentence case ("Your name", "Set a password", "Kevin has
   closed this path."). The website uses Title Case for primary CTA buttons ("Get Started", "Sign In",
   "Create Account", "Begin Registration"); Identity uses sentence case ("Sign out", "Delete account",
   "Verify code"). **For the social app, use sentence case for buttons** and Title Case for product
   names only. Eyebrow labels and codes are UPPERCASE monospace ("SERVICES REGISTRY", "REF: SB-ERR-404").
8. **Numbers look official**: dollar fees to the cent (`$12.00`), times as ranges ("3–10 business days"),
   en dash in ranges, em dash between a fee and its reason ("Fee assessed: $3.50 — Existing near Kevin.").
9. **No emojis**, except the Identity joke of emoji-stuffed generic "AI marketing" copy
   ("most personal way to prove that your face is your face 😀"). Use that only as parody.
10. **Two-beat jokes**: a reasonable statement, then a colder one. "Access to services is conditional.
    Your usage is monitored." / "It will begin."
11. **Legalese is the punchline.** Disclaimers are part of the product, not fine print to hide.
12. **Borked gags are deliberate and marked as such**: mislabelled fields ("password (not your real
    password)"), pointless help buttons ("Confused?"), escalating dialogs. Use sparingly on purpose.

### Verbatim examples (file paths relative to `/home/user/southbaghq/`)

Marketing / hero
1. "An ecosystem of AI powered services<br />*you do not fully control.*" (`website/src/pages/index.astro`)
2. "Access to services is conditional. Your usage is monitored. Continued use constitutes acceptance." (`website/src/pages/index.astro`)
3. "Three divisions. One institution." (`website/src/pages/index.astro`)
4. "Built for institutions. Imposed on everyone else." (`website/src/pages/index.astro`)
5. "One account. All services. ... Centralised by design." (`website/src/pages/index.astro`)
6. "All policy exceptions, compliance waivers, and service escalations are reviewed personally by Kevin. Response times are not guaranteed." (`website/src/pages/index.astro`)
7. "Southbag Code: A Terminal Agent for Developers Who Already Have a Terminal" (`website/src/content/news/southbag-code-announced.md`)
8. "Write code only slightly slower than Kevin." (same file)
9. "You trust Kevin. Kevin is watching." (same file)
10. "What is expected of you." (`website/src/pages/business.astro`)

Product blurbs
11. "Points have no cash value and expire at Southbag's discretion." (`website/src/pages/financial.astro`, Rewards)
12. "Banking operations conducted via Slack integration. ... Southbag cannot be held responsible for decisions made via chat." (`website/src/pages/financial.astro`)
13. "Managed stylesheet delivery and transformation services. Southbag may update your styles during scheduled maintenance windows." (`website/src/pages/digital.astro`, CSS)
14. "Inputs retained for 90 days. Outputs may be reviewed. ... Southbag is not liable for outputs." (`website/src/pages/digital.astro`, AI)
15. "All commits are retained permanently. ... Code is never fully deleted." (`website/src/pages/business.astro`, Version Control)
16. "Monitoring cannot be disabled. Contact your account manager for compliance documentation." (`website/src/pages/digital.astro`)
17. "Applications received 247 · Granted this year 3 · Denied or pending 244" (`website/src/pages/digital.astro`)

Legal / disclaimers
18. "By continuing, you agree to all Southbag terms, policies, and data retention schedules. Your consent is non-revocable during the hold period." (`website/src/pages/index.astro`)
19. "By linking Slack, you agree that everything the Slack bot remembers about you may overwrite your Banking record. Kevin has already agreed on your behalf." (`website/src/pages/onboarding.astro`)
20. "All policy decisions are final and reviewed by Kevin." (`website/src/components/Footer.astro`)
21. "Southbag reserves the right to revise published articles retroactively when inaccuracies are identified, or when inaccuracies are identified and deemed inconvenient." (`website/src/content/news/welcome-to-the-news-desk.md`)

Errors / validation
22. "Kevin has closed this path." (`website/src/pages/404.astro`)
23. "This attempt is on record. Kevin was already watching. He does not need to respond." (`website/src/pages/404.astro`)
24. "Fee — $12.00 — Policy curiosity" and "Do not request this path again. The Pile does not forget." (`website/src/pages/404.astro`)
25. "That is not an email. Kevin logged it." (`website/src/lib/onboarding-kevin.ts`)
26. "Eight characters minimum. Kevin did not write the rule. Kevin enforces it." (`website/src/lib/onboarding-kevin.ts`)
27. "Kevin does not ask twice. He asks once and charges. Fee assessed: $7.00 — Kevin's time." (`website/src/lib/onboarding-kevin.ts`)
28. "Unexpected registration failure. Still probably secure." (`identity/src/routes/login/+page.server.ts`)
29. "You are not you" / "That isn't a face" / "That photo is not a photo." (`identity/src/lib/server/plugins/southbag-id.ts`)
30. "Youre account has successfully been deleted<br />Kevin is disappointed in you" (`identity/src/routes/deleted/+page.svelte`, typo is intentional)

Empty states / small UI
31. "No 3rd party apps yet." / "No login methods recorded." / "No active sessions recorded." (`identity/src/routes/(dashboard)/...`)
32. "Apps aren't trusted by Kevin" (`identity/src/routes/(dashboard)/developer/apps/new/+page.svelte`)
33. "No tickets. The house prefers it that way." (`banking/economy.js`)
34. "Buy, sell, or look at prices. That is the whole product." (`banking/economy.js`)
35. "Before continuing, Southbag requires ten dialogues. This makes the app safer by making the user tired." (`identity/src/routes/consent/+page.svelte`)
36. "Shells are a privilege, not a right. Southbag Identity is required." / "Windows is not supported. Please visit a branch." (`terminal/src/renderer/index.html`)
37. "Southbag Mobile accounts are non transferrable and only work in this version of the app and on this device. Sorry, not sorry." (`mobile-v1/www/index.html`)
38. Buttons: "Get Started", "Begin Registration", "Leave the registry", "Yes, sign me in", "No, create one", "Submit Exception Request" (website); "Log in with Southbag Identity", "Give up and find a branch", "Confused?" (`banking/public/index.html`, `terminal/src/renderer/index.html`).

---

## 3. Website structure and the ecosystem

**Stack.** Astro (SSR on Cloudflare), `site: "https://southbag.cc"`, `trailingSlash: "never"`. Fonts:
Cormorant Garamond (display, light 300, italics for the twist), IBM Plex Sans (body), IBM Plex Mono
(labels, codes, nav). Theme colour `#050608` (near-black). The nav wordmark is `/logo.png`. The footer wordmark
is `SOUTHBAG` spaced in mono.

**Titles/SEO** (`website/src/lib/seo.ts`): default `Southbag — Institutional Services`; pages `"<Title> — Southbag"`.
Organisation name: **Southbag Institutional Services Ltd.** Default description: "Southbag provides
integrated financial infrastructure, digital network services, and enterprise business software across jurisdictions."
404 meta: "This path is withheld. Your request has been logged. Kevin has been notified. He does not need to respond."

**Nav** (`website/src/components/Nav.astro`): wordmark · Financial · Digital · Business · News. On the right,
guests see `Sign In` (→ `https://identity.southbag.cc/login`) and `Get Started` (→ `/onboarding`). Signed-in
users see their **email** plus `Dashboard` (→ `https://identity.southbag.cc/home`).

**Product page anatomy** (financial/digital/business): breadcrumb in mono caps (`SOUTHBAG / DIGITAL SERVICES`)
→ H1 "Southbag Digital" → deadpan description → meta counters ("99.4% Uptime (30d)") + status badge
("Operational") + Kevin badge ("Approval pending") → notice band ("Notice" / "Monitoring notice", with a REF
code) → product card grid (name + description) → a detail panel (e.g. "Data Retention Schedule" table:
"Indefinite" / "Not available") → regulatory footer strip (Framework, Data Controller, Executive Review).

**Footer** (`website/src/components/Footer.astro`), verbatim:
- Brand blurb: "Integrated financial, digital, and business services. All operations are monitored.
  Southbag assumes no liability for consequential losses arising from service availability, policy
  enforcement, or compliance holds." · `Reg. No. SB-INS-00-1924`
- Columns: **Financial** (Online Banking, Invest, Crypto Exchange, Pay Later, Tax, Insurance, Compliance,
  Payroll) · **Digital** (Broadband, Mobile, Firewall, VPN, Code, AI, DNS, CSS) · **Business** (Secure
  Access, MDM, CRM, Version Control, Data Lake, Analytics, Edge Compute, Ecommerce) · **Legal & Policy**
  (Terms of Service, Privacy Policy, Acceptable Use, Data Residency, Compliance Framework, Appeals Process,
  Kevin: Contact). All legal links are `#`, which is intentional and tracked as `website_dead_link_click`.
- Disclaimer: "Disclaimer: This website is a work of satire. Southbag is not a real company, and none of
  the services, products, or policies described here exist."
- Bottom row: "© {year} Southbag Institutional Services Ltd. · All rights reserved. · All policy decisions
  are final and reviewed by Kevin." with the right-hand badge "Reviewed by Kevin".
- Other legal entities: Southbag Financial Authority (SFA, Licence No. SB-FIN-LIC-00924), Southbag Digital
  Infrastructure Ltd., Southbag Enterprise Services Ltd., Southbag Insurance Partners Ltd.

**All URLs found**
| URL | What |
|---|---|
| `https://southbag.cc` (+ `www.`) | Marketing site (Astro). `/financial`, `/digital`, `/business`, `/news`, `/onboarding` (`?flow=slack-banking`) |
| `https://identity.southbag.cc` | Southbag Identity™: `/login`, `/home`, `/account`, `/security`, `/southbag-id`, `/developer`, `/consent`, `/deleted`, `/api/auth/*`, `/.well-known/openid-configuration` |
| `https://banking.southbag.cc` | Southbag Online Banking: `/auth/login`, `/auth/onboard`, `/auth/slack/onboard`, `/slack/events`, `/api/*` |
| `https://code.southbag.cc` | Southbag Code (`/auth/login?return_to=/account`) |
| `https://drive.southbag.cc` | Southbag Drive™ (`/auth/login`) |
| `https://office.southbag.cc` | Southbag Office™ (`/auth/login`) |
| `https://support.southbag.cc` | Southbag Support (`/ai` = "Chat with a Human") |
| `https://branch-locator.southbag.cc` | Branch Locator ("Give up and find a branch") |
| `https://palantir.southbag.cc` | Palantir analytics proxy (PostHog) |
| `https://lore.southbag.cc` | Lore archive (Next/Fumadocs) |
| `https://southbaghq.github.io` | Southbag Mobile web UI (trusted origin) |
| `https://servicetable.ingo.au` / `about.servicetable.ingo.au` | Service Table support desk (support repo) |
| `http://internet.online.banking.southbag.v4.customer-access...michealsoft.tech/` | Joke 14-label banking URL |
| `https://southbag-online-banking.com.verify-id.io` | Phishing-quiz "correct" answer (banking learnwithsouthbank) |

The Identity dashboard's "Your apps" grid (`identity/src/routes/(dashboard)/home/+page.svelte`) lists first-party
apps by name + `/auth/login` link. **Ask for the social app to be added there**, as
`{ name: 'Southbag Social', href: 'https://social.southbag.cc/auth/login' }`.

---

## 4. Suggested copy for the social app

### Name (pick one)
1. **Southbag Social** (`social.southbag.cc`), catalogue code **SB-DIG-009** under Digital. Plain
   "Southbag + noun" like Code/Terminal/Mobile. **Recommended**: it matches the convention, reads instantly,
   and leaves the jokes to the copy.
2. **Southbag Feed™**: short, and uses the ™ that the Identity/Drive/Office family carries.
3. **The Pile**: follows are "adding someone to The Pile". Great lore, but the name hides what the product is.
   Better used as a feature name (see below).

**Tagline:** "Share everything. Kevin already has."
Alternates: "Everyone you know. Monitored." · "Connection, subject to review."

### Landing hero
- Eyebrow: `SB-DIG-009 · SOCIAL`
- H1: "A social network of people *you do not fully control.*"
- Sub: "Post, watch, follow and go live across one Southbag account. Your audience is curated. Your reach
  is conditional. Your content is retained permanently. Continued scrolling constitutes acceptance."
- CTA: `Log in with Southbag Identity` (primary) · `Give up and find a branch` (ghost)
- Note under CTA: "By continuing, you agree to all Southbag terms, policies, and content retention schedules.
  Kevin has already liked this on your behalf."

### Buttons (sentence case)
| Action | Label | Tooltip / microcopy |
|---|---|---|
| Post | `Post` | "Submit for review" once pressed; toast "Posted. Pending review." |
| Like | `Like` | Count label "Likes (fees apply)" |
| Unlike | `Withdraw like` | "Withdrawal processing: 1–3 business days." |
| Share | `Share` | "Shared. Recipients have been logged." |
| Repost | `Repost` | "Reposting is reposting. Kevin was first." |
| Follow | `Add to The Pile` | Following state: `In The Pile`. Unfollow: "No removal process is documented." |
| Comment | `Comment` | Placeholder: "Say something compliant." |
| Upload video | `Upload video` | "Uploads are retained permanently. Deletion is advisory." |
| Go live | `Go live` | Confirm: "You are now live. So is Kevin." |
| End stream | `End broadcast` | "Broadcast ended. Recording retained per SB-NET-2022." |
| Report | `Report to Kevin` | "Kevin has already seen it." |
| Block | `Block` | "Blocked. They can still see you. Kevin can still see both of you." |
| Delete post | `Request deletion` | "Deletion request filed. Code is never fully deleted. Neither are posts." |
| Edit | `Amend` | "Amendments are logged. The original is retained." |
| Boost | `Boost post ($4.99)` | "Reach is not guaranteed." |

### Empty states
- No posts (own profile): "Nothing posted yet. Your silence has been noted."
- No posts (feed): "Your feed is empty. This is being reviewed."
- No followers: "Nobody has added you to The Pile. Kevin is aware."
- Not following anyone: "You are not following anyone. Kevin follows you. That will have to do."
- No notifications: "No notifications. Kevin has read them already."
- No comments: "No comments. The silence is compliant."
- No messages: "No messages. All future messages will be retained."
- Search, no results: "No results. The ones you wanted are on Floor 3."

### Errors
- Generic: "Something went wrong. It has been logged. Kevin does not need to respond."
- 404: "Kevin has closed this post." + "Fee — $12.00 — Policy curiosity"
- Post too long: "Posts are limited to 280 characters. Kevin counted. His count is authoritative."
- Empty post: "Kevin does not accept blank posts. He does accept fees. Fee assessed: $2.00 — Kevin tax."
- Upload failed: "Upload failed. The video is still retained."
- Rate limited: "You are posting too confidently. Please wait. Kevin is aware."
- Session expired: "Your session has ended. Southbag Identity is required."
- Canberra geotag: "Location not recognised. That area is Reserved." + "Canberra Adjacency Levy applied."
- Mentioning 2019: "This post references an incident that did not occur. It has been removed."
- Live stream down: "Broadcast unavailable. Please visit a branch."

### Onboarding / login
- Page title: "Welcome to Southbag Social" · body: "You must log in with your Southbag account before you can
  post, watch or be watched."
- Primary button: **`Log in with Southbag Identity`** (the existing label in Banking and Terminal. Use it
  instead of "Sign in with…"). Secondary: `Confused?` → alert "Use the blue button."
- Handle step (Identity has no usernames, see section 5): "Choose a handle. Southbag has already chosen one for you.
  It is @southbag_customer_4471. You may keep it." Button: `Keep assigned handle` / `Request a different handle`.
- Avatar step: "Upload a profile photo. Or don't. We already have your face." (Southbag ID™ nod.)
- Consent line: "By continuing, you agree that your posts, likes, watch history and hesitation may be used
  for Palantir analytics, Rewards points (no cash value), and The Pile."

### Footer disclaimer (reuse website structure)
- Brand blurb: "Southbag Social is a monitored social network operated by Southbag Digital Infrastructure Ltd.
  Reach, visibility and existence are not guaranteed. All posts are final and reviewed by Kevin."
- Keep the verbatim satire line: "Disclaimer: This website is a work of satire. Southbag is not a real
  company, and none of the services, products, or policies described here exist."
- Bottom: "© {year} Southbag Institutional Services Ltd. · All rights reserved. · All policy decisions are
  final and reviewed by Kevin." + badge "Reviewed by Kevin".
- Ecosystem links: Southbag (southbag.cc) · Identity · Online Banking · Code · Support · Branch Locator · Lore.

### ~15 satirical gags
1. **Like fee ledger.** Each like costs $0.02 ("Appreciation surcharge"). Receiving likes incurs "Popularity
   tax". The ledger link says "View in Southbag Online Banking".
2. **Sponsored by Kevin's Briefcase.** A promoted post shows the $250 replica: "Do not open. Ships sealed.
   Customers who have opened it should not post about it."
3. **Kevin's account.** @kevin has 0 posts, follows everyone, and has "Seen" on every story, including
   stories posted before he joined. A follow button that always reads `Already following you`.
4. **Verified tiers.** Bronze→Silver→Gold→Platinum→Diamond→Obsidian checkmarks. "Each tier costs more and does
   absolutely nothing." (the banking `/south-upgrade` joke)
5. **Terms of Posting §14.** "Continued scrolling constitutes acceptance. Scrolling backwards constitutes
   acceptance twice."
6. **Retention schedule table** on the privacy page: Posts: Indefinite. Deleted posts: Indefinite. Drafts
   you didn't send: Indefinite. Deletion: "Not available."
7. **Floor 3 channel.** A live stream with 1 viewer that nobody started. Tapping it: "Southbag has no Floor 3."
8. **Canberra geofence.** Posts tagged in the ACT are greyed out and labelled "Reserved". The Canberra
   Adjacency Levy is charged per view from Melbourne.
9. **Algorithmic transparency panel.** "Why am I seeing this?" answers: "Kevin." Appeals route to the
   (`#`) Appeals Process link.
10. **Blahaj shadowban.** Any image containing a Blahaj posts with "This content is prohibited. (We love it.)".
    Buying a "Prohibited Shark Permit" ($140) lifts it.
11. **Mystery fee notifications.** "You were charged $0.37: Vibes assessment." "Suspicion of happiness tax."
12. **Unfollow policy.** Unfollowing requires 30 days' notice and a written executive request, mirroring
    Business "Termination and Offboarding".
13. **Go-live gauntlet.** Going live from an untrusted device requires ten confirmation dialogs, as the
    Identity consent screen does. "This makes the stream safer by making the streamer tired."
14. **Read receipts for posts you haven't written yet.** "Kevin has taken action before the event that caused it."
15. **Stories expire in 24 hours. Retention does not.** The story ring label is "Expired (retained)".
16. **Office light cam.** A permanent 24/7 live stream of Kevin's office light. It never turns off, and
    maintenance tickets in the comments are "closed by Kevin".
17. **Support button farm.** Ten stacked buttons ("Chat with a Human", "Live Support", "Speak to an Agent") that
    all go to `support.southbag.cc/ai`.

---

## 5. Southbag Identity (how it presents itself)

- **Product name:** "Southbag Identity™" (Better Auth `appName` and TOTP `issuer` in
  `identity/src/lib/server/auth.ts`; login heading "Welcome to Southbag Identity™" / "Please log in to access
  your account."). Dashboard pages are titled `Southbag Identity - Home|Account|Security|Developer`, and the
  footer reads "Kevin is watching". The UI is deliberately borked (the password field placeholder is
  "Enter username", and there are fields like "amount" and "Balance?").
- **Face login sub-brand:** "Southbag ID™" with the buttons "Sign in with Southbag ID™" / "Close Southbag ID™" and
  the hint "Look directly into the camera and think about banking." (`identity/src/lib/components/SouthbagIdLogin.svelte`).
- **Button text other apps use:** **"Log in with Southbag Identity"** (`banking/public/index.html`,
  `terminal/src/renderer/index.html`), with the page meta "Log in to Southbag Online Banking with Southbag Identity."
  The website nav simply says "Sign In", and onboarding says "Enter your Southbag Identity credentials."
- **Integration pattern** (terminal README, banking README): OAuth 2.1 + PKCE public client, **dynamic client
  registration** (`allowUnauthenticatedClientRegistration: true`) at `/api/auth/oauth2/register`; authorize,
  token and userinfo at `/api/auth/oauth2/{authorize,token,userinfo}`; discovery at
  `/.well-known/openid-configuration`. Redirect URIs that are all `https://*.southbag.cc` **skip consent**
  (`southbag-trust.ts`). Any other redirect triggers the ten-dialog "Southbag Untrusted App Warning" gauntlet.
  The session cookie is shared on `.southbag.cc`, and any `https://*.southbag.cc` origin may call
  `/api/auth/get-session` with credentials (CORS in `identity/src/lib/server/cors.ts`).
- **Scopes:** `openid profile email money accounts transfer_everything offline_access`.
- **User table** (`identity/src/lib/server/db/auth.schema.ts`): `id, name, email, emailVerified, image,
  createdAt, updatedAt, twoFactorEnabled`. There is **no username / handle field**.
- **Userinfo claims** (Better Auth `@better-auth/oauth-provider` ~1.4.21, `userNormalClaims`, no custom claims configured):
  - always `sub` (user id)
  - `profile` scope: `name`, `picture` (= `user.image`), `given_name`, `family_name` (split from name)
  - `email` scope: `email`, `email_verified`
  - no `preferred_username`, `nickname` or handle.
- **Caveats for a social app:**
  - Every Identity account is created with `name: "Southbag Customer"` (`identity/src/routes/login/+page.server.ts`,
    `website/src/lib/identity.ts` `IDENTITY_DEFAULT_NAME`). The name typed during website onboarding goes only
    to Palantir (`onboarding_name`), so `name` is effectively always "Southbag Customer" and
    `given_name`/`family_name` are "Southbag"/"Customer".
  - `image` is never set by any UI, so `picture` is usually absent. Southbag ID™ face photos live in a separate
    table (`southbag_id_credential`) and are **not** exposed via userinfo.
  - Result: the social app must own **handles, display names and avatars** itself and key users by `sub`.
    This fits the voice ("Southbag has already chosen one for you").
  - Palantir: identify users by Identity `sub`, super property `southbag_app: "social"` (the convention in the terminal README).
