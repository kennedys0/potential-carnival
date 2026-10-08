import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

const SELECT_TRADES_SAFE = '*, remaining_raw:remaining_raw::text, token_amount_raw:token_amount_raw::text, sol_spent_lamports:sol_spent_lamports::text, sol_received_lamports:sol_received_lamports::text, fee_lamports:fee_lamports::text';
const SELECT_EXIT_ATTEMPTS_SAFE = '*, tokens_amount_raw:tokens_amount_raw::text';

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
  fee_lamports?: number | string;
  pnl_sol?: number | null;
  pnl_percent?: number | null;
  status: 'RESERVED' | 'SIGNED' | 'BROADCAST_ATTEMPTED' | 'PENDING' | 'OPEN' | 'PARTIAL_EXIT' | 'CLOSED' | 'FAILED';
  created_at?: string;
  closed_at?: string | null;
  token_amount_raw?: string | number | null;
  token_decimals?: number | null;
  sol_spent_lamports?: string | number | null;
  sol_received_lamports?: string | number | null;
  sol_usd_at_fill?: number | null;
  failure_reason?: string | null;
  idempotency_key?: string | null;
  pending_signature?: string | null;
  exit_attempts?: number;
  last_exit_error?: string | null;
  needs_attention?: boolean;
  remaining_raw?: string | number | null;
  realized_pnl_sol?: number | null;
  blockhash?: string | null;
  last_valid_block_height?: number | null;
  pending_since?: string | null;
  highest_pnl_percent?: number | null;
}

