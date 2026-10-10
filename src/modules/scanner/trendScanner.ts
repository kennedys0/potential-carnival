import { logger } from '../../utils/logger';
import { ScannerService } from './scannerService';
import { AutopilotEngine } from '../autopilot/autopilotEngine';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { UserStateService } from '../user/userStateService';
import { getRedisConnection } from '../../queue/connection';
import { liveFeedSubscribers } from './liveFeedState';
import { escapeHtml } from '../telegram/formatters/messageFormatter';

export class TrendScanner {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly scannerService: ScannerService,
    private readonly autopilotEngine: AutopilotEngine,
    private readonly securityService: SecurityFilterService,
    private readonly analyzerService: AnalyzerService,
    private readonly autopilotRepo: AutopilotRepository,
    private readonly userStateService: UserStateService,
    private readonly botApi: any
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

  private async fetchOrganicTrendingTokens(): Promise<{ tokenAddress: string; pairAddress: string; symbol: string }[]> {
    // Primary source: GeckoTerminal — organic trending pools sorted by volume (no paid promotions)
    try {
      const url = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&page=1';
      const res = await fetch(url, { headers: { 'Accept': 'application/json;version=20230302' } });
      if (!res.ok) throw new Error(`GeckoTerminal responded ${res.status}`);
      const data: any = await res.json();
      const pools: any[] = data?.data ?? [];
      const included: any[] = data?.included ?? [];
      
      const result: { tokenAddress: string; pairAddress: string; symbol: string }[] = [];
      for (const pool of pools) {
        const poolAddr = pool.attributes?.address;
        const relBaseToken = pool.relationships?.base_token?.data;
        if (!poolAddr || !relBaseToken) continue;
        const baseToken = included.find((i: any) => i.type === relBaseToken.type && i.id === relBaseToken.id);
        const tokenAddress = baseToken?.attributes?.address ?? relBaseToken.id?.split('_')[1];
        const symbol = baseToken?.attributes?.symbol ?? '???';
        if (!tokenAddress) continue;
        result.push({ tokenAddress, pairAddress: poolAddr, symbol });
      }
      logger.info(`TrendScanner: GeckoTerminal returned ${result.length} organic trending tokens.`);
      return result;
    } catch (err) {
      logger.warn({ err }, 'TrendScanner: GeckoTerminal trending failed');
      return [];
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

      // Discovery is organic-only. Paid boosts/profiles must never enter an auto-buy pipeline.
      const combinedList = await this.fetchOrganicTrendingTokens();
      
      // Deduplicate by token address
      const uniqueTokensMap = new Map<string, typeof combinedList[0]>();
      for (const t of combinedList) {
        if (!uniqueTokensMap.has(t.tokenAddress)) {
          uniqueTokensMap.set(t.tokenAddress, t);
        }
      }
      const trendingList = Array.from(uniqueTokensMap.values());
      logger.info(`TrendScanner: Loaded ${trendingList.length} unique organic GeckoTerminal tokens.`);
      
      const redis = getRedisConnection();

      const newTokens: typeof trendingList = [];
      for (const t of trendingList) {
        const isScanned = await redis.get(`scanned_token:${t.tokenAddress}`);
        if (!isScanned) {
          newTokens.push(t);
        }
      }
      
      // Ambil top 30 token trending untuk di-scan ringan
      const tokensToScan = newTokens.slice(0, 30);
      logger.info(`TrendScanner: Fetching profiles for ${tokensToScan.length} NEW multi-source trending Solana tokens.`);

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
        const volA = a.volume?.h24 ?? 0;
        const volB = b.volume?.h24 ?? 0;
        return volB - volA;
      });

      // Ambil top 10 pair paling likuid/bervolume tinggi untuk analisis mendalam (RPC calls)
      const topPairs = sortedPairs.slice(0, 10);
      logger.info(`TrendScanner: Selected top ${topPairs.length} pairs by volume for deep analysis.`);

