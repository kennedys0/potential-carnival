import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

export interface TradeRecord {
  id?: string;
  user_id: number;
  token_mint: string;
  token_symbol: string;
  side: 'BUY' | 'SELL';
  source: 'MANUAL' | 'AUTOPILOT';
  is_dry_run: boolean;
  sol_amount: number;
  token_amount: number;
  entry_price_usd: number;
  exit_price_usd?: number | null;
  tx_signature?: string | null;
  fee_lamports?: number;
  pnl_sol?: number | null;
  pnl_percent?: number | null;
  status: 'PENDING' | 'OPEN' | 'PARTIAL_EXIT' | 'CLOSED' | 'FAILED';
  created_at?: string;
  closed_at?: string | null;
  token_amount_raw?: number | null;
  token_decimals?: number | null;
  sol_spent_lamports?: number | null;
  sol_received_lamports?: number | null;
  sol_usd_at_fill?: number | null;
  failure_reason?: string | null;
  idempotency_key?: string | null;
  pending_signature?: string | null;
  exit_attempts?: number;
  last_exit_error?: string | null;
  needs_attention?: boolean;
  remaining_raw?: number | null;
  realized_pnl_sol?: number | null;
}

export class TradeRepository {
  constructor(private readonly db: SupabaseClient) {}

  async createTrade(trade: TradeRecord): Promise<TradeRecord> {
    const { data, error } = await this.db
      .from('trades')
      .insert(trade)
      .select()
      .single();

    if (error) throw new Error(`Failed to createTrade: ${error.message}`);
    return data as TradeRecord;
  }

  async getOpenTradesByUserId(userId: number): Promise<TradeRecord[]> {
    return this.getTradesByStatuses(userId, ['OPEN', 'PARTIAL_EXIT']);
  }

  async getTradesByStatuses(userId: number, statuses: string[]): Promise<TradeRecord[]> {
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .in('status', statuses);

    if (error) throw new Error(`Failed to getTradesByStatuses: ${error.message}`);
    return (data || []) as TradeRecord[];
  }

  async getPendingTradesWithSignature(): Promise<any[]> {
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .eq('status', 'PENDING')
      .not('pending_signature', 'is', null);
    
    if (error) {
      logger.error({ error }, 'Failed to get pending trades with signature');
      return [];
    }
    return data || [];
  }

  async getOpenTradesOrderedFIFO(): Promise<any[]> {
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .in('status', ['OPEN', 'PARTIAL_EXIT'])
      .order('created_at', { ascending: true });
      
    if (error) {
      logger.error({ error }, 'Failed to get open trades ordered FIFO');
      return [];
    }
    return data || [];
  }

  async getClosedTradesSince(userId: number, sinceStr: string): Promise<TradeRecord[]> {
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'CLOSED')
      .gte('closed_at', sinceStr);

    if (error) throw new Error(`Failed to getClosedTradesSince: ${error.message}`);
    return (data || []) as TradeRecord[];
  }

  async getRecentClosedTrades(userId: number, limit: number = 10): Promise<TradeRecord[]> {
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'CLOSED')
      .order('closed_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Failed to getRecentClosedTrades: ${error.message}`);
    return (data || []) as TradeRecord[];
  }

  async getTradeById(id: string): Promise<TradeRecord | null> {
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // not found
      throw new Error(`Failed to getTradeById: ${error.message}`);
    }
    return data as TradeRecord;
  }

  async updateTradeStatus(id: string, updates: Partial<TradeRecord>): Promise<void> {
    const { error } = await this.db
      .from('trades')
      .update(updates)
      .eq('id', id);

    if (error) throw new Error(`Failed to updateTradeStatus: ${error.message}`);
  }
}
