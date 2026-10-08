import { SupabaseClient } from '@supabase/supabase-js';

export interface SniperConfigRecord {
  user_id: number;
  enabled: boolean;
  trading_mode: 'PAPER' | 'LIVE';
  buy_amount_sol: number;
  max_active_positions: number;
  max_buys_per_day: number;
  max_daily_entry_budget_sol: number;
  max_pool_age_minutes: number;
  min_pool_age_seconds: number;
  min_liquidity_usd: number;
  minimum_safety_score: number;
  require_sell_route: boolean;
  reject_unknown_critical_safety_checks: boolean;
  max_slippage_bps: number;
  tp_sl_enabled: boolean;
  take_profit_percent: number;
  stop_loss_percent: number;
  notifications_enabled: boolean;
  rejected_candidates_summary: boolean;
  updated_at?: string;
}

export interface SniperStateRecord {
  user_id: number;
  daily_buys_count: number;
  daily_entry_sol: number;
  accounting_date: string;
  updated_at?: string;
}

export class SniperRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getOrCreateConfig(userId: number): Promise<SniperConfigRecord> {
    const { data, error } = await this.db
      .from('sniper_configs')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (data) return data as SniperConfigRecord;

    const defaultConfig: SniperConfigRecord = {
      user_id: userId,
      enabled: false,
      trading_mode: 'PAPER',
      buy_amount_sol: 0.01,
      max_active_positions: 3,
      max_buys_per_day: 3,
      max_daily_entry_budget_sol: 0.03,
      max_pool_age_minutes: 5,
      min_pool_age_seconds: 20,
      min_liquidity_usd: 10000,
      minimum_safety_score: 80,
      require_sell_route: true,
      reject_unknown_critical_safety_checks: true,
      max_slippage_bps: 300,
      tp_sl_enabled: true,
      take_profit_percent: 20,
      stop_loss_percent: 10,
      notifications_enabled: true,
      rejected_candidates_summary: true,
    };

    const { data: inserted, error: insertError } = await this.db
      .from('sniper_configs')
      .insert(defaultConfig)
      .select()
      .single();

    if (insertError) throw new Error(`Failed to create default sniper config: ${insertError.message}`);
    return inserted as SniperConfigRecord;
  }

  async updateConfig(
    userId: number,
    updates: Partial<SniperConfigRecord>
  ): Promise<SniperConfigRecord> {
    const { data, error } = await this.db
      .from('sniper_configs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new Error(`Failed to update sniper config: ${error.message}`);
    return data as SniperConfigRecord;
  }

  async getAllActiveConfigs(): Promise<SniperConfigRecord[]> {
    const { data, error } = await this.db
      .from('sniper_configs')
      .select('*')
      .eq('enabled', true);

    if (error) throw new Error(`Failed to getAllActiveConfigs for sniper: ${error.message}`);
    return (data || []) as SniperConfigRecord[];
  }

}
