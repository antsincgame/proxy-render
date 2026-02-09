const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || '';

const app = express();
app.use(morgan('short'));
app.use(cors({ origin: '*' }));

// ─── Health check ────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Info page ───────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    service: 'proxy-render',
    version: '2.0.0',
    mode: 'HTTP Forward Proxy + API Relay',
    usage: {
      forward_proxy: {
        description: 'Use as HTTP proxy in your app settings',
        host: 'proxy-render-kb84.onrender.com',
        port: 443,
        protocol: 'HTTP/HTTPS',
      },
      api_relay: {
        description: 'Or use /proxy?url=TARGET endpoint directly',
        example: '/proxy?url=https://api.openai.com/v1/models',
      },
    },
    health: '/health',
  });
});

// ─── Universal proxy handler ─────────────────────────────
function proxyRequest(targetUrl, req, res) {
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  // Ensure protocol
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL: ' + targetUrl });
  }

  // Build outgoing headers
  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'x-target-url', 'x-api-key', 'x-forwarded-for',
    'x-forwarded-proto', 'x-forwarded-host', 'x-render-origin-server',
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cdn-loop',
  ]);

  const outHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) {
      outHeaders[key] = value;
    }
  }
  outHeaders['host'] = parsed.host;

  const transport = parsed.protocol === 'https:' ? https : http;
  const fullPath = parsed.pathname + parsed.search;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: fullPath,
    method: req.method,
    headers: outHeaders,
    timeout: 60000,
  };

  console.log(`[PROXY] ${req.method} -> ${parsed.origin}${fullPath}`);

  const proxyReq = transport.request(options, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    delete responseHeaders['transfer-encoding'];
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

  // Collect and forward body
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (chunks.length > 0) {
      proxyReq.write(Buffer.concat(chunks));
    }
    proxyReq.end();
  });
  req.on('error', () => proxyReq.destroy());
}

// ═══════════════════════════════════════════════════════════
//  MODE 1: Forward proxy (full URL in request line)
//  PHP cURL sends: GET http://api.openai.com/v1/models HTTP/1.1
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
//  MODE 2: API Relay — /proxy?url=... or /proxy/https://...
// ═══════════════════════════════════════════════════════════
app.all('/proxy', (req, res) => {
  const targetUrl = req.headers['x-target-url'] || req.query.url;
  proxyRequest(targetUrl, req, res);
});

app.all('/proxy/*', (req, res) => {
  const match = req.path.match(/^\/proxy\/(.+)/);
  const targetUrl = match ? decodeURIComponent(match[1]) : null;
  proxyRequest(targetUrl, req, res);
});

// ═══════════════════════════════════════════════════════════
//  MODE 3: Catch-all for forward proxy requests
//  When configured as proxy, requests come as full URLs or
//  with X-Target-URL header on any path
// ═══════════════════════════════════════════════════════════
app.all('*', (req, res) => {
  // Check if this is a forward proxy request (full URL in path)
  const originalUrl = req.originalUrl || req.url;

  // Forward proxy: full URL as request path
  if (/^https?:\/\//i.test(originalUrl)) {
    return proxyRequest(originalUrl, req, res);
  }

  // X-Target-URL header present — relay mode
  if (req.headers['x-target-url']) {
    const base = req.headers['x-target-url'].replace(/\/$/, '');
    const path = originalUrl;
    return proxyRequest(base + path, req, res);
  }

  // Not a proxy request
  res.status(404).json({
    error: 'Not a proxy request',
    hint: 'Use /proxy?url=TARGET or set X-Target-URL header',
  });
});

// ─── Create HTTP server for CONNECT support ──────────────
const server = http.createServer(app);

// Handle CONNECT method (for HTTPS through forward proxy)
server.on('connect', (req, clientSocket, head) => {
  console.log(`[CONNECT] ${req.url}`);

  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;

  const serverSocket = require('net').connect(targetPort, hostname, () => {
    clientSocket.write(
      'HTTP/1.1 200 Connection Established\r\n' +
      'Proxy-Agent: proxy-render\r\n' +
      '\r\n'
    );
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on('error', (err) => {
    console.error(`[CONNECT ERROR] ${hostname}:${targetPort}`, err.message);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });

  clientSocket.on('error', () => serverSocket.destroy());
  serverSocket.on('timeout', () => {
    serverSocket.destroy();
    clientSocket.end();
  });
  serverSocket.setTimeout(60000);
});

// ─── Start ───────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Proxy server v2.0 running on port ${PORT}`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  Relay:    http://localhost:${PORT}/proxy?url=TARGET`);
  console.log(`  Forward:  Configure as HTTP proxy — host:${PORT}`);
});
