// Test double for Southbag Identity's internal freeze API (scripts/test.sh starts it).
// dev-erin is frozen; dev-frank makes Identity answer 500 (status unknown); everyone else is fine.
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer test-secret') {
    res.writeHead(401).end('{}');
    return;
  }
  const userId = new URL(req.url, 'http://x').searchParams.get('userId');
  if (userId === 'dev-frank') { res.writeHead(500).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ frozen: userId === 'dev-erin', reason: null, frozenAt: null, unfrozenViaFlow: false }));
});
server.listen(8798, () => console.log('mock identity on :8798'));
