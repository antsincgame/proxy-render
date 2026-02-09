const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];
const API_KEY = process.env.API_KEY || ''; // optional auth

const app = express();

// ─── Middleware ───────────────────────────────────────────
app.use(morgan('short'));
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Target-URL', 'X-API-Key'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
}));

// Parse raw body to forward it
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ─── Auth check (optional) ──────────────────────────────
function checkAuth(req, res, next) {
  if (!API_KEY) return next(); // no key set — skip auth
  const provided = req.headers['x-api-key'] || req.query.apikey;
  if (provided === API_KEY) return next();
  return res.status(403).json({ error: 'Forbidden: invalid API key' });
}

// ─── Health check ────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Info page ───────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'proxy-render',
    version: '1.0.0',
    usage: {
      method1_header: {
        description: 'Pass target URL via X-Target-URL header',
        example: 'curl -H "X-Target-URL: https://api.example.com/data" https://YOUR-PROXY.onrender.com/proxy',
      },
      method2_query: {
        description: 'Pass target URL via ?url= query parameter',
        example: 'curl "https://YOUR-PROXY.onrender.com/proxy?url=https://api.example.com/data"',
      },
      method3_path: {
        description: 'Pass target URL as path after /proxy/',
        example: 'curl "https://YOUR-PROXY.onrender.com/proxy/https://api.example.com/data"',
      },
    },
    health: '/health',
  });
});

// ─── Main proxy endpoint ─────────────────────────────────
app.all('/proxy', checkAuth, handleProxy);
app.all('/proxy/*', checkAuth, handleProxy);

function handleProxy(req, res) {
  // 1. Determine target URL
  let targetUrl =
    req.headers['x-target-url'] ||
    req.query.url ||
    extractPathUrl(req.path);

  if (!targetUrl) {
    return res.status(400).json({
      error: 'Missing target URL. Use X-Target-URL header, ?url= query, or /proxy/https://...',
    });
  }

  // Ensure protocol
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL: ' + targetUrl });
  }

  // 2. Build outgoing headers (forward most, skip hop-by-hop)
  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'x-target-url', 'x-api-key',
  ]);
  const outHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) {
      outHeaders[key] = value;
    }
  }
  outHeaders['host'] = parsed.host;

  // Forward query params from original request (merge)
  const proxyParams = new URLSearchParams(parsed.search);
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'url' && k !== 'apikey') {
      proxyParams.set(k, v);
    }
  }
  const queryString = proxyParams.toString();
  const fullPath = parsed.pathname + (queryString ? '?' + queryString : '');

  // 3. Make the request
  const transport = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: fullPath,
    method: req.method,
    headers: outHeaders,
    timeout: 30000,
  };

  console.log(`[PROXY] ${req.method} -> ${parsed.origin}${fullPath}`);

  const proxyReq = transport.request(options, (proxyRes) => {
    // Forward status & headers
    const responseHeaders = { ...proxyRes.headers };
    delete responseHeaders['transfer-encoding']; // let express handle it

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('[PROXY ERROR]', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy error: ' + err.message });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Proxy timeout' });
    }
  });

  // Send body if present
  if (req.body && req.body.length > 0) {
    proxyReq.write(req.body);
  }
  proxyReq.end();
}

// Extract URL from path: /proxy/https://example.com/path -> https://example.com/path
function extractPathUrl(path) {
  const match = path.match(/^\/proxy\/(.+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

// ─── Start server ────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Proxy server running on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  Proxy:  http://localhost:${PORT}/proxy?url=TARGET`);
  if (API_KEY) console.log('  Auth:   API key required (X-API-Key header)');
  else console.log('  Auth:   OPEN (set API_KEY env to protect)');
});
