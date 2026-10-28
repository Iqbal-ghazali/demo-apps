// Agent Room: a local web app where one human brainstorms with Claude and Codex
// in a shared conversation. The server uses only Node built-ins; the npm packages
// are browser libraries it serves to the page.

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms } from './src/rooms.js';
import { Health } from './src/preflight.js';
import { AGENTS } from './src/prompts.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const MAX_MESSAGE = 4000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const health = new Health();

// `npm run check`: run the connection check in the terminal and exit.
if (process.argv.includes('--check')) {
  const state = await health.check();
  for (const a of Object.values(state.agents)) {
    const mark = a.ok ? '✓' : '✗';
    console.log(`${mark} ${AGENTS[a.id].name.padEnd(6)} ${a.version || '-'} · ${a.auth}${a.model ? ' · ' + a.model : ''}${a.ok ? '' : `\n    ${a.error} ${a.hint || ''}`}`);
  }
  process.exit(health.allOk ? 0 : 1);
}

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/icons.svg': ['public/icons.svg', 'image/svg+xml'],
  // Browser libraries, served from node_modules (see NOTES.md, "Open-source libraries")
  '/vendor/htm-preact.js': ['node_modules/htm/preact/standalone.module.js', 'text/javascript; charset=utf-8'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8'],
};

const missing = Object.values(STATIC).map(([f]) => f).filter((f) => !existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error(`Missing files: ${missing.join(', ')}\nRun "npm install" first.`);
  process.exit(1);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const rooms = new Rooms();

function meta() {
  return {
    serverNow: Date.now(),
    agents: Object.fromEntries(Object.values(AGENTS).map((a) => [a.id, { name: a.name, role: a.role }])),
    health: health.state,
    rooms: rooms.list(),
  };
}

// Server-sent events. "meta" = sidebar + connections; "room" = one room changed in full.
const clients = new Set();
function push(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
rooms.on('change', (room) => {
  push('room', room.toJSON());
  push('meta', meta());
});
rooms.on('removed', () => push('meta', meta()));
health.onChange(() => push('meta', meta()));
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15_000).unref();

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON.'));
      }
    });
  });
}

// The room spends the user's AI plan, so only accept requests from this app on this machine:
// the Host check blocks DNS rebinding, the custom header blocks cross-site requests.
function allowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
  if (req.method !== 'GET' && req.headers['x-agent-room'] !== '1') return false;
  return true;
}

function messageText(body) {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('Type a message first.');
  if (text.length > MAX_MESSAGE) throw new Error(`Keep messages under ${MAX_MESSAGE} characters.`);
  return text;
}

const routes = [
  ['POST', /^\/api\/rooms$/, async (req) => {
    const room = rooms.create(messageText(await readJson(req)));
    return { id: room.id };
  }],
  ['GET', /^\/api\/rooms\/([\w-]+)$/, (req, id) => rooms.get(id).toJSON()],
  ['DELETE', /^\/api\/rooms\/([\w-]+)$/, (req, id) => rooms.remove(id)],
  ['POST', /^\/api\/rooms\/([\w-]+)\/messages$/, async (req, id) => rooms.get(id).say(messageText(await readJson(req)))],
  ['POST', /^\/api\/rooms\/([\w-]+)\/continue$/, (req, id) => rooms.get(id).continue()],
  ['POST', /^\/api\/rooms\/([\w-]+)\/stop$/, (req, id) => rooms.get(id).stop()],
  ['POST', /^\/api\/rooms\/([\w-]+)\/retry$/, async (req, id) => rooms.get(id).retry(String((await readJson(req)).messageId || ''))],
  ['POST', /^\/api\/recheck$/, () => {
    health.check();
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!allowed(req)) return send(res, 403, { error: 'Forbidden.' });

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, readFileSync(path.join(ROOT, file)), type);
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
    res.write(`event: meta\ndata: ${JSON.stringify(meta())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const exportMatch = req.method === 'GET' && url.pathname.match(/^\/api\/rooms\/([\w-]+)\/export$/);
  if (exportMatch) {
    try {
      const room = rooms.get(exportMatch[1]);
      return send(res, 200, room.exportMarkdown(), 'text/markdown; charset=utf-8', {
        'Content-Disposition': `attachment; filename="agent-room-${room.id}.md"`,
      });
    } catch (err) {
      return send(res, 404, { error: err.message });
    }
  }

  for (const [method, pattern, handler] of routes) {
    const match = req.method === method && url.pathname.match(pattern);
    if (!match) continue;
    try {
      const result = await handler(req, ...match.slice(1));
      return send(res, 200, result ?? { ok: true });
    } catch (err) {
      return send(res, err.message === 'Room not found.' ? 404 : 400, { error: err.message });
    }
  }
  send(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  if (HOST === '0.0.0.0') console.log(`Agent Room listening on port ${PORT} (open the port you published, e.g. http://localhost:3000)`);
  else console.log(`Agent Room running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log('Checking Claude and Codex connections…');
  health.check().then((s) => {
    for (const a of Object.values(s.agents)) {
      console.log(`  ${a.ok ? '✓' : '✗'} ${AGENTS[a.id].name}: ${a.ok ? `${a.auth}${a.model ? ', ' + a.model : ''}` : `${a.error} ${a.hint || ''}`}`);
    }
  });
});
