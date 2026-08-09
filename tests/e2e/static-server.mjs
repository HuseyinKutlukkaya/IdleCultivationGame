/**
 * static-server.mjs — dependency-free static file server for E2E tests.
 *
 * Serves the repo root over HTTP so a real browser can load the ES modules
 * and data/ JSON exactly like GitHub Pages would (module scripts and fetch()
 * do not work over file:// in Chrome). Dev-only test tooling — never ships.
 *
 * Usage: node tests/e2e/static-server.mjs
 * (Listens on port 4173, or PORT from the environment.)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    const filePath = normalize(join(ROOT, pathname === '/' ? 'index.html' : pathname));

    // Refuse path-traversal escapes outside the repo root.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`E2E static server listening on http://127.0.0.1:${PORT}`);
});
