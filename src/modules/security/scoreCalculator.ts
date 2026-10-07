import { appSettings } from '../../config/settings';

export interface FactorResult<T> {
  value: T | null;
  status: 'OK' | 'UNAVAILABLE';
  source: string;
}

export interface SecurityEvaluationInput {
  mintAuthorityActive: FactorResult<boolean>;
  freezeAuthorityActive: FactorResult<boolean>;
  dangerousExtensions: FactorResult<string[]>;
  lpBurnedOrLocked: FactorResult<boolean>;
  top10HolderPercent: FactorResult<number>;
  deployerHoldingPercent: FactorResult<number>;
  liquidityUsd: FactorResult<number>;
  marketCapUsd: FactorResult<number>;
  sellSimulationSuccess: FactorResult<boolean>;
  effectiveTaxPercent: FactorResult<number>;
  deployerRugCount: FactorResult<number>;
}

export interface FactorReport {
  name: string;
  value: string;
  source: string;
}

export interface SecurityScoreResult {
  score: number;
  level: 'SAFE' | 'CAUTION' | 'DANGER' | 'UNVERIFIED';
  isHardBlocked: boolean;
  hardBlockReasons: string[];
  riskFlags: string[];
  coverage: number;
  report: FactorReport[];
}

export class ScoreCalculator {
  static calculate(input: SecurityEvaluationInput): SecurityScoreResult {
    const hardBlockReasons: string[] = [];
    const riskFlags: string[] = [];
    const report: FactorReport[] = [];
    
    const settings = appSettings.SECURITY_PARAMS;
    let score = 0;
    let availableWeights = 0;
    const totalWeights = 100;

    const addReport = (name: string, factor: FactorResult<any>, formattedValue: string) => {
      report.push({
        name,
        value: factor.status === 'OK' ? formattedValue : 'N/A',
        source: factor.source || 'Unknown'
      });
    };

    // HARD BLOCKS & CRITICAL FACTORS (Must be available)
    addReport('Mint Authority', input.mintAuthorityActive, input.mintAuthorityActive.value ? 'Active' : 'Renounced');
    if (input.mintAuthorityActive.status === 'UNAVAILABLE') {
      hardBlockReasons.push('Mint authority data UNAVAILABLE');
    } else if (input.mintAuthorityActive.value) {
      hardBlockReasons.push('Mint authority still active');
    }

    addReport('Freeze Authority', input.freezeAuthorityActive, input.freezeAuthorityActive.value ? 'Active' : 'Renounced');
    if (input.freezeAuthorityActive.status === 'UNAVAILABLE') {
      hardBlockReasons.push('Freeze authority data UNAVAILABLE');
    } else if (input.freezeAuthorityActive.value) {
      hardBlockReasons.push('Freeze authority still active');
    }

    addReport('Dangerous Extensions', input.dangerousExtensions, input.dangerousExtensions.value?.length ? input.dangerousExtensions.value.join(', ') : 'None');
    if (input.dangerousExtensions.status === 'OK' && input.dangerousExtensions.value && input.dangerousExtensions.value.length > 0) {
      hardBlockReasons.push(`Dangerous Token-2022 extensions: ${input.dangerousExtensions.value.join(', ')}`);
    }

    addReport('Sell Simulation', input.sellSimulationSuccess, input.sellSimulationSuccess.value ? 'Success' : 'Failed');
    if (input.sellSimulationSuccess.status === 'UNAVAILABLE') {
      hardBlockReasons.push('Sell simulation route data UNAVAILABLE');
    } else if (!input.sellSimulationSuccess.value) {
      hardBlockReasons.push('Sell simulation failed (Honeypot risk)');
    }

    addReport('Liquidity', input.liquidityUsd, `$${input.liquidityUsd.value?.toFixed(2)}`);
    if (input.liquidityUsd.status === 'UNAVAILABLE') {
      hardBlockReasons.push('Liquidity data UNAVAILABLE');
    } else if (input.liquidityUsd.value! < settings.MIN_LIQUIDITY_USD) {
      hardBlockReasons.push(`Liquidity too low: $${input.liquidityUsd.value}`);
    }

    addReport('Tax', input.effectiveTaxPercent, `${input.effectiveTaxPercent.value}%`);
    if (input.effectiveTaxPercent.status === 'OK' && input.effectiveTaxPercent.value! > settings.MAX_TAX_PERCENT) {
      hardBlockReasons.push(`Excessive tax: ${input.effectiveTaxPercent.value}%`);
    }

    // DYNAMIC SCORING
    // LP Status
    addReport('LP Locked/Burned', input.lpBurnedOrLocked, input.lpBurnedOrLocked.value ? 'Yes' : 'No');
    if (input.lpBurnedOrLocked.status === 'OK') {
      availableWeights += settings.WEIGHTS.LP_STATUS;
      if (input.lpBurnedOrLocked.value) {
        score += settings.WEIGHTS.LP_STATUS;
      } else {
        riskFlags.push('LP is not burned or locked');
      }
    }

    // Top 10 Holder concentration
    addReport('Top 10 Holders', input.top10HolderPercent, `${input.top10HolderPercent.value?.toFixed(1)}%`);
    if (input.top10HolderPercent.status === 'OK') {
      availableWeights += settings.WEIGHTS.TOP10_HOLDER;
      const val = input.top10HolderPercent.value!;
      if (val <= settings.THRESHOLDS.TOP10_SAFE) {
        score += settings.WEIGHTS.TOP10_HOLDER;
      } else if (val <= settings.THRESHOLDS.TOP10_CAUTION) {
        score += (settings.WEIGHTS.TOP10_HOLDER / 2);
        riskFlags.push(`Moderate holder concentration: Top 10 holds ${val.toFixed(1)}%`);
      } else {
        riskFlags.push(`High holder concentration: Top 10 holds ${val.toFixed(1)}%`);
      }
    }

    // Deployer Holding
    addReport('Deployer Holding', input.deployerHoldingPercent, `${input.deployerHoldingPercent.value?.toFixed(1)}%`);
    if (input.deployerHoldingPercent.status === 'OK') {
      availableWeights += settings.WEIGHTS.DEPLOYER_HOLDING;
      const val = input.deployerHoldingPercent.value!;
      if (val <= settings.THRESHOLDS.DEPLOYER_SAFE) {
        score += settings.WEIGHTS.DEPLOYER_HOLDING;
      } else if (val <= settings.THRESHOLDS.DEPLOYER_CAUTION) {
        score += (settings.WEIGHTS.DEPLOYER_HOLDING / 2);
        riskFlags.push(`Deployer holds ${val.toFixed(1)}%`);
      } else {
        riskFlags.push(`High deployer balance: ${val.toFixed(1)}%`);
      }
    }

    // Liquidity Depth
    if (input.liquidityUsd.status === 'OK') {
      availableWeights += settings.WEIGHTS.LIQUIDITY_DEPTH;
      const val = input.liquidityUsd.value!;
      if (val >= settings.THRESHOLDS.LIQUIDITY_SAFE) {
        score += settings.WEIGHTS.LIQUIDITY_DEPTH;
      } else if (val >= settings.THRESHOLDS.LIQUIDITY_CAUTION) {
        score += (settings.WEIGHTS.LIQUIDITY_DEPTH * 0.75);
      } else {
        score += (settings.WEIGHTS.LIQUIDITY_DEPTH * 0.4);
        riskFlags.push(`Low liquidity depth: $${Math.round(val)}`);
      }
    }

    // Deployer History
    addReport('Deployer Rug Count', input.deployerRugCount, `${input.deployerRugCount.value}`);
    if (input.deployerRugCount.status === 'OK') {
      availableWeights += settings.WEIGHTS.DEPLOYER_HISTORY;
      const val = input.deployerRugCount.value!;
      if (val === 0) {
        score += settings.WEIGHTS.DEPLOYER_HISTORY;
      } else {
        riskFlags.push(`Deployer has ${val} rugged projects`);
      }
    }

    // Effective Tax
    if (input.effectiveTaxPercent.status === 'OK') {
      availableWeights += settings.WEIGHTS.EFFECTIVE_TAX;
      const val = input.effectiveTaxPercent.value!;
      if (val <= settings.THRESHOLDS.TAX_SAFE) {
        score += settings.WEIGHTS.EFFECTIVE_TAX;
      } else {
        score += (settings.WEIGHTS.EFFECTIVE_TAX / 2);
        riskFlags.push(`Tax detected: ${val}%`);
      }
    }

    const coverage = (availableWeights / totalWeights) * 100;
    
    // Hard blocks -> Score 0, DANGER
    if (hardBlockReasons.length > 0) {
      return {
        score: 0,
        level: 'DANGER',
        isHardBlocked: true,
        hardBlockReasons,
        riskFlags: [...new Set([...hardBlockReasons, ...riskFlags])],
        coverage,
        report,
      };
    }

    // Determine Level
    let level: 'SAFE' | 'CAUTION' | 'DANGER' | 'UNVERIFIED' = 'UNVERIFIED';
    
    // Scale score based on coverage (e.g. if you got 60 out of 60 available weights, that's 100% scaled score)
    const scaledScore = availableWeights > 0 ? (score / availableWeights) * 100 : 0;
    
    if (coverage < settings.MIN_COVERAGE_PERCENT) {
      level = 'UNVERIFIED';
    } else {
      if (scaledScore >= 80) level = 'SAFE';
      else if (scaledScore >= 60) level = 'CAUTION';
      else level = 'DANGER';
    }

    return {
      score: Math.round(scaledScore),
      level,
      isHardBlocked: false,
      hardBlockReasons: [],
      riskFlags,
      coverage,
      report,
    };
  }
}
