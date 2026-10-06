import { Bot } from 'grammy';
import { getEnv } from '../../config/env';
import { logger } from '../../utils/logger';

export function createTelegramBot(token?: string): Bot {
  const botToken = token || getEnv().TELEGRAM_BOT_TOKEN;
  const bot = new Bot(botToken);

  bot.catch((err) => {
    logger.error({ err }, 'Grammy unhandled bot error');
  });

  return bot;
}
