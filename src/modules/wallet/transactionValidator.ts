import {
  AddressLookupTableAccount,
  AccountInfo,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeCloseAccountInstruction,
  decodeInstruction,
  decodeSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  isCloseAccountInstruction,
  isSyncNativeInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { appSettings } from '../../config/settings';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PUMP_BONDING_CURVE_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);
const PUMP_SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
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
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegateOption: number;
  delegate: PublicKey;
  delegatedAmount: bigint;
  state: number;
  closeAuthorityOption: number;
  closeAuthority: PublicKey;
  existed: boolean;
};

type ValidatedMessage = {
  instructions: TransactionInstruction[];
  minimumOutputAmountRaw: bigint;
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
    const validated = this.validateMessage(transaction, wallet, intent, lookupTables);
    this.validateComputeBudget(validated.instructions);
    await this.validateSimulation(transaction, intent, wallet, validated.instructions, validated.minimumOutputAmountRaw);
  }

  validateMessage(
    transaction: VersionedTransaction,
    wallet: PublicKey,
    intent: SwapTransactionIntent,
    lookupTables: AddressLookupTableAccount[] = [],
  ): ValidatedMessage {
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
      intent.provider === 'JUPITER' ? JUPITER_V6_PROGRAM_ID : PUMP_BONDING_CURVE_PROGRAM_ID,
    ]);
    const requiredSwapProgram = intent.provider === 'JUPITER' ? JUPITER_V6_PROGRAM_ID : PUMP_BONDING_CURVE_PROGRAM_ID;

    if (!instructions.some((instruction) => instruction.programId.toBase58() === requiredSwapProgram)) {
      throw new TransactionValidationError(`missing ${intent.provider} swap instruction`);
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
      } else if (instruction.programId.equals(TOKEN_PROGRAM_ID) || instruction.programId.equals(TOKEN_2022_PROGRAM_ID)) {
        this.validateTokenInstruction(instruction, wallet);
      } else if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        this.validateAssociatedTokenInstruction(instruction, wallet, intent);
      }
    }

    const minimumOutputAmountRaw = intent.provider === 'PUMP_PORTAL'
      ? this.validatePumpInstruction(instructions, wallet, intent)
      : this.validateJupiterMinimumOutput(intent);
    return { instructions, minimumOutputAmountRaw };
  }

  private validateJupiterMinimumOutput(intent: SwapTransactionIntent): bigint {
    if (!intent.minimumOutputAmountRaw || intent.minimumOutputAmountRaw <= 0n) {
      throw new TransactionValidationError('Jupiter minimum output must be positive');
    }
    return intent.minimumOutputAmountRaw;
  }

  private validateTokenInstruction(instruction: TransactionInstruction, wallet: PublicKey): void {
    if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      throw new TransactionValidationError('top-level Token-2022 instructions are not allowed in a swap');
    }

    let decoded;
    try {
      decoded = decodeInstruction(instruction, TOKEN_PROGRAM_ID);
    } catch (error) {
      throw new TransactionValidationError(`invalid token instruction: ${this.errorMessage(error)}`);
    }

    const expectedWrappedSolAccount = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), wallet);
    if (isSyncNativeInstruction(decoded)) {
      const sync = decodeSyncNativeInstruction(instruction, TOKEN_PROGRAM_ID);
      if (!sync.keys.account.pubkey.equals(expectedWrappedSolAccount)) {
        throw new TransactionValidationError('SyncNative is only allowed for the wallet wrapped-SOL ATA');
      }
      return;
    }
    if (isCloseAccountInstruction(decoded)) {
      const close = decodeCloseAccountInstruction(instruction, TOKEN_PROGRAM_ID);
      if (
        !close.keys.account.pubkey.equals(expectedWrappedSolAccount)
        || !close.keys.destination.pubkey.equals(wallet)
        || !close.keys.authority.pubkey.equals(wallet)
        || close.keys.multiSigners.length !== 0
      ) {
        throw new TransactionValidationError('CloseAccount is only allowed for the wallet wrapped-SOL ATA');
      }
      return;
    }

    throw new TransactionValidationError(`top-level token instruction ${decoded.data.instruction} is not allowed in a swap`);
  }

  private validateAssociatedTokenInstruction(
    instruction: TransactionInstruction,
    wallet: PublicKey,
    intent: SwapTransactionIntent,
  ): void {
    if (instruction.data.length > 1 || (instruction.data.length === 1 && instruction.data[0] !== 1)) {
      throw new TransactionValidationError('only associated-token account creation is allowed in a swap');
    }
    if (instruction.keys.length !== 6 && instruction.keys.length !== 7) {
      throw new TransactionValidationError('invalid associated-token instruction account count');
    }

    const [payer, associatedToken, owner, mint, systemProgram, tokenProgram, rent] = instruction.keys;
    if (
      !payer.pubkey.equals(wallet)
      || !payer.isSigner
      || !owner.pubkey.equals(wallet)
      || !systemProgram.pubkey.equals(SystemProgram.programId)
      || (rent && !rent.pubkey.equals(SYSVAR_RENT_PUBKEY))
      || (!tokenProgram.pubkey.equals(TOKEN_PROGRAM_ID) && !tokenProgram.pubkey.equals(TOKEN_2022_PROGRAM_ID))
    ) {
      throw new TransactionValidationError('associated-token instruction is not owned and funded by the wallet');
    }

    const approvedMints = new Set([intent.inputMint, intent.outputMint]);
    if (!approvedMints.has(mint.pubkey.toBase58())) {
      throw new TransactionValidationError('associated-token instruction uses a mint outside the swap intent');
    }
    const expectedAta = getAssociatedTokenAddressSync(mint.pubkey, wallet, false, tokenProgram.pubkey);
    if (!associatedToken.pubkey.equals(expectedAta)) {
      throw new TransactionValidationError('associated-token instruction does not target the expected wallet ATA');
    }
  }

  private validatePumpInstruction(
    instructions: TransactionInstruction[],
    wallet: PublicKey,
    intent: SwapTransactionIntent,
  ): bigint {
    const pumpInstructions = instructions.filter((instruction) => instruction.programId.toBase58() === PUMP_BONDING_CURVE_PROGRAM_ID);
    if (pumpInstructions.length !== 1) {
      throw new TransactionValidationError('Pump transaction must contain exactly one swap instruction');
    }

    const instruction = pumpInstructions[0];
    if (instruction.data.length < 24 || instruction.keys.length < 9) {
      throw new TransactionValidationError('invalid Pump swap instruction');
    }
    const discriminator = instruction.data.subarray(0, 8);
    const firstAmount = instruction.data.readBigUInt64LE(8);
    const secondAmount = instruction.data.readBigUInt64LE(16);
    const expectedMint = new PublicKey(intent.side === 'BUY' ? intent.outputMint : intent.inputMint);
    const tokenProgram = instruction.keys[8].pubkey;
    if (
      !instruction.keys[2].pubkey.equals(expectedMint)
      || !instruction.keys[5].pubkey.equals(getAssociatedTokenAddressSync(expectedMint, wallet, false, tokenProgram))
      || !instruction.keys[6].pubkey.equals(wallet)
      || !instruction.keys[6].isSigner
      || (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID))
    ) {
      throw new TransactionValidationError('Pump swap accounts do not match the approved wallet and mint');
    }

    if (discriminator.equals(PUMP_SELL_DISCRIMINATOR)) {
      if (intent.side !== 'SELL' || instruction.data.length !== 24 || firstAmount !== intent.inputAmountRaw) {
        throw new TransactionValidationError('Pump sell amount does not match the approved input');
      }
      if (secondAmount <= 0n) throw new TransactionValidationError('Pump sell minimum output must be positive');
      return secondAmount;
    }

    if (intent.side !== 'BUY') {
      throw new TransactionValidationError('Pump buy instruction does not match a sell intent');
    }
    if (instruction.data.length !== 24 && instruction.data.length !== 26) {
      throw new TransactionValidationError('unsupported Pump buy instruction format');
    }
    if (instruction.data.length === 26 && instruction.data[25] !== 0) {
      throw new TransactionValidationError('Pump partial-fill buys are not allowed');
    }
    if (discriminator.equals(PUMP_BUY_DISCRIMINATOR)) {
      if (secondAmount > intent.inputAmountRaw) {
        throw new TransactionValidationError('Pump buy maximum SOL cost exceeds the approved input');
      }
      if (firstAmount <= 0n) throw new TransactionValidationError('Pump buy minimum output must be positive');
      return firstAmount;
    }
    if (discriminator.equals(PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR)) {
      if (firstAmount !== intent.inputAmountRaw) {
        throw new TransactionValidationError('Pump buy SOL input does not match the approved input');
      }
      if (secondAmount <= 0n) throw new TransactionValidationError('Pump buy minimum output must be positive');
      return secondAmount;
    }

    throw new TransactionValidationError('unsupported Pump swap instruction');
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
    instructions: TransactionInstruction[],
    minimumOutput: bigint,
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

    const instructionAddresses = [...new Set(instructions.flatMap((instruction) => instruction.keys.map((key) => key.pubkey.toBase58())))];
    const accountInfos = await this.getMultipleAccountInfos(
      instructionAddresses.map((address) => new PublicKey(address)),
    );
    instructionAddresses.forEach((address, index) => {
      const info = accountInfos[index];
      if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) return;
      const snapshot = this.decodeTokenAccount(new PublicKey(address), info.data);
      if (snapshot.owner.equals(wallet)) trackedAccounts.set(address, snapshot);
    });

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
      if (!account) {
        const before = trackedAccounts.get(address);
        if (before?.existed) {
          throw new TransactionValidationError(`wallet token account was closed during simulation: ${address}`);
        }
        postTokenAmounts.set(address, 0n);
        return;
      }
      const before = trackedAccounts.get(address);
      const after = this.decodeTokenAccount(new PublicKey(address), account.data[0]);
      if (!before) throw new TransactionValidationError(`missing pre-simulation token state: ${address}`);
      this.validateTokenAccountState(before, after, intent);
      postTokenAmounts.set(address, after.amount);
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
      ...this.decodeTokenAccount(pubkey, account.data),
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
        accounts.push({
          address: expectedAta,
          mint,
          owner: wallet,
          amount: 0n,
          delegateOption: 0,
          delegate: PublicKey.default,
          delegatedAmount: 0n,
          state: 1,
          closeAuthorityOption: 0,
          closeAuthority: PublicKey.default,
          existed: false,
        });
      }
    }

    return accounts;
  }

  private decodeTokenAccount(address: PublicKey, data: Buffer | string): TokenAccountSnapshot {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    if (buffer.length < AccountLayout.span) {
      throw new TransactionValidationError('invalid token account data returned by RPC');
    }
    const decoded = AccountLayout.decode(buffer.subarray(0, AccountLayout.span));
    return {
      address,
      mint: decoded.mint,
      owner: decoded.owner,
      amount: decoded.amount,
      delegateOption: decoded.delegateOption,
      delegate: decoded.delegate,
      delegatedAmount: decoded.delegatedAmount,
      state: decoded.state,
      closeAuthorityOption: decoded.closeAuthorityOption,
      closeAuthority: decoded.closeAuthority,
      existed: true,
    };
  }

  private async getMultipleAccountInfos(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const results: (AccountInfo<Buffer> | null)[] = [];
    for (let offset = 0; offset < addresses.length; offset += 100) {
      const chunk = addresses.slice(offset, offset + 100);
      results.push(...await this.connection.getMultipleAccountsInfo(chunk, 'confirmed'));
    }
    return results;
  }

  private validateTokenAccountState(
    before: TokenAccountSnapshot,
    after: TokenAccountSnapshot,
    intent: SwapTransactionIntent,
  ): void {
    if (
      !after.mint.equals(before.mint)
      || !after.owner.equals(before.owner)
      || after.delegateOption !== before.delegateOption
      || !after.delegate.equals(before.delegate)
      || after.delegatedAmount !== before.delegatedAmount
      || after.state !== before.state
      || after.closeAuthorityOption !== before.closeAuthorityOption
      || !after.closeAuthority.equals(before.closeAuthority)
    ) {
      throw new TransactionValidationError(`token account authority or state changed: ${before.address.toBase58()}`);
    }

    const mint = before.mint.toBase58();
    if (mint !== intent.inputMint && mint !== intent.outputMint && after.amount !== before.amount) {
      throw new TransactionValidationError(`unrelated token account balance changed: ${before.address.toBase58()}`);
    }
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
