import {
  AddressLookupTableAccount,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { appSettings } from '../../config/settings';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PUMP_BONDING_CURVE_PROGRAM_ID = '6EF8rrecthR5DkzonNwu78J9yU15xNu6FgwQk8bD3K';
const MEMO_PROGRAM_IDS = [
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
];

export type SwapProvider = 'JUPITER' | 'PUMP_PORTAL';

export interface SwapTransactionIntent {
  provider: SwapProvider;
  side: 'BUY' | 'SELL';
  walletPublicKey: string;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: bigint;
  minimumOutputAmountRaw?: bigint;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}

type TokenAccountSnapshot = {
  address: PublicKey;
  amount: bigint;
};

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(`Transaction validation failed: ${message}`);
    this.name = 'TransactionValidationError';
  }
}

export class TransactionValidator {
  constructor(private readonly connection: Connection) {}

  async validateSwap(transaction: VersionedTransaction, intent: SwapTransactionIntent): Promise<void> {
    if (intent.inputAmountRaw <= 0n) {
      throw new TransactionValidationError('input amount must be positive');
    }

    const wallet = new PublicKey(intent.walletPublicKey);
    const lookupTables = intent.addressLookupTableAccounts ?? await this.resolveLookupTables(transaction);
    const instructions = this.validateMessage(transaction, wallet, intent.provider, lookupTables);
    this.validateComputeBudget(instructions);
    await this.validateSimulation(transaction, intent, wallet);
  }

  validateMessage(
    transaction: VersionedTransaction,
    wallet: PublicKey,
    provider: SwapProvider,
    lookupTables: AddressLookupTableAccount[] = [],
  ): TransactionInstruction[] {
    const message = transaction.message;
    const staticAccountKeys = message.staticAccountKeys;
    const requiredSigners = staticAccountKeys.slice(0, message.header.numRequiredSignatures);

    if (requiredSigners.length !== 1 || !requiredSigners[0].equals(wallet)) {
      throw new TransactionValidationError('wallet must be the only required signer');
    }
    if (!staticAccountKeys[0]?.equals(wallet)) {
      throw new TransactionValidationError('unexpected fee payer');
    }
    if (transaction.signatures.some((signature) => signature.some((byte) => byte !== 0))) {
      throw new TransactionValidationError('provider returned a pre-signed transaction');
    }

    let instructions: TransactionInstruction[];
    try {
      instructions = TransactionMessage.decompile(
        message,
        message.version === 0 ? { addressLookupTableAccounts: lookupTables } : undefined,
      ).instructions;
    } catch (error) {
      throw new TransactionValidationError(`cannot decompile transaction: ${this.errorMessage(error)}`);
    }

    const allowedPrograms = new Set([
      SystemProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      ...MEMO_PROGRAM_IDS,
      provider === 'JUPITER' ? JUPITER_V6_PROGRAM_ID : PUMP_BONDING_CURVE_PROGRAM_ID,
    ]);
    const requiredSwapProgram = provider === 'JUPITER' ? JUPITER_V6_PROGRAM_ID : PUMP_BONDING_CURVE_PROGRAM_ID;

    if (!instructions.some((instruction) => instruction.programId.toBase58() === requiredSwapProgram)) {
      throw new TransactionValidationError(`missing ${provider} swap instruction`);
    }

    for (const instruction of instructions) {
      const programId = instruction.programId.toBase58();
      if (!allowedPrograms.has(programId)) {
        throw new TransactionValidationError(`program is not allowlisted: ${programId}`);
      }
      for (const account of instruction.keys) {
        if (account.isSigner && !account.pubkey.equals(wallet)) {
          throw new TransactionValidationError(`unexpected instruction signer: ${account.pubkey.toBase58()}`);
        }
      }
      if (instruction.programId.equals(SystemProgram.programId)) {
        this.validateSystemInstruction(instruction, wallet);
      }
    }

    return instructions;
  }

