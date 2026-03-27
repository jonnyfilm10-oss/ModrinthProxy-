const http = require('http');
const { init }               = require('./db');
const { startProxy }         = require('./proxy');
const { registerSubRoutes }  = require('./subscription');
const { startBot }           = require('./bot');

function checkEnv() {
  if (!process.env.BOT_TOKEN) {
    console.error('[startup] Missing BOT_TOKEN');
    process.exit(1);
  }
  // DATABASE_URL и RAILWAY_PUBLIC_DOMAIN Railway подставляет сам
  if (!process.env.DATABASE_URL) {
    console.error('[startup] Missing DATABASE_URL — добавь PostgreSQL сервис в Railway');
    process.exit(1);
  }
}

async function main() {
  checkEnv();

  await init();
  console.log('[db] Ready');

  // Один HTTP сервер на один PORT
  // — subscription.js отвечает на GET /<key>
  // — proxy.js обрабатывает CONNECT и http:// запросы
  const server = http.createServer();

  registerSubRoutes(server);
  startProxy(server);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] Listening on ${PORT}`));

  startBot();
}

main().catch((err) => {
  console.error('[startup] Fatal:', err.message);
  process.exit(1);
});
