// Test double for Southbag Drive's WebDAV endpoint (scripts/test.sh starts it for albums tests).
// Flat in-memory file store behind Basic auth, matching the real thing's contract:
//   PUT    /webdav/<name>  content-length required -> 201 created / 204 replaced / 401
//   GET    /webdav/<name>  Range honoured          -> 200 / 206 / 404 / 416
//   HEAD   /webdav/<name>  headers only
import { createServer } from 'node:http';

const AUTH = 'Basic ' + Buffer.from('albums@southbag.cc:test-drive-token').toString('base64');
const files = new Map();

const server = createServer((req, res) => {
  if (req.headers.authorization !== AUTH) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/webdav\//, ''));
  if (!name) {
    res.writeHead(404).end('not found');
    return;
  }

  if (req.method === 'PUT') {
    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared)) {
      res.writeHead(411).end('length required');
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      if (data.length !== declared) {
        res.writeHead(400).end('size mismatch');
        return;
      }
      const replaced = files.has(name);
      files.set(name, { data, type: (req.headers['content-type'] || 'application/octet-stream').split(';')[0] });
      res.writeHead(replaced ? 204 : 201, { location: `/webdav/${encodeURIComponent(name)}` }).end();
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = files.get(name);
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    const headers = {
      'content-type': file.type,
      'accept-ranges': 'bytes',
      etag: `"${name}-${file.data.length}"`,
      'last-modified': new Date().toUTCString(),
    };
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), file.data.length - 1) : file.data.length - 1;
      if (start >= file.data.length || start > end) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${file.data.length}` }).end();
        return;
      }
      headers['content-range'] = `bytes ${start}-${end}/${file.data.length}`;
      headers['content-length'] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method !== 'HEAD') res.end(file.data.subarray(start, end + 1));
      else res.end();
      return;
    }
    headers['content-length'] = String(file.data.length);
    res.writeHead(200, headers);
    if (req.method !== 'HEAD') res.end(file.data);
    else res.end();
    return;
  }

  res.writeHead(405).end('method not allowed');
});

server.listen(8797, () => console.log('mock drive on :8797'));
