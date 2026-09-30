// Tiny client for the API tests. Users are the seeded dev accounts (scripts/seed-local.sh).
export const BASE = process.env.BASE || 'http://localhost:8799';

export function as(who) {
  const headers = { cookie: `southbag_social_session=dev-${who}`, origin: BASE };
  const call = async (method, path, body) => {
    const init = { method, headers: { ...headers } };
    if (body instanceof Uint8Array) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(BASE + (path.startsWith('/') ? path : `/api/${path}`), init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p),
  };
}

export const anon = {
  get: async p => { const r = await fetch(BASE + `/api/${p}`); return { status: r.status, body: await r.json().catch(() => null) }; },
};
