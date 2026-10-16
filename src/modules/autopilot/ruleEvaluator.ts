import { SecurityScoreResult } from '../security/scoreCalculator';
import { AiAnalysis } from '../analyzer/analyzerService';

export interface AutopilotSafetyFilterParams {
  minSafetyScore: number;
  allowedLevels: string[];
  minLiquidityUsd: number;
  maxTop10Percent?: number;
  maxDeployerPercent?: number;
  requireLpBurnOrLock?: boolean;
}

export interface AutopilotAiCriteriaParams {
  minConfidence: number;
  minRiskReward: number;
  allowedSetups: string[];
  requireAi?: boolean;
}

export class RuleEvaluator {
  static evaluateCriticalChecks(
    security: SecurityScoreResult,
    safetyParams: AutopilotSafetyFilterParams,
  ): { passed: string[]; failed: string[] } {
    const passed: string[] = [];
    const failed: string[] = [];
    const checks = security.criticalChecks;

    if (safetyParams.requireLpBurnOrLock) {
      if (checks?.lpBurnedOrLocked === true) passed.push('LP burn/lock verified');
      else
        failed.push(
          checks?.lpBurnedOrLocked === false
            ? 'LP is not burned or locked'
            : 'LP burn/lock status is unavailable',
        );
    }

    if (safetyParams.maxTop10Percent !== undefined) {
      const actual = checks?.top10HolderPercent;
      if (actual === null || actual === undefined) {
        failed.push('Top-10 holder concentration is unavailable');
      } else if (actual > safetyParams.maxTop10Percent) {
        failed.push(`Top-10 holder concentration ${actual}% exceeds ${safetyParams.maxTop10Percent}%`);
      } else {
        passed.push(`Top-10 holder concentration ${actual}% <= ${safetyParams.maxTop10Percent}%`);
      }
    }

    if (safetyParams.maxDeployerPercent !== undefined) {
      const actual = checks?.deployerHoldingPercent;
      if (actual === null || actual === undefined) {
        failed.push('Deployer holding is unavailable');
      } else if (actual > safetyParams.maxDeployerPercent) {
        failed.push(`Deployer holding ${actual}% exceeds ${safetyParams.maxDeployerPercent}%`);
      } else {
        passed.push(`Deployer holding ${actual}% <= ${safetyParams.maxDeployerPercent}%`);
      }
    }

    return { passed, failed };
  }

  /**
   * Panggil fungsi ini SEBELUM memanggil LLM agar tidak membuang waktu/kredit API
   * untuk token yang sudah pasti gagal di filter keamanan atau likuiditas.
   */
  static evaluatePreAiSafety(
    security: SecurityScoreResult,
    safetyParams: AutopilotSafetyFilterParams,
    liquidityUsd: number,
  ): {
    canProceedToAi: boolean;
    action?: 'SKIP' | 'REJECT';
    reason?: string;
    rulesPassed: string[];
    rulesFailed: string[];
  } {
    const rulesPassed: string[] = [];
    const rulesFailed: string[] = [];

    if (security.isHardBlocked) {
      rulesFailed.push(...security.hardBlockReasons);
      return {
        canProceedToAi: false,
        action: 'REJECT',
        reason: `Hard-block triggered: ${security.hardBlockReasons.join('; ')}`,
        rulesPassed,
        rulesFailed,
      };
    }

    const criticalPolicy = this.evaluateCriticalChecks(security, safetyParams);
    rulesPassed.push(...criticalPolicy.passed);
    rulesFailed.push(...criticalPolicy.failed);

    if (security.score < safetyParams.minSafetyScore) {
      rulesFailed.push(`Safety score ${security.score} below minimum ${safetyParams.minSafetyScore}`);
    } else {
      rulesPassed.push(`Safety score ${security.score} >= ${safetyParams.minSafetyScore}`);
    }

    if (!safetyParams.allowedLevels.includes(security.level)) {
      rulesFailed.push(`Safety level ${security.level} not in allowed list`);
    } else {
      rulesPassed.push(`Safety level ${security.level} allowed`);
    }

    if (liquidityUsd < safetyParams.minLiquidityUsd) {
      rulesFailed.push(`Liquidity $${liquidityUsd} below minimum $${safetyParams.minLiquidityUsd}`);
    } else {
      rulesPassed.push(`Liquidity $${liquidityUsd} >= $${safetyParams.minLiquidityUsd}`);
    }

    if (rulesFailed.length > 0) {
      return {
        canProceedToAi: false,
        action: 'SKIP',
        reason: rulesFailed.join('; '),
        rulesPassed,
        rulesFailed,
      };
    }

    return {
      canProceedToAi: true,
      rulesPassed,
      rulesFailed,
    };
  }

