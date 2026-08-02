// Zero-dependency dev server: serves the static app and mounts the /api/wrapped
// handler so the hosted path can be tested locally.
//
//   ANTHROPIC_API_KEY=sk-ant-... node server.mjs
//   open http://localhost:5173

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import wrappedHandler from './api/wrapped.js';
import checkoutHandler from './api/checkout.js';
import claimHandler from './api/claim.js';
import webhookHandler from './api/stripe-webhook.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 400_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function shim(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  return res;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const POST_ROUTES = {
    '/api/wrapped': wrappedHandler,
    '/api/checkout': checkoutHandler,
    '/api/stripe-webhook': webhookHandler,
  };

  if (url.pathname === '/api/claim') {
    await claimHandler(req, shim(res));
    return;
  }

  const route = POST_ROUTES[url.pathname];
  if (route) {
    try {
      // The webhook verifies a signature over these exact bytes — pass the raw
      // string straight through and never re-serialise it.
      req.body = await readBody(req);
      req.rawBody = req.body;
    } catch {
      shim(res).status(413).json({ error: 'Payload too large.' });
      return;
    }
    await route(req, shim(res));
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, safe);

  if (!file.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Chat Wrapped running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — paste a key in the UI, or run stats-only.');
  }
});
