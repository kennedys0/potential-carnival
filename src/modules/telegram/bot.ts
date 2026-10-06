import { Bot } from 'grammy';
import { getEnv } from '../../config/env';
import { logger } from '../../utils/logger';

export function createTelegramBot(token?: string): Bot {
  const env = getEnv();
  const botToken = token || env.TELEGRAM_BOT_TOKEN;
  const bot = new Bot(botToken);

  const whitelistedUsers = env.WHITELISTED_USERS
    ? env.WHITELISTED_USERS.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id))
    : [];

  // Middleware: Access Control
  bot.use(async (ctx, next) => {
    if (!ctx.from) return; // ignore if no from
    if (whitelistedUsers.length > 0 && !whitelistedUsers.includes(ctx.from.id)) {
      logger.warn({ userId: ctx.from.id }, 'Unauthorized access attempt');
      // For stealth, we can ignore, but let's reply once to notify they are blocked
      return; 
    }
    await next();
  });

  // Middleware: Simple Rate Limiting for /scan
  const scanLimits = new Map<number, { count: number, lastReset: number }>();
  bot.command('scan', async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId) {
      const now = Date.now();
      const limit = scanLimits.get(userId) || { count: 0, lastReset: now };
      
      // Reset every 1 minute
      if (now - limit.lastReset > 60000) {
        limit.count = 0;
        limit.lastReset = now;
      }
      
      limit.count++;
      scanLimits.set(userId, limit);

      // Memory leak protection: periodically sweep old entries randomly or just use setTimeout
      // A simple sweep on every 100th request:
      if (Math.random() < 0.01) {
        for (const [key, val] of scanLimits.entries()) {
          if (now - val.lastReset > 60000) {
            scanLimits.delete(key);
          }
        }
      }

      if (limit.count > 10) { // Max 10 scans per minute
        logger.warn({ userId }, 'Rate limit exceeded for /scan');
        await ctx.reply('⚠️ Anda melakukan terlalu banyak /scan. Tunggu 1 menit.');
        return;
      }
    }
    await next();
  });

  bot.catch((err) => {
    logger.error({ err }, 'Grammy unhandled bot error');
  });

  return bot;
}
