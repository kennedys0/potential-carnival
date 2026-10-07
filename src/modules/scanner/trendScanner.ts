import { logger } from '../../utils/logger';
import { ScannerService } from './scannerService';
import { AutopilotEngine } from '../autopilot/autopilotEngine';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { UserStateService } from '../user/userStateService';

export const liveFeedSubscribers = new Set<number>();

// Cache to remember scanned tokens and prevent scanning the same token repeatedly
const scannedTokensCache = new Map<string, number>();

export class TrendScanner {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly scannerService: ScannerService,
    private readonly autopilotEngine: AutopilotEngine,
    private readonly securityService: SecurityFilterService,
    private readonly analyzerService: AnalyzerService,
    private readonly autopilotRepo: AutopilotRepository,
    private readonly userStateService: UserStateService
  ) {}

  start() {
    if (this.intervalId) return;
    logger.info('Starting TrendScanner for Autopilot...');
    // Scan every 2 minutes
    this.intervalId = setInterval(() => this.scanTrending(), 2 * 60 * 1000);
    // Trigger first scan after 10 seconds
    setTimeout(() => this.scanTrending(), 10000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async scanTrending() {
    try {
      // 1. Get active autopilot users
      const activeConfigs = await this.autopilotRepo.getAllActiveConfigs();
      if (!activeConfigs || activeConfigs.length === 0) {
        logger.info('TrendScanner: No active autopilot users, skipping scan.');
        return;
      }

      logger.info(`TrendScanner: Fetching trending tokens for ${activeConfigs.length} active users...`);

      // 2. Fetch latest boosted/trending tokens from DexScreener
      const response = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
      if (!response.ok) throw new Error('Failed to fetch from DexScreener Token Boosts');
      
      const tokens = (await response.json()) as any[];
      const now = Date.now();
      // Cleanup cache (older than 15 minutes)
      for (const [address, timestamp] of scannedTokensCache.entries()) {
        if (now - timestamp > 15 * 60 * 1000) {
          scannedTokensCache.delete(address);
        }
      }

      const solanaTokens = tokens.filter((t: any) => t.chainId === 'solana' && !scannedTokensCache.has(t.tokenAddress));
      
      // Ambil top 15 token trending untuk di-scan ringan
      const tokensToScan = solanaTokens.slice(0, 15);
      logger.info(`TrendScanner: Fetching profiles for ${tokensToScan.length} NEW trending Solana tokens.`);

      // Ambil profile/pair DexScreener secara concurrent max 3 sekaligus (Chunking manual)
      const fetchedPairs = [];
      const chunkSize = 3;
      for (let i = 0; i < tokensToScan.length; i += chunkSize) {
        const chunk = tokensToScan.slice(i, i + chunkSize);
        const chunkPromises = chunk.map(async (t) => {
          try {
            return await this.scannerService.scanTokenByAddress(t.tokenAddress);
          } catch (e) {
            return null;
          }
        });
        const results = await Promise.all(chunkPromises);
        fetchedPairs.push(...results.filter((p) => p !== null));
        
        // Kasih nafas ke API DexScreener
        if (i + chunkSize < tokensToScan.length) {
          await new Promise((res) => setTimeout(res, 500));
        }
      }

      // Sort by 24h volume (highest first)
      const sortedPairs = fetchedPairs.sort((a: any, b: any) => {
        const volA = a.volume?.h24 || 0;
        const volB = b.volume?.h24 || 0;
        return volB - volA;
      });

      // Ambil top 3 pair paling likuid/bervolume tinggi untuk analisis mendalam (RPC calls)
      const topPairs = sortedPairs.slice(0, 3);
      logger.info(`TrendScanner: Selected top ${topPairs.length} pairs by volume for deep analysis.`);

      for (const pair of topPairs) {
        const tokenAddress = pair.baseToken.address;
        scannedTokensCache.set(tokenAddress, now);
        
        const priceUsd = parseFloat(pair.priceUsd || '0');
        if (priceUsd === 0) continue;

        const security = await this.securityService.evaluateToken(tokenAddress, {
          liquidityUsd: pair.liquidity?.usd || null,
          marketCapUsd: pair.marketCap || pair.fdv || null,
        });

        const candles = await this.scannerService.getCandles('solana', pair.pairAddress, 'minute', 5);
        const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map(c => c.volume);
        const currentVolume = pair.volume?.m5 || (candles.length > 0 ? candles[candles.length - 1].volume : 0);
        
        const indicators = this.analyzerService.calculateIndicators(candles, priceUsd, currentVolume, pastVolumes);
        let aiAnalysis = null;
        if (indicators) {
          aiAnalysis = await this.analyzerService.analyzeWithLlm(pair.baseToken.symbol, priceUsd, indicators, security.riskFlags);
        }

        // 4. Evaluate for all active users
        for (const config of activeConfigs) {
          try {
            const currentState = await this.userStateService.getAutopilotState(config.user_id);
            
            // Circuit Breaker Check
            if (currentState.isCircuitBroken) {
              logger.debug(`Autopilot circuit broken for user ${config.user_id}, skipping.`);
              continue;
            }

            const rawSnapshot = {
              tokenAddress,
              priceUsd,
              liquidityUsd: pair.liquidity?.usd,
              marketCap: pair.marketCap || pair.fdv,
              currentVolume,
              indicators,
              currentState
            };

            const result = await this.autopilotEngine.processCandidate(
              config.user_id,
              tokenAddress,
              pair.baseToken.symbol,
              priceUsd,
              pair.liquidity?.usd || 0,
              security,
              aiAnalysis,
              currentState,
              rawSnapshot
            );

            if (result.executed) {
              logger.info(`Autopilot executed trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
              
              // Notify user
              try {
                const grammy = await import('grammy');
                const envMod = await import('../../config/env.js');
                const botToken = envMod.getEnv().TELEGRAM_BOT_TOKEN;
                const bot = new grammy.Bot(botToken);
                await bot.api.sendMessage(config.user_id, 
                  `🤖 <b>Autopilot Alert!</b>\n\n` +
                  `Sistem baru saja mengeksekusi order <b>BUY</b> untuk token <b>${pair.baseToken.symbol}</b> secara otomatis!\n` +
                  `Alasan: ${result.reason}\n\n` +
                  `Cek /positions untuk melihat performa posisimu sekarang.`,
                  { parse_mode: 'HTML' }
                );
              } catch (e) {
                logger.error({ err: e }, 'Gagal mengirim notifikasi Autopilot ke user');
              }
            } else {
              logger.debug(`Autopilot skipped trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
              if (liveFeedSubscribers.has(config.user_id)) {
                try {
                  const grammy = await import('grammy');
                  const envMod = await import('../../config/env.js');
                  const botToken = envMod.getEnv().TELEGRAM_BOT_TOKEN;
                  const bot = new grammy.Bot(botToken);
                  await bot.api.sendMessage(config.user_id, 
                    `🔍 <b>[Live Feed]</b> Token <b>${pair.baseToken.symbol}</b> di-skip.\n` +
                    `Alasan: ${result.reason}`,
                    { parse_mode: 'HTML' }
                  );
                } catch (e) {
                  // ignore live feed errors
                }
              }
            }
          } catch (err) {
            logger.error({ err, userId: config.user_id }, 'Error evaluating candidate for user');
          }
        } // end loop over users

        // Jeda minimal antar koin agar RPC tidak di-spam beruntun
        await new Promise((res) => setTimeout(res, 2000));
      } // end loop over pairs
      
      // Notify live feed subscribers that a cycle finished
      for (const userId of liveFeedSubscribers) {
        try {
          const grammy = await import('grammy');
          const envMod = await import('../../config/env.js');
          const botToken = envMod.getEnv().TELEGRAM_BOT_TOKEN;
          const bot = new grammy.Bot(botToken);
          await bot.api.sendMessage(userId, `✅ <b>[Live Feed]</b> Selesai memindai ${topPairs.length} token trending. Siklus berikutnya dalam 2 menit.`, { parse_mode: 'HTML' });
        } catch (e) {
          // ignore
        }
      }
    } catch (err) {
      logger.error({ err }, 'TrendScanner Error');
    }
  }
}
