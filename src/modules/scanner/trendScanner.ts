import { logger } from '../../utils/logger';
import { ScannerService } from './scannerService';
import { AutopilotEngine } from '../autopilot/autopilotEngine';
import { RuleEvaluator } from '../autopilot/ruleEvaluator';
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
  buildRadarCandidateKeyboard,
} from '../telegram/formatters/messageFormatter';
import { appSettings } from '../../config/settings.js';
import { DexScreenerClient } from './dexScreenerClient';

interface PairProcessContext {
  cappedActiveConfigs: any[];
  liveFeedSubscribers: Set<number>;
  redis: any;
  counters: { passedSafety: number; executed: number };
}

export interface TelegramBotApi {
  sendMessage: (chatId: number | string, text: string, other?: any) => Promise<any>;
}

export class TrendScanner {
  private intervalId?: NodeJS.Timeout;
  private isScanning = false;
  private readonly dexScreener = new DexScreenerClient();

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
        headers: { Accept: 'application/json;version=20230302' },
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

      const redis = getRedisConnection();

      // ── Max-positions & Circuit Breaker gate: cek di paling awal sebelum fetch data pasar! ──
      const configsWithCapacity = await Promise.all(
        activeConfigs.map(async (cfg) => {
          const safetyParams = cfg.safety_params as any;
          if (safetyParams?.enable_trending === false) {
            return { cfg, state: null as any, maxPos: 0, hasCap: false, reason: 'DISABLED' };
          }
          const state = await this.userStateService.getAutopilotState(cfg.user_id);
          const maxPos = Number((cfg.sizing_params as any)?.max_concurrent_positions ?? 3);
          const isCircuitBroken = await this.userStateService.checkCircuitBreaker(cfg.user_id, state);
          if (isCircuitBroken) {
            return { cfg, state, maxPos, hasCap: false, reason: 'CIRCUIT_BROKEN' };
          }
          return {
            cfg,
            state,
            maxPos,
            hasCap: state.trendingPositionsCount < maxPos,
            reason: state.trendingPositionsCount < maxPos ? 'OK' : 'MAX_POSITIONS',
          };
        })
      );

      const usersWithCapacity = configsWithCapacity.filter((x) => x.hasCap);

      // Notify capped users (once per 5 min)
      for (const { cfg, state, maxPos, reason } of configsWithCapacity.filter((x) => !x.hasCap)) {
        if (reason === 'MAX_POSITIONS' && state && liveFeedSubscribers.has(cfg.user_id)) {
          const capKey = `trending:cap_notified:${cfg.user_id}`;
          if (!(await redis.get(capKey))) {
            await redis.set(capKey, '1', 'EX', 5 * 60);
            try {
              await this.botApi.sendMessage(
                cfg.user_id,
                `⏸ <b>Trending Scanning Dijeda</b>\n\nPosisi aktif sudah mencapai batas maksimal (<b>${state.trendingPositionsCount}/${maxPos}</b>).\n\nScanning akan dilanjutkan kembali setelah salah satu posisi ditutup.`,
                { parse_mode: 'HTML' }
              );
            } catch (_) {}
          }
        }
      }

      if (usersWithCapacity.length === 0) {
        logger.info('TrendScanner: no eligible users with capacity — skipping scan cycle');
        return;
      }

      const cappedActiveConfigs = usersWithCapacity.map((x) => x.cfg);
      logger.info(`TrendScanner: Fetching trending tokens for ${cappedActiveConfigs.length} eligible users...`);

      // Discovery is organic-only. Paid boosts/profiles must never enter an auto-buy pipeline.
      const combinedList = await this.fetchOrganicTrendingTokens();

      // Deduplicate by token address
      const uniqueTokensMap = new Map<string, (typeof combinedList)[0]>();
      for (const t of combinedList) {
        if (!uniqueTokensMap.has(t.tokenAddress)) {
          uniqueTokensMap.set(t.tokenAddress, t);
        }
      }
      const trendingList = Array.from(uniqueTokensMap.values());
      logger.info(`TrendScanner: Loaded ${trendingList.length} unique organic GeckoTerminal tokens.`);

      const newTokens: typeof trendingList = [];
      for (const t of trendingList) {
        const isScanned = await redis.get(`scanned_token:${t.tokenAddress}`);
        if (!isScanned) {
          newTokens.push(t);
        }
      }

