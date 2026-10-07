import { TradeRepository } from '../../database/repositories/tradeRepository';
import { AutopilotRepository, AutopilotStateRecord } from '../../database/repositories/autopilotRepository';
import { WalletService } from '../wallet/walletService';
import { getRedisConnection } from '../../queue/connection';
import { appSettings } from '../../config/settings';
import { logger } from '../../utils/logger';

export interface AutopilotStateMetrics {
  openPositionsCount: number;
  availableBalanceSol: number;
  dailyLossSol: number;
  consecutiveLosses: number;
  maxDrawdown: number;
  isCircuitBroken: boolean;
  circuitBreakReason?: string;
  heldMints: string[];
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
    const openTrades = await this.tradeRepo.getTradesByStatuses(userId, ['OPEN', 'PARTIAL_EXIT', 'PENDING']);
    const openPositionsCount = openTrades.length;
    const heldMints = openTrades.map((t) => t.token_mint);

    // 2. Get Balance
    const wallet = await this.walletService.getOrCreateWallet(userId);
    const balance = await this.walletService.getBalance(wallet.publicKey);
    const minReserve = sizingParams.min_reserve_sol || 0.05;
    const autopilotBudget = sizingParams.autopilot_budget_sol || Infinity;
    
    const availableBalanceSol = Math.max(0, Math.min(balance.sol - minReserve, autopilotBudget));

    // 3. Get Closed Trades Today (based on DAY_BOUNDARY_TZ)
    const tz = appSettings.DAY_BOUNDARY_TZ || 'UTC';
    
    // Get start of day in specified timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const year = parseInt(parts.find(p => p.type === 'year')!.value);
    const month = parseInt(parts.find(p => p.type === 'month')!.value) - 1;
    const day = parseInt(parts.find(p => p.type === 'day')!.value);
    
    // Create UTC date that corresponds to midnight in target timezone
    const startOfDayStr = new Date(Date.UTC(year, month, day, 0, 0, 0)).toISOString();
    // It's a rough approximation for DB query, we should ideally let DB handle timezone if possible,
    // but we can query trades closed after startOfDay.
    
    const closedTrades = await this.tradeRepo.getClosedTradesSince(userId, startOfDayStr);
    
    let dailyLossSol = 0;
    let dailyRealizedPnlSol = 0;
    for (const t of closedTrades) {
      if (t.pnl_sol) {
        dailyRealizedPnlSol += t.pnl_sol;
        if (t.pnl_sol < 0) {
          dailyLossSol += Math.abs(t.pnl_sol);
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

    // 5. Max Drawdown
    // To calculate max drawdown, we need the equity curve. We can simplify by just tracking peak equity in autopilot_states
    const state = await this.autopilotRepo.getAutopilotState(userId);
    let maxDrawdown = state?.max_drawdown || 0;

    return {
      openPositionsCount,
      availableBalanceSol,
      dailyLossSol,
      consecutiveLosses,
      maxDrawdown,
      isCircuitBroken: state?.is_circuit_broken || false,
      circuitBreakReason: state?.circuit_break_reason || '',
      heldMints,
    };
  }

  async checkCircuitBreaker(userId: number, metrics: AutopilotStateMetrics): Promise<void> {
    if (metrics.isCircuitBroken) return; // Already broken

    const config = await this.autopilotRepo.getOrCreateConfig(userId);
    const cbParams = config.circuit_breaker_params as any;
    const maxDailyLoss = cbParams.max_daily_loss_sol || 1.0;
    const maxConsecutiveLosses = cbParams.max_consecutive_losses || 3;
    const maxDrawdownLimit = cbParams.max_drawdown_percent || 20;

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
      logger.error({ userId, reason }, `DANGER: Circuit Breaker triggered for user ${userId}. Reason: ${reason}`);
      await redis.set(`killswitch:user:${userId}`, '1', 'EX', 86400); // Lock for 24h

      await this.autopilotRepo.updateAutopilotState(userId, {
        is_circuit_broken: true,
        circuit_break_reason: reason,
      });
      await this.autopilotRepo.updateConfig(userId, {
        is_active: false,
      });
      
      await this.autopilotRepo.saveCircuitBreakerEvent({
        user_id: userId,
        trigger_type: 'CIRCUIT_BREAKER',
        description: reason,
      });
    }
  }
}
