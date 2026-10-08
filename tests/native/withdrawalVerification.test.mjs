import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWithdrawalTransfer } from '../../src/modules/wallet/withdrawalVerification.ts';

const source = 'SRC123';
const destination = 'DST456';
function fixture(info = { source, destination, lamports: '9007199254740993' }) {
  return {
    meta: { err: null },
    transaction: { message: {
      accountKeys: [{ pubkey: { toBase58: () => source } }],
      instructions: [{ program: 'system', parsed: { type: 'transfer', info } }]
    } }
  };
}
test('accepts the exact authorized amount even above Number.MAX_SAFE_INTEGER', () => {
  assert.equal(verifyWithdrawalTransfer(fixture(), source, destination, '9007199254740993'), true);
});
test('rejects missing expected amount (including legacy MAX)', () => {
  assert.equal(verifyWithdrawalTransfer(fixture(), source, destination, null), false);
});
test('rejects wrong source or destination', () => {
  assert.equal(verifyWithdrawalTransfer(fixture({ source: 'WRONG', destination, lamports: '42' }), source, destination, '42'), false);
  assert.equal(verifyWithdrawalTransfer(fixture(), source, 'WRONG', '9007199254740993'), false);
});
test('rejects an unsafe JavaScript numeric lamports value', () => {
  assert.equal(verifyWithdrawalTransfer(fixture({ source, destination, lamports: 9007199254740993 }), source, destination, '9007199254740993'), false);
});
test('rejects a wrong amount or multiple transfers', () => {
  assert.equal(verifyWithdrawalTransfer(fixture(), source, destination, '1'), false);
  const tx = fixture();
  tx.transaction.message.instructions.push({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: '10' } } });
  assert.equal(verifyWithdrawalTransfer(tx, source, destination, '9007199254740993'), false);
});
test('rejects wrong fee payer or on-chain failure', () => {
  const tx = fixture();
  tx.transaction.message.accountKeys[0].pubkey.toBase58 = () => 'OTHER';
  assert.equal(verifyWithdrawalTransfer(tx, source, destination, '9007199254740993'), false);
  tx.transaction.message.accountKeys[0].pubkey.toBase58 = () => source;
  tx.meta.err = { InstructionError: [0, 'Custom'] };
  assert.equal(verifyWithdrawalTransfer(tx, source, destination, '9007199254740993'), false);
});
