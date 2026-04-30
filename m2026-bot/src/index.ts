import { Bot, webhookCallback, Context } from 'grammy';
import { Client as NotionClient } from '@notionhq/client';
import { ALLOWED_USER_IDS, setDbIds } from './config';
import {
  handleStart,
  handleNew,
  handleCancel,
  handleRefresh,
  handleStatus,
  handleOrders,
  handleText,
  handleCallback,
  handleContact,
  handleVoice,
} from './flow';
import { handleApi } from './api';

export interface CloudflareEnv {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_SECRET: string;
  NOTION_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  GROQ_API_KEY: string;
  M2026_DATA_SOURCE_ID?: string;
  POSITIONS_DATA_SOURCE_ID?: string;
  SESSIONS: KVNamespace;
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    setDbIds(env.M2026_DATA_SOURCE_ID, env.POSITIONS_DATA_SOURCE_ID);
    const url = new URL(request.url);

    // API для Web App (отдельный путь от Telegram webhook)
    if (url.pathname.startsWith('/api/')) {
      const notion = new NotionClient({ auth: env.NOTION_TOKEN });
      return handleApi(request, {
        kv: env.SESSIONS,
        notion,
        telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      }, url);
    }

    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    const notion = new NotionClient({ auth: env.NOTION_TOKEN });
    const handlerEnv = {
      kv: env.SESSIONS,
      notion,
      anthropicKey: env.ANTHROPIC_API_KEY,
      groqKey: env.GROQ_API_KEY,
      telegramToken: env.TELEGRAM_BOT_TOKEN,
    };

    // Whitelist: блокируем чужих
    bot.use(async (ctx, next) => {
      const id = ctx.from?.id;
      if (!id || !ALLOWED_USER_IDS.includes(id)) {
        await ctx.reply('Бот доступен только для приёмщиков.').catch(() => {});
        return;
      }
      await next();
    });

    // Команды
    bot.command('start', (ctx) => handleStart(ctx));
    bot.command('new', (ctx) => handleNew(ctx, handlerEnv));
    bot.command('cancel', (ctx) => handleCancel(ctx, handlerEnv));
    bot.command('refresh', (ctx) => handleRefresh(ctx, handlerEnv));
    bot.command('status', (ctx) => handleStatus(ctx, handlerEnv));
    bot.command('orders', (ctx) => handleOrders(ctx, handlerEnv));

    // Кнопки главного меню (reply keyboard)
    bot.hears('🆕 Новый клиент', (ctx) => handleNew(ctx, handlerEnv));
    bot.hears('🔍 Статус', (ctx) => handleStatus(ctx, handlerEnv));
    bot.hears('📅 Заказы', (ctx) => handleOrders(ctx, handlerEnv));
    bot.hears('❌ Отмена', (ctx) => handleCancel(ctx, handlerEnv));
    bot.hears('🔄 Обновить опции', (ctx) => handleRefresh(ctx, handlerEnv));
    bot.hears('ℹ️ Помощь', (ctx) => handleStart(ctx));

    // Кнопки
    bot.on('callback_query:data', (ctx) => handleCallback(ctx, handlerEnv));

    // Контакт (когда телефон отправлен как карточка контакта)
    bot.on('message:contact', (ctx) => handleContact(ctx, handlerEnv));

    // Голосовые сообщения
    bot.on('message:voice', (ctx) => handleVoice(ctx, handlerEnv));

    // Текстовые сообщения (свободный ввод полей)
    bot.on('message:text', (ctx) => handleText(ctx, handlerEnv));

    // Обработка ошибок чтобы не падать на webhook
    bot.catch((err) => {
      console.error('bot error:', err);
    });

    return webhookCallback(bot, 'cloudflare-mod', {
      secretToken: env.TELEGRAM_BOT_SECRET,
    })(request);
  },
};
