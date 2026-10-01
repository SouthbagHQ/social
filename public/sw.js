// Service worker for push notifications only (no caching, no fetch handler). Registered by
// public/js/push.js when someone turns notifications on in Settings. Messages come from
// src/lib/push.ts as { title, body, url }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title || 'Southbag Social', {
    body: data.body || 'You have new notifications.',
    icon: '/img/s-256.png',
    data: { url: data.url || '/notifications' },
  }));
});

// Opens the notification's page: in an open tab if there is one (the app navigates without a
// reload, see public/js/push.js), otherwise in a new window.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/notifications', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find(t => new URL(t.url).origin === url.origin);
    if (tab) {
      tab.postMessage({ type: 'navigate', url: url.pathname + url.search });
      return tab.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});

// The push service replaced the subscription: subscribe again with the same key and tell the server.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options?.applicationServerKey
      || await fetch('/api/push').then(r => r.json()).then(r => r.public_key);
    if (!key) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscriptions', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub),
    });
  })());
});
