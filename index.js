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

  const server = http.createServer();
  registerSubRoutes(server);
  startProxy(server);

  const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || '1080', 10);
  const PORT = parseInt(process.env.HTTP_PORT || process.env.PORT || '3000', 10);

  if (PORT === SOCKS_PORT) {
    console.error(`[startup] PORT conflict: HTTP and SOCKS5 both on ${PORT}. Set HTTP_PORT to a different value.`);
    process.exit(1);
  }

  server.listen(PORT, () => console.log(`[http] Listening on ${PORT}`));

  // SOCKS5 — на SOCKS_PORT (Railway TCP Proxy: 28566 -> SOCKS_PORT)
  startSocks5Server();

  startBot();
}

main().catch((err) => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});
