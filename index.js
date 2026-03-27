const http = require('http');
const { init }               = require('./db');
const { startProxy, startSocks5Server } = require('./proxy');
const { registerSubRoutes }  = require('./subscription');
const { startBot }           = require('./bot');

function checkEnv() {
  if (!process.env.BOT_TOKEN) {
    console.error('[startup] Missing BOT_TOKEN');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('[startup] Missing DATABASE_URL — добавь PostgreSQL сервис в Railway');
    process.exit(1);
  }
}

async function main() {
  checkEnv();

  await init();
  console.log('[db] Ready');

  // HTTP сервер — подписки + HTTP прокси
  const server = http.createServer();
  registerSubRoutes(server);
  startProxy(server);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] Listening on ${PORT}`));

  // SOCKS5 сервер — для Happ
  startSocks5Server();

  startBot();
}

main().catch((err) => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});
