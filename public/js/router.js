// History-API router. Routes map a path pattern to a lazily imported view module.
//
// A view module's default export is `async function (ctx) → Node`:
//   ctx.params   route params, e.g. { handle } for '/@:handle'
//   ctx.query    URLSearchParams
//   ctx.path     current pathname
//   ctx.me       signed-in user (store.me) or null
//   ctx.layout(kind)   'default' (main + sidebar), 'wide' (no sidebar, 1280px), 'full' (edge to edge, no footer)
//   ctx.title(text)    sets document.title ("text — Southbag Social")
//   ctx.cleanup(fn)    run fn when navigating away (stop videos, observers, timers…)
//   ctx.signal         AbortSignal aborted on navigation (pass to api.get)
//   ctx.requireAuth()  returns true if signed in, otherwise renders the sign-in prompt and returns false
//
// Links: any <a href="/..."> is intercepted automatically. Use navigate(path) in code.

import { store } from './store.js';

const routes = [];
let current = { cleanups: [], controller: null };
let renderFn = null;

/** Register a route. Pattern segments starting with ':' are params; '@:handle' matches '/@kevin'. */
export function route(pattern, load) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/\/$/, '').replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; }) + '/?$');
  routes.push({ pattern, regex, keys, load });
}

export function match(path) {
  for (const r of routes) {
    const m = path.match(r.regex);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function navigate(to, { replace = false, scroll = true } = {}) {
  const url = new URL(to, location.origin);
  if (url.origin !== location.origin) { location.href = url.href; return; }
  if (replace) history.replaceState({}, '', url.pathname + url.search + url.hash);
  else history.pushState({}, '', url.pathname + url.search + url.hash);
  run(scroll);
}

/** Re-render the current route (after login state changes, say). */
export const refresh = () => run(false);

export function startRouter(render) {
  renderFn = render;
  window.addEventListener('popstate', () => run(false));
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.external != null) return;
    const url = new URL(a.href, location.origin);
    if (url.origin !== location.origin || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/')) return;
    event.preventDefault();
    if (url.pathname === location.pathname && url.search === location.search && url.hash) { location.hash = url.hash; return; }
    navigate(url.pathname + url.search + url.hash);
  });
  run(false);
}

async function run(scroll) {
  for (const fn of current.cleanups) { try { fn(); } catch (e) { console.error(e); } }
  current.controller?.abort();
  const controller = new AbortController();
  const cleanups = [];
  current = { cleanups, controller };
  // Workers Assets canonicalises /@handle to /%40handle on a hard load; put the @ back.
  if (location.pathname.includes('%40')) {
    history.replaceState(history.state, '', location.pathname.replaceAll('%40', '@') + location.search + location.hash);
  }
  const found = match(location.pathname) || match('/404');
  const ctx = {
    params: found?.params || {},
    query: new URLSearchParams(location.search),
    path: location.pathname,
    me: store.me,
    signal: controller.signal,
    cleanup: fn => cleanups.push(fn),
  };
  await renderFn(ctx, found?.route, controller, scroll);
}
