import { describe, it, expect } from 'vitest';
import { formatProgressBar, formatUsd, formatPrice } from '../../src/modules/telegram/formatters/messageFormatter';

describe('Message Formatter', () => {
  it('formats progress bar cleanly', () => {
    const bar = formatProgressBar(60, 100);
    expect(bar).toBe('▰▰▰▰▰▰▱▱▱▱ 60/100');
  });

  it('formats large USD values compactly', () => {
    expect(formatUsd(1250000)).toBe('$1.25M');
    expect(formatUsd(45200)).toBe('$45.2K');
    expect(formatUsd(150.25)).toBe('$150.25');
  });

  it('formats small token prices cleanly with decimals', () => {
    expect(formatPrice(0.0000421)).toBe('$0.00004210');
    expect(formatPrice(1.25)).toBe('$1.25');
  });
});
