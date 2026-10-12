import { Context } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';
import { SniperRepository } from '../../../database/repositories/sniperRepository';
import { liveFeedSubscribers } from '../../scanner/liveFeedState';
import { formatRadarHub, buildRadarHubKeyboard } from '../formatters/messageFormatter';

export async function handleRadarHub(
  ctx: Context,
  autopilotRepo: AutopilotRepository,
  sniperRepo: SniperRepository
): Promise<void> {
  if (!ctx.from) return;

  const isLiveFeedActive = liveFeedSubscribers.has(ctx.from.id);
  const autoConfig = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const sniperConfig = await sniperRepo.getOrCreateConfig(ctx.from.id);

  const sizing = (autoConfig.sizing_params as any) || {};
  const trendingSizeSol = typeof sizing.fixed_sol === 'number' && !Number.isNaN(sizing.fixed_sol) ? sizing.fixed_sol : 0.1;

  const sniperSizeSol = typeof sniperConfig.buy_amount_sol === 'number' && sniperConfig.buy_amount_sol > 0 ? sniperConfig.buy_amount_sol : 0.05;

  const text = formatRadarHub({
    isLiveFeedActive,
    isTrendingActive: !!autoConfig.is_active,
    isSniperActive: !!sniperConfig.enabled,
    trendingSizeSol,
    sniperSizeSol,
  });

  const keyboard = buildRadarHubKeyboard(isLiveFeedActive);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
