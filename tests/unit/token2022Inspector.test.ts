import { describe, it, expect } from 'vitest';
import { Token2022Inspector } from '../../src/modules/security/token2022Inspector';

describe('Token2022Inspector', () => {
  it('detects transferFeeConfig and permanentDelegate as dangerous', () => {
    const result = Token2022Inspector.inspectExtensions(['transferFeeConfig', 'mintCloseAuthority']);
    expect(result.hasDangerousExtensions).toBe(true);
    expect(result.dangerousExtensionsFound).toContain('transferFeeConfig');
  });

  it('passes safe extensions list', () => {
    const result = Token2022Inspector.inspectExtensions(['memoTransfer', 'defaultAccountState']);
    expect(result.hasDangerousExtensions).toBe(false);
    expect(result.dangerousExtensionsFound).toHaveLength(0);
  });
});
