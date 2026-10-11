import { TradeRepository } from '../../database/repositories/tradeRepository';
import { AutopilotRepository, AutopilotStateRecord } from '../../database/repositories/autopilotRepository';
import { WalletService } from '../wallet/walletService';
import { getRedisConnection } from '../../queue/connection';
import { appSettings } from '../../config/settings';
import { logger } from '../../utils/logger';

export interface AutopilotStateMetrics {
  openPositionsCount: number;
  sniperPositionsCount: number;
  trendingPositionsCount: number;
  availableBalanceSol: number;
  dailyLossSol: number;
  consecutiveLosses: number;
  maxDrawdown: number;
  isCircuitBroken: boolean;
  circuitBreakReason?: string;
  heldMints: string[];
}

export function calculateMaxDrawdownPercent(
  startingEquitySol: number,
  pnlEvents: Array<{ realized_pnl_sol: number }>,
): number {
  if (!Number.isFinite(startingEquitySol) || startingEquitySol <= 0) return 0;
  let equity = startingEquitySol;
  let peak = startingEquitySol;
  let maxDrawdown = 0;

  for (const event of pnlEvents) {
    const pnl = Number(event.realized_pnl_sol);
    if (!Number.isFinite(pnl)) continue;
    equity += pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    }
  }

  return Math.max(0, maxDrawdown);
}

export class UserStateService {
  constructor(
    private readonly tradeRepo: TradeRepository,
    private readonly autopilotRepo: AutopilotRepository,
    private readonly walletService: WalletService
  ) {}

  async getAutopilotState(userId: number): Promise<AutopilotStateMetrics> {
    const config = await this.autopilotRepo.getOrCreateConfig(userId);
    const sizingParams = config.sizing_params as any;
    
    // 1. Get Open Positions
    // Actually we should get from positions table, but let's assume we can get from trades for now
    // Since Phase 2/3 will migrate to PENDING/OPEN/PARTIAL_EXIT.
    const allActiveTrades = await this.tradeRepo.getTradesByStatuses(userId, ['RESERVED', 'SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING', 'OPEN', 'PARTIAL_EXIT']);
    
    // We no longer assume PENDING trades have failed based on time. 
    // They are considered active exposure until definitively FAILED.
    const openTrades = allActiveTrades;
    const openPositionsCount = openTrades.length;
    const sniperPositionsCount = openTrades.filter(t => t.strategy === 'NEW_TOKEN_SNIPER').length;
    const trendingPositionsCount = openTrades.filter(t => t.source === 'AUTOPILOT' && t.strategy !== 'NEW_TOKEN_SNIPER').length;
    const heldMints = openTrades.map((t) => t.token_mint);

    // 2. Get Balance
    const wallet = await this.walletService.getOrCreateWallet(userId);
    const balance = await this.walletService.getBalance(wallet.publicKey);
    
    // Sum up unconfirmed SOL exposures (entries that might land)
    let unconfirmedExposureSol = 0;
    for (const t of openTrades) {
      if (['RESERVED', 'SIGNED', 'BROADCAST_ATTEMPTED', 'PENDING'].includes(t.status) && t.sol_amount) {
        unconfirmedExposureSol += t.sol_amount;
      }
    }

    const minReserve = sizingParams.min_reserve_sol ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_MIN_RESERVE_SOL;
    const autopilotBudget = sizingParams.autopilot_budget_sol ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_BUDGET_SOL;
    
    // Deduct unconfirmed exposures so we don't double-spend
    const conservativeBalance = balance.sol - unconfirmedExposureSol;
    const availableBalanceSol = Math.max(0, Math.min(conservativeBalance - minReserve, autopilotBudget));

    // 3. Get Closed Trades Today (based on DAY_BOUNDARY_TZ)
    const tz = appSettings.DAY_BOUNDARY_TZ || 'UTC';
    
    // Uses PostgreSQL timezone conversion to accurately get midnight in target timezone
    const pnlEvents = await this.tradeRepo.getDailyRealizedPnlEvents(userId, tz);
    
    let dailyLossSol = 0;
    let dailyRealizedPnlSol = 0;
    for (const event of pnlEvents) {
      const pnl = Number(event.realized_pnl_sol);
      if (Number.isFinite(pnl)) {
        dailyRealizedPnlSol += pnl;
        if (pnl < 0) {
          dailyLossSol += Math.abs(pnl);
        }
      }
    }

    // 4. Consecutive Losses (all time or just recently)
    // We get last N closed trades
    const recentTrades = await this.tradeRepo.getRecentClosedTrades(userId, 10);
    let consecutiveLosses = 0;
    for (const t of recentTrades) {
      if (t.pnl_sol && t.pnl_sol < 0) {
        consecutiveLosses++;
      } else if (t.pnl_sol && t.pnl_sol > 0) {
        break;
      }
    }

    // 5. Realized daily drawdown. Open positions are valued at cost so a buy
    // does not look like an equity loss merely because SOL left the wallet.
    const openCostSol = openTrades.reduce((sum, trade) => {
      const lamports = Number(trade.sol_spent_lamports ?? 0);
      const cost = Number.isFinite(lamports) && lamports > 0 ? lamports / 1_000_000_000 : Number(trade.sol_amount ?? 0);
      return sum + (Number.isFinite(cost) && cost > 0 ? cost : 0);
    }, 0);
    const estimatedEquityAtCost = balance.sol + openCostSol;
    const estimatedSessionStartEquity = estimatedEquityAtCost - dailyRealizedPnlSol;
    const riskCapitalSol = Math.max(
      0.000000001,
      Math.min(autopilotBudget, Math.max(estimatedSessionStartEquity, 0.000000001)),
    );
    const maxDrawdown = calculateMaxDrawdownPercent(riskCapitalSol, pnlEvents);

    const state = await this.autopilotRepo.getAutopilotState(userId);
    await this.autopilotRepo.updateAutopilotState(userId, {
      daily_realized_pnl_sol: dailyRealizedPnlSol,
      daily_trades_count: new Set(pnlEvents.map((event) => event.trade_id)).size,
      consecutive_losses: consecutiveLosses,
      max_drawdown: maxDrawdown,
    });

    return {
      openPositionsCount,
      sniperPositionsCount,
      trendingPositionsCount,
      availableBalanceSol,
      dailyLossSol,
      consecutiveLosses,
      maxDrawdown,
      isCircuitBroken: state?.is_circuit_broken || false,
      circuitBreakReason: state?.circuit_break_reason || '',
      heldMints,
    };
  }

