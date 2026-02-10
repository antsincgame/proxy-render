const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

const app = express();
app.use(morgan('short'));
app.use(cors({ origin: '*' }));

// ─── Password protection ──────────────────────────────────
function requirePassword(req, res, next) {
  if (!PROXY_PASSWORD) return next();
  if (req.path === '/' || req.path === '/health') return next();

  let provided =
    req.headers['x-proxy-password'] ||
    req.query.password ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : '');

  // Basic Auth: логин может быть любой, пароль должен совпадать
  if (!provided && req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8');
      const password = decoded.includes(':') ? decoded.split(':')[1] : decoded;
      provided = password;
    } catch (_) {}
  }

  if (provided === PROXY_PASSWORD) return next();

  res.status(401).json({
    error: 'Unauthorized',
    message: 'Укажите пароль: X-Proxy-Password, ?password=..., Basic Auth или Bearer',
  });
}

app.use(requirePassword);

// ─── Health check (без пароля для мониторинга Render) ─────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Info / docs ─────────────────────────────────────────
app.get('/', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'proxy-render-kb84.onrender.com';
  res.json({
    service: 'proxy-render',
    version: '3.0.0',
    mode: 'API Gateway / Relay Proxy',
    auth: PROXY_PASSWORD ? 'Пароль обязателен: X-Proxy-Password или ?password=...' : 'Выключена',
    endpoints: {
      openai:     `https://${host}/openai/v1/...`,
      openrouter: `https://${host}/openrouter/api/v1/...`,
      perplexity: `https://${host}/perplexity/...`,
      anthropic:  `https://${host}/anthropic/v1/...`,
      generic:    `https://${host}/proxy?url=https://any-api.com/path`,
    },
    health: '/health',
  });
});

// ─── Universal proxy handler ─────────────────────────────
function proxyRequest(targetUrl, req, res) {
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL: ' + targetUrl });
  }

  // Build outgoing headers — forward everything relevant (не пробрасываем пароль прокси)
  const skipHeaders = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding',
    'x-target-url', 'x-api-key', 'x-proxy-password', 'x-forwarded-for',
    'x-forwarded-proto', 'x-forwarded-host', 'x-render-origin-server',
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cdn-loop',
    'rndr-id', 'render-proxy-ttl',
  ]);

  const outHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skipHeaders.has(key.toLowerCase())) continue;
    // Basic Auth использовался для пароля прокси — не слать в целевой API
    if (key.toLowerCase() === 'authorization' && (value || '').startsWith('Basic ')) continue;
    outHeaders[key] = value;
  }
  outHeaders['host'] = parsed.host;

  const transport = parsed.protocol === 'https:' ? https : http;
  // убираем пароль прокси из query, чтобы не слать его в целевой API
  parsed.searchParams.delete('password');
  const fullPath = parsed.pathname + (parsed.search || '');

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: fullPath,
    method: req.method,
    headers: outHeaders,
    timeout: 120000,
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
//  API GATEWAY ROUTES
//  Replace base URL in your app settings with proxy URL
// ═══════════════════════════════════════════════════════════

// OpenAI: https://api.openai.com/v1/... → /openai/v1/...
app.all('/openai/*', (req, res) => {
  const path = req.originalUrl.replace(/^\/openai/, '');
  proxyRequest('https://api.openai.com' + path, req, res);
});

// OpenRouter: https://openrouter.ai/api/v1/... → /openrouter/api/v1/...
app.all('/openrouter/*', (req, res) => {
  const path = req.originalUrl.replace(/^\/openrouter/, '');
  proxyRequest('https://openrouter.ai' + path, req, res);
});

// Perplexity: https://api.perplexity.ai/... → /perplexity/...
app.all('/perplexity/*', (req, res) => {
  const path = req.originalUrl.replace(/^\/perplexity/, '');
  proxyRequest('https://api.perplexity.ai' + path, req, res);
});

// Anthropic: https://api.anthropic.com/v1/... → /anthropic/v1/...
app.all('/anthropic/*', (req, res) => {
  const path = req.originalUrl.replace(/^\/anthropic/, '');
  proxyRequest('https://api.anthropic.com' + path, req, res);
});

// Google Gemini: https://generativelanguage.googleapis.com/... → /gemini/...
app.all('/gemini/*', (req, res) => {
  const path = req.originalUrl.replace(/^\/gemini/, '');
  proxyRequest('https://generativelanguage.googleapis.com' + path, req, res);
});

// ═══════════════════════════════════════════════════════════
//  GENERIC PROXY — /proxy?url=TARGET or /proxy/https://...
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
//  CATCH-ALL — X-Target-URL header relay
// ═══════════════════════════════════════════════════════════
app.all('*', (req, res) => {
  if (req.headers['x-target-url']) {
    const base = req.headers['x-target-url'].replace(/\/$/, '');
    return proxyRequest(base + req.originalUrl, req, res);
  }

  res.status(404).json({
    error: 'Unknown route',
    hint: 'Use /openai/..., /openrouter/..., /perplexity/..., /anthropic/..., /gemini/... or /proxy?url=TARGET',
  });
});

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Proxy API Gateway v3.0 running on port ${PORT}`);
  console.log(`  Auth:       ${PROXY_PASSWORD ? 'ON (X-Proxy-Password / ?password=)' : 'OFF'}`);
  console.log(`  Health:     http://localhost:${PORT}/health`);
  console.log(`  OpenAI:     http://localhost:${PORT}/openai/v1/...`);
  console.log(`  OpenRouter: http://localhost:${PORT}/openrouter/api/v1/...`);
  console.log(`  Perplexity: http://localhost:${PORT}/perplexity/...`);
  console.log(`  Anthropic:  http://localhost:${PORT}/anthropic/v1/...`);
  console.log(`  Gemini:     http://localhost:${PORT}/gemini/...`);
  console.log(`  Generic:    http://localhost:${PORT}/proxy?url=TARGET`);
});
