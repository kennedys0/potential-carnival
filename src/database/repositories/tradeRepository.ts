import { SupabaseClient } from '@supabase/supabase-js';

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
    const { data, error } = await this.db
      .from('trades')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'OPEN');

    if (error) throw new Error(`Failed to getOpenTradesByUserId: ${error.message}`);
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
