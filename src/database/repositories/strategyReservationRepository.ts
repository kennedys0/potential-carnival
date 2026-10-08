import type { SupabaseClient } from '@supabase/supabase-js';
import { solToLamports } from '../../modules/autopilot/strategyRisk';
import { appSettings } from '../../config/settings';

export type StrategyName = 'TRENDING' | 'NEW_TOKEN_SNIPER';
export interface StrategyReservationRequest {
  userId: number;
  tokenMint: string;
  strategy: StrategyName;
  isDryRun: boolean;
  amountSol: number | string;
  availableBalanceSol: number | string;
  maxStrategyPositions: number;
  maxGlobalPositions: number;
  maxDailyBuys?: number;
  maxDailyBudgetSol?: number | string;
}

/** All strategies share the same PostgreSQL-serialized reservation gate. */
export class StrategyReservationRepository {
  constructor(private readonly db: SupabaseClient) {}

  async reserve(request: StrategyReservationRequest): Promise<string | null> {
    const amountLamports = solToLamports(request.amountSol);
    const availableLamports = solToLamports(request.availableBalanceSol);
    const dailyBudget = request.strategy === 'NEW_TOKEN_SNIPER'
      ? solToLamports(request.maxDailyBudgetSol ?? appSettings.STRATEGY_RESERVATION_PARAMS.DEFAULT_SNIPER_DAILY_BUDGET_SOL)
      : solToLamports(appSettings.STRATEGY_RESERVATION_PARAMS.MAX_TRENDING_DAILY_BUDGET_SOL);
    const { data, error } = await this.db.rpc('reserve_strategy_entry', {
      p_user_id: request.userId,
      p_token_mint: request.tokenMint,
      p_strategy: request.strategy,
      p_is_dry_run: request.isDryRun,
      p_amount_lamports: amountLamports.toString(),
      p_max_strategy_positions: request.maxStrategyPositions,
      p_max_global_positions: request.maxGlobalPositions,
      p_max_daily_buys: request.strategy === 'NEW_TOKEN_SNIPER' ? (request.maxDailyBuys ?? appSettings.STRATEGY_RESERVATION_PARAMS.DEFAULT_SNIPER_DAILY_BUYS) : appSettings.STRATEGY_RESERVATION_PARAMS.MAX_TRENDING_DAILY_BUYS,
      p_max_daily_lamports: dailyBudget.toString(),
      p_available_lamports: availableLamports.toString(),
    });
    if (error) throw new Error(`Strategy reservation failed (fail closed): ${error.message}`);
    return typeof data === 'string' && data ? data : null;
  }

  async finish(id: string, status: 'IN_FLIGHT' | 'COMPLETED'): Promise<void> {
    const { data, error } = await this.db.rpc('finish_strategy_reservation', { p_id: id, p_status: status });
    if (error || data !== true) throw new Error(`Failed to persist strategy reservation state: ${error?.message ?? String(data)}`);
  }

  async releaseIfUnbroadcast(id: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('release_strategy_reservation', { p_id: id });
    if (error) throw new Error(`Failed to safely release strategy reservation: ${error.message}`);
    return data === true;
  }
}
