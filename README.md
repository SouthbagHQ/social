# Southbag Social

Posts, photos, videos, shorts, stories, groups and messages for Southbag accounts.

It signs in with **Southbag Identity™** and follows the look of the other Southbag products
([Identity](https://github.com/SouthbagHQ/identity), [Office](https://github.com/SouthbagHQ/office),
[Branch Locator](https://github.com/SouthbagHQ/branch-locator)).

## How it runs (Cloudflare free plan)

- **One Worker** (`src/`, [Hono](https://hono.dev)) plus **Workers Assets** for the frontend
  (`public/`, plain ES modules, no build step). Only `/api/*`, `/auth/*` and `/media/*` wake the
  Worker; every other request is a free static file.
- **One D1 database for everything, including files.** There is no R2. Photos and videos are
  split into 1.5 MiB chunks and stored as BLOB rows (a D1 row tops out at 2 MB). A free-plan
  database holds 500 MB; files may use 400 MB of it, and uploads past that are refused.
- Files are served with HTTP Range support, one chunk per request, so seeking a video costs one
  query. Chunks are immutable and cached with the Cache API on custom domains.
- The browser shrinks photos to 2048 px WebP before uploading and grabs a poster frame from videos.
  Limits: photos 10 MB, videos 60 MB, audio 20 MB.
- An hourly cron trigger expires stories, cleans up abandoned uploads and sessions, and renews
  Southbag Verified.
- **Southbag Verified is paid for with real (fake) money.** Subscribing takes $8.00 straight from
  the subscriber's [Southbag Online Banking](https://github.com/SouthbagHQ/banking) account, and
  again every 30 days. Banking opens an account for anyone who doesn't have one. Social calls
  Banking's `Billing` entrypoint over a service binding (`BANKING`; RPC between the two Workers,
  not reachable from the internet), see `src/lib/banking.ts`. Locally there is no bank unless you
  run Banking's `wrangler dev` too; `scripts/test.sh` sets `BANKING_DEV=1`, which makes charges
  succeed without one.
- **People send each other money** from `/payments`, a profile ("Send money") or a one-to-one chat.
  Banking moves the money with its own transfer (and its fee pile, paid by the sender) through the
  same binding; Social records the payment, posts it in the pair's chat and notifies the recipient.
  Payments are final.
- **Push notifications** with no push provider account (Web Push). Settings > Notifications turns
  them on for one browser. The Worker encrypts each message for that browser and signs it with our
  own VAPID key (`src/lib/push.ts`, WebCrypto, no packages), then sends it to the push service the
  browser picked (Google's, Mozilla's, Apple's or Microsoft's). Routes don't send anything: after
  every write request, and after the hourly cron, the Worker pushes notification rows from the last
  10 minutes that haven't been pushed or read (at most 20 a run). A subscription ends with the
  session that made it. iPhones and iPads need Social added to the Home Screen first
  (`public/manifest.webmanifest`). Chats don't push yet; only notifications do.

## Southbag Identity

Login is the same OIDC + PKCE flow Southbag Online Banking uses. The first login from an origin
registers a public client with `identity.southbag.cc` (dynamic client registration). Redirect
URIs on `*.southbag.cc` skip Identity's consent gauntlet. Sessions are opaque tokens stored hashed.
Apps can also send an Identity access token as `Authorization: Bearer …`.

Identity calls everyone "Southbag Customer" and has no usernames, so new accounts land on
`/welcome` to choose a handle.

## Develop

```sh
npm install
npm run db:migrate:local
npm run seed:local     # test users alice, bob, carol and kevin
npm run dev            # http://localhost:8787
```

Set the cookie `southbag_social_session=dev-alice` (or `dev-bob`, `dev-carol`, `dev-kevin`) to be
signed in locally without Identity. `npm run check` type-checks the Worker.

Push notifications are off locally until you add keys: `node scripts/vapid-keys.mjs >> .dev.vars`.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before adding a feature, and
[`docs/STYLE.md`](docs/STYLE.md) for the interface and copy rules.

## Analytics

Social reports to Palantir, the PostHog instance every Southbag app uses (`palantir.southbag.cc`).

- **Browser.** `public/palantir.js` is the shared Southbag client script, identical in every app
  (don't edit it here). It records pageviews, including client-side navigation, plus clicks,
  page leaves, errors, web vitals and session replays. It identifies the signed-in user by their
  Identity id from `/api/me`. `public/js/store.js` re-identifies or resets when someone signs in or
  out mid-visit. Views can send custom events with `track()` from `public/js/analytics.js`.
- **Server.** `track(c, 'social_…', props)` from `src/lib/palantir.ts` records what the API did:
  sign-in, sign-out and new accounts, posts, reactions, reposts, bookmarks, follows, friends and
  blocks, uploads, stories, groups, communities, events, podcasts and music, servers, careers,
  polls, pins, searches and profile edits. Events are sent after the response (`waitUntil`), so
  they never slow down or break a request. They join the browser's session through PostHog's
  cookie and are attributed to the signed-in user.
- **Not captured.** Only ids, kinds, counts and flags are sent. Post text, comments, messages,
  captions and search queries are never sent: searches record the type, query length and result
  count. Server events drop the query string from `$current_url`.
- **Local dev and tests.** The server sends nothing from `localhost`/`127.0.0.1` or under
  `node --test`. To try it locally, run
  `npx wrangler dev --var PALANTIR_DEV:1 --var PALANTIR_HOST_OVERRIDE:http://127.0.0.1:8827` with
  a local collector on that port. The override only works for localhost requests. The shared
  browser script still runs in local dev, as it does in every Southbag app. Block
  `palantir.southbag.cc` in your browser if you don't want local clicks recorded.

## Deploy

```sh
npm run deploy         # applies migrations, then deploys
```

Banking must already be deployed with its `Billing` entrypoint, or subscribing to Verified fails
with "Southbag Online Banking is unavailable." (nothing is charged).

Push notifications need a VAPID key pair, once: run `node scripts/vapid-keys.mjs`, then
`npx wrangler secret put VAPID_PUBLIC_KEY` and `npx wrangler secret put VAPID_PRIVATE_KEY` with the
two values. Until then Settings says "Notifications aren't available." Keep the pair: a new one cuts
every browser off until it next opens Social.

It deploys to the Southbag account (`account_id` in `wrangler.jsonc`) at `social.southbag.cc`,
with the `southbag-social` D1 database. For a fresh account, run
`npx wrangler d1 create southbag-social` and put its `database_id` in `wrangler.jsonc` first.

To list Southbag Social on the Identity dashboard, add
`{ name: 'Southbag Social', href: 'https://social.southbag.cc/auth/login' }` to the "Your apps"
grid in SouthbagHQ/identity.

---

*This is satire. Southbag is not a real company.*
