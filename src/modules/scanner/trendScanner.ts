import { logger } from '../../utils/logger';
import { ScannerService } from './scannerService';
import { AutopilotEngine } from '../autopilot/autopilotEngine';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { UserStateService } from '../user/userStateService';
import { getRedisConnection } from '../../queue/connection';
import { liveFeedSubscribers } from './liveFeedState';
import { 
  escapeHtml, 
  formatRadarCandidate, 
  formatRadarCycleDigest, 
  buildRadarCandidateKeyboard 
} from '../telegram/formatters/messageFormatter';
import { appSettings } from '../../config/settings.js';

export interface TelegramBotApi {
  sendMessage: (chatId: number | string, text: string, other?: any) => Promise<any>;
}

export class TrendScanner {
  private intervalId?: NodeJS.Timeout;
  private isScanning = false;

  constructor(
    private readonly scannerService: ScannerService,
    private readonly autopilotEngine: AutopilotEngine,
    private readonly securityService: SecurityFilterService,
    private readonly analyzerService: AnalyzerService,
    private readonly autopilotRepo: AutopilotRepository,
    private readonly userStateService: UserStateService,
    private readonly botApi: TelegramBotApi
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
    const redis = getRedisConnection();
    const cacheKey = 'trending_tokens:geckoterminal';

    // Primary source: GeckoTerminal — organic trending pools sorted by volume (no paid promotions)
    try {
      const url = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&page=1';
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json;version=20230302' },
        signal: AbortSignal.timeout(appSettings.MARKET_DATA_FETCH_TIMEOUT_MS),
      });
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
      if (result.length > 0) {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 180);
      }
      return result;
    } catch (err) {
      logger.warn({ err }, 'TrendScanner: GeckoTerminal trending failed, attempting cache fallback');
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const fallback = JSON.parse(cached);
          logger.info(`TrendScanner: Restored ${fallback.length} trending tokens from cache fallback.`);
          return fallback;
        }
      } catch {
        // ignore cache parse error
      }
      return [];
    }
  }

  private async scanTrending() {
    if (this.isScanning) {
      logger.debug('TrendScanner: previous scan cycle still in progress, skipping overlapping cycle');
      return;
    }
    this.isScanning = true;
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

      // Ambil profile/pair DexScreener via batch query hemat kuota
      const tokenAddresses = tokensToScan.map((t) => t.tokenAddress);
      const pairsMap = await this.scannerService.scanTokensByAddresses(tokenAddresses);
      const fetchedPairs = Array.from(pairsMap.values());



      // Pre-filter: only keep pairs with valid price, minimum liquidity ($1,000), and minimum 24h volume ($500)
      const minLiquidityUsd = 1000;
      const minVolume24h = 500;
      const viablePairs: typeof fetchedPairs = [];

      for (const pair of fetchedPairs) {
        const price = parseFloat(pair.priceUsd || '0');
        const liquidity = Number(pair.liquidity?.usd ?? 0);
        const volume = Number(pair.volume?.h24 ?? 0);

        if (!Number.isFinite(price) || price <= 0 || liquidity < minLiquidityUsd || volume < minVolume24h) {
          // Cache non-viable tokens in Redis for 15 minutes to save batch API quota on subsequent cycles
          if (pair.baseToken?.address) {
            await redis.set(`scanned_token:${pair.baseToken.address}`, '1', 'EX', 15 * 60);
          }
          continue;
        }
        viablePairs.push(pair);
      }

      // Sort by 24h volume (highest first)
      const sortedPairs = viablePairs.sort((a: any, b: any) => {
        const volA = a.volume?.h24 ?? 0;
        const volB = b.volume?.h24 ?? 0;
        return volB - volA;
      });

      // Ambil top 5 pair paling likuid/bervolume tinggi untuk analisis mendalam (RPC calls)
      const topPairs = sortedPairs.slice(0, 5);
      logger.info(`TrendScanner: Selected ${topPairs.length}/${viablePairs.length} viable pairs by volume for deep analysis.`);

      let cyclePassedSafetyCount = 0;
      let cycleExecutedCount = 0;

      // ── Max-positions gate: skip heavy token processing if every user is already full ──
      const redis2 = getRedisConnection(); // redis is already declared later; use alias here
      const configsWithCapacity = await Promise.all(
        activeConfigs.map(async (cfg) => {
          const state = await this.userStateService.getAutopilotState(cfg.user_id);
          const maxPos = Number((cfg.sizing_params as any)?.max_concurrent_positions ?? 3);
          return { cfg, state, maxPos, hasCap: state.trendingPositionsCount < maxPos };
        })
      );

      const usersWithCapacity = configsWithCapacity.filter((x) => x.hasCap);

      // Notify capped users (once per 5 min) and skip the whole scan if none have room
      for (const { cfg, state, maxPos } of configsWithCapacity.filter((x) => !x.hasCap)) {
        if (liveFeedSubscribers.has(cfg.user_id)) {
          const capKey = `trending:cap_notified:${cfg.user_id}`;
          if (!(await redis2.get(capKey))) {
            await redis2.set(capKey, '1', 'EX', 5 * 60);
            try {
              await this.botApi.sendMessage(
                cfg.user_id,
                `⏸ <b>Trending Scanning Dijeda</b>\n\nPosisi aktif sudah mencapai batas maksimal (<b>${state.trendingPositionsCount}/${maxPos}</b>).\n\nScanning akan dilanjutkan kembali setelah salah satu posisi ditutup.`,
                { parse_mode: 'HTML' }
              );
            } catch (_) {}
          }
        }
        logger.debug(`TrendScanner: user ${cfg.user_id} at max trending positions (${state.trendingPositionsCount}/${maxPos}), skipping cycle`);
      }

      if (usersWithCapacity.length === 0) {
        logger.info('TrendScanner: all active users at max positions — skipping scan cycle');
        return;
      }

      // Rebuild activeConfigs to only include users with room for a new position
      const cappedActiveConfigs = usersWithCapacity.map((x) => x.cfg);

      for (const pair of topPairs) {
        try {
          const tokenAddress = pair.baseToken.address;
          await redis.set(`scanned_token:${tokenAddress}`, '1', 'EX', 15 * 60);
          
          const priceUsd = parseFloat(pair.priceUsd || '0');
          if (priceUsd === 0) continue;

          const security = await this.securityService.evaluateToken(tokenAddress, {
            liquidityUsd: pair.liquidity?.usd || null,
            marketCapUsd: pair.marketCap || pair.fdv || null,
            pairAddress: pair.pairAddress,
          });

          if (!security.isHardBlocked && security.score >= 50) {
            cyclePassedSafetyCount++;
          }

          const candles = await this.scannerService.getCandles('solana', pair.pairAddress, 'minute', 5);
          // Resample 5m candles to 15m macro candles mathematically without extra API calls
          const macroCandles = resampleCandles(candles, 3);
          const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map(c => c.volume);
          const currentVolume = pair.volume?.m5 || (candles.length > 0 ? candles[candles.length - 1].volume : 0);
          
          const indicators = this.analyzerService.calculateIndicators(candles, priceUsd, currentVolume, pastVolumes, macroCandles);
          let aiAnalysis = null;
          // Panggil AI hanya jika indikator lengkap dan token lolos filter keamanan dasar
          if (indicators && !security.isHardBlocked && security.score >= 50) {
            aiAnalysis = await this.analyzerService.analyzeWithLlm(pair.baseToken.symbol, priceUsd, indicators, security.riskFlags);
          }

          // 4. Evaluate for all active users
          for (const config of cappedActiveConfigs) {
            try {
              const currentState = await this.userStateService.getAutopilotState(config.user_id);
              const maxPos = Number((config.sizing_params as any)?.max_concurrent_positions ?? 3);
              // Per-user capacity re-check (state may have changed after another token was bought)
              if (currentState.trendingPositionsCount >= maxPos) {
                logger.debug(`TrendScanner: user ${config.user_id} reached max trending positions (${currentState.trendingPositionsCount}/${maxPos}) mid-cycle, skipping`);
                continue;
              }

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
                candleCount: candles.length,
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
                cycleExecutedCount++;
                logger.info(`Autopilot executed trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
                
                // Notify user
                try {
                  const alertText = formatRadarCandidate({
                    type: 'TRENDING',
                    symbol: pair.baseToken.symbol,
                    name: pair.baseToken.name,
                    tokenAddress,
                    pairAddress: pair.pairAddress,
                    priceUsd,
                    liquidityUsd: pair.liquidity?.usd,
                    volume5mUsd: currentVolume,
                    securityScore: security.score,
                    securityLevel: security.level,
                    riskFlags: security.riskFlags,
                    status: 'EXECUTED',
                    reason: result.reason,
                  });
                  const keyboard = buildRadarCandidateKeyboard(tokenAddress, pair.pairAddress, true);
                  await this.botApi.sendMessage(config.user_id, alertText, { 
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                  });
                } catch (e) {
                  logger.error({ err: e }, 'Gagal mengirim notifikasi Autopilot ke user');
                }
              } else {
                logger.debug(`Autopilot skipped trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`);
                if (liveFeedSubscribers.has(config.user_id)) {
                  try {
                    const alertText = formatRadarCandidate({
                      type: 'TRENDING',
                      symbol: pair.baseToken.symbol,
                      name: pair.baseToken.name,
                      tokenAddress,
                      pairAddress: pair.pairAddress,
                      priceUsd,
                      liquidityUsd: pair.liquidity?.usd,
                      volume5mUsd: currentVolume,
                      securityScore: security.score,
                      securityLevel: security.level,
                      riskFlags: security.riskFlags,
                      status: 'SKIPPED',
                      reason: result.reason,
                    });
                    const keyboard = buildRadarCandidateKeyboard(tokenAddress, pair.pairAddress, false);
                    await this.botApi.sendMessage(config.user_id, alertText, { 
                      parse_mode: 'HTML',
                      reply_markup: keyboard,
                    });
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

        // Jeda minimal antar koin agar RPC dan GeckoTerminal tidak di-spam beruntun
        await new Promise((res) => setTimeout(res, 2500));
      } // end loop over pairs
      
      // Notify live feed subscribers that a cycle finished
      const digestText = formatRadarCycleDigest({
        type: 'TRENDING',
        scannedCount: topPairs.length,
        passedSafetyCount: cyclePassedSafetyCount,
        executedCount: cycleExecutedCount,
      });
      for (const userId of liveFeedSubscribers) {
        try {
          await this.botApi.sendMessage(userId, digestText, { parse_mode: 'HTML' });
        } catch (e) {
          // ignore
        }
      }
    } catch (err) {
      logger.error({ err }, 'TrendScanner Error');
    } finally {
      this.isScanning = false;
    }
  }
}

function resampleCandles(candles: any[], factor: number = 3): any[] {
  if (!candles || candles.length < factor) return [];
  const resampled: any[] = [];
  for (let i = 0; i <= candles.length - factor; i += factor) {
    const chunk = candles.slice(i, i + factor);
    resampled.push({
      timestamp: chunk[chunk.length - 1].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c: any) => c.high)),
      low: Math.min(...chunk.map((c: any) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum: number, c: any) => sum + c.volume, 0),
    });
  }
  return resampled;
}
