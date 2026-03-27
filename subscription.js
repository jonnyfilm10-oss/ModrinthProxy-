const { subKeyExists } = require('./db');

// Happ и другие клиенты (Clash, v2rayNG) принимают подписку:
// base64( строки с прокси-конфигами, разделённые \n )
//
// Для HTTP-прокси с авторизацией формат строки:
//   http://user:PASSWORD@HOST:PORT#Название
//
// Happ читает это и настраивает прокси автоматически.

function getHost() {
  return process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PROXY_HOST || 'localhost:3000';
}

function buildSubscription(subKey) {
  const host = getHost();
  const port = process.env.PROXY_PORT || '80';
  const name = encodeURIComponent('Modrinth Proxy 🚀');

  // HTTP прокси — основной
  const httpLine  = `http://user:${subKey}@${host}:${port}#${name}`;

  const raw = [httpLine].join('\n');
  return Buffer.from(raw).toString('base64');
}

function registerSubRoutes(server) {
  const origListeners = server.listeners('request').slice();

  server.on('request', async (req, res) => {
    // Роут подписки: GET /<subKey>
    const match = req.url.match(/^\/([a-f0-9]{32})$/i);
    if (!match) return; // не наш роут — пусть proxy.js обрабатывает

    const subKey = match[1];

    const exists = await subKeyExists(subKey);
    if (!exists) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }

    const b64 = buildSubscription(subKey);

    res.writeHead(200, {
      'Content-Type':        'text/plain; charset=utf-8',
      'Content-Disposition': 'inline; filename="sub.txt"',
      // Заголовки которые читает Happ/Clash
      'profile-title':       Buffer.from('Modrinth Proxy').toString('base64'),
      'profile-update-interval': '24',
      'subscription-userinfo': 'upload=0; download=0; total=0; expire=0',
    });
    res.end(b64);
  });
}

module.exports = { registerSubRoutes };
