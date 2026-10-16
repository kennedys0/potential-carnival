import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CurrencyService } from '../../src/utils/currencyService';

// Mock meniru sumber kurs baru (patch 2026-10-14): SOL/USD dari DexScreener,
// USD/IDR dari open.er-api.com. fetch dipanggil 2x (Promise.all), jadi mock
// memilih respons berdasarkan URL.
const dexScreenerOk = (priceUsd: string = '180') => ({
  ok: true,
  status: 200,
  json: async () => ({ pairs: [{ priceUsd }] }),
});
const erApiOk = (idr: string = '16666.6666666667') => ({
  ok: true,
  status: 200,
  json: async () => ({ rates: { IDR: idr } }),
});
const okFetch = (priceUsd = '180', idr = '16666.6666666667') =>
  vi.fn().mockImplementation((url: string) =>
    String(url).includes('dexscreener.com')
      ? Promise.resolve(dexScreenerOk(priceUsd))
      : Promise.resolve(erApiOk(idr)));

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

  it('tetap null (tidak melempar) bila fetch gagal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const svc = new CurrencyService();
    await expect(svc.fetchRates()).resolves.toBeUndefined();
    expect(svc.getUsdPerSol()).toBeNull();
  });

  it('mengembalikan kurs nyata setelah fetch sukses', async () => {
    vi.stubGlobal('fetch', okFetch());
    const svc = new CurrencyService();
    await svc.fetchRates();
    expect(svc.getUsdPerSol()).toBe(180);
    expect(svc.getIdrPerSol()).toBeCloseTo(3_000_000, 6);
    expect(svc.solToUsd(2)).toBe(360);
    expect(svc.solToIdr(0.5)).toBeCloseTo(1_500_000, 6);
  });

  it('menolak respons rusak/nol (tidak menyimpan nilai tak valid)', async () => {
    vi.stubGlobal('fetch', okFetch('0', '0'));
    const svc = new CurrencyService();
    await svc.fetchRates();
    expect(svc.getUsdPerSol()).toBeNull();
  });

  it('kurs basi (melewati batas stale) kembali menjadi null', async () => {
    vi.stubGlobal('fetch', okFetch());
    const svc = new CurrencyService();
    await svc.fetchRates();
    expect(svc.getUsdPerSol()).toBe(180);

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z')); // +60 menit > 30 menit
    expect(svc.getUsdPerSol()).toBeNull();
    expect(svc.solToIdr(1)).toBeNull();
  });
});
