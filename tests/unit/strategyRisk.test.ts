import { describe, expect, it } from 'vitest';
import { parseExitPolicy, sniperExitPolicy } from '../../src/modules/autopilot/strategyRisk';

describe('exit policy validation', () => {
  it('fills safe defaults and canonicalizes the legacy trailing distance key', () => {
    expect(parseExitPolicy({
      tp1_percent: 10,
      tp2_percent: 30,
      sl_percent: 8,
      trailing_stop_percent: 7,
    })).toEqual(expect.objectContaining({
      enabled: true,
      tp1_percent: 10,
      tp1_sell_share: 50,
      tp2_percent: 30,
      sl_percent: 8,
      trailing_stop_delta_percent: 7,
    }));
  });

  it('rejects inverted take-profit levels and unsafe stop-loss values', () => {
    expect(() => parseExitPolicy({
      tp1_percent: 50,
      tp2_percent: 20,
      sl_percent: 8,
    })).toThrow(/tp2_percent/);
    expect(() => parseExitPolicy({
      tp1_percent: 10,
      tp2_percent: 20,
      sl_percent: -1,
    })).toThrow(/sl_percent/);
  });

  it('rejects stringly typed numeric policy data instead of coercing it', () => {
    expect(() => parseExitPolicy({
      tp1_percent: '15',
      tp2_percent: 30,
      sl_percent: 8,
    })).toThrow(/tp1_percent/);
  });

  it('produces a fully validated single-target sniper policy', () => {
    expect(sniperExitPolicy({
      tp_sl_enabled: true,
      take_profit_percent: 25,
      stop_loss_percent: 10,
    })).toEqual({
      enabled: true,
      tp1_percent: 25,
      tp2_percent: 25,
      sl_percent: 10,
      trailing_stop_enabled: false,
      trailing_stop_percent: 0,
      trailing_activation_percent: 0,
    });
  });
});
