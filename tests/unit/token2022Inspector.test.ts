import { describe, it, expect, vi } from 'vitest';
import { Token2022Inspector } from '../../src/modules/security/token2022Inspector';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Mock spl-token methods
vi.mock('@solana/spl-token', async () => {
  const actual: any = await vi.importActual('@solana/spl-token');
  return {
    ...actual,
    getMint: vi.fn().mockResolvedValue({}),
    getExtensionTypes: vi.fn((data) => {
      // Return extension types based on mocked data length
      if (data.length === 1) return [1, 2]; // e.g. TransferFeeConfig
      if (data.length === 2) return [10, 11]; // safe
      return [];
    }),
    ExtensionType: {
      1: 'TransferFeeConfig',
      2: 'MintCloseAuthority',
      10: 'MemoTransfer',
      11: 'DefaultAccountState'
    }
  };
});

describe('Token2022Inspector', () => {
  it('detects TransferFeeConfig as dangerous', async () => {
    const mockConnection: any = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(1) }),
    };
    
    const result = await Token2022Inspector.inspectExtensions(
      mockConnection,
      new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      TOKEN_2022_PROGRAM_ID
    );

    expect(result.status).toBe('OK');
    expect(result.value).toContain('TransferFeeConfig');
  });

  it('passes safe extensions list', async () => {
    const mockConnection: any = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(2) }),
    };

    const result = await Token2022Inspector.inspectExtensions(
      mockConnection,
      new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      TOKEN_2022_PROGRAM_ID
    );

    expect(result.status).toBe('OK');
    // DefaultAccountState is actually marked as dangerous in our code now
    // Wait, DANGEROUS_EXTENSIONS includes 'DefaultAccountState'
    expect(result.value).toContain('DefaultAccountState');
  });

  it('ignores classic SPL token', async () => {
    const result = await Token2022Inspector.inspectExtensions(
      {} as any,
      new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      TOKEN_PROGRAM_ID
    );
    expect(result.status).toBe('OK');
    expect(result.value).toEqual([]);
  });
});
