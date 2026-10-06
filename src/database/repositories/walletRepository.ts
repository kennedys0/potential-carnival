import { SupabaseClient } from '@supabase/supabase-js';

export interface WalletRecord {
  id?: string;
  user_id: number;
  public_key: string;
  encrypted_private_key: string;
  iv: string;
  auth_tag: string;
  created_at?: string;
}

export class WalletRepository {
  constructor(private readonly db: SupabaseClient) {}

  async saveWallet(record: Omit<WalletRecord, 'id' | 'created_at'>): Promise<WalletRecord> {
    const { data, error } = await this.db
      .from('user_wallets')
      .upsert(record, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw new Error(`Failed to saveWallet: ${error.message}`);
    return data as WalletRecord;
  }

  async getWalletByUserId(userId: number): Promise<WalletRecord | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) return null;
    return data as WalletRecord;
  }
}
