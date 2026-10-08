import { logger } from '../../utils/logger';
import { ScannerService } from './scannerService';
import { AutopilotEngine } from '../autopilot/autopilotEngine';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { SniperRepository } from '../../database/repositories/sniperRepository';
import { UserStateService } from '../user/userStateService';
import { getRedisConnection } from '../../queue/connection';
import { liveFeedSubscribers } from './liveFeedState';

export class SniperScanner {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly scannerService: ScannerService,
    private readonly autopilotEngine: AutopilotEngine,
    private readonly securityService: SecurityFilterService,
    private readonly analyzerService: AnalyzerService,
    private readonly sniperRepo: SniperRepository,
    private readonly userStateService: UserStateService,
    private readonly botApi: any
  ) {}

  start() {
    if (this.intervalId) return;
    logger.info('Starting SniperScanner for Autopilot...');
    // Scan every 1 minute for new pairs (faster than trending)
    this.intervalId = setInterval(() => this.scanSniper(), 1 * 60 * 1000);
    // Trigger first scan after 15 seconds
    setTimeout(() => this.scanSniper(), 15000);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  private async scanSniper() {
    try {
      // 1. Get active autopilot users
      const activeConfigs = await this.sniperRepo.getAllActiveConfigs();
      if (!activeConfigs || activeConfigs.length === 0) {
        return;
      }

      logger.info(`SniperScanner: Fetching new token profiles...`);

      // 2. Fetch new tokens
      const newProfiles = await this.scannerService.fetchNewPairs();
      const redis = getRedisConnection();

      const newTokens: typeof newProfiles = [];
      for (const t of newProfiles) {
        const isScanned = await redis.get(`scanned_token_sniper:${t.tokenAddress}`);
        if (!isScanned) {
          newTokens.push(t);
        }
      }
      
      const tokensToScan = newTokens.slice(0, 15);
      if (tokensToScan.length === 0) return;
      
      logger.info(`SniperScanner: Found ${tokensToScan.length} NEW unseen token profiles.`);

      // Ambil profile/pair DexScreener secara concurrent
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
        
        if (i + chunkSize < tokensToScan.length) {
          await new Promise((res) => setTimeout(res, 500));
        }
      }

      // Sort by pairCreatedAt (newest first) instead of volume, because it's sniper
      const sortedPairs = fetchedPairs.sort((a: any, b: any) => {
        const timeA = a.pairCreatedAt ?? 0;
        const timeB = b.pairCreatedAt ?? 0;
        return timeB - timeA;
      });

      const topPairs = sortedPairs.slice(0, 5);
      
      for (const pair of topPairs) {
        try {
          const tokenAddress = pair.baseToken.address;
          await redis.set(`scanned_token_sniper:${tokenAddress}`, '1', 'EX', 60 * 60); // 1 hour cache
          
          const priceUsd = parseFloat(pair.priceUsd || '0');
          if (priceUsd === 0) continue;

          const security = await this.securityService.evaluateToken(tokenAddress, {
            liquidityUsd: pair.liquidity?.usd || null,
            marketCapUsd: pair.marketCap || pair.fdv || null,
          });

          // Fetch candles (might be empty for very new pairs)
          const candles = await this.scannerService.getCandles('solana', pair.pairAddress, 'minute', 1);
          const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map(c => c.volume);
          const currentVolume = pair.volume?.m5 || (candles.length > 0 ? candles[candles.length - 1].volume : 0);
          
          const indicators = this.analyzerService.calculateIndicators(candles, priceUsd, currentVolume, pastVolumes);
          let aiAnalysis = null;
          // Only analyze with LLM if indicators exist and LLM is enabled in Sniper mode
          if (indicators) {
            aiAnalysis = await this.analyzerService.analyzeWithLlm(pair.baseToken.symbol, priceUsd, indicators, security.riskFlags);
          }

          // 4. Evaluate for all active users
          for (const config of activeConfigs) {
            try {
              const currentState = await this.userStateService.getAutopilotState(config.user_id);
              
              if (currentState.isCircuitBroken) continue;

              const rawSnapshot = {
                tokenAddress,
                priceUsd,
                liquidityUsd: pair.liquidity?.usd,
                marketCap: pair.marketCap || pair.fdv,
                currentVolume,
                indicators,
                currentState,
                isSniper: true
              };

              // We already know it's enabled because we fetched active configs
              // const safetyParams = config.safety_params as any;
              // if (safetyParams?.enable_sniper === false) continue;
              
              // Sniper risk limit check
              const sniperState = await this.sniperRepo.getState(config.user_id);
              if (sniperState.daily_buys_count >= config.max_buys_per_day) {
                logger.debug(`Sniper limit reached: daily buys for user ${config.user_id}`);
                continue;
              }
              if (Number(sniperState.daily_entry_sol) + config.buy_amount_sol > config.max_daily_entry_budget_sol) {
                logger.debug(`Sniper limit reached: daily budget for user ${config.user_id}`);
                continue;
              }

              // Evaluate Candidate via AutopilotEngine
              // In a full refactor we would have an independent SniperEngine, but the prompt says 
              // "Use the EXISTING verified transaction execution and reconciliation infrastructure." 
              // and "Architecture - TWO STRATEGIES, ONE EXECUTION ENGINE".
              // AutopilotEngine handles standard risk checks. We can override params.

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
                'SNIPER'
              );

              if (result.executed) {
                logger.info(`Sniper executed trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
                
                await this.sniperRepo.incrementState(config.user_id, config.buy_amount_sol);
                
                try {
                  await this.botApi.sendMessage(config.user_id, 
                    `⚡ <b>SNIPER EXECUTION</b> ⚡\n\n` +
                    `Sistem mendeteksi token baru yang aman dan baru saja mengeksekusi <b>BUY</b>!\n\n` +
                    `🎯 <b>Target:</b> <code>${pair.baseToken.symbol}</code>\n` +
                    `📄 <b>CA:</b> <code>${tokenAddress}</code>\n` +
                    `🛡️ <b>Safety:</b> ${security.score}/100\n` +
                    (security.riskFlags.length > 0 ? `⚠️ <b>Flags:</b> ${security.riskFlags.length > 2 ? security.riskFlags.slice(0, 2).join(', ') + ', dll' : security.riskFlags.join(', ')}\n` : '') +
                    `📝 <b>Analisa:</b> <i>${result.reason}</i>\n\n` +
                    `👉 Cek /positions untuk memantau performa.`,
                    { parse_mode: 'HTML' }
                  );
                } catch (e) {
                  // ignore
                }
              } else {
                logger.debug(`Sniper skipped trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
                if (liveFeedSubscribers.has(config.user_id)) {
                  try {
                    await this.botApi.sendMessage(config.user_id, 
                      `⚡ <b>SNIPER RADAR</b>\n` +
                      `├ <b>Token:</b> <code>${pair.baseToken.symbol}</code>\n` +
                      `├ <b>CA:</b> <code>${tokenAddress}</code>\n` +
                      `├ <b>Safety:</b> ${security.score}/100 🛡️\n` +
                      (security.riskFlags.length > 0 ? `├ <b>Flags:</b> ${security.riskFlags.length > 2 ? security.riskFlags.slice(0, 2).join(', ') + ', dll' : security.riskFlags.join(', ')}\n` : '') +
                      `├ <b>Status:</b> ⚪ SKIPPED\n` +
                      `└ <b>Reason:</b> <i>${result.reason}</i>`,
                      { parse_mode: 'HTML' }
                    );
                  } catch (e) {
                    // ignore live feed errors
                  }
                }
              }
            } catch (err) {
              logger.error({ err, userId: config.user_id }, 'Error evaluating sniper candidate for user');
            }
          }
        } catch (err) {
          logger.error({ err }, 'Error evaluating sniper token candidate, skipping to next token');
          continue;
        }

        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (err) {
      logger.error({ err }, 'SniperScanner Error');
    }
  }
}
