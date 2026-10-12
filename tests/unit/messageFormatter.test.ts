import { describe, it, expect } from 'vitest';
import { 
  formatProgressBar, 
  formatUsd, 
  formatPrice, 
  formatRadarCandidate, 
  formatRadarCycleDigest, 
  formatRadarHub,
  buildRadarCandidateKeyboard,
  buildRadarHubKeyboard
} from '../../src/modules/telegram/formatters/messageFormatter';

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

  describe('Radar Formatters', () => {
    it('formats a skipped radar candidate cleanly with safety score and friendly reason', () => {
      const output = formatRadarCandidate({
        type: 'TRENDING',
        symbol: 'SOLCAT',
        name: 'Solana Cat',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        priceUsd: 0.0045,
        liquidityUsd: 45000,
        volume5mUsd: 12000,
        securityScore: 85,
        securityLevel: 'SAFE',
        status: 'SKIPPED',
        reason: 'Volatile or low confidence',
      });

      expect(output).toContain('AUTOPILOT RADAR');
      expect(output).toContain('SOLCAT');
      expect(output).toContain('⚪ DILEWATI');
      expect(output).toContain('$45.0K');
      expect(output).toContain('85/100');
      expect(output).toContain('Kondisi teknikal');
    });

    it('formats an executed sniper radar candidate cleanly', () => {
      const output = formatRadarCandidate({
        type: 'SNIPER',
        symbol: 'PEPE<NEW>',
        tokenAddress: 'TokenAddress123',
        priceUsd: 0.000012,
        liquidityUsd: 15000,
        poolAgeText: '45 detik',
        securityScore: 90,
        securityLevel: 'SAFE',
        status: 'EXECUTED',
        reason: 'Order submitted to mempool',
      });

      expect(output).toContain('SNIPER RADAR');
      expect(output).toContain('PEPE&lt;NEW&gt;');
      expect(output).toContain('🟢 EKSEKUSI BUY');
      expect(output).toContain('45 detik');
      expect(output).toContain('Order submitted');
    });

    it('formats radar cycle digest properly', () => {
      const digest = formatRadarCycleDigest({
        type: 'TRENDING',
        scannedCount: 20,
        passedSafetyCount: 16,
        executedCount: 1,
      });

      expect(digest).toContain('RINGKASAN SIKLUS RADAR');
      expect(digest).toContain('20 Pair');
      expect(digest).toContain('16 Pair');
      expect(digest).toContain('1 Order');
    });

    it('formats radar hub dashboard with state indicators', () => {
      const hub = formatRadarHub({
        isLiveFeedActive: true,
        isTrendingActive: true,
        isSniperActive: false,
        trendingSizeSol: 0.1,
        sniperSizeSol: 0.05,
      });

      expect(hub).toContain('RADAR LIVE FEED COMMAND HUB');
      expect(hub).toContain('🟢 AKTIF');
      expect(hub).toContain('0.1 SOL');
      expect(hub).toContain('🔴 NONAKTIF');
    });

    it('builds keyboards with appropriate callback data and links', () => {
      const candKb = buildRadarCandidateKeyboard('Token123', 'Pair456', true);
      const buttons = candKb.inline_keyboard.flat();
      expect(buttons.some(b => 'callback_data' in b && b.callback_data === 'refresh:Token123')).toBe(true);
      expect(buttons.some(b => 'url' in b && b.url.includes('Pair456'))).toBe(true);
      expect(buttons.some(b => 'callback_data' in b && b.callback_data === 'menu_positions')).toBe(true);

      const hubKb = buildRadarHubKeyboard(true);
      const hubButtons = hubKb.inline_keyboard.flat();
      expect(hubButtons.some(b => 'callback_data' in b && b.callback_data === 'toggle_livefeed' && b.text.includes('Matikan'))).toBe(true);
    });
  });
});

