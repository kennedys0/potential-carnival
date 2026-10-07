import { logger } from './logger';
import { appSettings } from '../config/settings';

/**
 * Kurs SOL/USD/IDR dari CoinGecko.
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
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana,tether&vs_currencies=idr,usd',
        { signal: AbortSignal.timeout(appSettings.CURRENCY_FETCH_TIMEOUT_MS) },
      );
      if (!response.ok) {
        throw new Error(`CoinGecko returned status: ${response.status}`);
      }
      const data = (await response.json()) as any;

      const idrSol = data?.solana?.idr;
      const usdSol = data?.solana?.usd;
      const idrUsd = data?.tether?.idr;
      if (!CurrencyService.valid(idrSol) || !CurrencyService.valid(usdSol) || !CurrencyService.valid(idrUsd)) {
        throw new Error('CoinGecko response missing/invalid rate fields');
      }

      this.idrPerSol = idrSol;
      this.usdPerSol = usdSol;
      this.idrPerUsd = idrUsd;
      this.lastSuccessAt = now;
      logger.info({ idrPerUsd: idrUsd, idrPerSol: idrSol, usdPerSol: usdSol }, 'Currency rates updated from CoinGecko');
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch currency rates from CoinGecko');
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
