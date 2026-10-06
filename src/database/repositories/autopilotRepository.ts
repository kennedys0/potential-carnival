import { SupabaseClient } from '@supabase/supabase-js';

export interface AutopilotConfigRecord {
  user_id: number;
  is_active: boolean;
  mode: 'PAPER' | 'LIVE';
  risk_profile: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE' | 'CUSTOM';
  safety_params: Record<string, unknown>;
  ai_params: Record<string, unknown>;
  sizing_params: Record<string, unknown>;
  exit_params: Record<string, unknown>;
  circuit_breaker_params: Record<string, unknown>;
  updated_at?: string;
}

export interface DecisionLogRecord {
  id?: string;
  user_id: number;
  token_mint: string;
  token_symbol?: string | null;
  action: 'BUY' | 'SKIP' | 'REJECT';
  safety_score: number;
  safety_flags?: string[] | null;
  ai_verdict?: string | null;
  ai_confidence?: number | null;
  rules_passed?: string[] | null;
  rules_failed?: string[] | null;
  reason_summary: string;
  raw_snapshot?: Record<string, unknown> | null;
  timestamp?: string;
}

export class AutopilotRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getOrCreateConfig(userId: number): Promise<AutopilotConfigRecord> {
    const { data, error } = await this.db
      .from('autopilot_configs')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (data) return data as AutopilotConfigRecord;

    const defaultConfig: AutopilotConfigRecord = {
      user_id: userId,
      is_active: false,
      mode: 'PAPER',
      risk_profile: 'MODERATE',
      safety_params: {
        min_safety_score: 75,
        allowed_levels: ['SAFE', 'CAUTION'],
        min_liquidity_usd: 10000,
        max_top10_percent: 25,
        max_deployer_percent: 5,
        lp_burn_or_lock_required: true,
      },
      ai_params: {
        min_confidence: 70,
        min_risk_reward: 1.5,
        allowed_setups: ['BREAKOUT', 'MOMENTUM', 'PULLBACK'],
      },
      sizing_params: {
        mode: 'FIXED_SOL',
        fixed_sol: 0.1,
        max_concurrent_positions: 3,
        min_reserve_sol: 0.05,
      },
      exit_params: {
        tp1_percent: 15,
        tp1_sell_share: 50,
        tp2_percent: 30,
        sl_percent: 8,
        trailing_stop_enabled: true,
        trailing_stop_delta_percent: 5,
      },
      circuit_breaker_params: {
        max_daily_loss_sol: 1.0,
        max_consecutive_losses: 3,
      },
    };

    const { data: inserted, error: insertError } = await this.db
      .from('autopilot_configs')
      .insert(defaultConfig)
      .select()
      .single();

    if (insertError) throw new Error(`Failed to create default autopilot config: ${insertError.message}`);
    return inserted as AutopilotConfigRecord;
  }

  async saveDecisionLog(log: DecisionLogRecord): Promise<void> {
    const { error } = await this.db.from('decision_logs').insert(log);
    if (error) throw new Error(`Failed to saveDecisionLog: ${error.message}`);
  }
}
