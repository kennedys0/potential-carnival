import { SupabaseClient } from '@supabase/supabase-js';

export interface WalletRecord {
  id?: string;
  user_id: number;
  public_key: string;
  encrypted_private_key: string;
  iv: string;
  auth_tag: string;
  encryption_version?: number;
  owner_pubkey?: string | null;
  created_at?: string;
}

export class WalletRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getOrCreateWallet(record: Omit<WalletRecord, 'id' | 'created_at' | 'owner_pubkey'>): Promise<WalletRecord> {
    const { data, error } = await this.db
      .rpc('get_or_create_user_wallet', {
        p_user_id: record.user_id,
        p_public_key: record.public_key,
        p_encrypted_private_key: record.encrypted_private_key,
        p_iv: record.iv,
        p_auth_tag: record.auth_tag,
      })
      .single();

    if (error) throw new Error(`Failed to getOrCreateWallet: ${error.message}`);
    if (!data) throw new Error('Failed to getOrCreateWallet: database returned no wallet');
    return data as WalletRecord;
  }

  async getWalletByUserId(userId: number): Promise<WalletRecord | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`Failed to getWalletByUserId: ${error.message}`);
    if (!data) return null;
    return data as WalletRecord;
  }

  async getAllWallets(): Promise<WalletRecord[]> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*');
    if (error) throw new Error(`Failed to getAllWallets: ${error.message}`);
    return data as WalletRecord[];
  }

  async getLegacyWallets(): Promise<WalletRecord[]> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('encryption_version', 1);
    if (error) throw new Error(`Failed to getLegacyWallets: ${error.message}`);
    return data as WalletRecord[];
  }

  async upgradeWalletEncryption(
    existing: WalletRecord,
    encrypted: Pick<WalletRecord, 'encrypted_private_key' | 'iv' | 'auth_tag'>,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from('user_wallets')
      .update({
        encrypted_private_key: encrypted.encrypted_private_key,
        iv: encrypted.iv,
        auth_tag: encrypted.auth_tag,
        encryption_version: 2,
      })
      .eq('user_id', existing.user_id)
      .eq('public_key', existing.public_key)
      .eq('encrypted_private_key', existing.encrypted_private_key)
      .eq('iv', existing.iv)
      .eq('auth_tag', existing.auth_tag)
      .eq('encryption_version', 1)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Failed to upgradeWalletEncryption: ${error.message}`);
    return !!data;
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

  async createWithdrawalAttempt(data: { user_id: number; amount_sol: number; destination_address: string; status: string; idempotency_key: string; expected_lamports?: string }): Promise<string> {
    const { data: record, error } = await this.db.from('withdrawal_attempts').insert(data).select('id').single();
    if (error) {
      if (error.code === '23505') { // unique violation
        throw new Error('Withdrawal sedang diproses atau sudah pernah dikirim.');
      }
      throw new Error(`Failed to create withdrawal attempt: ${error.message}`);
    }
    return record.id;
  }

  async atomicCreateWithdrawal(data: { user_id: number; amount_sol: number; destination_address: string; idempotency_key: string; spendable_sol: number }): Promise<string> {
    const { data: record, error } = await this.db.rpc('atomic_create_withdrawal', {
      p_user_id: data.user_id,
      p_amount_sol: data.amount_sol,
      p_destination_address: data.destination_address,
      p_idempotency_key: data.idempotency_key,
      p_spendable_sol: data.spendable_sol
    });
    if (error) {
      if (error.message.includes('Withdrawal sedang diproses') || error.message.includes('Saldo spendable tidak mencukupi')) {
        throw new Error(error.message);
      }
      throw new Error(`Failed to atomically create withdrawal: ${error.message}`);
    }
    return record;
  }

  async getWithdrawalAttemptById(id: string): Promise<any> {
    const { data, error } = await this.db.from('withdrawal_attempts').select('*').eq('id', id).single();
    if (error) return null;
    return data;
  }

  async updateWithdrawalAttempt(id: string, updates: { status?: string; tx_signature?: string; expected_lamports?: string }): Promise<void> {
    const { error } = await this.db.from('withdrawal_attempts').update(updates).eq('id', id);
    if (error) {
      throw new Error(`Failed to update withdrawal attempt: ${error.message}`);
    }
  }

  async cancelAuthorizedWithdrawal(id: string, userId: number): Promise<boolean> {
    const { data, error } = await this.db
      .from('withdrawal_attempts')
      .update({ status: 'CANCELLED' })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'AUTHORIZED')
      .select('id')
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to cancel withdrawal attempt: ${error.message}`);
    }
    return !!data;
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
      .in('status', [
        'CREATED', 'AUTHORIZED', 'CLAIMED', 'SIGNED', 'SUBMITTED',
        'CONFIRMING', 'TX_CONFIRMED', 'RECONCILING', 'PENDING', 'NEEDS_ATTENTION',
        'UNKNOWN', 'EXPIRED'
      ]);
    if (error) {
      throw new Error(`Database error on getPendingWithdrawals: ${error.message}`);
    }
    return data;
  }
}
