import { logger } from '../../utils/logger';
import { ScannerService } from './scannerService';
import { AutopilotEngine } from '../autopilot/autopilotEngine';
import { SecurityFilterService } from '../security/securityFilterService';
import { AnalyzerService } from '../analyzer/analyzerService';
import { SniperRepository } from '../../database/repositories/sniperRepository';
import { UserStateService } from '../user/userStateService';
import { getRedisConnection } from '../../queue/connection';
import { liveFeedSubscribers } from './liveFeedState';
import { evaluatePoolAge, failClosedSniperSafety } from '../autopilot/strategyRisk';
import { matchDiscoveredPool } from './sniperPoolSelection';
import {
  formatRadarCandidate,
  formatRadarCycleDigest,
  buildRadarCandidateKeyboard,
} from '../telegram/formatters/messageFormatter';

const htmlEscape = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (char) =>
      (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[char]
  );

/** Fetches new POOLS, not the largest pool of a token. Both modes use the shared execution engine. */
export class SniperScanner {
  private intervalId?: NodeJS.Timeout;
  private startupId?: NodeJS.Timeout;
  private scanning = false;

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
    logger.info('Starting New Pool Sniper scanner (60-second polling)');
    this.intervalId = setInterval(() => void this.scanSniper(), 60_000);
    this.startupId = setTimeout(() => void this.scanSniper(), 15_000);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    if (this.startupId) clearTimeout(this.startupId);
    this.intervalId = undefined;
    this.startupId = undefined;
  }

  private async scanSniper() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const configs = await this.sniperRepo.getAllActiveConfigs();
      if (configs.length === 0) return;
      const redis = getRedisConnection();

      // 1. Pre-check kapasitas posisi & circuit breaker di awal siklus agar tidak buang RPC/API jika semua user penuh
      const preCheckedConfigs: typeof configs = [];
      for (const config of configs) {
        const state = await this.userStateService.getAutopilotState(config.user_id);
        const maxPos = config.max_active_positions ?? 3;
        if (state.sniperPositionsCount >= maxPos) {
          if (liveFeedSubscribers.has(config.user_id)) {
            const capKey = `sniper:cap_notified:${config.user_id}`;
            if (!(await redis.get(capKey))) {
              await redis.set(capKey, '1', 'EX', 5 * 60);
              try {
                await this.botApi.sendMessage(
                  config.user_id,
                  `⏸ <b>Sniper Scanning Dijeda</b>\n\nPosisi aktif sudah mencapai batas maksimal (<b>${state.sniperPositionsCount}/${maxPos}</b>).\n\nScanning akan dilanjutkan kembali setelah salah satu posisi ditutup.`,
                  { parse_mode: 'HTML' }
                );
              } catch (_) {}
            }
          }
          logger.debug(
            `SniperScanner: user ${config.user_id} at max positions (${state.sniperPositionsCount}/${maxPos}), skipping cycle`
          );
          continue;
        }
        if (await this.userStateService.checkCircuitBreaker(config.user_id, state)) {
          continue;
        }
        preCheckedConfigs.push(config);
      }

      if (preCheckedConfigs.length === 0) {
        logger.debug('SniperScanner: no active users with available sniper capacity, skipping cycle');
        return;
      }

      const pools = (await this.scannerService.fetchNewPairs()).slice(0, 3);
      const now = Date.now();

      let cyclePassedSafetyCount = 0;
      let cycleExecutedCount = 0;

      const notifyGlobalLiveFeed = async (candidate: any, reason: string) => {
        const notifKey = `sniper:notified_global:${candidate.pairAddress}`;
        if (await redis.get(notifKey)) return;
        await redis.set(notifKey, '1', 'EX', 15 * 60);

        const ageText = candidate.poolCreatedAtMs
          ? `${Math.max(1, Math.round((Date.now() - candidate.poolCreatedAtMs) / 1000))} detik`
          : null;

        const alertText = formatRadarCandidate({
          type: 'SNIPER',
          symbol: candidate.symbol,
          tokenAddress: candidate.tokenAddress,
          pairAddress: candidate.pairAddress,
          poolAgeText: ageText,
          status: 'SKIPPED',
          reason,
        });
        const keyboard = buildRadarCandidateKeyboard(candidate.tokenAddress, candidate.pairAddress, false);

        for (const userId of liveFeedSubscribers) {
          try {
            const cfg = await this.sniperRepo.getOrCreateConfig(userId);
            if (cfg.enabled) {
              await this.botApi.sendMessage(userId, alertText, {
                parse_mode: 'HTML',
                reply_markup: keyboard,
              });
            }
          } catch (e) {}
        }
      };

      for (const candidate of pools) {
        if (!candidate.poolCreatedAtMs || candidate.poolCreatedAtMs > now) {
          await notifyGlobalLiveFeed(candidate, 'Invalid pool creation time');
          continue;
        }
        const eligibleConfigs = preCheckedConfigs.filter(
          (c) =>
            evaluatePoolAge(candidate.poolCreatedAtMs, now, c.min_pool_age_seconds, c.max_pool_age_minutes) === 'READY'
        );
        if (eligibleConfigs.length === 0) {
          await notifyGlobalLiveFeed(candidate, 'Pool age belum masuk target window');
          continue;
        }

        // Fetch exact pool and exact token, not the most liquid pool of that token.
        const pair = matchDiscoveredPool(
          candidate,
          await this.scannerService.scanSpecificPool(candidate.pairAddress)
        );
        if (!pair || !pair.pairCreatedAt || Math.abs(pair.pairCreatedAt - candidate.poolCreatedAtMs) > 120_000) {
          await notifyGlobalLiveFeed(candidate, 'Data DexScreener belum sinkron / valid');
          continue;
        }

        candidate.symbol =
          pair.baseToken?.symbol && pair.baseToken.symbol !== '???' ? pair.baseToken.symbol : candidate.symbol;

        const priceUsd = Number(pair.priceUsd);
        const liquidityUsd = Number(pair.liquidity?.usd);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(liquidityUsd)) {
          await notifyGlobalLiveFeed(candidate, 'Likuiditas atau harga kosong di DexScreener');
          continue;
        }

        // Security check uses THIS pool's liquidity, never the liquidity of an older pair.
        const security = await this.securityService.evaluateToken(candidate.tokenAddress, {
          liquidityUsd,
          marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
          pairAddress: candidate.pairAddress || pair.pairAddress,
        });
        if (security.isHardBlocked) {
          await notifyGlobalLiveFeed(candidate, `Gagal tes Anti-Rug: ${security.hardBlockReasons.join(', ')}`);
          continue;
        }
        cyclePassedSafetyCount++;

        // Ambil 1m candles saja dan resample secara matematis ke 5m (hemat 1 round-trip API call agar sniping cepat!)
        const candles = await this.scannerService.getCandles('solana', candidate.pairAddress, 'minute', 1);
        const macroCandles = resampleSniperCandles(candles, 5);
        const volumes = candles.slice(0, -1).map((c) => c.volume);
        // Gunakan volume 1 menit dari candle terbaru (atau rata-rata m5 dibagi 5) agar satuannya setara dengan `volumes` (1m)
        const latestCandleVol = candles.at(-1)?.volume;
        const estimated1mVolFromM5 = pair.volume?.m5 ? Number(pair.volume.m5) / 5 : 0;
        const currentVolume =
          latestCandleVol !== undefined && latestCandleVol > 0 ? latestCandleVol : estimated1mVolFromM5;

        let indicators = this.analyzerService.calculateIndicators(
          candles,
          priceUsd,
          currentVolume,
          volumes,
          macroCandles
        );

        // FALLBACK KHUSUS SNIPER POOL BARU (< 21 menit):
        // Pool yang baru lahir 1-15 menit belum punya 21 candle 1-menit.
        // Jika candles < 21 tapi pool punya metrik momentum positif di DexScreener/candle awal,
        // bangun synthetic snapshot agar tidak mati konyol di RuleEvaluator fallback!
        if (!indicators) {
          const m5Change = Number((pair as any).priceChange?.m5 ?? 0);
          const m5Buys = Number((pair as any).txns?.m5?.buys ?? 0);
          const m5Sells = Number((pair as any).txns?.m5?.sells ?? 0);
          const m5Vol = Number(pair.volume?.m5 ?? currentVolume ?? 0);
          const firstOpen = candles.length > 0 ? candles[0].open : priceUsd;
          const isBullishEarlyAction =
            priceUsd >= firstOpen || m5Change > 0 || (m5Buys > m5Sells && m5Buys >= 3);

          if (isBullishEarlyAction && m5Vol > 0) {
            indicators = {
              ema9: priceUsd * 1.005, // Representasi momentum awal bullish (EMA9 > EMA21)
              ema21: priceUsd * 0.995,
              rsi14: 55, // Zona aman momentum awal (30 - 70)
              atr14: priceUsd * 0.05,
              vwap: priceUsd * 0.99,
              volumeSpikeRatio: Math.max(1.6, m5Buys / Math.max(1, m5Sells)),
              calculatedStopLoss: priceUsd * 0.85,
              calculatedTp1: priceUsd * 1.25,
              calculatedTp2: priceUsd * 1.5,
            };
          }
        }

        const ai = null; // Disabled AI for faster sniping

        for (const config of eligibleConfigs) {
          const notifyUserLiveFeed = async (reason: string) => {
            if (liveFeedSubscribers.has(config.user_id)) {
              const notifKey = `sniper:notified_user:${config.user_id}:${candidate.pairAddress}`;
              if (await redis.get(notifKey)) return;
              await redis.set(notifKey, '1', 'EX', 15 * 60);

              const ageText = candidate.poolCreatedAtMs
                ? `${Math.max(1, Math.round((Date.now() - candidate.poolCreatedAtMs) / 1000))} detik`
                : null;

              const alertText = formatRadarCandidate({
                type: 'SNIPER',
                symbol: candidate.symbol,
                tokenAddress: candidate.tokenAddress,
                pairAddress: candidate.pairAddress,
                priceUsd,
                liquidityUsd,
                poolAgeText: ageText,
                securityScore: security?.score,
                securityLevel: security?.level,
                riskFlags: security?.riskFlags,
                status: 'SKIPPED',
                reason,
              });
              const keyboard = buildRadarCandidateKeyboard(candidate.tokenAddress, candidate.pairAddress, false);

              try {
                await this.botApi.sendMessage(config.user_id, alertText, {
                  parse_mode: 'HTML',
                  reply_markup: keyboard,
                });
              } catch (e) {}
            }
          };

          const doneKey = `sniper:processed:${config.user_id}:${candidate.pairAddress}`;
          if (await redis.get(doneKey)) continue;
          try {
            const latest = await this.sniperRepo.getOrCreateConfig(config.user_id);
            if (!latest.enabled) continue;
            if (
              evaluatePoolAge(
                candidate.poolCreatedAtMs,
                Date.now(),
                latest.min_pool_age_seconds,
                latest.max_pool_age_minutes
              ) !== 'READY'
            ) {
              await notifyUserLiveFeed('Pool age belum sesuai target khusus pengguna ini');
              continue;
            }
            if (liquidityUsd < latest.min_liquidity_usd) {
              await notifyUserLiveFeed(
                `Likuiditas ($${liquidityUsd}) di bawah target pengguna ($${latest.min_liquidity_usd})`
              );
              continue;
            }
            const safetyReject = failClosedSniperSafety(security, latest.reject_unknown_critical_safety_checks);
            if (safetyReject) {
              await notifyUserLiveFeed(`Ditolak filter keamanan Sniper: ${safetyReject}`);
              continue;
            }
            if (
              latest.require_sell_route &&
              security.report?.find((r) => r.name === 'Sell Route Quote')?.value !== 'Route Available'
            ) {
              await notifyUserLiveFeed('Gagal pengecekan rute jual (Sell Route)');
              continue;
            }

            const state = await this.userStateService.getAutopilotState(config.user_id);
            const maxPos = latest.max_active_positions ?? 3;
            if (state.sniperPositionsCount >= maxPos) {
              logger.debug(
                `SniperScanner: user ${config.user_id} reached max sniper positions (${state.sniperPositionsCount}/${maxPos}) inside evaluation, skipping`
              );
              continue;
            }
            if (await this.userStateService.checkCircuitBreaker(config.user_id, state)) continue;
            const result = await this.autopilotEngine.processCandidate(
              config.user_id,
              candidate.tokenAddress,
              candidate.symbol,
              priceUsd,
              liquidityUsd,
              security,
              ai,
              state,
              {
                poolAddress: candidate.pairAddress,
                poolCreatedAtMs: candidate.poolCreatedAtMs,
                tokenAddress: candidate.tokenAddress,
                priceUsd,
                liquidityUsd,
                indicators,
                isSniper: true,
              },
              'SNIPER'
            );
            if (result.executed) {
              cycleExecutedCount++;
              await redis.set(doneKey, '1', 'EX', 86_400);
              if (latest.notifications_enabled) {
                try {
                  const ageText = candidate.poolCreatedAtMs
                    ? `${Math.max(1, Math.round((Date.now() - candidate.poolCreatedAtMs) / 1000))} detik`
                    : null;

                  const alertText = formatRadarCandidate({
                    type: 'SNIPER',
                    symbol: candidate.symbol,
                    tokenAddress: candidate.tokenAddress,
                    pairAddress: candidate.pairAddress,
                    priceUsd,
                    liquidityUsd,
                    poolAgeText: ageText,
                    securityScore: security?.score,
                    securityLevel: security?.level,
                    riskFlags: security?.riskFlags,
                    status: 'EXECUTED',
                    reason: result.reason,
                  });
                  const keyboard = buildRadarCandidateKeyboard(candidate.tokenAddress, candidate.pairAddress, true);

                  await this.botApi.sendMessage(config.user_id, alertText, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                  });
                } catch (error) {
                  logger.warn({ error }, 'Sniper notification could not be delivered');
                }
              }
            } else if (liveFeedSubscribers.has(config.user_id)) {
              const notifKey = `sniper:notified_user:${config.user_id}:${candidate.pairAddress}`;
              if (!(await redis.get(notifKey))) {
                await redis.set(notifKey, '1', 'EX', 15 * 60);
                try {
                  const ageText = candidate.poolCreatedAtMs
                    ? `${Math.max(1, Math.round((Date.now() - candidate.poolCreatedAtMs) / 1000))} detik`
                    : null;

                  const alertText = formatRadarCandidate({
                    type: 'SNIPER',
                    symbol: candidate.symbol,
                    tokenAddress: candidate.tokenAddress,
                    pairAddress: candidate.pairAddress,
                    priceUsd,
                    liquidityUsd,
                    poolAgeText: ageText,
                    securityScore: security?.score,
                    securityLevel: security?.level,
                    riskFlags: security?.riskFlags,
                    status: 'SKIPPED',
                    reason: result.reason,
                  });
                  const keyboard = buildRadarCandidateKeyboard(candidate.tokenAddress, candidate.pairAddress, false);

                  await this.botApi.sendMessage(config.user_id, alertText, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                  });
                } catch {
                  /* Best effort notification. */
                }
              }
            }
          } catch (error) {
            logger.error(
              { error, userId: config.user_id, pool: candidate.pairAddress },
              'Sniper evaluation failed; candidate will remain retriable'
            );
          }
        }
      }

      // Notify live feed subscribers that a cycle finished
      const digestText = formatRadarCycleDigest({
        type: 'SNIPER',
        scannedCount: pools.length,
        passedSafetyCount: cyclePassedSafetyCount,
        executedCount: cycleExecutedCount,
      });
      for (const userId of liveFeedSubscribers) {
        try {
          const cfg = await this.sniperRepo.getOrCreateConfig(userId);
          if (cfg.enabled) {
            await this.botApi.sendMessage(userId, digestText, { parse_mode: 'HTML' });
          }
        } catch (e) {}
      }
    } catch (error) {
      logger.error({ error }, 'New Pool Sniper scan failed');
    } finally {
      this.scanning = false;
    }
  }
}

function resampleSniperCandles(candles: any[], factor: number = 5): any[] {
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
