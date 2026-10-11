import { Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import QRCode from 'qrcode';
import bs58 from 'bs58';
import { KeypairService } from './keypairService';
import { WalletRecord, WalletRepository } from '../../database/repositories/walletRepository';
import { getEnv } from '../../config/env';
import { TxSender, TxSendResult } from './txSender';
import { verifyWithdrawalTransfer } from './withdrawalVerification.js';
import { SwapTransactionIntent, TransactionValidator } from './transactionValidator.js';
import { appSettings } from '../../config/settings';

export class WalletService {
  constructor(
    private readonly walletRepo: WalletRepository,
    private readonly connection: Connection
  ) {}

  public getConnection(): Connection {
    return this.connection;
  }

  async getParsedTransaction(signature: string) {
    return this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 1 });
  }

  async getOrCreateWallet(userId: number): Promise<{ publicKey: string }> {
    const existing = await this.walletRepo.getWalletByUserId(userId);
    if (existing) {
      return { publicKey: existing.public_key };
    }

    const keypair = KeypairService.createNewKeypair();
    try {
      const env = getEnv();
      const publicKey = keypair.publicKey.toBase58();
      const encrypted = KeypairService.encrypt(keypair, env.MASTER_ENCRYPTION_KEY, {
        userId,
        publicKey,
      });
      const storedWallet = await this.walletRepo.getOrCreateWallet({
        user_id: userId,
        public_key: publicKey,
        encrypted_private_key: encrypted.encryptedData,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
      });

      // A concurrent request may have inserted a different candidate first.
      // The database row is authoritative; never return the losing candidate.
      if (storedWallet.encryption_version !== 2) {
        throw new Error('Wallet encryption migration 039 is required before wallet creation');
      }
      return { publicKey: storedWallet.public_key };
    } finally {
      KeypairService.clearKeypair(keypair);
    }
  }

  async getWalletRecord(userId: number) {
    return this.walletRepo.getWalletByUserId(userId);
  }

  async updateOwnerPubkey(userId: number, ownerPubkey: string) {
    return this.walletRepo.updateOwnerPubkey(userId, ownerPubkey);
  }

  async getBalance(publicKeyString: string): Promise<{ sol: number; lamports: number }> {
    const pubkey = new PublicKey(publicKeyString);
    const lamports = await this.connection.getBalance(pubkey);
    return {
      sol: lamports / LAMPORTS_PER_SOL,
      lamports,
    };
  }

  async getTokenBalance(walletPubkeyString: string, tokenMintString: string): Promise<{ raw: bigint, decimals: number, ui: number }> {
    const walletPubkey = new PublicKey(walletPubkeyString);
    const tokenMint = new PublicKey(tokenMintString);
    const accounts = await this.connection.getParsedTokenAccountsByOwner(walletPubkey, { mint: tokenMint });
    if (accounts.value.length === 0) return { raw: 0n, decimals: 0, ui: 0 };
    
    // Sum up if there are multiple accounts for the same mint, usually just one
    let totalRaw = 0n;
    let decimals = 0;
    let totalUi = 0;
    for (const acc of accounts.value) {
      const tokenAmount = acc.account.data.parsed.info.tokenAmount;
      totalRaw += BigInt(tokenAmount.amount);
      decimals = tokenAmount.decimals;
      totalUi += tokenAmount.uiAmount ?? 0;
    }
    return { raw: totalRaw, decimals, ui: totalUi };
  }

  async generateQrBuffer(address: string): Promise<Buffer> {
    return QRCode.toBuffer(address, {
      type: 'png',
      width: 300,
      margin: 2,
    });
  }

  async exportPrivateKey(userId: number): Promise<string> {
    const env = getEnv();
    if (!env.PRIVATE_KEY_EXPORT_ENABLED) {
      throw new Error('Export private key dinonaktifkan oleh operator.');
    }
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar. Ketik /start terlebih dahulu.');
    const keypair = await this.decryptWalletRecord(wallet);
    try {
      return bs58.encode(keypair.secretKey);
    } finally {
      KeypairService.clearKeypair(keypair);
    }
  }

  async requestWithdrawal(userId: number, destinationAddress: string, amountSol: number | 'MAX', idempotencyKey: string): Promise<string> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar.');
    
    const sourcePubkey = new PublicKey(wallet.public_key);
    const balance = await this.connection.getBalance(sourcePubkey);
    const spendableSol = balance / LAMPORTS_PER_SOL;
    
    const amount = amountSol === 'MAX' ? -1 : amountSol;
    return this.walletRepo.atomicCreateWithdrawal({
      user_id: userId,
      amount_sol: amount,
      destination_address: destinationAddress,
      idempotency_key: idempotencyKey,
      spendable_sol: spendableSol
    });
  }

  async withdrawSol(userId: number, destinationAddress: string, amountSol: number | 'MAX', existingWithdrawalId?: string): Promise<string> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar.');
    
    let finalDestAddress = destinationAddress;
    let finalAmountSol = amountSol;
    
    if (existingWithdrawalId) {
      const record = await this.walletRepo.getWithdrawalAttemptById(existingWithdrawalId);
      if (!record) throw new Error('Data withdrawal tidak ditemukan.');
      finalDestAddress = record.destination_address;
      finalAmountSol = record.amount_sol === -1 ? 'MAX' : record.amount_sol;
    }

    let destPubkey: PublicKey;
    try {
      destPubkey = new PublicKey(finalDestAddress);
    } catch {
      throw new Error('Alamat Solana tujuan tidak valid.');
    }

    if (wallet.owner_pubkey && destPubkey.toBase58() !== wallet.owner_pubkey) {
      throw new Error('Alamat tujuan tidak cocok dengan Owner Pubkey yang terdaftar (Security Policy).');
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
    const keypair = await this.decryptWalletRecord(wallet);

    try {
      const secureUrl = env.SECURE_WITHDRAWAL_RPC_URL || env.SOLANA_RPC_URL;
      const withdrawalConnection = new Connection(secureUrl, 'confirmed');

      const { blockhash, lastValidBlockHeight } = await withdrawalConnection.getLatestBlockhash('confirmed');

      // Calculate fee
      const tempAmount = finalAmountSol === 'MAX' ? 1000 : Math.floor(finalAmountSol * LAMPORTS_PER_SOL);
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
      
      const fee = await withdrawalConnection.getFeeForMessage(message, 'confirmed');
      const estimatedFee = fee.value ?? appSettings.NETWORK_FEE_FALLBACK_LAMPORTS;
      
      let transferLamports = 0;
      const rentReserve = 0.01 * LAMPORTS_PER_SOL;
      const maxAllowed = Math.floor(balance * 0.9); // Max 90% of balance
      const absoluteMax = balance - rentReserve - estimatedFee; // Or keep 0.01 SOL rent
      const safeMaxLamports = Math.min(maxAllowed, absoluteMax);

      if (safeMaxLamports <= 0) {
        throw new Error('Saldo terlalu kecil (minimal butuh 0.01 SOL sisa untuk rent).');
      }

      if (finalAmountSol === 'MAX') {
        transferLamports = safeMaxLamports;
      } else {
        transferLamports = Math.floor(finalAmountSol * LAMPORTS_PER_SOL);
        if (transferLamports > safeMaxLamports) {
           throw new Error(`Jumlah terlalu besar. Maksimum yang diizinkan (safe limit): ${(safeMaxLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        }
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
      
      let withdrawalId = existingWithdrawalId;
      if (!withdrawalId) {
        const idempotencyKey = `wd_${userId}_${Date.now()}`;
        withdrawalId = await this.walletRepo.createWithdrawalAttempt({
          user_id: userId,
          amount_sol: transferLamports / LAMPORTS_PER_SOL,
          destination_address: finalDestAddress,
          status: 'PENDING',
          idempotency_key: idempotencyKey,
          expected_lamports: transferLamports.toString()
        });
      } else {
        await this.walletRepo.updateWithdrawalAttempt(withdrawalId, { 
          status: 'SUBMITTED',
          expected_lamports: transferLamports.toString()
        });
      }

      const result = await TxSender.sendAndConfirm(withdrawalConnection, transaction, [keypair], {
        onSignature: async (sig) => {
          await this.walletRepo.updateWithdrawalAttempt(withdrawalId!, { tx_signature: sig, status: 'SIGNED' });
        }
      });
      
      if (
        result.status === 'SIGN_FAILED' ||
        result.status === 'PERSISTENCE_FAILED' ||
        result.status === 'SUBMISSION_REJECTED' ||
        result.status === 'FAILED_ONCHAIN'
      ) {
        await this.walletRepo.updateWithdrawalAttempt(withdrawalId!, { status: 'FAILED' });
        throw new Error(`Withdrawal gagal: ${result.status} - ${JSON.stringify(result.err)}`);
      }
      
      if (
        result.status === 'UNKNOWN' ||
        result.status === 'SUBMISSION_TIMEOUT' ||
        result.status === 'CONFIRMING' ||
        result.status === 'EXPIRED'
      ) {
        await this.walletRepo.updateWithdrawalAttempt(withdrawalId!, { status: 'CONFIRMING' });
        throw new Error(`Status transaksi tidak pasti (${result.status}). Harap cek explorer sebelum mengulang.`);
      }

      // A confirmed signature does not prove that the authorized withdrawal
      // instruction transferred the exact SOL amount to its intended recipient.
      // The recovery worker can finish this later if transaction metadata is not
      // yet indexed or RPC is temporarily unavailable.
      let parsedWithdrawal = null;
      try {
        parsedWithdrawal = await withdrawalConnection.getParsedTransaction(result.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 1,
        });
      } catch {
        // Preserve durable execution ownership; never send an immediate replacement.
      }
      if (!parsedWithdrawal || !verifyWithdrawalTransfer(
        parsedWithdrawal,
        sourcePubkey.toBase58(),
        finalDestAddress,
        transferLamports.toString(),
      )) {
        await this.walletRepo.updateWithdrawalAttempt(withdrawalId!, {
          status: parsedWithdrawal ? 'NEEDS_ATTENTION' : 'CONFIRMING',
        });
        throw new Error('Withdrawal confirmed but exact transfer evidence is not yet reconciled. Do not retry this withdrawal.');
      }

      await this.walletRepo.updateWithdrawalAttempt(withdrawalId!, { status: 'SUCCESS' });
      return result.signature;
    } finally {
      KeypairService.clearKeypair(keypair); // zero out memory per transaction
    }
  }

  async signAndSendVersionedTransaction(
    userId: number,
    transaction: VersionedTransaction,
    options: {
      intent: SwapTransactionIntent;
      onSignature?: (sig: string) => Promise<void>;
      onSend?: () => Promise<void>;
    },
  ): Promise<TxSendResult> {
    const wallet = await this.walletRepo.getWalletByUserId(userId);
    if (!wallet) throw new Error('Wallet belum terdaftar.');
    if (options.intent.walletPublicKey !== wallet.public_key) {
      throw new Error('Transaction intent wallet does not match the stored wallet');
    }

    await new TransactionValidator(this.connection).validateSwap(transaction, options.intent);

    const keypair = await this.decryptWalletRecord(wallet);

    try {
      return await TxSender.sendAndConfirm(this.connection, transaction, [keypair], options);
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

  async upgradeLegacyWalletEncryption(): Promise<number> {
    const legacyWallets = await this.walletRepo.getLegacyWallets();
    for (const wallet of legacyWallets) {
      const keypair = await this.decryptWalletRecord(wallet);
      KeypairService.clearKeypair(keypair);
    }
    return legacyWallets.length;
  }

  private async decryptWalletRecord(wallet: WalletRecord) {
    const version = wallet.encryption_version ?? 1;
    if (version !== 1 && version !== 2) {
      throw new Error(`Unsupported wallet encryption version: ${version}`);
    }

    const env = getEnv();
    const context = { userId: wallet.user_id, publicKey: wallet.public_key };
    const payload = {
      encryptedData: wallet.encrypted_private_key,
      iv: wallet.iv,
      authTag: wallet.auth_tag,
    };
    const keypair = KeypairService.decrypt(
      payload,
      env.MASTER_ENCRYPTION_KEY,
      version === 2 ? context : undefined,
    );

    if (keypair.publicKey.toBase58() !== wallet.public_key) {
      KeypairService.clearKeypair(keypair);
      throw new Error('Encrypted wallet key does not match its stored public key');
    }

    if (version === 1) {
      try {
        const rebound = KeypairService.encrypt(keypair, env.MASTER_ENCRYPTION_KEY, context);
        const upgraded = await this.walletRepo.upgradeWalletEncryption(wallet, {
          encrypted_private_key: rebound.encryptedData,
          iv: rebound.iv,
          auth_tag: rebound.authTag,
        });
        if (!upgraded) {
          const current = await this.walletRepo.getWalletByUserId(wallet.user_id);
          if (!current || current.encryption_version !== 2) {
            throw new Error('Legacy wallet encryption upgrade lost ownership of the database row');
          }
          const verificationKeypair = KeypairService.decrypt(
            {
              encryptedData: current.encrypted_private_key,
              iv: current.iv,
              authTag: current.auth_tag,
            },
            env.MASTER_ENCRYPTION_KEY,
            { userId: current.user_id, publicKey: current.public_key },
          );
          try {
            if (verificationKeypair.publicKey.toBase58() !== wallet.public_key) {
              throw new Error('Concurrent wallet encryption upgrade changed the custody key');
            }
          } finally {
            KeypairService.clearKeypair(verificationKeypair);
          }
        }
      } catch (error) {
        KeypairService.clearKeypair(keypair);
        throw error;
      }
    }

    return keypair;
  }
}
