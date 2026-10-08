import { describe, it, expect } from 'vitest';
import { FillParser } from '../../src/modules/trader/fillParser';
import { ParsedTransactionWithMeta } from '@solana/web3.js';

describe('FillParser', () => {
  const walletPubkey = 'Wallet1111111111111111111111111111111111111';
  const mintPubkey = 'Token11111111111111111111111111111111111111';

  it('parses buy fill correctly with WSOL and 6 decimals', () => {
    const tx: any = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1000000000, 0, 0],
        postBalances: [900000000, 0, 0], // Spent 100,000,000 (0.1 SOL) + 5000 fee
        preTokenBalances: [],
        postTokenBalances: [
          { mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '1000000', decimals: 6 } }
        ]
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: { toBase58: () => walletPubkey } },
            { pubkey: { toBase58: () => mintPubkey } }
          ]
        }
      }
    };

    const result = FillParser.parseBuyFill(tx, walletPubkey, mintPubkey);
    expect(result).not.toBeNull();
    expect(result?.tokenDeltaRaw).toBe(1000000n);
    expect(result?.decimals).toBe(6);
    expect(result?.solDeltaLamports).toBe(100000000n - 5000n); // 99,995,000 spent on swap
    expect(result?.feeLamports).toBe(5000n);
  });

  it('parses sell fill correctly with 9 decimals', () => {
    const tx: any = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [900000000, 0, 0],
        postBalances: [1000000000, 0, 0], // Received 100,000,000 (0.1 SOL) - 5000 fee
        preTokenBalances: [
          { mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '1000000000', decimals: 9 } }
        ],
        postTokenBalances: [
          { mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '0', decimals: 9 } }
        ]
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: { toBase58: () => walletPubkey } },
            { pubkey: { toBase58: () => mintPubkey } }
          ]
        }
      }
    };

    const result = FillParser.parseSellFill(tx, walletPubkey, mintPubkey);
    expect(result).not.toBeNull();
    expect(result?.tokenDeltaRaw).toBe(1000000000n);
    expect(result?.decimals).toBe(9);
    expect(result?.solDeltaLamports).toBe(100000000n + 5000n); // 100,005,000 received from swap
    expect(result?.feeLamports).toBe(5000n);
  });

  it('returns null if transaction failed', () => {
    const tx: any = {
      meta: {
        err: { InstructionError: [0, 'CustomError'] },
      },
      transaction: { message: { accountKeys: [] } }
    };
    expect(FillParser.parseBuyFill(tx, walletPubkey, mintPubkey)).toBeNull();
  });

  it('returns null if wallet not in accountKeys', () => {
    const tx: any = {
      meta: { err: null, preBalances: [], postBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => mintPubkey } }] } }
    };
    expect(FillParser.parseBuyFill(tx, walletPubkey, mintPubkey)).toBeNull();
  });

  it('returns null if token delta is 0', () => {
    const tx: any = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1000000000],
        postBalances: [1000000000], 
        preTokenBalances: [],
        postTokenBalances: []
      },
      transaction: {
        message: {
          accountKeys: [ { pubkey: { toBase58: () => walletPubkey } } ]
        }
      }
    };
    expect(FillParser.parseBuyFill(tx, walletPubkey, mintPubkey)).toBeNull();
  });

  it('parses sell fill correctly when multiple token accounts exist and only one changes', () => {
    // Pengujian A — Account pertama tidak berubah
    const tx: any = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [900000000, 0, 0],
        postBalances: [1000000000, 0, 0],
        preTokenBalances: [
          { accountIndex: 1, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '100', decimals: 6 } },
          { accountIndex: 2, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '250', decimals: 6 } }
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '100', decimals: 6 } },
          { accountIndex: 2, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '200', decimals: 6 } }
        ]
      },
      transaction: { message: { accountKeys: [ { pubkey: { toBase58: () => walletPubkey } }, { pubkey: { toBase58: () => mintPubkey } } ] } }
    };
    const result = FillParser.parseSellFill(tx, walletPubkey, mintPubkey);
    expect(result).not.toBeNull();
    expect(result?.tokenDeltaRaw).toBe(50n); // 350 - 300 = 50
  });

  it('parses sell fill correctly when multiple token accounts exist and both change', () => {
    // Pengujian B — Kedua account berubah
    const tx: any = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [900000000, 0, 0],
        postBalances: [1000000000, 0, 0],
        preTokenBalances: [
          { accountIndex: 1, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '100', decimals: 6 } },
          { accountIndex: 2, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '250', decimals: 6 } }
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '80', decimals: 6 } },
          { accountIndex: 2, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '200', decimals: 6 } }
        ]
      },
      transaction: { message: { accountKeys: [ { pubkey: { toBase58: () => walletPubkey } }, { pubkey: { toBase58: () => mintPubkey } } ] } }
    };
    const result = FillParser.parseSellFill(tx, walletPubkey, mintPubkey);
    expect(result).not.toBeNull();
    expect(result?.tokenDeltaRaw).toBe(70n); // 350 - 280 = 70
  });

  it('parses buy fill correctly when a new token account is created', () => {
    // account didn't exist in pre, exists in post
    const tx: any = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1000000000, 0, 0],
        postBalances: [900000000, 0, 0],
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 1, mint: mintPubkey, owner: walletPubkey, uiTokenAmount: { amount: '500', decimals: 6 } }
        ]
      },
      transaction: { message: { accountKeys: [ { pubkey: { toBase58: () => walletPubkey } }, { pubkey: { toBase58: () => mintPubkey } } ] } }
    };
    const result = FillParser.parseBuyFill(tx, walletPubkey, mintPubkey);
    expect(result).not.toBeNull();
    expect(result?.tokenDeltaRaw).toBe(500n);
  });
});
