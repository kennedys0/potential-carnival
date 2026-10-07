import { logger } from './logger';

class CurrencyService {
  private idrPerUsd: number = 0;
  private idrPerSol: number = 0;
  private usdPerSol: number = 0;
  private lastFetchTime: number = 0;
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

  async fetchRates(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetchTime < this.CACHE_DURATION_MS && this.lastFetchTime !== 0) {
      return; // Use cached values
    }

    try {
      // Fetch SOL and USD to IDR from CoinGecko
      // Using solana and tether as proxies
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,tether&vs_currencies=idr,usd');
      if (!response.ok) {
        throw new Error(`CoinGecko returned status: ${response.status}`);
      }
      
      const data = (await response.json()) as any;
      
      if (data.solana && data.solana.idr) {
        this.idrPerSol = data.solana.idr;
      }
      if (data.solana && data.solana.usd) {
        this.usdPerSol = data.solana.usd;
      }
      if (data.tether && data.tether.idr) {
        this.idrPerUsd = data.tether.idr;
      }

      this.lastFetchTime = now;
      logger.info({ idrPerUsd: this.idrPerUsd, idrPerSol: this.idrPerSol }, 'Currency rates updated from CoinGecko');
    } catch (err: any) {
      logger.error({ err }, 'Failed to fetch currency rates from CoinGecko');
      // If we don't have a cache at all (still 0), we don't fallback to magic numbers
      if (this.idrPerUsd === 0) {
        logger.warn('Currency service could not initialize on first run. Will retry on next call.');
      }
    }
  }

  formatIdr(amount: number): string {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  }

  private assertInitialized() {
    if (this.idrPerUsd === 0 || this.idrPerSol === 0 || this.usdPerSol === 0) {
      throw new Error('Currency rates not yet initialized. CoinGecko API might be down.');
    }
  }

  getIdrPerUsd(): number {
    this.assertInitialized();
    return this.idrPerUsd;
  }

  getIdrPerSol(): number {
    this.assertInitialized();
    return this.idrPerSol;
  }

  getUsdPerSol(): number {
    this.assertInitialized();
    return this.usdPerSol;
  }
}

export const currencyService = new CurrencyService();
