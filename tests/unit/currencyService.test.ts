import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CurrencyService } from '../../src/utils/currencyService';

const okResponse = (rates: any[] = [
  { symbol: 'SOLUSDT', price: '180' },
  { symbol: 'USDTIDR', price: '16666.6666666667' },
]) => ({
  ok: true,
  status: 200,
  json: async () => rates,
});

describe('CurrencyService (tanpa fallback palsu)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mengembalikan null sebelum ada fetch sukses (tidak ada nilai bawaan)', () => {
    const svc = new CurrencyService();
    expect(svc.getUsdPerSol()).toBeNull();
    expect(svc.getIdrPerSol()).toBeNull();
    expect(svc.solToIdr(1)).toBeNull();
    expect(svc.formatIdr(null)).toBe('N/A');
    expect(svc.formatUsd(null)).toBe('N/A');
  });

  it('tetap null (tidak melempar) bila Binance gagal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const svc = new CurrencyService();
    await expect(svc.fetchRates()).resolves.toBeUndefined();
    expect(svc.getUsdPerSol()).toBeNull();
  });

  it('mengembalikan kurs nyata setelah fetch sukses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const svc = new CurrencyService();
    await svc.fetchRates();
    expect(svc.getUsdPerSol()).toBe(180);
    expect(svc.getIdrPerSol()).toBeCloseTo(3_000_000, 6);
    expect(svc.solToUsd(2)).toBe(360);
    expect(svc.solToIdr(0.5)).toBeCloseTo(1_500_000, 6);
  });

  it('menolak respons rusak/nol (tidak menyimpan nilai tak valid)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([
      { symbol: 'SOLUSDT', price: '0' },
      { symbol: 'USDTIDR', price: '0' },
    ])));
    const svc = new CurrencyService();
    await svc.fetchRates();
    expect(svc.getUsdPerSol()).toBeNull();
  });

  it('kurs basi (melewati batas stale) kembali menjadi null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
    const svc = new CurrencyService();
    await svc.fetchRates();
    expect(svc.getUsdPerSol()).toBe(180);

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z')); // +60 menit > 30 menit
    expect(svc.getUsdPerSol()).toBeNull();
    expect(svc.solToIdr(1)).toBeNull();
  });
});
