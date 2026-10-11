import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../utils/logger';

export interface CopyTradeTarget {
  id: string;
  user_id: number;
  target_wallet_address: string;
  label: string | null;
  max_buy_usd: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type CopyTradeDeliveryStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'RETRY'
  | 'COMPLETED'
  | 'REJECTED'
  | 'NEEDS_ATTENTION';

export interface CopyTradeDelivery {
  id: string;
  target_id: string | null;
  user_id: number;
  target_wallet_address: string;
  source_signature: string;
  token_mint: string;
  max_buy_usd: number;
  status: CopyTradeDeliveryStatus;
  attempts: number;
  trade_id: string | null;
  last_error: string | null;
}

export class CopyTradeRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async getTargetsByUserId(userId: number): Promise<CopyTradeTarget[]> {
    const { data, error } = await this.supabase
      .from('copy_trade_targets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ err: error, userId }, 'Error fetching copy trade targets');
      throw new Error('Failed to fetch copy trade targets');
    }

    return data || [];
  }

  async getAllActiveTargets(): Promise<CopyTradeTarget[]> {
    const { data, error } = await this.supabase
      .from('copy_trade_targets')
      .select('*')
      .eq('is_active', true);

    if (error) {
      logger.error({ err: error }, 'Error fetching active copy trade targets');
      return [];
    }

    return data || [];
  }

  async getActiveTargetById(id: string, userId: number): Promise<CopyTradeTarget | null> {
    const { data, error } = await this.supabase
      .from('copy_trade_targets')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw new Error(`Failed to fetch active copy trade target: ${error.message}`);
    return data as CopyTradeTarget | null;
  }

  async enqueueDeliveries(
    targets: CopyTradeTarget[],
    tokenMint: string,
    sourceSignature: string,
  ): Promise<void> {
    if (targets.length === 0) return;
    const rows = targets.map((target) => ({
      target_id: target.id,
      user_id: target.user_id,
      target_wallet_address: target.target_wallet_address,
      source_signature: sourceSignature,
      token_mint: tokenMint,
      max_buy_usd: target.max_buy_usd,
      status: 'PENDING',
    }));
    const { error } = await this.supabase
      .from('copy_trade_deliveries')
      .upsert(rows, {
        onConflict: 'user_id,target_wallet_address,source_signature',
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`Failed to enqueue copy trade deliveries: ${error.message}`);
  }

  async claimNextDelivery(): Promise<CopyTradeDelivery | null> {
    const { data, error } = await this.supabase.rpc('claim_copy_trade_delivery');
    if (error) throw new Error(`Failed to claim copy trade delivery: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return row ? row as CopyTradeDelivery : null;
  }

  async findDeliveredTradeId(delivery: CopyTradeDelivery): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('trades')
      .select('id')
      .eq('user_id', delivery.user_id)
      .eq('strategy', 'COPY_TRADE')
      .eq('copy_target_wallet', delivery.target_wallet_address)
      .eq('copy_source_signature', delivery.source_signature)
      .maybeSingle();
    if (error) throw new Error(`Failed to recover delivered copy trade: ${error.message}`);
    return data?.id ? String(data.id) : null;
  }

  async finishDelivery(
    id: string,
    attempt: number,
    status: Extract<CopyTradeDeliveryStatus, 'RETRY' | 'COMPLETED' | 'REJECTED' | 'NEEDS_ATTENTION'>,
    lastError?: string,
    tradeId?: string,
  ): Promise<void> {
    const { data, error } = await this.supabase.rpc('finish_copy_trade_delivery', {
      p_id: id,
      p_attempt: attempt,
      p_status: status,
      p_last_error: lastError ?? null,
      p_trade_id: tradeId ?? null,
    });
    if (error || data !== true) {
      throw new Error(`Failed to finish copy trade delivery: ${error?.message ?? String(data)}`);
    }
  }

  async addTarget(userId: number, walletAddress: string, maxBuyUsd: number, label?: string): Promise<CopyTradeTarget> {
    const { data, error } = await this.supabase
      .from('copy_trade_targets')
      .insert({
        user_id: userId,
        target_wallet_address: walletAddress,
        max_buy_usd: maxBuyUsd,
        label: label || null,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      logger.error({ err: error, userId, walletAddress }, 'Error adding copy trade target');
      throw new Error(`Gagal menyimpan wallet target: ${error.message}`);
    }

    return data;
  }

  async removeTarget(userId: number, walletAddress: string): Promise<void> {
    const { error } = await this.supabase
      .from('copy_trade_targets')
      .delete()
      .eq('user_id', userId)
      .eq('target_wallet_address', walletAddress);

    if (error) {
      logger.error({ err: error, userId, walletAddress }, 'Error removing copy trade target');
      throw new Error('Gagal menghapus wallet target');
    }
  }

  async toggleTargetStatus(userId: number, walletAddress: string, isActive: boolean): Promise<CopyTradeTarget> {
    const { data, error } = await this.supabase
      .from('copy_trade_targets')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('target_wallet_address', walletAddress)
      .select()
      .single();

    if (error) {
      logger.error({ err: error, userId, walletAddress }, 'Error toggling copy trade target status');
      throw new Error('Gagal mengubah status wallet target');
    }

    return data;
  }
}
