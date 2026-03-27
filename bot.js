const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const { createUser, getUserSubs, deleteSub } = require('./db');

const MAX_SUBS = 3;

function makeSubUrl(subKey) {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PROXY_HOST || 'localhost:3000';
  return `https://${host}/${subKey}`;
}

function formatDate(d) {
  return new Date(d).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function startBot() {
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  // /start
  bot.onText(/\/start/, (msg) => {
    const name = msg.from.first_name || 'друг';
    bot.sendMessage(msg.chat.id,
      `👋 Привет, *${name}*\\!\n\n` +
      `Здесь ты получишь подписку для доступа к Modrinth\\.\n\n` +
      `*Команды:*\n` +
      `/getsub — получить ссылку на подписку\n` +
      `/mysubs — мои подписки\n` +
      `/deletesub — удалить подписку\n` +
      `/help — как добавить в Happ`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // /help
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `*Как добавить подписку в Happ:*\n\n` +
      `1\\. Получи ссылку через /getsub\n` +
      `2\\. Открой *Happ* → вкладка Proxies\n` +
      `3\\. Нажми \\+ → *Import from URL*\n` +
      `4\\. Вставь ссылку и нажми Import\n` +
      `5\\. Готово — Modrinth работает 🎉`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  // /getsub
  bot.onText(/\/getsub/, async (msg) => {
    const { id: userId, username, first_name } = msg.from;
    const uname = username || first_name || String(userId);

    try {
      const existing = await getUserSubs(userId);
      if (existing.length >= MAX_SUBS) {
        return bot.sendMessage(msg.chat.id,
          `❌ У тебя уже ${MAX_SUBS} подписки — это максимум\\.\n` +
          `Удали старую через /deletesub`,
          { parse_mode: 'MarkdownV2' }
        );
      }

      // Ключ — 32 hex символа (UUID без дефисов)
      const subKey = uuidv4().replace(/-/g, '');
      await createUser(subKey, userId, uname);

      const url = makeSubUrl(subKey);

      bot.sendMessage(msg.chat.id,
        `✅ *Твоя подписка готова\\!*\n\n` +
        `Ссылка для Happ:\n` +
        `\`${url}\`\n\n` +
        `*Как добавить:*\n` +
        `Happ → Proxies → \\+ → Import from URL → вставь ссылку\n\n` +
        `_Не делись ссылкой с другими\\!_`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (err) {
      console.error('[bot] getsub error:', err.message);
      bot.sendMessage(msg.chat.id, '❌ Ошибка. Попробуй позже.');
    }
  });

  // /mysubs
  bot.onText(/\/mysubs/, async (msg) => {
    try {
      const subs = await getUserSubs(msg.from.id);
      if (subs.length === 0) {
        return bot.sendMessage(msg.chat.id,
          'У тебя нет активных подписок\\.\nИспользуй /getsub',
          { parse_mode: 'MarkdownV2' }
        );
      }

      const list = subs.map((s, i) => {
        const url = makeSubUrl(s.sub_key);
        return `${i + 1}\\. \`${url}\`\n    📅 ${formatDate(s.created_at)}`;
      }).join('\n\n');

      bot.sendMessage(msg.chat.id,
        `🔗 *Твои подписки \\(${subs.length}/${MAX_SUBS}\\):*\n\n${list}`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (err) {
      console.error('[bot] mysubs error:', err.message);
      bot.sendMessage(msg.chat.id, '❌ Ошибка. Попробуй позже.');
    }
  });

  // /deletesub — без аргумента: показать список
  bot.onText(/^\/deletesub$/, async (msg) => {
    try {
      const subs = await getUserSubs(msg.from.id);
      if (subs.length === 0) {
        return bot.sendMessage(msg.chat.id, 'У тебя нет подписок для удаления.');
      }

      const keyboard = subs.map((s) => [{
        text: `🗑 ${s.sub_key.slice(0, 8)}...  (${formatDate(s.created_at)})`,
        callback_data: `del:${s.sub_key}`,
      }]);

      bot.sendMessage(msg.chat.id, 'Выбери подписку для удаления:', {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      console.error('[bot] deletesub error:', err.message);
      bot.sendMessage(msg.chat.id, '❌ Ошибка. Попробуй позже.');
    }
  });

  // Обработка кнопок удаления
  bot.on('callback_query', async (query) => {
    if (!query.data.startsWith('del:')) return;
    const subKey = query.data.slice(4);

    try {
      const ok = await deleteSub(subKey, query.from.id);
      bot.answerCallbackQuery(query.id);
      bot.editMessageText(
        ok ? '✅ Подписка удалена.' : '❌ Не найдено.',
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
    } catch (err) {
      console.error('[bot] callback delete error:', err.message);
      bot.answerCallbackQuery(query.id, { text: 'Ошибка' });
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[bot] polling error:', err.message);
  });

  console.log('[bot] Started');
}

module.exports = { startBot };
