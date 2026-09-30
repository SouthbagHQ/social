# Southbag Social

A social network of people *you do not fully control.*

Southbag Social is Southbag's answer to Twitter, Instagram, YouTube, Facebook and TikTok, in one
monitored place: short posts, photo posts, long videos, vertical shorts, 24-hour stories, groups,
friends, walls, reactions, reposts, direct messages and notifications. Everything is retained
permanently. Continued scrolling constitutes acceptance.

It signs in with **Southbag Identity™** and follows the look of
[Southbag Online Banking](https://github.com/SouthbagHQ/banking): teal buttons, beveled borders,
crooked paper cards and a promotional banner nobody asked for.

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
`/welcome` to choose a handle. Southbag has already chosen one for you.

## Develop

```sh
npm install
npm run db:migrate:local
npm run seed:local     # test users alice, bob, carol and kevin
npm run dev            # http://localhost:8787
```

Set the cookie `southbag_social_session=dev-alice` (or `dev-bob`, `dev-carol`, `dev-kevin`) to be
signed in locally without Identity. `npm run check` type-checks the Worker.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before adding a feature. The UI guide is
[`docs/design.md`](docs/design.md) and the copy guide is [`docs/voice.md`](docs/voice.md).

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

*This is satire. Southbag is not a real company, and none of the services, products, or policies
described here exist. All policy decisions are final and reviewed by Kevin.*
