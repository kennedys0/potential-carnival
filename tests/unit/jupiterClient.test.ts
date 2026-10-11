import { AddressLookupTableAccount, Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { JupiterClient } from '../../src/modules/trader/jupiterClient';

const ACTIVE_SLOT = 18_446_744_073_709_551_615n;

function lookupTable(key = Keypair.generate().publicKey, addresses = [Keypair.generate().publicKey]) {
  return new AddressLookupTableAccount({
    key,
    state: {
      deactivationSlot: ACTIVE_SLOT,
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

describe('JupiterClient trust boundaries', () => {
  it('rejects a minimum output weaker than the requested slippage', () => {
    const client = new JupiterClient({} as any);
    const build: any = {
      inputMint: 'input',
      outputMint: 'output',
      inAmount: '100',
      outAmount: '1000',
      otherAmountThreshold: '1',
      swapMode: 'ExactIn',
      slippageBps: 100,
      priceImpactPct: '0.1',
      routePlan: [{}],
    };

    expect(() => (client as any).validateQuote(build, {
      inputMint: 'input',
      outputMint: 'output',
      inputAmountRaw: 100n,
      slippageBps: 100,
    })).toThrow(/weaker than the requested slippage/);

    build.otherAmountThreshold = '990';
    expect(() => (client as any).validateQuote(build, {
      inputMint: 'input',
      outputMint: 'output',
      inputAmountRaw: 100n,
      slippageBps: 100,
    })).not.toThrow();
  });

  it('uses an on-chain lookup table only when every API address matches', async () => {
    const table = lookupTable();
    const connection: any = {
      getAddressLookupTable: vi.fn().mockResolvedValue({ value: table }),
    };
    const client = new JupiterClient(connection);
    const raw = {
      [table.key.toBase58()]: table.state.addresses.map((address) => address.toBase58()),
    };

    await expect((client as any).resolveLookupTables(raw)).resolves.toEqual([table]);
    expect(connection.getAddressLookupTable).toHaveBeenCalledWith(
      table.key,
      { commitment: 'confirmed' },
    );
  });

  it('rejects API lookup-table contents that differ from on-chain state', async () => {
    const table = lookupTable();
    const connection: any = {
      getAddressLookupTable: vi.fn().mockResolvedValue({ value: table }),
    };
    const client = new JupiterClient(connection);
    const raw = {
      [table.key.toBase58()]: [Keypair.generate().publicKey.toBase58()],
    };

    await expect((client as any).resolveLookupTables(raw))
      .rejects.toThrow(/does not match on-chain state/);
  });
});
