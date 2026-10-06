import { describe, it, expect, vi } from 'vitest';
import { FeeEstimator } from '../../src/modules/trader/feeEstimator';

describe('FeeEstimator', () => {
  it('calculates 75th percentile priority fee accurately', async () => {
    const mockConnection: any = {
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([
        { prioritizationFee: 1000 },
        { prioritizationFee: 2000 },
        { prioritizationFee: 3000 },
        { prioritizationFee: 4000 },
      ]),
    };

    const estimator = new FeeEstimator(mockConnection);
    const fee = await estimator.getDynamicPriorityFee();
    expect(fee).toBeGreaterThanOrEqual(3000);
  });
});
