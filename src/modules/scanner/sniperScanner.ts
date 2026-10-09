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

const htmlEscape = (s: unknown): string => String(s).replace(/[&<>"']/g, char => (
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string,string>)[char]
));

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
      const pools = (await this.scannerService.fetchNewPairs()).slice(0, 3);
      const now = Date.now();

      const notifyGlobalLiveFeed = async (candidate: any, reason: string) => {
        const notifKey = `sniper:notified_global:${candidate.pairAddress}`;
        if (await redis.get(notifKey)) return;
        await redis.set(notifKey, '1', 'EX', 15 * 60);

        for (const userId of liveFeedSubscribers) {
          try {
            const cfg = await this.sniperRepo.getOrCreateConfig(userId);
            if (cfg.enabled) {
              await this.botApi.sendMessage(userId,
                `⚡ <b>SNIPER RADAR</b>\n` +
                `├ <b>Token:</b> <code>${htmlEscape(candidate.symbol)}</code>\n` +
                `├ <b>CA:</b> <code>${htmlEscape(candidate.tokenAddress)}</code>\n` +
                `├ <b>Status:</b> ⚪ SKIPPED\n` +
                `└ <b>Reason:</b> <i>${htmlEscape(reason)}</i>`, { 
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: [[{ text: '🔍 Scan Token', callback_data: `refresh:${candidate.tokenAddress}` }]] }
                });
            }
          } catch (e) {}
        }
      };

      for (const candidate of pools) {
        // Pool age cannot be inferred from token name, liquidity, or DexScreener ranking.
        if (!candidate.poolCreatedAtMs || candidate.poolCreatedAtMs > now) {
          await notifyGlobalLiveFeed(candidate, 'Invalid pool creation time');
          continue;
        }
        const eligibleConfigs = configs.filter(c =>
          evaluatePoolAge(candidate.poolCreatedAtMs, now, c.min_pool_age_seconds, c.max_pool_age_minutes) === 'READY'
        );
        if (eligibleConfigs.length === 0) {
          await notifyGlobalLiveFeed(candidate, 'Pool age belum masuk target window');
          continue;
        }

        // Fetch exact pool and exact token, not the most liquid pool of that token.
        const pair = matchDiscoveredPool(candidate,
          await this.scannerService.scanSpecificPool(candidate.pairAddress));
        if (!pair || !pair.pairCreatedAt ||
            Math.abs(pair.pairCreatedAt - candidate.poolCreatedAtMs) > 120_000) {
          await notifyGlobalLiveFeed(candidate, 'Data DexScreener belum sinkron / valid');
          continue;
        }
        
        // Update the symbol if DexScreener has it (GeckoTerminal often returns ??? for very new pools)
        candidate.symbol = pair.baseToken?.symbol && pair.baseToken.symbol !== '???' 
          ? pair.baseToken.symbol 
          : candidate.symbol;

        const priceUsd = Number(pair.priceUsd);
        const liquidityUsd = Number(pair.liquidity?.usd);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(liquidityUsd)) {
          await notifyGlobalLiveFeed(candidate, 'Likuiditas atau harga kosong di DexScreener');
          continue;
        }

        // Security check uses THIS pool's liquidity, never the liquidity of an older pair.
        const security = await this.securityService.evaluateToken(candidate.tokenAddress, {
          liquidityUsd, marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
        });
        if (security.isHardBlocked) {
          await notifyGlobalLiveFeed(candidate, `Gagal tes Anti-Rug: ${security.hardBlockReasons.join(', ')}`);
          continue;
        }
        const candles = await this.scannerService.getCandles('solana', candidate.pairAddress, 'minute', 1);
        const macroCandles = await this.scannerService.getCandles('solana', candidate.pairAddress, 'minute', 5);
        const volumes = candles.slice(0, -1).map(c => c.volume);
        const currentVolume = pair.volume?.m5 ?? candles.at(-1)?.volume ?? 0;
        const indicators = this.analyzerService.calculateIndicators(candles, priceUsd, currentVolume, volumes, macroCandles);
        const ai = null; // Disabled AI for faster sniping

        for (const config of eligibleConfigs) {
          const notifyUserLiveFeed = async (reason: string) => {
            if (liveFeedSubscribers.has(config.user_id)) {
              const notifKey = `sniper:notified_user:${config.user_id}:${candidate.pairAddress}`;
              if (await redis.get(notifKey)) return;
              await redis.set(notifKey, '1', 'EX', 15 * 60);

              try {
                await this.botApi.sendMessage(config.user_id,
                  `⚡ <b>SNIPER RADAR</b>\n` +
                  `├ <b>Token:</b> <code>${htmlEscape(candidate.symbol)}</code>\n` +
                  `├ <b>CA:</b> <code>${htmlEscape(candidate.tokenAddress)}</code>\n` +
                  `├ <b>Status:</b> ⚪ SKIPPED\n` +
                  `└ <b>Reason:</b> <i>${htmlEscape(reason)}</i>`, { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔍 Scan Token', callback_data: `refresh:${candidate.tokenAddress}` }]] }
                  });
              } catch (e) {}
            }
          };

          const doneKey = `sniper:processed:${config.user_id}:${candidate.pairAddress}`;
          if (await redis.get(doneKey)) continue;
          try {
            // Re-read enabled status immediately before an entry; the engine re-checks again.
            const latest = await this.sniperRepo.getOrCreateConfig(config.user_id);
            if (!latest.enabled) continue;
            if (evaluatePoolAge(candidate.poolCreatedAtMs, Date.now(), latest.min_pool_age_seconds,
                latest.max_pool_age_minutes) !== 'READY') {
              await notifyUserLiveFeed('Pool age belum sesuai target khusus pengguna ini');
              continue;
            }
            if (liquidityUsd < latest.min_liquidity_usd) {
              await notifyUserLiveFeed(`Likuiditas ($${liquidityUsd}) di bawah target pengguna ($${latest.min_liquidity_usd})`);
              continue;
            }
            const safetyReject = failClosedSniperSafety(security, latest.reject_unknown_critical_safety_checks);
            if (safetyReject || (latest.require_sell_route && security.report?.find(r => r.name === 'Sell Simulation')?.value !== 'Success')) {
              // Security conditions may change; do not permanently suppress an early pool.
              await notifyUserLiveFeed('Gagal pengecekan rute jual (Sell Route)');
              continue;
            }

            const state = await this.userStateService.getAutopilotState(config.user_id);
            if (await this.userStateService.checkCircuitBreaker(config.user_id, state)) continue;
            const result = await this.autopilotEngine.processCandidate(
              config.user_id, candidate.tokenAddress, candidate.symbol, priceUsd,
              liquidityUsd, security, ai, state,
              { poolAddress: candidate.pairAddress, poolCreatedAtMs: candidate.poolCreatedAtMs,
                tokenAddress: candidate.tokenAddress, priceUsd, liquidityUsd, indicators,
                isSniper: true }, 'SNIPER'
            );
            if (result.executed) {
              // Accepted/submitted orders must never be automatically replayed due to RPC timeout.
              await redis.set(doneKey, '1', 'EX', 86_400);
              if (latest.notifications_enabled) {
                try {
                  await this.botApi.sendMessage(config.user_id,
                    `⚡ <b>New Pool Sniper</b>\nToken: <code>${htmlEscape(candidate.symbol)}</code>\n` +
                    `Mint: <code>${htmlEscape(candidate.tokenAddress)}</code>\n` +
                    `Chart: <a href="https://dexscreener.com/solana/${candidate.tokenAddress}">DexScreener</a>\n` +
                    `Pool: <code>${htmlEscape(candidate.pairAddress)}</code>\n` +
                    `Status: <b>${htmlEscape(result.status ?? 'SUBMITTED')}</b>\n` +
                    `Order: ${htmlEscape(result.reason)}\n\n` +
                    `On-chain status can remain pending; check /positions for reconciliation.`,
                    { parse_mode: 'HTML' });
                } catch (error) {
                  logger.warn({ error }, 'Sniper notification could not be delivered');
                }
              }
            } else if (liveFeedSubscribers.has(config.user_id)) {
              const notifKey = `sniper:notified_user:${config.user_id}:${candidate.pairAddress}`;
              if (!(await redis.get(notifKey))) {
                await redis.set(notifKey, '1', 'EX', 15 * 60);
                try {
                  await this.botApi.sendMessage(config.user_id,
                    `⚡ <b>SNIPER RADAR</b>\n` +
                    `├ <b>Token:</b> <code>${htmlEscape(candidate.symbol)}</code>\n` +
                    `├ <b>CA:</b> <code>${htmlEscape(candidate.tokenAddress)}</code>\n` +
                    `├ <b>Status:</b> ⚪ SKIPPED\n` +
                    `└ <b>Reason:</b> <i>${htmlEscape(result.reason)}</i>`, { 
                      parse_mode: 'HTML',
                      reply_markup: { inline_keyboard: [[{ text: '🔍 Scan Token', callback_data: `refresh:${candidate.tokenAddress}` }]] }
                    });
                } catch { /* Best effort notification. */ }
              }
            }
          } catch (error) {
            logger.error({ error, userId: config.user_id, pool: candidate.pairAddress },
              'Sniper evaluation failed; candidate will remain retriable');
          }
        }
      }

      // Notify live feed subscribers that a cycle finished
      for (const userId of liveFeedSubscribers) {
        try {
          // Check if sniper is enabled for this user to avoid spamming if they only want trending
          const cfg = await this.sniperRepo.getOrCreateConfig(userId);
          if (cfg.enabled) {
            await this.botApi.sendMessage(userId, `🔄 <b>SNIPER CYCLE COMPLETE</b>\n└ Memindai <b>${pools.length}</b> token baru. Standby untuk siklus berikutnya...`, { parse_mode: 'HTML' });
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
