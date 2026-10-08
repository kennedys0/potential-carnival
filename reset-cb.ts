import { getSupabaseClient } from './src/database/client';

async function resetCb() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('autopilot_states').update({ is_circuit_broken: false, circuit_break_reason: null }).neq('user_id', 0);
  if (error) {
    console.error('Error resetting:', error);
  } else {
    console.log('Circuit breaker states reset in Supabase.');
  }
}

resetCb().then(() => process.exit(0));
