#!/usr/bin/env bash
# Seeds the LOCAL D1 database with test accounts and ready-made sessions, so you can use the app
# under `wrangler dev` without a round trip to Southbag Identity.
#   npm run db:migrate:local && npm run seed:local
# Then set a cookie in the browser (or curl -H 'cookie: …'):
#   southbag_social_session=dev-alice   (also dev-bob, dev-carol, dev-kevin)
set -euo pipefail
cd "$(dirname "$0")/.."
sql=""
now=$(date +%s000)
for who in alice bob carol kevin erin frank; do
  hash=$(node -e "console.log(require('crypto').createHash('sha256').update('dev-$who').digest('base64url'))")
  name="$(tr '[:lower:]' '[:upper:]' <<< "${who:0:1}")${who:1}"
  [ "$who" = kevin ] && name="Kevin" && verified=1 || verified=0
  sql+="INSERT OR IGNORE INTO users (id, handle, name, bio, verified, created_at, updated_at) VALUES ('dev-$who', '$who', '$name Southbag', 'Test account.', $verified, $now, $now);"
  sql+="INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('$hash', 'dev-$who', 9999999999999, $now);"
done
# Identity tokens for shared albums (media is uploaded to each user's OWN Drive). Carol
# deliberately gets none, so the tests can watch the "sign in again" path.
for who in alice bob kevin; do
  sql+="INSERT OR REPLACE INTO identity_tokens (user_id, access_token, refresh_token, expires_at, updated_at) VALUES ('dev-$who', 'dev-drive-$who', NULL, 9999999999999, $now);"
done
npx wrangler d1 execute DB --local ${PERSIST_TO:+--persist-to "$PERSIST_TO"} --command "$sql" > /dev/null
echo "Seeded. Cookies: southbag_social_session=dev-alice | dev-bob | dev-carol | dev-kevin"