      for (const pair of topPairs) {
        try {
          const tokenAddress = pair.baseToken.address;
          await redis.set(`scanned_token:${tokenAddress}`, '1', 'EX', 15 * 60);
          
          const priceUsd = parseFloat(pair.priceUsd || '0');
          if (priceUsd === 0) continue;

          const security = await this.securityService.evaluateToken(tokenAddress, {
            liquidityUsd: pair.liquidity?.usd || null,
            marketCapUsd: pair.marketCap || pair.fdv || null,
          });

          const candles = await this.scannerService.getCandles('solana', pair.pairAddress, 'minute', 5);
          const macroCandles = await this.scannerService.getCandles('solana', pair.pairAddress, 'minute', 15);
          const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map(c => c.volume);
          const currentVolume = pair.volume?.m5 || (candles.length > 0 ? candles[candles.length - 1].volume : 0);
          
          const indicators = this.analyzerService.calculateIndicators(candles, priceUsd, currentVolume, pastVolumes, macroCandles);
          let aiAnalysis = null;
          if (indicators) {
            aiAnalysis = await this.analyzerService.analyzeWithLlm(pair.baseToken.symbol, priceUsd, indicators, security.riskFlags);
          }

          // 4. Evaluate for all active users
          for (const config of activeConfigs) {
            try {
              const currentState = await this.userStateService.getAutopilotState(config.user_id);
              
              // Circuit Breaker Check
              if (await this.userStateService.checkCircuitBreaker(config.user_id, currentState)) {
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

              const safetyParams = config.safety_params as any;
              if (safetyParams?.enable_trending === false) continue;

              const result = await this.autopilotEngine.processCandidate(
                config.user_id,
                tokenAddress,
                pair.baseToken.symbol,
                priceUsd,
                pair.liquidity?.usd ?? 0,
                security,
                aiAnalysis,
                currentState,
                rawSnapshot,
                'TRENDING'
              );

              if (result.executed) {
                logger.info(`Autopilot executed trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
                
                // Notify user
                try {
                  await this.botApi.sendMessage(config.user_id, 
                    `🚨 <b>AUTOPILOT EXECUTION</b> 🚨\n\n` +
                    `Sistem mendeteksi setup yang valid dan baru saja mengeksekusi <b>BUY</b>!\n\n` +
                    `🎯 <b>Target:</b> <code>${escapeHtml(pair.baseToken.symbol)}</code>\n` +
                    `📄 <b>CA:</b> <code>${tokenAddress}</code>\n` +
                    `🛡️ <b>Safety:</b> ${security.score}/100\n` +
                    (security.riskFlags.length > 0 ? `⚠️ <b>Flags:</b> ${security.riskFlags.length > 2 ? security.riskFlags.slice(0, 2).map(escapeHtml).join(', ') + ', dll' : security.riskFlags.map(escapeHtml).join(', ')}\n` : '') +
                    `📝 <b>Analisa:</b> <i>${escapeHtml(result.reason)}</i>\n\n` +
                    `👉 Cek /positions untuk memantau performa.`,
                    { parse_mode: 'HTML' }
                  );
                } catch (e) {
                  logger.error({ err: e }, 'Gagal mengirim notifikasi Autopilot ke user');
                }
              } else {
                logger.debug(`Autopilot skipped trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
                if (liveFeedSubscribers.has(config.user_id)) {
                  try {
                    await this.botApi.sendMessage(config.user_id, 
                      `📡 <b>AUTOPILOT RADAR</b>\n` +
                      `├ <b>Token:</b> <code>${escapeHtml(pair.baseToken.symbol)}</code>\n` +
                      `├ <b>CA:</b> <code>${tokenAddress}</code>\n` +
                      `├ <b>Safety:</b> ${security.score}/100 🛡️\n` +
                      (security.riskFlags.length > 0 ? `├ <b>Flags:</b> ${security.riskFlags.length > 2 ? security.riskFlags.slice(0, 2).map(escapeHtml).join(', ') + ', dll' : security.riskFlags.map(escapeHtml).join(', ')}\n` : '') +
                      `├ <b>Status:</b> ⚪ SKIPPED\n` +
                      `└ <b>Reason:</b> <i>${escapeHtml(result.reason)}</i>`,
                      { 
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: '🔍 Scan Token', callback_data: `refresh:${tokenAddress}` }]] }
                      }
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
        } catch (err) {
          logger.error({ err, tokenAddress: pair.baseToken.address }, 'Error evaluating token candidate, skipping to next token');
          continue;
        }

        // Jeda minimal antar koin agar RPC tidak di-spam beruntun
        await new Promise((res) => setTimeout(res, 2000));
      } // end loop over pairs
      
      // Notify live feed subscribers that a cycle finished
      for (const userId of liveFeedSubscribers) {
        try {
          await this.botApi.sendMessage(userId, `🔄 <b>RADAR CYCLE COMPLETE</b>\n└ Memindai <b>${topPairs.length}</b> token teratas. Standby untuk siklus berikutnya...`, { parse_mode: 'HTML' });
        } catch (e) {
          // ignore
        }
      }
    } catch (err) {
      logger.error({ err }, 'TrendScanner Error');
    }
  }
}
