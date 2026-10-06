import { DexScreenerClient, DexScreenerPair } from './dexScreenerClient';

export class ScannerService {
  constructor(private readonly dexScreener: DexScreenerClient) {}

  async scanTokenByAddress(tokenAddress: string): Promise<DexScreenerPair | null> {
    return this.dexScreener.getTokenData(tokenAddress);
  }
}
