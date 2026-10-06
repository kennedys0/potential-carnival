import { SupabaseClient } from '@supabase/supabase-js';

export interface UserRecord {
  telegram_id: number;
  username: string | null;
  role: 'user' | 'admin';
  is_whitelisted: boolean;
  created_at?: string;
  updated_at?: string;
}

export class UserRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getOrCreateUser(telegramId: number, username?: string): Promise<UserRecord> {
    const { data, error } = await this.db
      .from('users')
      .upsert(
        {
          telegram_id: telegramId,
          username: username || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'telegram_id' }
      )
      .select()
      .single();

    if (error) throw new Error(`Failed to getOrCreateUser: ${error.message}`);
    return data as UserRecord;
  }

  async getUser(telegramId: number): Promise<UserRecord | null> {
    const { data, error } = await this.db
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (error) return null;
    return data as UserRecord;
  }
}
