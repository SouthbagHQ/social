# Southbag Social

Posts, photos, videos, shorts, stories, groups and messages for Southbag accounts.

It signs in with **Southbag Identity™** and follows the look of the other Southbag products
([Identity](https://github.com/SouthbagHQ/identity), [Office](https://github.com/SouthbagHQ/office),
[Branch Locator](https://github.com/SouthbagHQ/branch-locator)).

## How it runs (Cloudflare free plan)

- **One Worker** (`src/`, [Hono](https://hono.dev)) plus **Workers Assets** for the frontend
  (`public/`, plain ES modules, no build step). Only `/api/*`, `/auth/*` and `/media/*` wake the
  Worker; every other request is a free static file.
- **D1 for everything, including files.** There is no R2. Photos and videos are split into
  1.5 MiB chunks and stored as BLOB rows (a D1 row tops out at 2 MB). Chunks live in a separate
  `MEDIA` database. A free-plan database holds 500 MB, so you can bind more chunk stores as
  `MEDIA_1` … `MEDIA_9`, and new uploads go to the emptiest one.
- Files are served with HTTP Range support, one chunk per request, so seeking a video costs one
  query. Chunks are immutable and cached with the Cache API on custom domains.
- The browser shrinks photos to 2048 px WebP before uploading and grabs a poster frame from videos.
  Limits: photos 10 MB, videos 60 MB, audio 20 MB.
- An hourly cron trigger expires stories and cleans up abandoned uploads and sessions.

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

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before adding a feature, and
[`docs/STYLE.md`](docs/STYLE.md) for the interface and copy rules.

## Deploy

```sh
npx wrangler d1 create southbag-social
npx wrangler d1 create southbag-social-media
# Put both database_id values in wrangler.jsonc, and uncomment the social.southbag.cc route.
npm run deploy         # applies migrations to both databases, then deploys
```

To add storage later: create another database, apply `migrations-media/` to it, and bind it as
`MEDIA_1` in `wrangler.jsonc`.

To list Southbag Social on the Identity dashboard, add
`{ name: 'Southbag Social', href: 'https://social.southbag.cc/auth/login' }` to the "Your apps"
grid in SouthbagHQ/identity.

---

*This is satire. Southbag is not a real company.*
