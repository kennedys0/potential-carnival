/** Pure helpers: exact SOL-to-lamport conversion and position policy snapshots. */
export function solToLamports(amount: number | string): bigint {
  const value = String(amount);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) {
    throw new Error('Invalid SOL amount: must be a positive decimal with <=9 places');
  }
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (result <= 0n || result > 1_000_000_000_000n) {
    throw new Error('SOL amount exceeds safe transaction range');
  }
  return result;
}

export interface ExitPolicySnapshot extends Record<string, unknown> {
  enabled: boolean;
  tp1_percent: number;
  tp2_percent: number;
  sl_percent: number;
  trailing_stop_enabled: boolean;
  trailing_stop_percent: number;
  trailing_activation_percent: number;
}

export function sniperExitPolicy(config: {
  tp_sl_enabled: boolean;
  take_profit_percent: number;
  stop_loss_percent: number;
}): ExitPolicySnapshot {
  const tp = Number(config.take_profit_percent);
  const sl = Number(config.stop_loss_percent);
  if (!(tp > 0 && tp <= 1000 && sl > 0 && sl <= 100)) {
    throw new Error('Invalid sniper TP/SL configuration');
  }
  return {
    enabled: config.tp_sl_enabled === true,
    tp1_percent: tp,
    tp2_percent: tp,
    sl_percent: sl,
    trailing_stop_enabled: false,
    trailing_stop_percent: 0,
    trailing_activation_percent: 0,
  };
}

export function evaluatePoolAge(createdAtMs: number | null, nowMs: number,
  minAgeSeconds: number, maxAgeMinutes: number): 'READY' | 'TOO_YOUNG' | 'TOO_OLD' | 'UNKNOWN' {
  if (!Number.isFinite(createdAtMs) || createdAtMs === null || createdAtMs <= 0) return 'UNKNOWN';
  const age = nowMs - createdAtMs;
  if (age < 0) return 'UNKNOWN';
  if (age < minAgeSeconds * 1000) return 'TOO_YOUNG';
  if (age > maxAgeMinutes * 60_000) return 'TOO_OLD';
  return 'READY';
}

export function failClosedSniperSafety(
  security: { isHardBlocked: boolean; hardBlockReasons: string[]; report?: Array<{ name: string; value: string }> },
  requireKnownCritical: boolean
): string | null {
  if (security.isHardBlocked || security.hardBlockReasons.length) {
    return security.hardBlockReasons.join('; ') || 'Critical security veto';
  }
  if (requireKnownCritical) {
    const required = ['Mint Authority', 'Freeze Authority', 'Dangerous Extensions', 'Sell Simulation', 'Liquidity'];
    for (const name of required) {
      const result = security.report?.find(r => r.name === name);
      if (!result || result.value === 'N/A' || result.value === 'undefined') return `${name} is unverified`;
    }
  }
  return null;
}