  private validateSystemInstruction(instruction: TransactionInstruction, wallet: PublicKey): void {
    let type;
    try {
      type = SystemInstruction.decodeInstructionType(instruction);
    } catch (error) {
      throw new TransactionValidationError(`invalid system instruction: ${this.errorMessage(error)}`);
    }
    if (type !== 'Transfer') {
      throw new TransactionValidationError(`system instruction ${type} is not allowed in a swap`);
    }

    const transfer = SystemInstruction.decodeTransfer(instruction);
    const expectedWrappedSolAccount = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), wallet);
    if (!transfer.fromPubkey.equals(wallet) || !transfer.toPubkey.equals(expectedWrappedSolAccount)) {
      throw new TransactionValidationError('native transfer is not an approved wrapped-SOL funding instruction');
    }
  }

  private validateComputeBudget(instructions: TransactionInstruction[]): void {
    let computeUnitLimit = 200_000;
    let computeUnitPrice = 0n;
    let limitInstructions = 0;
    let priceInstructions = 0;

    for (const instruction of instructions) {
      if (!instruction.programId.equals(ComputeBudgetProgram.programId)) continue;

      let type;
      try {
        type = ComputeBudgetInstruction.decodeInstructionType(instruction);
      } catch (error) {
        throw new TransactionValidationError(`invalid compute budget instruction: ${this.errorMessage(error)}`);
      }

      if (type === 'SetComputeUnitLimit') {
        limitInstructions += 1;
        computeUnitLimit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(instruction).units;
      } else if (type === 'SetComputeUnitPrice') {
        priceInstructions += 1;
        computeUnitPrice = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(instruction).microLamports);
      } else if (type === 'RequestUnits') {
        throw new TransactionValidationError('deprecated combined compute budget instruction is not allowed');
      }
    }

    if (limitInstructions > 1 || priceInstructions > 1) {
      throw new TransactionValidationError('duplicate compute budget controls');
    }
    if (computeUnitLimit > appSettings.TX_MAX_COMPUTE_UNITS) {
      throw new TransactionValidationError(`compute unit limit ${computeUnitLimit} exceeds cap`);
    }

    const priorityFeeLamports = (computeUnitPrice * BigInt(computeUnitLimit) + 999_999n) / 1_000_000n;
    if (priorityFeeLamports > BigInt(appSettings.TX_MAX_PRIORITY_FEE_LAMPORTS)) {
      throw new TransactionValidationError(`priority fee ${priorityFeeLamports} exceeds cap`);
    }
  }

  private async validateSimulation(
    transaction: VersionedTransaction,
    intent: SwapTransactionIntent,
    wallet: PublicKey,
  ): Promise<void> {
    const trackedAccounts = new Map<string, TokenAccountSnapshot>();
    const inputTokenAccounts = intent.inputMint === WSOL_MINT
      ? []
      : await this.getTokenAccounts(wallet, new PublicKey(intent.inputMint));
    const outputTokenAccounts = intent.outputMint === WSOL_MINT
      ? []
      : await this.getTokenAccounts(wallet, new PublicKey(intent.outputMint), true);

    for (const account of [...inputTokenAccounts, ...outputTokenAccounts]) {
      trackedAccounts.set(account.address.toBase58(), account);
    }

    const addresses = [wallet.toBase58(), ...trackedAccounts.keys()];
    const preWalletLamports = await this.connection.getBalance(wallet, 'confirmed');
    const simulation = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    });

    if (simulation.value.err) {
      throw new TransactionValidationError(`simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    if (!simulation.value.accounts || simulation.value.accounts.length !== addresses.length) {
      throw new TransactionValidationError('simulation did not return required account states');
    }

    const postWallet = simulation.value.accounts[0];
    if (!postWallet) throw new TransactionValidationError('wallet missing from simulation result');

    const postTokenAmounts = new Map<string, bigint>();
    addresses.slice(1).forEach((address, index) => {
      const account = simulation.value.accounts?.[index + 1];
      postTokenAmounts.set(address, account ? this.decodeTokenAmount(account.data[0]) : 0n);
    });

    const inputBefore = inputTokenAccounts.reduce((sum, account) => sum + account.amount, 0n);
    const inputAfter = inputTokenAccounts.reduce(
      (sum, account) => sum + (postTokenAmounts.get(account.address.toBase58()) ?? 0n),
      0n,
    );
    const outputBefore = outputTokenAccounts.reduce((sum, account) => sum + account.amount, 0n);
    const outputAfter = outputTokenAccounts.reduce(
      (sum, account) => sum + (postTokenAmounts.get(account.address.toBase58()) ?? 0n),
      0n,
    );
    const minimumOutput = intent.minimumOutputAmountRaw ?? BigInt(appSettings.TX_MIN_OUTPUT_RAW);

    if (intent.inputMint === WSOL_MINT) {
      const debit = BigInt(preWalletLamports) - BigInt(postWallet.lamports);
      const maximumDebit = intent.inputAmountRaw
        + BigInt(appSettings.TX_MAX_PRIORITY_FEE_LAMPORTS)
        + BigInt(appSettings.TX_MAX_NETWORK_FEE_LAMPORTS)
        + BigInt(appSettings.TX_MAX_INCIDENTAL_LAMPORTS);
      if (debit < intent.inputAmountRaw || debit > maximumDebit) {
        throw new TransactionValidationError(`native input debit ${debit} is outside the approved range`);
      }
    } else {
      const debit = inputBefore - inputAfter;
      if (debit !== intent.inputAmountRaw) {
        throw new TransactionValidationError(`token input debit ${debit} does not equal approved amount ${intent.inputAmountRaw}`);
      }
    }

    if (intent.outputMint === WSOL_MINT) {
      const netGain = BigInt(postWallet.lamports) - BigInt(preWalletLamports);
      const feeAllowance = BigInt(appSettings.TX_MAX_PRIORITY_FEE_LAMPORTS + appSettings.TX_MAX_NETWORK_FEE_LAMPORTS);
      if (netGain + feeAllowance < minimumOutput) {
        throw new TransactionValidationError(`native output ${netGain} is below minimum ${minimumOutput}`);
      }
    } else {
      const credit = outputAfter - outputBefore;
      if (credit < minimumOutput) {
        throw new TransactionValidationError(`token output ${credit} is below minimum ${minimumOutput}`);
      }
    }
  }

  private async getTokenAccounts(wallet: PublicKey, mint: PublicKey, includeExpectedAta = false): Promise<TokenAccountSnapshot[]> {
    const response = await this.connection.getTokenAccountsByOwner(wallet, { mint }, 'confirmed');
    const accounts = response.value.map(({ pubkey, account }) => ({
      address: pubkey,
      amount: this.decodeTokenAmount(account.data),
    }));

    if (includeExpectedAta) {
      const mintAccount = await this.connection.getAccountInfo(mint, 'confirmed');
      if (!mintAccount) throw new TransactionValidationError(`mint account not found: ${mint.toBase58()}`);
      const tokenProgram = mintAccount.owner;
      if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new TransactionValidationError(`unsupported mint owner: ${tokenProgram.toBase58()}`);
      }
      const expectedAta = getAssociatedTokenAddressSync(mint, wallet, false, tokenProgram);
      if (!accounts.some((account) => account.address.equals(expectedAta))) {
        accounts.push({ address: expectedAta, amount: 0n });
      }
    }

    return accounts;
  }

  private decodeTokenAmount(data: Buffer | string): bigint {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    if (buffer.length < AccountLayout.span) {
      throw new TransactionValidationError('invalid token account data returned by RPC');
    }
    return AccountLayout.decode(buffer.subarray(0, AccountLayout.span)).amount;
  }

  private async resolveLookupTables(transaction: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
    if (!(transaction.message instanceof MessageV0)) return [];

    const tables = await Promise.all(transaction.message.addressTableLookups.map(async ({ accountKey }) => {
      const response = await this.connection.getAddressLookupTable(accountKey, { commitment: 'confirmed' });
      if (!response.value) {
        throw new TransactionValidationError(`address lookup table not found: ${accountKey.toBase58()}`);
      }
      return response.value;
    }));
    return tables;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
