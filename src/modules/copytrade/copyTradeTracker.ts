import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../../utils/logger';
import { CopyTradeRepository } from '../../database/repositories/copyTradeRepository';
import { TraderService } from '../trader/traderService';
import { ScannerService } from '../scanner/scannerService';
import { SecurityFilterService } from '../security/securityFilterService';
import { AutopilotRepository } from '../../database/repositories/autopilotRepository';
import { getRedisConnection } from '../../queue/connection';
import { escapeHtml } from '../telegram/formatters/messageFormatter';

export class CopyTradeTracker {
  private activeSubscriptions = new Map<string, number>(); // walletAddress -> subscriptionId
  private activeTargets = new Set<string>(); // userId:walletAddress

  constructor(
    private readonly connection: Connection,
    private readonly copyTradeRepo: CopyTradeRepository,
    private readonly traderService: TraderService,
    private readonly scannerService: ScannerService,
    private readonly securityService: SecurityFilterService,
    private readonly autopilotRepo: AutopilotRepository,
    private readonly botApi: any
  ) {}

  async start() {
    logger.info('Starting CopyTradeTracker...');
    // Sync targets periodically
    setInterval(() => this.syncTargets(), 30000);
    await this.syncTargets();
  }

  stop() {
    for (const [wallet, subId] of this.activeSubscriptions.entries()) {
      this.connection.removeOnLogsListener(subId).catch(() => {});
    }
    this.activeSubscriptions.clear();
    this.activeTargets.clear();
  }

