import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { HolderAnalyzer } from '../../src/modules/security/holderAnalyzer';

describe('HolderAnalyzer raw amount accounting', () => {
  it('uses raw BigInt amounts when uiAmount is null and values exceed 2^53', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const supply = 100_000_000_000_000_000_000n;
    const connection: any = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          { amount: '12000000000000000000', decimals: 20, uiAmount: null, uiAmountString: '0.12' },
          { amount: '8000000000000000000', decimals: 20, uiAmount: null, uiAmountString: '0.08' },
          { amount: '1000000000000000000', decimals: 20, uiAmount: null, uiAmountString: '0.01' },
        ],
      }),
    };

    const result = await new HolderAnalyzer(connection).analyzeHolders(mint, supply);

    expect(result.top10Percent).toMatchObject({ status: 'OK', value: 21 });
    expect(result.largestHolderPercent).toMatchObject({ status: 'OK', value: 12 });
    expect(result.totalHoldersSampled).toBe(3);
  });

  it('sorts by raw balance instead of trusting RPC order', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const connection: any = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          { amount: '10', decimals: 0, uiAmount: 10, uiAmountString: '10' },
          { amount: '60', decimals: 0, uiAmount: 60, uiAmountString: '60' },
          { amount: '30', decimals: 0, uiAmount: 30, uiAmountString: '30' },
        ],
      }),
    };

    const result = await new HolderAnalyzer(connection).analyzeHolders(mint, 200n);
    expect(result.largestHolderPercent.value).toBe(30);
    expect(result.top10Percent.value).toBe(50);
  });

  it('fails closed on zero supply or internally inconsistent RPC balances', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const connection: any = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [{ amount: '101', decimals: 0, uiAmount: 101, uiAmountString: '101' }],
      }),
    };
    const analyzer = new HolderAnalyzer(connection);

    await expect(analyzer.analyzeHolders(mint, 0n)).resolves.toMatchObject({
      top10Percent: { status: 'UNAVAILABLE', value: null },
    });
    await expect(analyzer.analyzeHolders(mint, 100n)).resolves.toMatchObject({
      top10Percent: { status: 'UNAVAILABLE', value: null },
    });
  });
});
