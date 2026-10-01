// Push notifications in this browser: Settings turns them on and off, and app.js keeps the
// subscription registered for whoever turned them on. The service worker is public/sw.js; the
// server side is src/routes/push.ts and src/lib/push.ts.
//   GET /api/push   POST /api/push/subscriptions   DELETE /api/push/subscriptions?endpoint=

import { api, qs } from './api.js';
import { navigate } from './router.js';
import { store } from './store.js';

// Who turned notifications on in this browser. Someone else signing in here doesn't inherit them.
const OWNER = 'sb_push_user';
const owner = () => { try { return localStorage.getItem(OWNER); } catch { return null; } };
const setOwner = id => { try { id ? localStorage.setItem(OWNER, id) : localStorage.removeItem(OWNER); } catch {} };

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhones and iPads only offer notifications to sites added to the Home Screen. */
export const needsHomeScreen = () => !pushSupported() && /iPhone|iPad|iPod/.test(navigator.userAgent);

let config = null;
const serverConfig = () => (config ??= api.get('push').catch(err => { config = null; throw err; }));

const keyBytes = key => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const sameKey = (sub, key) => {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current), b = keyBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

async function registration() {
  return navigator.serviceWorker.getRegistration('/');
}

/** A subscription made with the server's current key (the old one is dropped if the key changed). */
async function subscribe(reg, publicKey) {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) { await sub.unsubscribe(); sub = null; }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
}

/** 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on' */
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  const { enabled } = await serverConfig();
  if (!enabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || owner() !== store.me?.id) return 'off';
  const reg = await registration();
  return reg && await reg.pushManager.getSubscription() ? 'on' : 'off';
}

/** Call straight from a click: the permission prompt needs one. Resolves false if it was refused. */
export async function enablePush() {
  const registering = navigator.serviceWorker.register('/sw.js');
  if (await Notification.requestPermission() !== 'granted') return false;
  const { public_key } = await serverConfig();
  await registering;
  let sub;
  try {
    sub = await subscribe(await navigator.serviceWorker.ready, public_key);
  } catch (err) {
    // Private windows and some browsers refuse with technical messages; say it plainly.
    console.warn(err);
    throw new Error("Notifications can't be turned on in this browser.");
  }
  await api.post('push/subscriptions', sub.toJSON());
  setOwner(store.me?.id);
  return true;
}

export async function disablePush() {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) {
    await api.del(`push/subscriptions${qs({ endpoint: sub.endpoint })}`);
    await sub.unsubscribe();
  }
  setOwner(null);
}

/**
 * On every visit: re-send the subscription (a no-op on the server unless something changed, such as
 * signing in again), and follow clicks on notifications into the open tab.
 */
export async function startPush() {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener('message', e => {
    const url = e.data?.type === 'navigate' && typeof e.data.url === 'string' ? e.data.url : null;
    if (url && url.startsWith('/') && !url.startsWith('//')) navigate(url);
  });
  navigator.serviceWorker.startMessages();
  if (!store.me || owner() !== store.me.id || Notification.permission !== 'granted') return;
  try {
    const reg = await registration();
    if (!reg || !await reg.pushManager.getSubscription()) return;
    const { enabled, public_key } = await serverConfig();
    if (!enabled) return;
    await api.post('push/subscriptions', (await subscribe(reg, public_key)).toJSON());
  } catch (err) {
    console.warn('Notifications could not be registered.', err);
  }
}
