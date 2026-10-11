import { describe, expect, it, vi } from 'vitest';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  AccountLayout,
  AuthorityType,
  createApproveInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  SwapTransactionIntent,
  TransactionValidationError,
  TransactionValidator,
} from '../../src/modules/wallet/transactionValidator';

const JUPITER_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const WSOL = 'So11111111111111111111111111111111111111112';
const OUTPUT_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint,
    owner,
    amount,
    delegateOption: 0,
    delegate: PublicKey.default,
    state: 1,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  }, data);
  return data;
}

function transactionFor(wallet: PublicKey, instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function jupiterInstruction(wallet: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: JUPITER_PROGRAM,
    keys: [{ pubkey: wallet, isSigner: true, isWritable: true }],
    data: Buffer.from([1]),
  });
}

function intentFor(wallet: PublicKey): SwapTransactionIntent {
  return {
    provider: 'JUPITER',
    side: 'BUY',
    walletPublicKey: wallet.toBase58(),
    inputMint: WSOL,
    outputMint: OUTPUT_MINT.toBase58(),
    inputAmountRaw: 100_000_000n,
    minimumOutputAmountRaw: 1n,
  };
}

function pumpInstruction(
  wallet: PublicKey,
  mint: PublicKey,
  discriminator: number[],
  firstAmount: bigint,
  secondAmount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(24);
  Buffer.from(discriminator).copy(data, 0);
  data.writeBigUInt64LE(firstAmount, 8);
  data.writeBigUInt64LE(secondAmount, 16);
  const keys = Array.from({ length: 9 }, () => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: false,
  }));
  keys[2] = { pubkey: mint, isSigner: false, isWritable: false };
  keys[5] = { pubkey: getAssociatedTokenAddressSync(mint, wallet), isSigner: false, isWritable: true };
  keys[6] = { pubkey: wallet, isSigner: true, isWritable: true };
  keys[8] = { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false };
  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data });
}