export interface ExitAttemptRecord {
  id?: string;
  trade_id: string;
  percentage: number;
  tokens_amount_raw: string | number;
  status: 'PENDING' | 'CONFIRMING' | 'SUCCESS' | 'FAILED';
  tx_signature?: string | null;
  idempotency_key: string;
  worker_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export class TradeRepository {
  constructor(private readonly db: SupabaseClient) {}

  async createTrade(trade: TradeRecord): Promise<TradeRecord> {
    const { data, error } = await this.db
      .from('trades')
      .insert(trade)
      .select(SELECT_TRADES_SAFE)
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
      .select(SELECT_TRADES_SAFE)
      .eq('user_id', userId)
      .in('status', statuses);

    if (error) throw new Error(`Failed to getTradesByStatuses: ${error.message}`);
    return (data || []) as TradeRecord[];
  }

  async getInflightTradesWithSignature(): Promise<any[]> {
    const { data, error } = await this.db
      .from('trades')
      .select(SELECT_TRADES_SAFE)
      .in('status', ['PENDING', 'SIGNED', 'BROADCAST_ATTEMPTED'])
      .not('pending_signature', 'is', null);
    
    if (error) {
      throw new Error(`Failed to get pending trades with signature: ${error.message}`);
    }
    return data || [];
  }

  async getReservedTradesWithoutSignature(): Promise<TradeRecord[]> {
    const { data, error } = await this.db
      .from('trades')
      .select(SELECT_TRADES_SAFE)
      .eq('status', 'RESERVED')
      .is('pending_signature', null);
      
    if (error) {
      throw new Error(`Failed to get pending trades without signature: ${error.message}`);
    }
    return (data || []) as TradeRecord[];
  }

  async getOpenTradesOrderedFIFO(): Promise<any[]> {
    const { data, error } = await this.db
      .from('trades')
      .select(SELECT_TRADES_SAFE)
      .in('status', ['OPEN', 'PARTIAL_EXIT'])
      .order('created_at', { ascending: true });
      
    if (error) {
      throw new Error(`Failed to get open trades ordered FIFO: ${error.message}`);
    }
    return data || [];
  }

  async getClosedTradesSince(userId: number, sinceStr: string): Promise<TradeRecord[]> {
    const { data, error } = await this.db
      .from('trades')
      .select(SELECT_TRADES_SAFE)
      .eq('user_id', userId)
      .eq('status', 'CLOSED')
      .gte('closed_at', sinceStr);

    if (error) throw new Error(`Failed to getClosedTradesSince: ${error.message}`);
    return (data || []) as TradeRecord[];
  }

  async getRecentClosedTrades(userId: number, limit: number = 10): Promise<TradeRecord[]> {
    const { data, error } = await this.db
      .from('trades')
      .select(SELECT_TRADES_SAFE)
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
      .select(SELECT_TRADES_SAFE)
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

  async getPendingExitAttempts(tradeId: string): Promise<ExitAttemptRecord[]> {
    const { data, error } = await this.db
      .from('exit_attempts')
      .select(SELECT_EXIT_ATTEMPTS_SAFE)
      .eq('trade_id', tradeId)
      .eq('status', 'PENDING');
      
    if (error) throw new Error(`Failed to getPendingExitAttempts: ${error.message}`);
    return (data || []) as ExitAttemptRecord[];
  }

  async getAllPendingExitAttempts(): Promise<ExitAttemptRecord[]> {
    const { data, error } = await this.db
      .from('exit_attempts')
      .select(SELECT_EXIT_ATTEMPTS_SAFE)
      .eq('status', 'PENDING');
      
    if (error) throw new Error(`Failed to getAllPendingExitAttempts: ${error.message}`);
    return (data || []) as ExitAttemptRecord[];
  }

  async createExitAttempt(attempt: ExitAttemptRecord): Promise<ExitAttemptRecord> {
    const { data, error } = await this.db
      .from('exit_attempts')
      .insert(attempt)
      .select(SELECT_EXIT_ATTEMPTS_SAFE)
      .single();

    if (error) throw new Error(`Failed to createExitAttempt: ${error.message}`);
    return data as ExitAttemptRecord;
  }

  async updateExitAttempt(id: string, updates: Partial<ExitAttemptRecord>): Promise<void> {
    const { error } = await this.db
      .from('exit_attempts')
      .update(updates)
      .eq('id', id);

    if (error) throw new Error(`Failed to updateExitAttempt: ${error.message}`);
  }

  async atomicReconcileExit(
    tradeId: string,
    exitAttemptId: string | undefined,
    updates: Partial<TradeRecord> & {
      token_delta_raw?: string | bigint;
      sol_delta_lamports?: string | bigint | number;
      fee_lamports?: string | bigint | number;
    }
  ): Promise<void> {
    const { error, data } = await this.db.rpc('atomic_reconcile_exit', {
      p_trade_id: tradeId,
      p_exit_attempt_id: exitAttemptId ?? null,
      p_tx_signature: updates.tx_signature ?? null,
      p_token_delta_raw: updates.token_delta_raw ? updates.token_delta_raw.toString() : 0,
      p_sol_delta_lamports: updates.sol_delta_lamports !== undefined ? updates.sol_delta_lamports.toString() : 0,
      p_fee_lamports: updates.fee_lamports !== undefined ? updates.fee_lamports.toString() : 0,
      p_exit_price_usd: updates.exit_price_usd ?? null
    });

    if (error) {
      throw new Error(`Failed to atomic_reconcile_exit: ${error.message}`);
    }

    if (data === 'ALREADY_APPLIED') {
      logger.info({ tradeId, exitAttemptId, signature: updates.tx_signature }, 'Reconciliation skipped: Already applied (idempotency)');
      return;
    }

    if (data === 'APPLIED') {
      return;
    }

    throw new Error(`Reconciliation rejected by database constraints: ${data}`);
  }

  async atomicReconcileEntry(
    tradeId: string,
    updates: Partial<TradeRecord>
  ): Promise<void> {
    const { error, data } = await this.db.rpc('atomic_reconcile_entry', {
      p_trade_id: tradeId,
      p_status: updates.status ?? null,
      p_tx_signature: updates.tx_signature ?? null,
      p_remaining_raw: updates.remaining_raw ?? null,
      p_token_decimals: updates.token_decimals ?? null,
      p_sol_spent_lamports: updates.sol_spent_lamports ?? null,
      p_token_amount_raw: updates.token_amount_raw ?? null,
      p_fee_lamports: updates.fee_lamports ?? null,
      p_sol_amount: updates.sol_amount ?? null,
      p_token_amount: updates.token_amount ?? null,
      p_needs_attention: updates.needs_attention ?? null
    });

    if (error) {
      throw new Error(`Failed to atomic_reconcile_entry: ${error.message}`);
    }

    if (data === 'ALREADY_APPLIED' || data === 'ALREADY_RESOLVED') {
      logger.info({ tradeId, signature: updates.tx_signature }, `Entry reconciliation skipped: ${data}`);
      return;
    }

    if (data === 'APPLIED' || data === 'RESOLVED') {
      return;
    }

    throw new Error(`Entry reconciliation rejected by database constraints: ${data}`);
  }

  async acquireBuyLock(userId: number, tokenMint: string, ownerToken: string, ttlSeconds: number = 30): Promise<boolean> {
    const { data, error } = await this.db.rpc('acquire_buy_lock', {
      p_user_id: userId,
      p_token_mint: tokenMint,
      p_owner_token: ownerToken,
      p_ttl_seconds: ttlSeconds
    });
    if (error) {
      logger.error({ err: error, userId, tokenMint }, 'Failed to acquire buy lock');
      return false;
    }
    return !!data;
  }

  async releaseBuyLock(userId: number, tokenMint: string, ownerToken: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('release_buy_lock', {
      p_user_id: userId,
      p_token_mint: tokenMint,
      p_owner_token: ownerToken
    });
    if (error) {
      logger.error({ err: error, userId, tokenMint }, 'Failed to release buy lock');
      return false;
    }
    return !!data;
  }

  async verifyBuyLock(userId: number, tokenMint: string, ownerToken: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('verify_buy_lock', {
      p_user_id: userId,
      p_token_mint: tokenMint,
      p_owner_token: ownerToken
    });
    if (error) {
      logger.error({ err: error, userId, tokenMint }, 'Failed to verify buy lock');
      return false;
    }
    return !!data;
  }

  async getClosedTradesToday(userId: number, timezone: string): Promise<TradeRecord[]> {
    const { data, error } = await this.db.rpc('get_daily_trade_stats', {
      p_user_id: userId,
      p_timezone: timezone
    });
    
    if (error) {
      throw new Error(`Failed to getClosedTradesToday: ${error.message}`);
    }
    return data as TradeRecord[];
  }
}