  static evaluate(
    security: SecurityScoreResult,
    ai: AiAnalysis | null,
    safetyParams: AutopilotSafetyFilterParams,
    aiParams: AutopilotAiCriteriaParams,
    liquidityUsd: number,
    currentPriceUsd: number,
    indicators?: any,
  ): {
    passed: boolean;
    action: 'BUY' | 'SKIP' | 'REJECT';
    reason: string;
    rulesPassed: string[];
    rulesFailed: string[];
  } {
    const preCheck = this.evaluatePreAiSafety(security, safetyParams, liquidityUsd);
    if (preCheck.action === 'REJECT') {
      return {
        passed: false,
        action: 'REJECT',
        reason: preCheck.reason!,
        rulesPassed: preCheck.rulesPassed,
        rulesFailed: preCheck.rulesFailed,
      };
    }

    const rulesPassed = [...preCheck.rulesPassed];
    const rulesFailed = [...preCheck.rulesFailed];

    // 5. AI Verdict & Criteria
    if (!ai) {
      if (aiParams.requireAi !== false) {
        if (!indicators) {
          rulesFailed.push('Riwayat candle belum cukup untuk kalkulasi teknikal (<21 candle)');
        } else {
          rulesFailed.push('Layanan AI tidak merespons (AI analysis unavailable)');
        }
      } else {
        if (indicators) {
          // Jalur eksplisit "early momentum" (pool baru < 21 candle): TIDAK ada EMA/RSI sintetis.
          // Nilai dari DATA REAL (m5 change, rasio buy/sell, volume) — tercatat apa adanya di log.
          if (indicators.isEarlyMomentum && indicators.earlyMomentum) {
            const em = indicators.earlyMomentum;
            let earlyPassed = true;
            const buyPressure = em.buysM5 > em.sellsM5 && em.buysM5 >= 3;
            const emChecks: Array<{ ok: boolean; passMsg: string; failMsg: string }> = [
              {
                ok: em.m5VolumeUsd > 0,
                passMsg: `Early momentum: volume m5 $${em.m5VolumeUsd.toFixed(0)} > 0`,
                failMsg: 'Early momentum: tidak ada volume m5',
              },
              {
                ok: em.priceVsFirstOpenPct >= 0 || em.m5ChangePct > 0 || buyPressure,
                passMsg: `Early momentum: aksi beli awal (vs open ${em.priceVsFirstOpenPct.toFixed(1)}%, m5 ${em.m5ChangePct.toFixed(1)}%, ${em.buysM5} buys vs ${em.sellsM5} sells)`,
                failMsg: `Early momentum: tidak ada aksi beli awal (vs open ${em.priceVsFirstOpenPct.toFixed(1)}%, m5 ${em.m5ChangePct.toFixed(1)}%)`,
              },
            ];
            for (const c of emChecks) {
              if (c.ok) {
                rulesPassed.push(c.passMsg);
              } else {
                rulesFailed.push(c.failMsg);
                earlyPassed = false;
              }
            }
            if (!earlyPassed) {
              rulesFailed.push('Early momentum criteria not met');
            }
          } else {
            let fallbackPassed = true;
            // Guard NaN eksplisit: tanpa ini, NaN <= NaN = false membuat gate lolos vakum.
            if (!Number.isFinite(indicators.ema9) || !Number.isFinite(indicators.ema21) || indicators.ema9 <= indicators.ema21) {
              rulesFailed.push(
                `Fallback: EMA9 (${indicators.ema9}) <= EMA21 (${indicators.ema21}) atau tidak valid`,
              );
              fallbackPassed = false;
            } else {
              rulesPassed.push('Fallback: EMA9 > EMA21 (Bullish trend)');
            }
            if (!Number.isFinite(indicators.rsi14) || indicators.rsi14 >= 70 || indicators.rsi14 <= 30) {
              rulesFailed.push(`Fallback: RSI14 (${indicators.rsi14}) out of safe zone (30-70) atau tidak valid`);
              fallbackPassed = false;
            } else {
              rulesPassed.push('Fallback: RSI14 is safe');
            }
            if (!Number.isFinite(indicators.volumeSpikeRatio) || indicators.volumeSpikeRatio < 1.5) {
              rulesFailed.push(`Fallback: Volume Spike (${indicators.volumeSpikeRatio}) < 1.5x atau tidak valid`);
              fallbackPassed = false;
            } else {
              rulesPassed.push('Fallback: Volume Spike >= 1.5x');
            }

            if (!fallbackPassed) {
              rulesFailed.push('Fallback indicators criteria not met');
            }
          }
        } else {
          rulesFailed.push('AI unavailable and technical indicators are unavailable');
        }
      }
    } else {
      if (ai.verdict !== 'BUY') {
        const aiReasons =
          ai.key_reasons && ai.key_reasons.length > 0 ? ` karena ${ai.key_reasons.join(', ')}` : '';
        rulesFailed.push(`AI verdict was ${ai.verdict}${aiReasons}`);
      } else {
        rulesPassed.push('AI verdict BUY');
      }

      if (ai.confidence < aiParams.minConfidence) {
        rulesFailed.push(`AI confidence ${ai.confidence}% below minimum ${aiParams.minConfidence}%`);
      } else {
        rulesPassed.push(`AI confidence ${ai.confidence}% >= ${aiParams.minConfidence}%`);
      }

      // P0 (review GPT): R:R OTORITATIF dihitung deterministik dari level SL/TP AI.
      // Angka klaim LLM (risk_reward_ratio) TIDAK dipakai untuk keputusan — hanya untuk log.
      // Contoh serangan yang dicegah: RR aktual 0.8 diklaim 1.5 dan lolos karena toleransi ±1.0.
      const tpPrices = (ai.take_profit_levels ?? [])
        .map((tp) => tp.price_usd)
        .filter((p) => Number.isFinite(p) && p > currentPriceUsd);
      const nearestTp = tpPrices.length > 0 ? Math.min(...tpPrices) : NaN;
      const riskDistance = currentPriceUsd - ai.stop_loss_usd;
      const authoritativeRR =
        Number.isFinite(nearestTp) && riskDistance > 0
          ? (nearestTp - currentPriceUsd) / riskDistance
          : NaN;
      if (!Number.isFinite(authoritativeRR)) {
        rulesFailed.push('Cannot compute deterministic R:R from AI SL/TP levels');
      } else if (authoritativeRR < aiParams.minRiskReward) {
        rulesFailed.push(
          `Deterministic R:R ${authoritativeRR.toFixed(2)} below minimum ${aiParams.minRiskReward} (LLM claimed ${ai.risk_reward_ratio})`
        );
      } else {
        rulesPassed.push(`Deterministic R:R ${authoritativeRR.toFixed(2)} >= ${aiParams.minRiskReward}`);
      }

      const setupType = String(ai.setup_type ?? '')
        .trim()
        .toUpperCase();
      const allowedSetups = aiParams.allowedSetups
        .map((setup) => String(setup).trim().toUpperCase())
        .filter((setup) => setup.length > 0);
      if (!setupType || setupType === 'NONE') {
        rulesFailed.push('AI setup type is not actionable');
      } else if (allowedSetups.length === 0 || !allowedSetups.includes(setupType)) {
        rulesFailed.push(`AI setup ${setupType} not in allowed setup list`);
      } else {
        rulesPassed.push(`AI setup ${setupType} allowed`);
      }

      // Deterministic validation of AI-generated financial parameters
      if (!Number.isFinite(ai.stop_loss_usd) || ai.stop_loss_usd <= 0) {
        rulesFailed.push(`Invalid AI Stop Loss value: ${ai.stop_loss_usd}`);
      } else if (currentPriceUsd > 0) {
        const slDistancePct = ((currentPriceUsd - ai.stop_loss_usd) / currentPriceUsd) * 100;
        if (slDistancePct < 2) {
          rulesFailed.push(`AI Stop Loss too tight: ${slDistancePct.toFixed(2)}% (min 2%)`);
        } else if (slDistancePct > 50) {
          rulesFailed.push(`AI Stop Loss too wide: ${slDistancePct.toFixed(2)}% (max 50%)`);
        } else {
          rulesPassed.push(`AI Stop Loss distance valid: ${slDistancePct.toFixed(2)}%`);
        }
      }
    }

    if (rulesFailed.length > 0) {
      return {
        passed: false,
        action: 'SKIP',
        reason: rulesFailed.join('; '),
        rulesPassed,
        rulesFailed,
      };
    }

    return {
      passed: true,
      action: 'BUY',
      reason: 'All safety and AI criteria passed',
      rulesPassed,
      rulesFailed: [],
    };
  }
}