describe('TransactionValidator', () => {
  it('ignores provider-supplied lookup table contents and resolves the table on-chain', async () => {
    const wallet = Keypair.generate().publicKey;
    const lookedUpAccount = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: 18_446_744_073_709_551_615n,
        lastExtendedSlot: 1,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [lookedUpAccount],
      },
    });
    const instruction = new TransactionInstruction({
      programId: JUPITER_PROGRAM,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: lookedUpAccount, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [instruction],
    }).compileToV0Message([table]));
    expect(transaction.message.addressTableLookups).toHaveLength(1);

    const connection: any = {
      getAddressLookupTable: vi.fn().mockResolvedValue({ value: null }),
    };
    const validator = new TransactionValidator(connection);

    await expect(validator.validateSwap(transaction, {
      ...intentFor(wallet),
      addressLookupTableAccounts: [table],
    })).rejects.toThrow(/address lookup table not found/);
    expect(connection.getAddressLookupTable).toHaveBeenCalled();
  });

  it('rejects an unexpected top-level program before signing', () => {
    const wallet = Keypair.generate().publicKey;
    const maliciousProgram = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      jupiterInstruction(wallet),
      new TransactionInstruction({ programId: maliciousProgram, keys: [], data: Buffer.alloc(0) }),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, intentFor(wallet)))
      .toThrow(/program is not allowlisted/);
  });

  it('rejects a direct SOL transfer to an attacker even though System Program is allowlisted', () => {
    const wallet = Keypair.generate().publicKey;
    const attacker = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: attacker, lamports: 1 }),
      jupiterInstruction(wallet),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, intentFor(wallet)))
      .toThrow(/not an approved wrapped-SOL funding instruction/);
  });

  it('rejects any signer other than the wallet', () => {
    const wallet = Keypair.generate().publicKey;
    const attacker = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      new TransactionInstruction({
        programId: JUPITER_PROGRAM,
        keys: [
          { pubkey: wallet, isSigner: true, isWritable: true },
          { pubkey: attacker, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, intentFor(wallet)))
      .toThrow(/only required signer|unexpected instruction signer/);
  });

  it('rejects an SPL approval that delegates an unrelated token account', () => {
    const wallet = Keypair.generate().publicKey;
    const attacker = Keypair.generate().publicKey;
    const unrelatedAccount = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      createApproveInstruction(unrelatedAccount, attacker, wallet, 9_999_999_999n),
      jupiterInstruction(wallet),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, intentFor(wallet)))
      .toThrow(/top-level token instruction/);
  });

  it('rejects an SPL authority change even when the wallet is the only signer', () => {
    const wallet = Keypair.generate().publicKey;
    const attacker = Keypair.generate().publicKey;
    const unrelatedAccount = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      createSetAuthorityInstruction(unrelatedAccount, wallet, AuthorityType.AccountOwner, attacker),
      jupiterInstruction(wallet),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, intentFor(wallet)))
      .toThrow(/top-level token instruction/);
  });

  it('accepts the canonical Pump program and derives an exact buy minimum from its instruction', () => {
    const wallet = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      pumpInstruction(wallet, OUTPUT_MINT, [56, 252, 116, 8, 158, 223, 205, 95], 100_000_000n, 55_000n),
    ]);
    const validator = new TransactionValidator({} as any);

    const validated = validator.validateMessage(transaction, wallet, {
      provider: 'PUMP_PORTAL',
      side: 'BUY',
      walletPublicKey: wallet.toBase58(),
      inputMint: WSOL,
      outputMint: OUTPUT_MINT.toBase58(),
      inputAmountRaw: 100_000_000n,
    });

    expect(validated.minimumOutputAmountRaw).toBe(55_000n);
  });

  it('rejects a Pump transaction whose encoded minimum is below the independent economic floor', () => {
    const wallet = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      pumpInstruction(wallet, OUTPUT_MINT, [56, 252, 116, 8, 158, 223, 205, 95], 100_000_000n, 55_000n),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, {
      provider: 'PUMP_PORTAL',
      side: 'BUY',
      walletPublicKey: wallet.toBase58(),
      inputMint: WSOL,
      outputMint: OUTPUT_MINT.toBase58(),
      inputAmountRaw: 100_000_000n,
      minimumEconomicOutputAmountRaw: 55_001n,
    })).toThrow(/below independent economic floor/);
  });

  it('rejects a Pump buy whose on-chain spend cap exceeds the approved input', () => {
    const wallet = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      pumpInstruction(wallet, OUTPUT_MINT, [102, 6, 61, 18, 1, 218, 235, 234], 55_000n, 100_000_001n),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, {
      provider: 'PUMP_PORTAL',
      side: 'BUY',
      walletPublicKey: wallet.toBase58(),
      inputMint: WSOL,
      outputMint: OUTPUT_MINT.toBase58(),
      inputAmountRaw: 100_000_000n,
    })).toThrow(/maximum SOL cost exceeds/);
  });

  it('rejects a priority fee above the configured cap', async () => {
    const wallet = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      jupiterInstruction(wallet),
    ]);
    const validator = new TransactionValidator({} as any);

    await expect(validator.validateSwap(transaction, {
      provider: 'JUPITER', side: 'BUY', walletPublicKey: wallet.toBase58(),
      inputMint: WSOL, outputMint: OUTPUT_MINT.toBase58(), inputAmountRaw: 100_000_000n,
      minimumOutputAmountRaw: 1n,
    })).rejects.toThrow(/priority fee/);
  });

  it('rejects a simulated native debit above the approved amount and fee caps', async () => {
    const wallet = Keypair.generate().publicKey;
    const tokenAccount = Keypair.generate().publicKey;
    const preTokenData = tokenAccountData(OUTPUT_MINT, wallet, 0n);
    const postTokenData = tokenAccountData(OUTPUT_MINT, wallet, 100n);
    const connection: any = {
      getTokenAccountsByOwner: vi.fn().mockResolvedValue({
        value: [{ pubkey: tokenAccount, account: { data: preTokenData } }],
      }),
      getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ID }),
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([null]),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      simulateTransaction: vi.fn().mockResolvedValue({
        value: {
          err: null,
          accounts: [
            { lamports: 700_000_000, data: ['', 'base64'], owner: PublicKey.default.toBase58(), executable: false },
            { lamports: 2_039_280, data: [postTokenData.toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false },
          ],
        },
      }),
    };
    const transaction = transactionFor(wallet, [jupiterInstruction(wallet)]);
    const validator = new TransactionValidator(connection);

    await expect(validator.validateSwap(transaction, {
      provider: 'JUPITER', side: 'BUY', walletPublicKey: wallet.toBase58(),
      inputMint: WSOL, outputMint: OUTPUT_MINT.toBase58(), inputAmountRaw: 100_000_000n,
      minimumOutputAmountRaw: 1n,
    })).rejects.toThrow(TransactionValidationError);
  });

  it('rejects a provider CPI that closes an unrelated wallet token account', async () => {
    const wallet = Keypair.generate().publicKey;
    const outputAccount = getAssociatedTokenAddressSync(OUTPUT_MINT, wallet);
    const unrelatedMint = Keypair.generate().publicKey;
    const unrelatedAccount = Keypair.generate().publicKey;
    const preOutputData = tokenAccountData(OUTPUT_MINT, wallet, 0n);
    const postOutputData = tokenAccountData(OUTPUT_MINT, wallet, 100n);
    const unrelatedData = tokenAccountData(unrelatedMint, wallet, 500n);
    const maliciousJupiterInstruction = new TransactionInstruction({
      programId: JUPITER_PROGRAM,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: unrelatedAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1]),
    });
    const connection: any = {
      getTokenAccountsByOwner: vi.fn().mockResolvedValue({
        value: [{ pubkey: outputAccount, account: { data: preOutputData } }],
      }),
      getAccountInfo: vi.fn().mockResolvedValue({ owner: TOKEN_PROGRAM_ID }),
      getMultipleAccountsInfo: vi.fn().mockImplementation(async (addresses: PublicKey[]) => addresses.map((address) => (
        address.equals(unrelatedAccount)
          ? { data: unrelatedData, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false }
          : null
      ))),
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      simulateTransaction: vi.fn().mockResolvedValue({
        value: {
          err: null,
          accounts: [
            { lamports: 899_900_000, data: ['', 'base64'], owner: PublicKey.default.toBase58(), executable: false },
            { lamports: 2_039_280, data: [postOutputData.toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false },
            null,
          ],
        },
      }),
    };
    const validator = new TransactionValidator(connection);

    await expect(validator.validateSwap(transactionFor(wallet, [maliciousJupiterInstruction]), intentFor(wallet)))
      .rejects.toThrow(/wallet token account was closed/);
  });
});
