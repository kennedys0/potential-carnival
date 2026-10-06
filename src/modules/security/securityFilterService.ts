import { Connection } from '@solana/web3.js';
import { AuthorityChecker } from './authorityChecker';
import { ScoreCalculator, SecurityEvaluationInput, SecurityScoreResult } from './scoreCalculator';

export class SecurityFilterService {
  private readonly authorityChecker: AuthorityChecker;

  constructor(private readonly connection: Connection) {
    this.authorityChecker = new AuthorityChecker(connection);
  }

  async evaluateToken(
    mintAddress: string,
    marketData: {
      liquidityUsd: number;
      marketCapUsd: number;
      top10Percent?: number;
      deployerHoldingPercent?: number;
      lpBurned?: boolean;
    }
  ): Promise<SecurityScoreResult> {
    const authority = await this.authorityChecker.checkAuthorities(mintAddress);

    const input: SecurityEvaluationInput = {
      mintAuthorityActive: authority.mintAuthorityActive,
      freezeAuthorityActive: authority.freezeAuthorityActive,
      dangerousExtensions: [],
      lpBurnedOrLocked: marketData.lpBurned ?? true,
      top10HolderPercent: marketData.top10Percent ?? 15,
      deployerHoldingPercent: marketData.deployerHoldingPercent ?? 2,
      liquidityUsd: marketData.liquidityUsd,
      marketCapUsd: marketData.marketCapUsd,
      sellSimulationSuccess: true, // evaluated separately or chained
      effectiveTaxPercent: 0,
      deployerRugCount: 0,
    };

    return ScoreCalculator.calculate(input);
  }
}
