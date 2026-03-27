const http    = require('http');
const net     = require('net');
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

// ─── HTTP прокси ──────────────────────────────────────────────────────────────
function startProxy(server) {
  server.on('request', async (req, res) => {
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

// ─── SOCKS5 сервер ────────────────────────────────────────────────────────────
//
// RFC 1928 + RFC 1929 (Username/Password auth)
//
// Handshake:
//   Client → [05 01 02]           (SOCKS5, 1 метод, auth=02)
//   Server → [05 02]              (выбираем username/password)
//   Client → [01 ulen user plen pass]
//   Server → [01 00]              (OK) или [01 01] (fail)
//
// Request:
//   Client → [05 01 00 atyp ...addr... port]
//   Server → [05 00 00 01 00 00 00 00 00 00]  (успех)

const SOCKS_AUTH    = 0x02;
const SOCKS_NO_AUTH = 0x00;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYP_IPV4   = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;
const SOCKS_ATYP_IPV6   = 0x04;

function handleSocks5(socket) {
  socket.once('data', (buf) => {
    // Greeting
    if (buf[0] !== 0x05) { socket.destroy(); return; }

    const nmethods = buf[1];
    const methods  = buf.slice(2, 2 + nmethods);

    if (!methods.includes(SOCKS_AUTH)) {
      // Не поддерживаем без авторизации
      socket.write(Buffer.from([0x05, 0xFF]));
      socket.destroy();
      return;
    }

    // Выбираем username/password auth
    socket.write(Buffer.from([0x05, SOCKS_AUTH]));

    socket.once('data', async (authBuf) => {
      // Auth sub-negotiation: [01 ulen ...user... plen ...pass...]
      if (authBuf[0] !== 0x01) { socket.destroy(); return; }

      const ulen = authBuf[1];
      // user игнорируем — нас интересует только пароль (= subKey)
      const plen = authBuf[2 + ulen];
      const pass = authBuf.slice(3 + ulen, 3 + ulen + plen).toString('utf8');

      const valid = await subKeyExists(pass).catch(() => false);
      if (!valid) {
        socket.write(Buffer.from([0x01, 0x01])); // auth fail
        socket.destroy();
        return;
      }

      socket.write(Buffer.from([0x01, 0x00])); // auth OK

      socket.once('data', (reqBuf) => {
        // Request: [05 cmd 00 atyp ...]
        if (reqBuf[0] !== 0x05 || reqBuf[1] !== SOCKS_CMD_CONNECT) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0]));
          socket.destroy();
          return;
        }

        const atyp = reqBuf[3];
        let host, port, addrEnd;

        if (atyp === SOCKS_ATYP_IPV4) {
          host    = Array.from(reqBuf.slice(4, 8)).join('.');
          addrEnd = 8;
        } else if (atyp === SOCKS_ATYP_DOMAIN) {
          const dlen = reqBuf[4];
          host    = reqBuf.slice(5, 5 + dlen).toString('utf8');
          addrEnd = 5 + dlen;
        } else if (atyp === SOCKS_ATYP_IPV6) {
          // IPv6 — собираем из 16 байт
          const parts = [];
          for (let i = 0; i < 8; i++) {
            parts.push(reqBuf.readUInt16BE(4 + i * 2).toString(16));
          }
          host    = parts.join(':');
          addrEnd = 20;
        } else {
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0,0,0,0, 0,0]));
          socket.destroy();
          return;
        }

        port = reqBuf.readUInt16BE(addrEnd);

        const remote = net.createConnection({ host, port });
        remote.setTimeout(30000, () => remote.destroy());

        remote.on('connect', () => {
          // Успешный ответ SOCKS5
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
          remote.pipe(socket, { end: true });
          socket.pipe(remote, { end: true });
        });

        remote.on('error', () => {
          if (socket.writable) {
            socket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0,0,0,0, 0,0]));
            socket.destroy();
          }
        });

        socket.on('error', () => remote.destroy());
      });
    });
  });

  socket.on('error', () => {});
}

function startSocks5Server() {
  const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || '1080', 10);

  const server = net.createServer(handleSocks5);

  server.listen(SOCKS_PORT, () => {
    console.log(`[socks5] Listening on ${SOCKS_PORT}`);
  });

  server.on('error', (err) => {
    console.error('[socks5] Server error:', err.message);
  });
}

module.exports = { startProxy, startSocks5Server };