  async checkCircuitBreaker(userId: number, metrics: AutopilotStateMetrics): Promise<boolean> {
    const config = await this.autopilotRepo.getOrCreateConfig(userId);
    const cbParams = config.circuit_breaker_params as any;
    const userDailyLoss = cbParams.max_daily_loss_sol ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_MAX_DAILY_LOSS_SOL;
    const maxDailyLoss = Math.min(userDailyLoss, 5.0); // Hardcoded absolute max daily loss of 5 SOL
    const maxConsecutiveLosses = cbParams.max_consecutive_losses ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_MAX_CONSECUTIVE_LOSSES;
    
    const userMaxDrawdown = cbParams.max_drawdown_percent ?? appSettings.AUTOPILOT_PARAMS.DEFAULT_MAX_DRAWDOWN_PERCENT;
    const maxDrawdownLimit = Math.min(userMaxDrawdown, 20.0); // Hardcoded absolute max drawdown of 20%

    let reason = '';
    if (metrics.dailyLossSol >= maxDailyLoss) {
      reason = `Daily loss limit reached: ${metrics.dailyLossSol.toFixed(2)} SOL >= ${maxDailyLoss}`;
    } else if (metrics.consecutiveLosses >= maxConsecutiveLosses) {
      reason = `Consecutive losses limit reached: ${metrics.consecutiveLosses} >= ${maxConsecutiveLosses}`;
    } else if (metrics.maxDrawdown >= maxDrawdownLimit) {
      reason = `Max drawdown limit reached: ${metrics.maxDrawdown.toFixed(2)}% >= ${maxDrawdownLimit}%`;
    }

    const redis = getRedisConnection();
    const rpcErrors = await redis.get(`rpc_errors:${userId}`);
    if (rpcErrors && parseInt(rpcErrors) >= 5) {
      reason = 'Too many RPC errors recently';
    }

    if (reason) {
      await redis.set(`killswitch:user:${userId}`, '1', 'EX', 86400); // Lock for 24h
      if (!metrics.isCircuitBroken || metrics.circuitBreakReason !== reason) {
        logger.error({ userId, reason }, `DANGER: Circuit Breaker triggered for user ${userId}. Reason: ${reason}`);
        await this.autopilotRepo.updateAutopilotState(userId, {
          is_circuit_broken: true,
          circuit_break_reason: reason,
        });
        await this.autopilotRepo.saveCircuitBreakerEvent({
          user_id: userId,
          trigger_type: 'CIRCUIT_BREAKER',
          description: reason,
        });
      }
      return true;
    }

    if (metrics.isCircuitBroken) {
      await redis.del(`killswitch:user:${userId}`);
      await this.autopilotRepo.updateAutopilotState(userId, {
        is_circuit_broken: false,
        circuit_break_reason: null,
      });
      logger.info({ userId }, 'Circuit breaker cleared after risk metrics recovered');
    }

    return false;
  }
}
