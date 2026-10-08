/**
 * Verify the *specific* SOL transfer authorized by a withdrawal request.
 * A successful transaction signature alone does not establish where funds went.
 * This parser deliberately rejects unknown/legacy expected amounts: they need
 * human investigation, not a guessed success result.
 */
import type { ParsedTransactionWithMeta } from '@solana/web3.js';

function exactRawLamports(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

export function verifyWithdrawalTransfer(
  tx: ParsedTransactionWithMeta | null,
  expectedSource: string,
  expectedDestination: string,
  expectedLamports: string | null | undefined,
): boolean {
  if (!tx?.meta || tx.meta.err || !expectedSource || !expectedDestination) return false;
  const expected = exactRawLamports(expectedLamports);
  if (expected === null || expected <= 0n) return false;

  const keys = tx.transaction?.message?.accountKeys;
  if (!keys || keys.length === 0) return false;
  const feePayer = keys[0];
  const feePayerKey = typeof feePayer === 'string' ? feePayer : feePayer.pubkey.toBase58();
  if (feePayerKey !== expectedSource) return false;

  const instructions = tx.transaction.message.instructions;
  if (!Array.isArray(instructions)) return false;
  const systemTransfers = instructions.filter((ix) =>
    'parsed' in ix && ix.program === 'system' && ix.parsed?.type === 'transfer'
  );
  // The current withdrawal builder creates exactly one direct SystemProgram.transfer.
  if (systemTransfers.length !== 1) return false;
  const instruction = systemTransfers[0];
  if (!('parsed' in instruction)) return false;
  const info = instruction.parsed?.info;
  if (!info || info.source !== expectedSource || info.destination !== expectedDestination) return false;
  return exactRawLamports(info.lamports) === expected;
}
