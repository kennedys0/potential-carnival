import { describe, expect, it, vi } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  TransactionValidationError,
  TransactionValidator,
} from '../../src/modules/wallet/transactionValidator';

const JUPITER_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
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

describe('TransactionValidator', () => {
  it('rejects an unexpected top-level program before signing', () => {
    const wallet = Keypair.generate().publicKey;
    const maliciousProgram = Keypair.generate().publicKey;
    const transaction = transactionFor(wallet, [
      jupiterInstruction(wallet),
      new TransactionInstruction({ programId: maliciousProgram, keys: [], data: Buffer.alloc(0) }),
    ]);
    const validator = new TransactionValidator({} as any);

    expect(() => validator.validateMessage(transaction, wallet, 'JUPITER'))
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

    expect(() => validator.validateMessage(transaction, wallet, 'JUPITER'))
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

    expect(() => validator.validateMessage(transaction, wallet, 'JUPITER'))
      .toThrow(/only required signer|unexpected instruction signer/);
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
});