      const tokensToScan = newTokens.slice(0, 30);
      if (tokensToScan.length === 0) {
        logger.info('TrendScanner: No new unscanned trending tokens in this cycle.');
        return;
      }
      logger.info(`TrendScanner: Fetching profiles for ${tokensToScan.length} NEW multi-source trending Solana tokens.`);

      const tokenAddresses = tokensToScan.map((t) => t.tokenAddress);
      const pairsMap = await this.scannerService.scanTokensByAddresses(tokenAddresses);
      const fetchedPairs = Array.from(pairsMap.values());

      // Cari nilai min_liquidity_usd terendah dari seluruh user aktif agar tidak memproses token di bawah syarat semua user
      const lowestUserMinLiquidity = Math.min(
        ...cappedActiveConfigs.map((c) => Number((c.safety_params as any)?.min_liquidity_usd ?? 10000)),
        10000
      );
      const minLiquidityUsd = Math.max(1000, lowestUserMinLiquidity);
      const minVolume24h = 500;
      const viablePairs: typeof fetchedPairs = [];

      for (const pair of fetchedPairs) {
        const price = parseFloat(pair.priceUsd || '0');
        const liquidity = Number(pair.liquidity?.usd ?? 0);
        const volume = Number(pair.volume?.h24 ?? 0);

        if (!Number.isFinite(price) || price <= 0 || liquidity < minLiquidityUsd || volume < minVolume24h) {
          if (pair.baseToken?.address) {
            await redis.set(`scanned_token:${pair.baseToken.address}`, '1', 'EX', 15 * 60);
          }
          continue;
        }
        viablePairs.push(pair);
      }

      // FIX #4: sort berdasarkan akselerasi volume 5 menit (momentum saat ini),
      // bukan volume 24 jam (yang didominasi token "tua" yang sudah dipompa berjam-jam).
      const momentumScore = (p: any) => (Number(p.volume?.m5 ?? 0) * 12) + Number(p.volume?.h1 ?? 0);
      const sortedPairs = viablePairs.sort((a: any, b: any) => momentumScore(b) - momentumScore(a));

      const topPairs = sortedPairs.slice(0, 5);
      logger.info(`TrendScanner: Selected ${topPairs.length}/${viablePairs.length} viable pairs by volume for deep analysis.`);

      let cyclePassedSafetyCount = 0;
      let cycleExecutedCount = 0;

      // FIX 1: proses topPairs PARALEL (concurrency terbatas) — tidak ada lagi antrian sekuensial
      // yang membuat pair ke-5 menunggu ~25 detik dan menerima sinyal basi.
      const pairCtx: PairProcessContext = {
        cappedActiveConfigs,
        liveFeedSubscribers,
        redis,
        counters: { passedSafety: 0, executed: 0 },
      };
      await this.mapWithConcurrency(
        topPairs,
        appSettings.SCANNER_PARAMS.PAIR_CONCURRENCY,
        (pair) => this.processPair(pair, pairCtx)
      );
      cyclePassedSafetyCount = pairCtx.counters.passedSafety;
      cycleExecutedCount = pairCtx.counters.executed;

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

