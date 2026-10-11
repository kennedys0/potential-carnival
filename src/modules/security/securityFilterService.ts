import { Connection, PublicKey } from '@solana/web3.js';
import { AuthorityChecker } from './authorityChecker';
import { Token2022Inspector } from './token2022Inspector';
import { HolderAnalyzer } from './holderAnalyzer';
import { HoneypotSimulator } from './honeypotSimulator';
import { ScoreCalculator, SecurityEvaluationInput, SecurityScoreResult, FactorResult } from './scoreCalculator';

export class SecurityFilterService {
  private readonly authorityChecker: AuthorityChecker;
  private readonly holderAnalyzer: HolderAnalyzer;
  private readonly honeypotSimulator: HoneypotSimulator;

  constructor(
    private readonly connection: Connection,
    jupiterClient?: any
  ) {
    this.authorityChecker = new AuthorityChecker(connection);
    this.holderAnalyzer = new HolderAnalyzer(connection);
    this.honeypotSimulator = new HoneypotSimulator(jupiterClient, connection);
  }

  async evaluateToken(
    mintAddress: string,
    marketData: {
      liquidityUsd: number | null;
      marketCapUsd: number | null;
      lpBurned?: boolean;
    }
  ): Promise<SecurityScoreResult> {
    const sellSimulationPromise = this.honeypotSimulator.simulateSell(mintAddress);
    const authority = await this.authorityChecker.checkAuthorities(mintAddress);
    
    let dangerousExtensionsPromise = Promise.resolve({ value: [], status: 'OK', source: 'Default' } as FactorResult<string[]>);
    if (authority.programId) {
      dangerousExtensionsPromise = Token2022Inspector.inspectExtensions(
        this.connection,
        new PublicKey(mintAddress),
        authority.programId
      );
    }

    const holderResultPromise = this.holderAnalyzer.analyzeHolders(mintAddress, authority.totalSupplyRaw);

    const [dangerousExtensions, holderResult, sellSimulation] = await Promise.all([
      dangerousExtensionsPromise,
      holderResultPromise,
      sellSimulationPromise
    ]);

    // Deployer holding logic: normally resolved from on-chain tx history or API (e.g. RugCheck)
    // For now we'll mark it as unavailable so it correctly lowers coverage instead of assuming SAFE
    const deployerHoldingPercent: FactorResult<number> = { value: null, status: 'UNAVAILABLE', source: 'Missing Deployer Resolution API' };
    const deployerRugCount: FactorResult<number> = { value: null, status: 'UNAVAILABLE', source: 'Missing RugCheck API' };

    const lpBurnedOrLocked: FactorResult<boolean> = marketData.lpBurned !== undefined 
      ? { value: marketData.lpBurned, status: 'OK', source: 'DexScreener API' }
      : { value: null, status: 'UNAVAILABLE', source: 'DexScreener API' };

    const liquidityUsd: FactorResult<number> = marketData.liquidityUsd !== null
      ? { value: marketData.liquidityUsd, status: 'OK', source: 'DexScreener API' }
      : { value: null, status: 'UNAVAILABLE', source: 'DexScreener API' };

    const marketCapUsd: FactorResult<number> = marketData.marketCapUsd !== null
      ? { value: marketData.marketCapUsd, status: 'OK', source: 'DexScreener API' }
      : { value: null, status: 'UNAVAILABLE', source: 'DexScreener API' };

    const input: SecurityEvaluationInput = {
      mintAuthorityActive: authority.mintAuthorityActive,
      freezeAuthorityActive: authority.freezeAuthorityActive,
      dangerousExtensions,
      lpBurnedOrLocked,
      top10HolderPercent: holderResult.top10Percent,
      deployerHoldingPercent,
      liquidityUsd,
      marketCapUsd,
      sellSimulationSuccess: sellSimulation.canSell,
      effectiveTaxPercent: sellSimulation.effectiveTaxPercent,
      deployerRugCount,
    };

    return ScoreCalculator.calculate(input);
  }
}
