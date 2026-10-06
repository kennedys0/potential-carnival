export interface SecurityEvaluationInput {
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  dangerousExtensions: string[];
  lpBurnedOrLocked: boolean;
  top10HolderPercent: number;
  deployerHoldingPercent: number;
  liquidityUsd: number;
  marketCapUsd: number;
  sellSimulationSuccess: boolean;
  effectiveTaxPercent: number;
  deployerRugCount: number;
}

export interface SecurityScoreResult {
  score: number;
  level: 'SAFE' | 'CAUTION' | 'DANGER';
  isHardBlocked: boolean;
  hardBlockReasons: string[];
  riskFlags: string[];
}

export class ScoreCalculator {
  static calculate(input: SecurityEvaluationInput): SecurityScoreResult {
    const hardBlockReasons: string[] = [];
    const riskFlags: string[] = [];

    // HARD BLOCKS (Immediate rejection / Score = 0)
    if (input.mintAuthorityActive) hardBlockReasons.push('Mint authority still active');
    if (input.freezeAuthorityActive) hardBlockReasons.push('Freeze authority still active');
    if (input.dangerousExtensions.length > 0) {
      hardBlockReasons.push(`Dangerous Token-2022 extensions: ${input.dangerousExtensions.join(', ')}`);
    }
    if (!input.sellSimulationSuccess) hardBlockReasons.push('Sell simulation failed (Honeypot risk)');
    if (input.effectiveTaxPercent > 5.0) hardBlockReasons.push(`Excessive tax: ${input.effectiveTaxPercent}%`);
    if (input.liquidityUsd < 2000) hardBlockReasons.push(`Liquidity too low: $${input.liquidityUsd}`);

    if (hardBlockReasons.length > 0) {
      return {
        score: 0,
        level: 'DANGER',
        isHardBlocked: true,
        hardBlockReasons,
        riskFlags: hardBlockReasons,
      };
    }

    // DYNAMIC SCORING (Max 100)
    let score = 0;

    // LP Status (25 pts)
    if (input.lpBurnedOrLocked) {
      score += 25;
    } else {
      riskFlags.push('LP is not burned or locked');
    }

    // Top 10 Holder concentration (20 pts)
    if (input.top10HolderPercent <= 15) {
      score += 20;
    } else if (input.top10HolderPercent <= 25) {
      score += 10;
      riskFlags.push(`Moderate holder concentration: Top 10 holds ${input.top10HolderPercent.toFixed(1)}%`);
    } else {
      riskFlags.push(`High holder concentration: Top 10 holds ${input.top10HolderPercent.toFixed(1)}%`);
    }

    // Deployer Holding (15 pts)
    if (input.deployerHoldingPercent <= 2) {
      score += 15;
    } else if (input.deployerHoldingPercent <= 5) {
      score += 8;
      riskFlags.push(`Deployer holds ${input.deployerHoldingPercent.toFixed(1)}%`);
    } else {
      riskFlags.push(`High deployer balance: ${input.deployerHoldingPercent.toFixed(1)}%`);
    }

    // Liquidity Depth (20 pts)
    if (input.liquidityUsd >= 50000) {
      score += 20;
    } else if (input.liquidityUsd >= 15000) {
      score += 15;
    } else {
      score += 8;
      riskFlags.push(`Low liquidity: $${Math.round(input.liquidityUsd)}`);
    }

    // Deployer History (10 pts)
    if (input.deployerRugCount === 0) {
      score += 10;
    } else {
      riskFlags.push(`Deployer has ${input.deployerRugCount} rugged projects`);
    }

    // Effective Tax (10 pts)
    if (input.effectiveTaxPercent <= 0.5) {
      score += 10;
    } else {
      score += 5;
      riskFlags.push(`Tax detected: ${input.effectiveTaxPercent}%`);
    }

    let level: 'SAFE' | 'CAUTION' | 'DANGER' = 'DANGER';
    if (score >= 80) level = 'SAFE';
    else if (score >= 60) level = 'CAUTION';

    return {
      score,
      level,
      isHardBlocked: false,
      hardBlockReasons: [],
      riskFlags,
    };
  }
}
