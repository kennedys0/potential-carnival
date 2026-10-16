import { logger } from './logger';
import { appSettings } from '../config/settings';

/**
 * Kurs SOL/USD/IDR.
 * Binance diblokir dari lokasi egress proxy (HTTP 451 restricted location),
 * jadi pakai: SOL/USD dari DexScreener, USD/IDR dari open.er-api.com (gratis).
 * ATURAN: tidak ada nilai fallback/hardcode. Jika belum ada data segar, semua getter mengembalikan `null`
 * dan pemanggil WAJIB menampilkan "N/A" (tampilan) atau menolak aksi (trading).
 */
export class CurrencyService {
  private idrPerUsd: number | null = null;
  private idrPerSol: number | null = null;
  private usdPerSol: number | null = null;
  private lastSuccessAt = 0;
  private lastAttemptAt = 0;

  private static valid(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
  }

  async fetchRates(): Promise<void> {
    const now = Date.now();
    if (this.lastSuccessAt !== 0 && now - this.lastSuccessAt < appSettings.CURRENCY_CACHE_TTL_MS) {
      return; // cache masih segar
    }
    if (this.lastAttemptAt !== 0 && now - this.lastAttemptAt < appSettings.CURRENCY_RETRY_MS && this.lastSuccessAt === 0) {
      return; // baru saja gagal; jangan menahan UI dengan retry beruntun
    }
    this.lastAttemptAt = now;

    try {
      // Binance mengembalikan 451 (restricted location) lewat egress proxy.
      // Alternatif: SOL/USD dari DexScreener, USD/IDR dari open.er-api.com.
      const timeoutMs = appSettings.CURRENCY_FETCH_TIMEOUT_MS;
      const [solRes, idrRes] = await Promise.all([
        fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
          signal: AbortSignal.timeout(timeoutMs),
        }),
        fetch('https://open.er-api.com/v6/latest/USD', {
          signal: AbortSignal.timeout(timeoutMs),
        }),
      ]);
      if (!solRes.ok) {
        throw new Error(`DexScreener returned status: ${solRes.status}`);
      }
      if (!idrRes.ok) {
        throw new Error(`er-api returned status: ${idrRes.status}`);
      }
      const solData = (await solRes.json()) as any;
      const idrData = (await idrRes.json()) as any;

      const usdSol = solData?.pairs?.[0]?.priceUsd ? parseFloat(solData.pairs[0].priceUsd) : null;
      const idrUsd = idrData?.rates?.IDR ? parseFloat(idrData.rates.IDR) : null;

      if (!CurrencyService.valid(usdSol) || !CurrencyService.valid(idrUsd)) {
        throw new Error('Rate response missing/invalid fields');
      }

      const idrSol = usdSol * idrUsd;

      this.idrPerSol = idrSol;
      this.usdPerSol = usdSol;
      this.idrPerUsd = idrUsd;
      this.lastSuccessAt = now;
      logger.info({ idrPerUsd: idrUsd, idrPerSol: idrSol, usdPerSol: usdSol }, 'Currency rates updated (DexScreener + er-api)');
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch currency rates');
    }
  }

  private isFresh(): boolean {
    return this.lastSuccessAt !== 0 && Date.now() - this.lastSuccessAt <= appSettings.CURRENCY_MAX_STALE_MS;
  }

  getIdrPerUsd(): number | null {
    return this.isFresh() ? this.idrPerUsd : null;
  }

  getIdrPerSol(): number | null {
    return this.isFresh() ? this.idrPerSol : null;
  }

  getUsdPerSol(): number | null {
    return this.isFresh() ? this.usdPerSol : null;
  }

  solToIdr(sol: number): number | null {
    const rate = this.getIdrPerSol();
    return rate === null ? null : sol * rate;
  }

  solToUsd(sol: number): number | null {
    const rate = this.getUsdPerSol();
    return rate === null ? null : sol * rate;
  }

  formatIdr(amount: number | null): string {
    if (amount === null || !Number.isFinite(amount)) return 'N/A';
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  }

  formatUsd(amount: number | null): string {
    if (amount === null || !Number.isFinite(amount)) return 'N/A';
    return `$${amount.toFixed(2)}`;
  }
}

export const currencyService = new CurrencyService();
