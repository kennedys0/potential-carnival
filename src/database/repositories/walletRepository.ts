import { SupabaseClient } from '@supabase/supabase-js';

export interface WalletRecord {
  id?: string;
  user_id: number;
  public_key: string;
  encrypted_private_key: string;
  iv: string;
  auth_tag: string;
  owner_pubkey?: string | null;
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

  async getAllWallets(): Promise<WalletRecord[]> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*');
    if (error) throw new Error(`Failed to getAllWallets: ${error.message}`);
    return data as WalletRecord[];
  }

  async updateOwnerPubkey(userId: number, pubkey: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('user_wallets')
      .update({ owner_pubkey: pubkey })
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) {
       throw error;
    }
    return true;
  }

  async createWithdrawalAttempt(data: { user_id: number; amount_sol: number; destination_address: string; status: string; idempotency_key: string }): Promise<string> {
    const { data: record, error } = await this.db.from('withdrawal_attempts').insert(data).select('id').single();
    if (error) {
      if (error.code === '23505') { // unique violation
        throw new Error('Withdrawal sedang diproses atau sudah pernah dikirim.');
      }
      throw new Error(`Failed to create withdrawal attempt: ${error.message}`);
    }
    return record.id;
  }

  async updateWithdrawalAttempt(id: string, updates: { status?: string; tx_signature?: string }): Promise<void> {
    const { error } = await this.db.from('withdrawal_attempts').update(updates).eq('id', id);
    if (error) {
      throw new Error(`Failed to update withdrawal attempt: ${error.message}`);
    }
  }

  async atomicClaimWithdrawal(id: string, userId: number): Promise<any> {
    const { data, error } = await this.db.rpc('atomic_claim_withdrawal', {
      p_id: id,
      p_user_id: userId
    });
    
    if (error) {
      throw new Error(`Failed to claim withdrawal: ${error.message}`);
    }
    
    return data; // returns (v_attempt, status)
  }

  async getPendingWithdrawals(): Promise<any[]> {
    const { data, error } = await this.db
      .from('withdrawal_attempts')
      .select('*')
      .in('status', ['CONFIRMING', 'SUBMITTED', 'SIGNED']);
    if (error) return [];
    return data;
  }
}
