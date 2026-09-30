// Fetch wrapper for the Worker API. Throws ApiError with the server's message.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, data, options = {}) {
  const init = { method, headers: {}, credentials: 'same-origin', signal: options.signal };
  if (data instanceof Blob || data instanceof ArrayBuffer) {
    init.body = data;
    init.headers['content-type'] = 'application/octet-stream';
  } else if (data !== undefined) {
    init.body = JSON.stringify(data);
    init.headers['content-type'] = 'application/json';
  }
  const response = await fetch(path.startsWith('/') ? path : `/api/${path}`, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('auth:required'));
    throw new ApiError(body?.error || `Request failed (${response.status}). It has been logged.`, response.status);
  }
  return body;
}

/** Query string from an object, skipping empty values. */
export const qs = params => {
  const s = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')).toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: (path, params, options) => request('GET', path + qs(params), undefined, options),
  post: (path, data) => request('POST', path, data ?? {}),
  put: (path, data) => request('PUT', path, data),
  patch: (path, data) => request('PATCH', path, data),
  del: (path) => request('DELETE', path),
};