  private async syncTargets() {
    try {
      const allActive = await this.copyTradeRepo.getAllActiveTargets();
      
      const newActiveSet = new Set<string>();
      const walletsToTrack = new Set<string>();

      for (const t of allActive) {
        newActiveSet.add(`${t.user_id}:${t.target_wallet_address}`);
        walletsToTrack.add(t.target_wallet_address);
      }

      this.activeTargets = newActiveSet;

      // Unsubscribe from removed wallets
      for (const [wallet, subId] of this.activeSubscriptions.entries()) {
        if (!walletsToTrack.has(wallet)) {
          await this.connection.removeOnLogsListener(subId);
          this.activeSubscriptions.delete(wallet);
          logger.info(`CopyTradeTracker: Stopped tracking ${wallet}`);
        }
      }

      // Subscribe to new wallets
      for (const wallet of walletsToTrack) {
        if (!this.activeSubscriptions.has(wallet)) {
          this.subscribeToWallet(wallet);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error syncing copy trade targets');
    }
  }

  private subscribeToWallet(walletAddress: string) {
    try {
      const pubkey = new PublicKey(walletAddress);
      const subId = this.connection.onLogs(
        pubkey,
        async (logs, ctx) => {
          if (logs.err) return; // Skip failed transactions
          // Quick filter: Usually Jupiter or Raydium involves swap instructions.
          // Very basic heuristic: check if logs contain typical swap keywords.
          const isSwap = logs.logs.some(l => l.includes('Swap') || l.includes('Instruction: Swap') || l.includes('Route'));
          if (isSwap) {
            await this.handlePotentialSwap(walletAddress, logs.signature);
          }
        },
        'confirmed'
      );
      this.activeSubscriptions.set(walletAddress, subId);
      logger.info(`CopyTradeTracker: Started tracking ${walletAddress}`);
    } catch (err) {
      logger.error({ err, walletAddress }, 'Invalid public key for tracking');
    }
  }

  private async handlePotentialSwap(walletAddress: string, signature: string) {
    const redis = getRedisConnection();
    // Prevent processing same signature twice
    if (await redis.setnx(`copy_tx_processed:${signature}`, '1')) {
      await redis.expire(`copy_tx_processed:${signature}`, 3600);
      
      // Fetch parsed transaction with a slight delay to ensure RPC has it
      setTimeout(async () => {
        try {
          const tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
          if (!tx || !tx.meta) return;

          // Simple parsing: Look for SOL balance decrease and Token balance increase for the target wallet
          const preBalances = tx.meta.preTokenBalances || [];
          const postBalances = tx.meta.postTokenBalances || [];

          let tokenMintBought: string | null = null;
          
          for (const post of postBalances) {
            if (post.owner === walletAddress) {
              const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
              const preUi = pre ? (pre.uiTokenAmount.uiAmount || 0) : 0;
              const postUi = post.uiTokenAmount.uiAmount || 0;
              
              // If token balance increased significantly, it's a BUY
              if (postUi > preUi) {
                tokenMintBought = post.mint;
                break; // Just grab the first bought token for simplicity
              }
            }
          }

          if (tokenMintBought) {
            logger.info(`[CopyTradeTracker] Detected BUY from ${walletAddress} for token ${tokenMintBought}. Processing copies...`);
            await this.executeCopies(walletAddress, tokenMintBought, signature);
          }

        } catch (err) {
          logger.error({ err, signature }, 'Error parsing transaction for copy trade');
        }
      }, 2000);
    }
  }

  private async executeCopies(targetWallet: string, tokenMint: string, signature: string) {
    const allActive = await this.copyTradeRepo.getAllActiveTargets();
    const followers = allActive.filter(t => t.target_wallet_address === targetWallet);
    
    if (followers.length === 0) return;

    try {
      // 1. Analyze the token for safety first (We only buy if it's somewhat safe)
      const pair = await this.scannerService.scanTokenByAddress(tokenMint);
      if (!pair) return;

      const priceUsd = parseFloat(pair.priceUsd || '0');
      const security = await this.securityService.evaluateToken(tokenMint, {
        liquidityUsd: pair.liquidity?.usd || null,
        marketCapUsd: pair.marketCap || pair.fdv || null,
      });

      if (security.level === 'DANGER' || security.score < 50) {
        logger.warn(`[CopyTradeTracker] Skipped copying ${tokenMint} for ${targetWallet}: Security Score ${security.score} (DANGER)`);
        for (const f of followers) {
           await this.botApi.sendMessage(f.user_id, 
            `🛑 <b>Copy Trade Dibatalkan</b>\n\nTarget <code>${targetWallet.slice(0,6)}...</code> baru saja membeli token <code>${pair.baseToken.symbol}</code>, namun digagalkan karena skor keamanan terlalu rendah (${security.score}/100).\nRisiko tinggi rugpull/honeypot!`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        return;
      }

      // 2. Execute for each follower
      for (const follower of followers) {
        const config = await this.autopilotRepo.getOrCreateConfig(follower.user_id);
        const isDryRun = config.mode === 'PAPER';
        // In a full implementation, we'd convert max_buy_usd to SOL based on current rate.
        // For now, we assume fixed sol or max_buy_usd conversion.
        // Let's use a fixed 0.05 SOL for MVP, or we can fetch SOL price.
        // For simplicity, we just pass the max_buy_usd directly if traderService supports it,
        // but traderService expects solAmount. We will hardcode 0.1 SOL or use a converter if needed.
        // Let's just use 0.1 SOL as standard copytrade size for MVP.
        const solAmount = 0.1; // Todo: Convert follower.max_buy_usd to SOL

        try {
          const trade = await this.traderService.executeOrder({
            userId: follower.user_id,
            tokenMint,
            tokenSymbol: pair.baseToken.symbol,
            solAmount,
            currentPriceUsd: priceUsd,
            isDryRun,
            source: 'AUTOPILOT', // Label as autopilot to trigger automated selling rules
          });

          await this.botApi.sendMessage(follower.user_id, 
            `⚡ <b>COPY TRADE BERHASIL!</b> ⚡\n\n` +
            `Target <code>${targetWallet.slice(0,6)}...</code> terpantau membeli token ini.\n\n` +
            `• <b>Token:</b> ${escapeHtml(pair.baseToken.symbol)} (<code>${tokenMint}</code>)\n` +
            `• <b>Status Keamanan:</b> ${security.score}/100 🛡️\n` +
            `• <b>Alokasi:</b> ${solAmount} SOL\n` +
            `• <b>Mode:</b> ${isDryRun ? '🟢 PAPER' : '⚡ LIVE'}\n\n` +
            `Cek /positions untuk memantau performa.`,
            { parse_mode: 'HTML' }
          );
        } catch (err: any) {
           await this.botApi.sendMessage(follower.user_id, `⚠️ <b>Gagal Copy Trade:</b> ${err.message}`, { parse_mode: 'HTML' });
        }
      }

    } catch (err) {
      logger.error({ err, tokenMint }, 'Error executing copies');
    }
  }
}
