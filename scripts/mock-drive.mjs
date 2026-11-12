// Test double for Southbag Drive's user-token API (scripts/test.sh starts it for albums tests).
// Matches the real thing's contract:
//   PUT  /api/upload               Bearer <user token>, content-length required
//                                  -> 201 { id, name, size } / 401 / 411
//   POST /api/files/<id>           Bearer, { share: true } -> 200 { token, url } / 401 / 404
//   GET  /share/<token>/download   PUBLIC, always the whole file (no Range) -> 200 / 404
// Tokens are the ones scripts/seed-local.sh plants in identity_tokens: dev-drive-<who>.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const files = new Map(); // id -> { data, type, name, owner, shareToken }
const shares = new Map(); // token -> id

const bearerUser = req => {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const match = token?.match(/^dev-drive-(\w+)$/);
  return match ? `dev-${match[1]}` : null;
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

  // Public share download: the link itself is the capability, and there is no Range support.
  const shareMatch = url.pathname.match(/^\/share\/(\w+)\/download$/);
  if (shareMatch && req.method === 'GET') {
    const file = files.get(shares.get(shareMatch[1]));
    if (!file) return res.writeHead(404).end('not found');
    res.writeHead(200, {
      'content-type': file.type,
      'content-length': String(file.data.length),
      'x-content-type-options': 'nosniff',
    });
    return res.end(file.data);
  }

  // Everything below needs a user token.
  const user = bearerUser(req);
  if (!user) return json(401, { error: 'unauthorized' });

  if (req.method === 'PUT' && url.pathname === '/api/upload') {
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (!Number.isInteger(declared) || declared < 1) return json(411, { error: 'length_required' });
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      if (data.length !== declared) return json(400, { error: 'size_mismatch' });
      const id = randomUUID();
      const name = decodeURIComponent(req.headers['x-sb-filename'] || 'unnamed.file');
      files.set(id, {
        data,
        name,
        type: req.headers['x-sb-content-type'] || 'application/octet-stream',
        owner: user,
        shareToken: null,
      });
      json(201, { id, name, size: data.length });
    });
    return;
  }

  const fileMatch = url.pathname.match(/^\/api\/files\/([\w-]+)$/);
  if (req.method === 'POST' && fileMatch) {
    const file = files.get(fileMatch[1]);
    if (!file || file.owner !== user) return json(404, { error: 'not_found' });
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.share) {
        file.shareToken ||= randomUUID().replaceAll('-', '');
        shares.set(file.shareToken, fileMatch[1]);
        return json(200, { token: file.shareToken, url: `http://localhost:8797/share/${file.shareToken}` });
      }
      if (file.shareToken) shares.delete(file.shareToken);
      file.shareToken = null;
      return json(200, { ok: true });
    });
    return;
  }

  json(404, { error: 'not_found' });
});

server.listen(8797, () => console.log('mock drive on :8797'));
