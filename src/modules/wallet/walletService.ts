import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import QRCode from 'qrcode';
import bs58 from 'bs58';
import { KeypairService } from './keypairService';
import { WalletRepository } from '../../database/repositories/walletRepository';
import { getEnv } from '../../config/env';

export class WalletService {
  constructor(
    private readonly walletRepo: WalletRepository,
    private readonly connection: Connection
  ) {}

  public getConnection(): Connection {
    return this.connection;
  }

  async getParsedTransaction(signature: string) {
    return this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  }

  async getOrCreateWallet(userId: number): Promise<{ publicKey: string }> {
    const existing = await this.walletRepo.getWalletByUserId(userId);
    if (existing) {
      return { publicKey: existing.public_key };
    }

    const keypair = KeypairService.createNewKeypair();
    const env = getEnv();
    const encrypted = KeypairService.encrypt(keypair, env.MASTER_ENCRYPTION_KEY);

    await this.walletRepo.saveWallet({
      user_id: userId,
      public_key: keypair.publicKey.toBase58(),
      encrypted_private_key: encrypted.encryptedData,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
    });

    return { publicKey: keypair.publicKey.toBase58() };
  }

  async getBalance(publicKeyString: string): Promise<{ sol: number; lamports: number }> {
    const pubkey = new PublicKey(publicKeyString);
    const lamports = await this.connection.getBalance(pubkey);
    return {
      sol: lamports / LAMPORTS_PER_SOL,
      lamports,
    };
  }

  async getTokenBalance(walletPubkeyString: string, tokenMintString: string): Promise<number> {
    const walletPubkey = new PublicKey(walletPubkeyString);
    const tokenMint = new PublicKey(tokenMintString);
    const accounts = await this.connection.getParsedTokenAccountsByOwner(walletPubkey, { mint: tokenMint });
    if (accounts.value.length === 0) return 0;
    
    // Sum up if there are multiple accounts for the same mint, usually just one
    let total = 0;
    for (const acc of accounts.value) {
      const amountStr = acc.account.data.parsed.info.tokenAmount.amount;
      total += parseInt(amountStr, 10);
    }
    return total;
  }

  async generateQrBuffer(address: string): Promise<Buffer> {
    return QRCode.toBuffer(address, {
      type: 'png',
      width: 300,
      margin: 2,
    });
  }

  async exportPrivateKey(userId: number): Promise<string> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar. Ketik /start terlebih dahulu.');
    const env = getEnv();
    const keypair = KeypairService.decrypt(
      {
        encryptedData: wallet.encrypted_private_key,
        iv: wallet.iv,
        authTag: wallet.auth_tag,
      },
      env.MASTER_ENCRYPTION_KEY
    );
    const pk = bs58.encode(keypair.secretKey);
    KeypairService.clearKeypair(keypair); // zero out memory
    return pk;
  }

  async withdrawSol(userId: number, destinationAddress: string, amountSol: number | 'MAX'): Promise<string> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar.');
    
    let destPubkey: PublicKey;
    try {
      destPubkey = new PublicKey(destinationAddress);
    } catch {
      throw new Error('Alamat Solana tujuan tidak valid.');
    }

    if (destPubkey.toBase58() === wallet.public_key) {
      throw new Error('Tidak dapat mengirim ke alamat sendiri.');
    }
    
    // Check if it's a program (not a normal wallet)
    const destAccount = await this.connection.getAccountInfo(destPubkey);
    if (destAccount && destAccount.executable) {
      throw new Error('Alamat tujuan adalah Program, bukan wallet biasa.');
    }

    const sourcePubkey = new PublicKey(wallet.public_key);
    const balance = await this.connection.getBalance(sourcePubkey);
    
    if (balance === 0) throw new Error('Saldo kosong.');

    const env = getEnv();
    const keypair = KeypairService.decrypt(
      {
        encryptedData: wallet.encrypted_private_key,
        iv: wallet.iv,
        authTag: wallet.auth_tag,
      },
      env.MASTER_ENCRYPTION_KEY
    );

    try {
      const { SystemProgram, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');

      // Calculate fee
      const tempAmount = amountSol === 'MAX' ? 1000 : Math.floor(amountSol * LAMPORTS_PER_SOL);
      const tempInstructions = [
        SystemProgram.transfer({
          fromPubkey: sourcePubkey,
          toPubkey: destPubkey,
          lamports: tempAmount,
        }),
      ];
      
      const message = new TransactionMessage({
        payerKey: sourcePubkey,
        recentBlockhash: blockhash,
        instructions: tempInstructions,
      }).compileToV0Message();
      
      const fee = await this.connection.getFeeForMessage(message, 'confirmed');
      const estimatedFee = fee.value || 5000;
      
      let transferLamports = 0;
      if (amountSol === 'MAX') {
        transferLamports = balance - estimatedFee;
      } else {
        transferLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
      }

      if (transferLamports <= 0 || transferLamports + estimatedFee > balance) {
        throw new Error('Saldo tidak cukup untuk menutupi jumlah transfer dan biaya jaringan (fee).');
      }

      const instructions = [
        SystemProgram.transfer({
          fromPubkey: sourcePubkey,
          toPubkey: destPubkey,
          lamports: transferLamports,
        }),
      ];

      const finalMessage = new TransactionMessage({
        payerKey: sourcePubkey,
        recentBlockhash: blockhash,
        instructions: instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(finalMessage);
      transaction.sign([keypair]);

      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });

      await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      return signature;
    } finally {
      KeypairService.clearKeypair(keypair); // zero out memory per transaction
    }
  }

  async signAndSendVersionedTransaction(userId: number, transaction: any): Promise<string> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar.');

    const env = getEnv();
    const keypair = KeypairService.decrypt(
      {
        encryptedData: wallet.encrypted_private_key,
        iv: wallet.iv,
        authTag: wallet.auth_tag,
      },
      env.MASTER_ENCRYPTION_KEY
    );

    try {
      transaction.sign([keypair]);

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      const signature = await this.connection.sendTransaction(transaction, {
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });

      // Create a promise that rejects after 30 seconds
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Transaction confirmation timeout (30s)')), 30000);
      });

      const confirmPromise = this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      await Promise.race([confirmPromise, timeoutPromise]);

      return signature;
    } finally {
      KeypairService.clearKeypair(keypair); // zero out memory per transaction
    }
  }

  async startDepositMonitoring(onDeposit: (userId: number, amountSol: number, signature?: string) => Promise<void>): Promise<void> {
    const wallets = await this.walletRepo.getAllWallets();
    for (const wallet of wallets) {
      const pubkey = new PublicKey(wallet.public_key);
      let previousBalance = await this.connection.getBalance(pubkey);

      this.connection.onAccountChange(
        pubkey,
        async (accountInfo, context) => {
          const newBalance = accountInfo.lamports;
          if (newBalance > previousBalance) {
            const diffLamports = newBalance - previousBalance;
            const diffSol = diffLamports / LAMPORTS_PER_SOL;
            // Best effort to get signature
            let signature: string | undefined;
            try {
              const sigs = await this.connection.getSignaturesForAddress(pubkey, { limit: 1 });
              if (sigs && sigs.length > 0) {
                signature = sigs[0].signature;
              }
            } catch {
              // ignore
            }
            await onDeposit(wallet.user_id, diffSol, signature);
          }
          previousBalance = newBalance;
        },
        'confirmed'
      );
    }
  }
}
