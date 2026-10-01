# Southbag Social — architecture and conventions

Read this before adding a feature. See also `docs/STYLE.md` (interface and copy).

## Runtime (Cloudflare free plan)

- One Worker (`src/index.ts`, Hono) plus Workers Assets for `public/`. Only `/api/*`, `/auth/*` and
  `/media/*` run the Worker; everything else is a static file, and unknown paths fall back to
  `public/index.html` (the SPA).
- **One D1 database.** `DB` holds everything, file bytes included (`migrations/`; chunks are in
  the `chunks` table). No R2, no KV, no Durable Objects.
- Free plan limits that shape the code: 10 ms CPU per request, 50 D1 queries per request,
  100k D1 row writes per day, 2 MB per D1 row, 500 MB per database. So: batch writes with
  `env.DB.batch`, keep list pages ≤ 50 items, use keyset pagination, avoid N+1 queries
  (`hydrate()` batches everything for a page of posts), no per-request fan-out writes.
- Hourly cron (`scheduled` in `src/index.ts`) expires stories, cleans up and renews Southbag
  Verified.
- **Money.** Southbag Online Banking holds everyone's money; Social reaches it through the `BANKING`
  service binding (Banking's `Billing` entrypoint, RPC) with `charge()`, `transfer()` and
  `account()` from `src/lib/banking.ts`. Southbag Verified uses `charge()` (claim the change in D1
  first and undo it if the charge throws, so nothing is charged twice). Payments between people
  (`src/routes/payments.ts`) use `transfer()`, Banking's own transfer with its fees and refusals,
  then record the payment, add a message with `payment_id` to the pair's one-to-one conversation
  and notify the recipient. No confirmation dialogs before money moves; payments can't be deleted.

## Auth

`src/lib/auth.ts` — Southbag Identity (OIDC + PKCE, dynamic client registration, same as
banking). Session cookie `southbag_social_session` (opaque, stored hashed) or an Identity
`Bearer` token. In a route, `c.get('user')` is the `SessionUser` or null; `requireUser(c)` throws 401.
Mutating requests with a cookie session must come from the same origin (checked in middleware).

Identity only gives us `sub`, `email`, `name` ("Southbag Customer" for everyone) and sometimes
`picture`, so Southbag Social owns handles, display names, bios and avatars. New users land
on `/welcome` to pick theirs.

## Backend conventions

- One Hono router per feature in `src/routes/<feature>.ts`, mounted in `src/index.ts` at
  `/api/<feature>`. Don't edit other features' routers.
- Errors: `fail(status, message)` from `src/lib/http.ts`. The message is shown to the user, so
  keep it short and plain ("Post not found.").
- Input: `await body(c)` and `str(value, max)`. Never trust client ids; check ownership.
- Paging: `?cursor=<last id>&limit=`; respond `{ items, next }` (`next` null at the end). IDs are
  time-sortable (`newId()`), so `WHERE id < ? ORDER BY id DESC` is newest-first keyset paging.
- Posts: never build post JSON by hand. Query post rows (use `visibleTo(viewerId)` for the WHERE
  clause and filter `deleted_at IS NULL` in lists), then `hydrate(env, viewer, rows)` →
  `PostJson[]`. Create posts with `createPost()` (it keeps counters, tags and notifications
  right). `deletePost()` is only for undoing a plain repost.
- Users in responses: `userCard(row)` (`{ id, handle, name, avatar_url, verified }`), selecting
  `userCardColumns`. Add `is_following` etc. alongside when useful.
- Notifications: `notify(env, {...})` or `notifyStatement()` inside a batch.
- Files: `ownedReadyMedia()` to validate media ids a user attaches; `mediaJson()` for output;
  `deleteMedia()` / `deleteUnusedMedia()` only for files nothing shows any more (abandoned
  uploads, replaced pictures, expired stories).
- **Nothing can be deleted.** No route deletes something a person made. Refuse with
  `fail(403, NO_DELETING)`; unmatched `DELETE /api/*` requests get that from `src/index.ts`.
  Undoing an action (unlike, unfollow, leave, withdraw) is fine. Community moderators can hide
  threads and comments (`removed`): hidden things stay readable by moderators and their author.

## Frontend conventions (`public/js`, no build step)

- ES modules, no framework. `h(tag, props, ...children)` from `dom.js` builds DOM. Never use
  `innerHTML` with user content.
- Routes are registered in `app.js`. A view is `public/js/views/<name>.js` whose default export
  is `async (ctx) => Node` (see the header comment in `router.js` for `ctx`: params, query, me,
  layout('default'|'wide'|'full'), title(), cleanup(), signal, requireAuth()).
- API: `api.get('feed', { cursor })`, `api.post('posts', {...})` etc. (`api.js`). Paths are relative
  to `/api/`. Errors are `ApiError` with the server's message — show with `toastError(err)` (a dialog; there are no toasts).
- Shared components — use them, don't re-implement:
  - `components/post.js` — `postCard(post, opts)`, `reactionButton`, `richText`, `postUrl`
  - `components/composer.js` — `composer({...})` / `composerCard()` (text, photos, video, uploads)
  - `components/media.js` — `photoGrid`, `carousel`, `videoEl`, `videoPlayer`, `videoThumb`, `postMedia`
  - `components/user.js` — `avatar`, `userName`, `verifiedBadge`, `followButton`, `userRow`
  - `ui.js` — `toast` / `toastError` (both open a dialog), `dialog`, `confirm`, `promptDialog`,
    `menu`, `loading`, `empty`, `errorBox`, `tabs`, `infiniteList`, `lightbox`, `share`, `copy`,
    `refuseDelete`
  - `upload.js` — `uploadFile(file, { onProgress })`, `pickFiles()`
  - `format.js` — `timeAgo`, `relative`, `count`, `plural`, `duration`, `money`
  - `store.js` — `store.me`, `store.unread`, `store.refresh()`, `store.patchMe()`, `login()`
- Styling: `public/css/southbag.css` holds the design system (tokens, `.south-card`,
  `.announcement-grid`, `.south-item`, `.btn`/`.btn-large`/`.btn-small`/`.btn-tiny`, `.tabs`,
  `.dialog`, …). Feature-specific CSS goes in `public/css/<feature>.css`, linked from
  `index.html`. Use the tokens (`var(--sb-blue)`, `var(--sb-muted)`, …) so dark mode works.
- Interface and copy rules: `docs/STYLE.md` (plain text only, greyscale, stretched media).

## Local development

```sh
npm install
npm run db:migrate:local
npm run seed:local          # test users alice, bob, carol, kevin
npm run dev                 # http://localhost:8787
```

Use the cookie `southbag_social_session=dev-alice` (or `dev-bob`, `dev-carol`, `dev-kevin`) to be
signed in without Identity. Mutating API calls need `origin: http://localhost:8787`.
`npx tsc --noEmit` type-checks the Worker.

## Migrations

Migration numbers are reserved per feature so parallel work never collides:
`0003_polls_pins.sql`, `0004_communities.sql`, `0005_events.sql`, `0006_audio.sql`,
`0007_servers.sql`, `0008_careers.sql`, `0009_notification_links.sql`, `0010_marketplace.sql`,
`0011_boards.sql`, `0012_streaks.sql`, `0013_wiki.sql`, `0014_dating.sql`. Never edit an applied
migration; add a new one.

## Analytics

Palantir (PostHog behind `palantir.southbag.cc`) is shared by every Southbag app. Record events with
`track(c, 'event_name', props)` from `src/lib/palantir.ts` on the server and `track('event_name', props)`
from `public/js/analytics.js` in the browser. Event names are `social_<noun>_<past-tense verb>`,
e.g. `social_post_created`, `social_listing_sold`.

- Call `track(c, …)` after the write succeeds, as a single line, usually just before `return c.json(…)`.
  It returns nothing and never throws. The event is sent after the response with `waitUntil`.
- Properties are ids, kinds, counts and flags only. Never send post or message text, captions,
  search queries or other free text. Send a length or a boolean such as `has_note` instead.
- The event goes to the signed-in user (`c.get('user')`, whose id is the Identity `sub` the browser
  identifies with). Signed-out visitors fall back to PostHog's cookie id, and events without either
  are dropped. Pass a fourth argument, `track(c, event, props, { id })`, when the actor isn't the
  session user, e.g. on `/auth/*` routes. Outside a Hono handler, use
  `tracker(request, env, ctx, user).capture(event, props)` (see `src/lib/auth.ts`).
- The server sends nothing under `node --test` or from localhost unless `PALANTIR_DEV=1`
  (`PALANTIR_HOST_OVERRIDE` points a local run at a mock collector).
- Pageviews are automatic. The shared `public/palantir.js` uses `capture_pageview: "history_change"`,
  so the router must not capture its own. Don't edit `public/palantir.js`: it is identical in every
  Southbag app.
