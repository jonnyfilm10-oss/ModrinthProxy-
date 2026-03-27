const { subKeyExists } = require('./db');

// Happ поддерживает протоколы: VLESS, VMess, Trojan, Shadowsocks, Socks5
// Формат Socks5 ссылки:
//   socks://BASE64(user:password)@host:port#name
//
// password = subKey (используется как пароль SOCKS5)

function getHost() {
  return process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PROXY_HOST || 'localhost';
}

function buildSubscription(subKey) {
  const host      = getHost();
  const port      = process.env.PROXY_PORT || process.env.SOCKS_PORT || '1080';
  const name      = encodeURIComponent('Modrinth Proxy 🚀');

  // Socks5: credentials = base64(user:subKey)
  const credentials = Buffer.from(`user:${subKey}`).toString('base64');
  const socksLine   = `socks://${credentials}@${host}:${port}#${name}`;

  return Buffer.from(socksLine).toString('base64');
}

function registerSubRoutes(server) {
  server.on('request', async (req, res) => {
    const match = req.url.match(/^\/([a-f0-9]{32})$/i);
    if (!match) return;

    const subKey = match[1];

    const exists = await subKeyExists(subKey);
    if (!exists) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    const b64 = buildSubscription(subKey);

    res.writeHead(200, {
      'Content-Type':              'text/plain; charset=utf-8',
      'Content-Disposition':       'inline; filename="sub.txt"',
      'profile-title':             Buffer.from('Modrinth Proxy').toString('base64'),
      'profile-update-interval':   '24',
      'subscription-userinfo':     'upload=0; download=0; total=0; expire=0',
    });
    res.end(b64);
  });
}

module.exports = { registerSubRoutes };
