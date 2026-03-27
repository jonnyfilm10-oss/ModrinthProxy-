const http  = require('http');
const net   = require('net');
const { URL } = require('url');
const { subKeyExists } = require('./db');

// ─── Hop-by-hop заголовки — убираем перед проксированием ─────────────────────
const HOP_BY_HOP = new Set([
  'proxy-authorization', 'proxy-connection', 'proxy-authenticate',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'keep-alive',
]);

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  out['connection'] = 'keep-alive';
  return out;
}

// ─── Извлечь ключ из Proxy-Authorization: Basic user:KEY ─────────────────────
function extractKey(req) {
  const header = req.headers['proxy-authorization'] || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon !== -1 ? decoded.slice(colon + 1) : null;
}

function deny407(socket) {
  if (!socket.writable) return;
  socket.write(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
    'Proxy-Authenticate: Basic realm="Modrinth Proxy"\r\n' +
    'Content-Length: 0\r\nConnection: close\r\n\r\n'
  );
  socket.destroy();
}

// ─── Основной сервер ──────────────────────────────────────────────────────────
function startProxy(server) {
  // HTTP запросы
  server.on('request', async (req, res) => {
    // Запросы к самому серверу (подписки) — не проксируем
    if (!req.url.startsWith('http')) return;

    const key = extractKey(req);
    if (!key || !(await subKeyExists(key))) {
      res.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="Modrinth Proxy"',
        'Content-Length': '0', 'Connection': 'close',
      });
      return res.end();
    }

    let target;
    try { target = new URL(req.url); }
    catch { res.writeHead(400); return res.end(); }

    const proxyReq = http.request({
      hostname: target.hostname,
      port:     target.port || 80,
      path:     target.pathname + target.search,
      method:   req.method,
      headers:  cleanHeaders(req.headers),
      timeout:  20000,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(); } });
    proxyReq.on('error',   () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
    req.pipe(proxyReq, { end: true });
  });

  // HTTPS CONNECT туннель
  server.on('connect', async (req, clientSocket, head) => {
    const key = extractKey(req);
    if (!key || !(await subKeyExists(key))) return deny407(clientSocket);

    const [hostname, portStr] = req.url.split(':');
    const port = parseInt(portStr, 10) || 443;

    const remote = net.createConnection({ host: hostname, port });

    remote.setTimeout(30000, () => remote.destroy());

    remote.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) remote.write(head);
      remote.pipe(clientSocket, { end: true });
      clientSocket.pipe(remote, { end: true });
    });

    remote.on('error', () => {
      if (clientSocket.writable) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      }
    });

    clientSocket.on('error', () => remote.destroy());
  });
}

module.exports = { startProxy };
