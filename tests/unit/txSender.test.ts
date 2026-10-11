import { describe, it, expect, vi } from 'vitest';
import { TxSender } from '../../src/modules/wallet/txSender';

describe('TxSender', () => {
  it('returns FAILED_ONCHAIN if getSignatureStatuses has err', async () => {
    const mockConnection: any = {
      sendTransaction: vi.fn().mockResolvedValue('mock-sig'),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{ err: { InstructionError: [0, 'custom error'] }, confirmationStatus: 'finalized' }]
      }),
      isBlockhashValid: vi.fn().mockResolvedValue({ value: true }),
    };

    const mockTx: any = {
      sign: vi.fn(),
      message: { recentBlockhash: 'mock-blockhash' },
      signatures: [new Uint8Array([1, 2, 3])]
    };

    const result = await TxSender.sendAndConfirm(mockConnection, mockTx, []);
    expect(result.status).toBe('FAILED_ONCHAIN');
    expect(result.err).toBeDefined();
  });

  it('returns SUCCESS if getSignatureStatuses is confirmed without err', async () => {
    const mockConnection: any = {
      sendTransaction: vi.fn().mockResolvedValue('mock-sig'),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{ err: null, confirmationStatus: 'confirmed' }]
      }),
      isBlockhashValid: vi.fn().mockResolvedValue({ value: true }),
    };

    const mockTx: any = {
      sign: vi.fn(),
      message: { recentBlockhash: 'mock-blockhash' },
      signatures: [new Uint8Array([1, 2, 3])]
    };

    const result = await TxSender.sendAndConfirm(mockConnection, mockTx, []);
    expect(result.status).toBe('SUCCESS');
    expect(result.signature).toBeDefined();
  });

  it('keeps a signed transaction UNKNOWN if blockhash expires and status is still unproven', async () => {
    const mockConnection: any = {
      sendTransaction: vi.fn().mockResolvedValue('mock-sig'),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [null]
      }),
      isBlockhashValid: vi.fn().mockResolvedValue({ value: false }), // Blockhash immediately expired
    };

    const mockTx: any = {
      sign: vi.fn(),
      message: { recentBlockhash: 'mock-blockhash' },
      signatures: [new Uint8Array([1, 2, 3])]
    };

    const result = await TxSender.sendAndConfirm(mockConnection, mockTx, [], { pollingIntervalMs: 1 });
    expect(result.status).toBe('UNKNOWN');
    expect(result.err).toContain('outcome remains unproven');
  });
});
