// Makes a VAPID key pair for push notifications (src/lib/push.ts).
//
//   node scripts/vapid-keys.mjs            prints VAPID_PUBLIC_KEY=… and VAPID_PRIVATE_KEY=… (.dev.vars format)
//   node scripts/vapid-keys.mjs --vars     prints them as `wrangler dev --var` flags (scripts/test.sh)
//
// Production: run it once and store each value with `npx wrangler secret put VAPID_PUBLIC_KEY` and
// `npx wrangler secret put VAPID_PRIVATE_KEY`. Keep the pair. A new pair cuts off every browser
// until it next opens Southbag Social, which subscribes it again with the new key.
const { webcrypto: { subtle } } = await import('node:crypto');
const { publicKey, privateKey } = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = Buffer.from(await subtle.exportKey('raw', publicKey)).toString('base64url');
const { d } = await subtle.exportKey('jwk', privateKey);
if (process.argv.includes('--vars')) console.log(`--var VAPID_PUBLIC_KEY:${pub} --var VAPID_PRIVATE_KEY:${d}`);
else console.log(`VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${d}`);
