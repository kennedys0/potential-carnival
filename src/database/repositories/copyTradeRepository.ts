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
