import { Keypair, PublicKey } from '@solana/web3.js';
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

  it('excludes pool, LP, vault, and burn addresses from top holder concentration', async () => {
    const mintPubkey = Keypair.generate().publicKey;
    const mint = mintPubkey.toBase58();
    const supply = 1_000_000_000n; // 1 Billion tokens

    // 1. Raydium AMM V4 pool vault (holds 800M tokens = 80%)
    const poolVaultPubkey = Keypair.generate().publicKey;
    const raydiumAuthorityPubkey = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
    const poolVaultData = Buffer.alloc(165);
    mintPubkey.toBuffer().copy(poolVaultData, 0);
    raydiumAuthorityPubkey.toBuffer().copy(poolVaultData, 32);
    poolVaultData.writeBigUInt64LE(800_000_000n, 64);

    // 2. Burn / Incinerator address (holds 100M tokens = 10%)
    const burnAccountPubkey = Keypair.generate().publicKey;
    const incineratorPubkey = new PublicKey('1nc1nerator11111111111111111111111111111111');
    const burnAccountData = Buffer.alloc(165);
    mintPubkey.toBuffer().copy(burnAccountData, 0);
    incineratorPubkey.toBuffer().copy(burnAccountData, 32);
    burnAccountData.writeBigUInt64LE(100_000_000n, 64);

    // 3. User 1 (holds 30M tokens = 3% of total, 3.33% of non-burned supply)
    const user1Pubkey = Keypair.generate().publicKey;
    const user1Owner = Keypair.generate().publicKey;
    const user1Data = Buffer.alloc(165);
    mintPubkey.toBuffer().copy(user1Data, 0);
    user1Owner.toBuffer().copy(user1Data, 32);
    user1Data.writeBigUInt64LE(30_000_000n, 64);

    // 4. User 2 (holds 20M tokens = 2% of total, 2.22% of non-burned supply)
    const user2Pubkey = Keypair.generate().publicKey;
    const user2Owner = Keypair.generate().publicKey;
    const user2Data = Buffer.alloc(165);
    mintPubkey.toBuffer().copy(user2Data, 0);
    user2Owner.toBuffer().copy(user2Data, 32);
    user2Data.writeBigUInt64LE(20_000_000n, 64);

    const connection: any = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          { address: poolVaultPubkey, amount: '800000000', decimals: 0, uiAmount: 800000000, uiAmountString: '800000000' },
          { address: burnAccountPubkey, amount: '100000000', decimals: 0, uiAmount: 100000000, uiAmountString: '100000000' },
          { address: user1Pubkey, amount: '30000000', decimals: 0, uiAmount: 30000000, uiAmountString: '30000000' },
          { address: user2Pubkey, amount: '20000000', decimals: 0, uiAmount: 20000000, uiAmountString: '20000000' },
        ],
      }),
      getMultipleAccountsInfo: vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
        return pubkeys.map(pk => {
          const str = pk.toBase58();
          if (str === poolVaultPubkey.toBase58()) {
            return { data: poolVaultData, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 1000 };
          }
          if (str === burnAccountPubkey.toBase58()) {
            return { data: burnAccountData, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 1000 };
          }
          if (str === user1Pubkey.toBase58()) {
            return { data: user1Data, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 1000 };
          }
          if (str === user2Pubkey.toBase58()) {
            return { data: user2Data, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 1000 };
          }
          return null;
        });
      }),
    };

    const analyzer = new HolderAnalyzer(connection);
    const result = await analyzer.analyzeHolders(mint, supply);

    // Top regular holders are User 1 (30M) + User 2 (20M) = 50M out of 900M non-burned = ~5.56% (or <= 5.6%)
    // Without exclusion, top 10 would falsely include 80% pool + 10% burn = 95%!
    expect(result.top10Percent.status).toBe('OK');
    expect(result.top10Percent.value).toBeLessThanOrEqual(6);
    expect(result.largestHolderPercent.value).toBeLessThanOrEqual(3.5);
    expect(result.excludedHoldersCount).toBe(2);
    expect(result.poolPercent?.value).toBe(80);
    expect(result.burnedPercent?.value).toBe(10);
  });

  it('excludes caller-supplied pairAddress or poolAddress from top holders', async () => {
    const mintPubkey = Keypair.generate().publicKey;
    const mint = mintPubkey.toBase58();
    const supply = 100_000_000n;
    const pairAddressPubkey = Keypair.generate().publicKey;
    const userPubkey = Keypair.generate().publicKey;

    const connection: any = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          { address: pairAddressPubkey, amount: '70000000', decimals: 0, uiAmount: 70000000, uiAmountString: '70000000' },
          { address: userPubkey, amount: '30000000', decimals: 0, uiAmount: 30000000, uiAmountString: '30000000' },
        ],
      }),
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([
        null, null,
      ]),
    };

    const analyzer = new HolderAnalyzer(connection);
    const result = await analyzer.analyzeHolders(mint, supply, {
      pairAddress: pairAddressPubkey.toBase58(),
    });

    expect(result.top10Percent.status).toBe('OK');
    // pairAddress is excluded, so only userPubkey (30M out of 100M = 30%) remains
    expect(result.top10Percent.value).toBe(30);
    expect(result.largestHolderPercent.value).toBe(30);
    expect(result.excludedHoldersCount).toBe(1);
  });

  it('identifies PDA pool vault owned by a known DEX program on-chain', async () => {
    const mintPubkey = Keypair.generate().publicKey;
    const mint = mintPubkey.toBase58();
    const supply = 1_000_000_000n;

    // Pump.fun bonding curve PDA
    const bondingCurvePda = Keypair.generate().publicKey;
    const bondingCurveVaultPubkey = Keypair.generate().publicKey;
    const pumpProgramId = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

    const vaultData = Buffer.alloc(165);
    mintPubkey.toBuffer().copy(vaultData, 0);
    bondingCurvePda.toBuffer().copy(vaultData, 32);
    vaultData.writeBigUInt64LE(900_000_000n, 64);

    const userPubkey = Keypair.generate().publicKey;
    const userOwner = Keypair.generate().publicKey;
    const userData = Buffer.alloc(165);
    mintPubkey.toBuffer().copy(userData, 0);
    userOwner.toBuffer().copy(userData, 32);
    userData.writeBigUInt64LE(100_000_000n, 64);

    const connection: any = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({
        value: [
          { address: bondingCurveVaultPubkey, amount: '900000000', decimals: 0, uiAmount: 900000000, uiAmountString: '900000000' },
          { address: userPubkey, amount: '100000000', decimals: 0, uiAmount: 100000000, uiAmountString: '100000000' },
        ],
      }),
      getMultipleAccountsInfo: vi.fn().mockImplementation(async (pubkeys: PublicKey[]) => {
        return pubkeys.map(pk => {
          const str = pk.toBase58();
          if (str === bondingCurveVaultPubkey.toBase58()) {
            return { data: vaultData, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 1000 };
          }
          if (str === userPubkey.toBase58()) {
            return { data: userData, executable: false, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 1000 };
          }
          if (str === bondingCurvePda.toBase58()) {
            // The PDA is owned by the Pump.fun bonding curve program!
            return { data: Buffer.alloc(100), executable: false, owner: pumpProgramId, lamports: 5000 };
          }
          if (str === userOwner.toBase58()) {
            // User wallet is owned by System program
            return { data: Buffer.alloc(0), executable: false, owner: new PublicKey('11111111111111111111111111111111'), lamports: 5000 };
          }
          return null;
        });
      }),
    };

    const analyzer = new HolderAnalyzer(connection);
    const result = await analyzer.analyzeHolders(mint, supply);

    // Bonding curve vault (900M = 90%) is excluded because its owner PDA is owned by Pump.fun program!
    // Only user (100M = 10%) is counted as regular holder.
    expect(result.top10Percent.status).toBe('OK');
    expect(result.top10Percent.value).toBe(10);
    expect(result.largestHolderPercent.value).toBe(10);
    expect(result.excludedHoldersCount).toBe(1);
    expect(result.poolPercent?.value).toBe(90);
  });
});