  /**
   * Proses satu pair: security -> candles -> indikator -> AI (cached) ->
   * freshness guard -> evaluasi per user. Dijalankan paralel via mapWithConcurrency.
   */
  private async processPair(pair: any, ctx: PairProcessContext): Promise<void> {
    try {
      const tokenAddress = pair.baseToken.address;
      let priceUsd = parseFloat(pair.priceUsd || '0');
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;

      const liquidityUsd = Number(pair.liquidity?.usd ?? 0);

      // MICRO-OPT: security check & candle fetch jalan PARALEL (hemat ~1-2 dtk per pair).
      // Candle tetap dipakai hanya bila lolos pre-AI safety (di bawah).
      const [security, candles] = await Promise.all([
        this.securityService.evaluateToken(tokenAddress, {
          liquidityUsd: liquidityUsd || null,
          marketCapUsd: pair.marketCap || pair.fdv || null,
          pairAddress: pair.pairAddress,
        }),
        this.scannerService.getCandles('solana', pair.pairAddress, 'minute', 1),
      ]);

      // Quarantine dicatat SETELAH analisa AI (lihat bawah) dengan TTL dibedakan per hasil.
      // (FIX #2: dulu langsung 15 menit di sini, sehingga verdict WAIT ikut terkunci 15 menit.)

      if (!security.isHardBlocked && security.score >= 50) {
        ctx.counters.passedSafety++;
      }

      // Cek apakah ada MINIMAL 1 user yang aturan keamanannya meloloskan token ini sebelum membuang kuota candle & LLM
      const anyUserPassesPreAiSafety = ctx.cappedActiveConfigs.some((cfg) => {
        const safeConf = (cfg.safety_params as any) || {};
        const check = RuleEvaluator.evaluatePreAiSafety(
          security,
          {
            minSafetyScore: safeConf.min_safety_score ?? 75,
            allowedLevels: safeConf.allowed_levels ?? ['SAFE'],
            minLiquidityUsd: safeConf.min_liquidity_usd ?? 10000,
            maxTop10Percent: safeConf.max_top10_percent,
            maxDeployerPercent: safeConf.max_deployer_percent,
            requireLpBurnOrLock: safeConf.lp_burn_or_lock_required,
          },
          liquidityUsd
        );
        return check.canProceedToAi;
      });

      let currentVolume = Number(pair.volume?.m5 ?? 0);
      let indicators = null;
      let aiAnalysis = null;

      if (anyUserPassesPreAiSafety) {
        // FIX #3: harga live DexScreener lebih fresh dari close candle (yang bisa basi dari cache).
        // Candle close hanya jadi fallback bila harga live tidak valid.
        const candleClose = candles.length > 0 ? candles[candles.length - 1].close : NaN;
        if ((!Number.isFinite(priceUsd) || priceUsd <= 0) && Number.isFinite(candleClose) && candleClose > 0) {
          priceUsd = candleClose;
        }

        const macroCandles = resampleCandles(candles, 5);
        const pastVolumes = candles.slice(0, Math.max(0, candles.length - 1)).map((c) => c.volume);
        const latestCandleVol = candles.length > 0 ? candles[candles.length - 1].volume : 0;
        currentVolume = Math.max(Number(pair.volume?.m5 ?? 0), latestCandleVol);

        indicators = this.analyzerService.calculateIndicators(
          candles,
          priceUsd,
          currentVolume,
          pastVolumes,
          macroCandles
        );

        // MICRO-OPT: freshness probe dimulai PARALEL dengan AI call (hemat ~0.5 dtk),
        // karena harga analisa (priceUsd) sudah diketahui sebelum AI dipanggil.
        const freshnessPromise = this.checkPriceFreshness(pair.pairAddress, priceUsd, pair.baseToken.symbol);

        if (indicators) {
          // FIX #7b: konteks orderflow & price action cepat untuk AI
          // (perubahan harga 5m, rasio beli/jual, bentuk 3 candle terakhir).
          const marketContext = {
            priceChangeM5Pct: Number(pair.priceChange?.m5 ?? NaN),
            buysM5: Number(pair.txns?.m5?.buys ?? NaN),
            sellsM5: Number(pair.txns?.m5?.sells ?? NaN),
            lastCandles: candles.slice(-3).map((c: any) => ({ open: c.open, high: c.high, low: c.low, close: c.close })),
          };
          // FIX 2: vonis AI dari cache bila fresh — tidak blocking LLM setiap siklus
          aiAnalysis = await this.analyzerService.getAiAnalysisWithCache(
            tokenAddress,
            pair.baseToken.symbol,
            priceUsd,
            indicators,
            security.riskFlags,
            marketContext
          );
        }

        // FIX 3: Freshness guard — harga bisa bergerak selama AI analisa.
        // Probe-nya sudah dimulai paralel sebelum AI call; tinggal tunggu hasilnya.
        // Jika drift melebihi toleransi, sinyal dianggap basi -> skip.
        const freshness = await freshnessPromise;
        if (!freshness.ok) {
          logger.info(
            { token: pair.baseToken.symbol, driftPct: freshness.driftPct.toFixed(2) },
            'TrendScanner: skip — harga bergerak terlalu jauh sejak analisa AI (sinyal basi)'
          );
          return;
        }
        priceUsd = freshness.freshPrice;

        // FIX #2: quarantine TTL dibedakan per hasil — WAIT cuma 2 menit agar
        // breakout berikutnya tidak terlewat; hard-blocked/gagal safety tetap 15 menit.
        const quarantineTtlSec =
          security.isHardBlocked || !anyUserPassesPreAiSafety
            ? 15 * 60
            : aiAnalysis?.verdict === 'WAIT'
              ? 2 * 60
              : 10 * 60;
        await ctx.redis.set(`scanned_token:${tokenAddress}`, '1', 'EX', quarantineTtlSec);
      } else {
        // Gagal pre-AI safety untuk semua user -> quarantine 15 menit (tidak perlu dicek tiap siklus)
        await ctx.redis.set(`scanned_token:${tokenAddress}`, '1', 'EX', 15 * 60);
        logger.debug(
          { token: pair.baseToken.symbol, score: security.score, liquidityUsd },
          'TrendScanner: Skipping candle & LLM fetch because token failed Pre-AI safety for all active users'
        );
      }

      // 4. Evaluate for all active users
      for (const config of ctx.cappedActiveConfigs) {
        try {
          const currentState = await this.userStateService.getAutopilotState(config.user_id);
          const maxPos = Number((config.sizing_params as any)?.max_concurrent_positions ?? 3);
          if (currentState.trendingPositionsCount >= maxPos) {
            logger.debug(
              `TrendScanner: user ${config.user_id} reached max trending positions (${currentState.trendingPositionsCount}/${maxPos}) mid-cycle, skipping`
            );
            continue;
          }

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
            currentState,
          };

          const safetyParams = config.safety_params as any;
          if (safetyParams?.enable_trending === false) continue;

          const result = await this.autopilotEngine.processCandidate(
            config.user_id,
            tokenAddress,
            pair.baseToken.symbol,
            priceUsd,
            liquidityUsd,
            security,
            aiAnalysis,
            currentState,
            rawSnapshot,
            'TRENDING'
          );

          if (result.executed) {
            ctx.counters.executed++;
            logger.info(
              `Autopilot executed trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`
            );

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
            logger.debug(
              `Autopilot skipped trade for user ${config.user_id} on ${pair.baseToken.symbol}: ${result.reason}`
            );
            if (ctx.liveFeedSubscribers.has(config.user_id)) {
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
      logger.error(
        { err, tokenAddress: pair.baseToken.address },
        'Error evaluating token candidate, skipping to next token'
      );
    }
  }

  /** Jalankan fn untuk tiap item dengan batas konkurensi. */
  private async mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
    const limit = Math.max(1, Math.min(concurrency, Math.max(items.length, 1)));
    let nextIndex = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        try {
          await fn(items[i]);
        } catch (err) {
          logger.error({ err }, 'TrendScanner: error in parallel pair worker');
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * FIX 3: bandingkan harga analisa vs harga fresh dari DexScreener.
   * Fail-open: jika harga fresh tidak bisa diambil, lanjut seperti biasa.
   */
  private async checkPriceFreshness(
    pairAddress: string,
    analysisPrice: number,
    symbol: string
  ): Promise<{ ok: boolean; freshPrice: number; driftPct: number }> {
    const maxDriftPct = appSettings.SCANNER_PARAMS.EXECUTION_MAX_PRICE_DRIFT_PCT;
    try {
      const freshPair = await this.dexScreener.getPairByAddress(pairAddress);
      const freshPrice = freshPair ? Number(freshPair.priceUsd) : NaN;
      if (!Number.isFinite(freshPrice) || freshPrice <= 0 || !(analysisPrice > 0)) {
        return { ok: true, freshPrice: analysisPrice, driftPct: 0 };
      }
      const driftPct = (Math.abs(freshPrice - analysisPrice) / analysisPrice) * 100;
      if (driftPct > maxDriftPct) {
        logger.info(
          { token: symbol, analysisPrice, freshPrice, driftPct: driftPct.toFixed(2), maxDriftPct },
          'TrendScanner: freshness guard menolak sinyal basi'
        );
        return { ok: false, freshPrice, driftPct };
      }
      return { ok: true, freshPrice, driftPct };
    } catch {
      return { ok: true, freshPrice: analysisPrice, driftPct: 0 };
    }
  }
}

/**
 * Resample candles disejajarkan dari ujung kanan (candle paling baru)
 * agar candle terakhir tidak pernah terbuang jika candles.length % factor !== 0.
 */
function resampleCandles(candles: any[], factor: number = 3): any[] {
  if (!candles || candles.length < factor) return [];
  const resampled: any[] = [];
  const startOffset = candles.length % factor;
  for (let i = startOffset; i <= candles.length - factor; i += factor) {
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
