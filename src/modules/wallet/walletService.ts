import { Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import QRCode from 'qrcode';
import bs58 from 'bs58';
import { KeypairService } from './keypairService';
import { WalletRepository } from '../../database/repositories/walletRepository';
import { getEnv } from '../../config/env';
import { TxSender, TxSendResult } from './txSender';

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
    const keypair = KeypairService.decrypt(
      {
        encryptedData: wallet.encrypted_private_key,
        iv: wallet.iv,
        authTag: wallet.auth_tag,
      },
      env.MASTER_ENCRYPTION_KEY
    );

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
      const estimatedFee = fee.value ?? 5000;
      
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

      await this.walletRepo.updateWithdrawalAttempt(withdrawalId!, { status: 'SUCCESS' });
      return result.signature;
    } finally {
      KeypairService.clearKeypair(keypair); // zero out memory per transaction
    }
  }

  async signAndSendVersionedTransaction(userId: number, transaction: any, options?: { onSignature?: (sig: string) => Promise<void>; onSend?: () => Promise<void> }): Promise<TxSendResult> {
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
}
