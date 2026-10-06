import { describe, it, expect } from 'vitest';
import { QUEUE_NAMES } from '../../src/queue/queues';

describe('Queue Definitions', () => {
  it('defines all required queue names', () => {
    expect(QUEUE_NAMES.SCAN).toBe('scan-queue');
    expect(QUEUE_NAMES.EVAL).toBe('eval-queue');
    expect(QUEUE_NAMES.EXEC).toBe('exec-queue');
    expect(QUEUE_NAMES.MONITOR).toBe('monitor-queue');
  });
});
