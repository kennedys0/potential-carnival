import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { appSettings } from '../../config/settings';

const ApiInstructionSchema = z.object({
  programId: z.string().min(32),
  accounts: z.array(z.object({
    pubkey: z.string().min(32),
    isSigner: z.boolean(),
    isWritable: z.boolean(),
  })),
  data: z.string(),
});

const BuildResponseSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string().regex(/^\d+$/),
  outAmount: z.string().regex(/^\d+$/),
  otherAmountThreshold: z.string().regex(/^\d+$/),
  swapMode: z.string(),
  slippageBps: z.number().int().nonnegative(),
  priceImpactPct: z.string(),
  routePlan: z.array(z.object({
    swapInfo: z.object({
      ammKey: z.string(),
      label: z.string(),
      inputMint: z.string(),
      outputMint: z.string(),
      inAmount: z.string(),
      outAmount: z.string(),
    }),
    percent: z.number(),
    bps: z.number(),
    usdValue: z.number().optional(),
  })),
  computeBudgetInstructions: z.array(ApiInstructionSchema),
  setupInstructions: z.array(ApiInstructionSchema),
  swapInstruction: ApiInstructionSchema,
  cleanupInstruction: ApiInstructionSchema.nullable(),
  otherInstructions: z.array(ApiInstructionSchema),
  tipInstruction: ApiInstructionSchema.nullable(),
  addressesByLookupTableAddress: z.record(z.array(z.string())).nullable(),
  transactionVersion: z.literal(0),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number().int().min(0).max(255)).length(32),
    lastValidBlockHeight: z.number().int().positive(),
  }),
});

type ApiInstruction = z.infer<typeof ApiInstructionSchema>;
export type JupiterBuildQuote = Pick<
  z.infer<typeof BuildResponseSchema>,
  'inputMint' | 'outputMint' | 'inAmount' | 'outAmount' | 'otherAmountThreshold' | 'slippageBps' | 'priceImpactPct'
>;

export interface JupiterSwapBuildResult {
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
  addressLookupTableAccounts: AddressLookupTableAccount[];
  quote: JupiterBuildQuote;
}

export class JupiterClient {
  private readonly baseUrl = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2';
  private readonly apiKey = process.env.JUPITER_API_KEY;
  private lastRequestTime = 0;
  private requestPromise: Promise<void> = Promise.resolve();
  private readonly minDelayMs = 250;
  private readonly indicativeTaker = Keypair.generate().publicKey.toBase58();

  constructor(private readonly connection: Connection) {}

  async getQuote(
    inputMint: string,
    outputMint: string,
    inputAmountRaw: bigint | number,
    slippageBps: number,
  ): Promise<JupiterBuildQuote> {
    const amount = BigInt(inputAmountRaw);
    const build = await this.fetchBuild(inputMint, outputMint, amount, slippageBps, this.indicativeTaker);
    return {
      inputMint: build.inputMint,
      outputMint: build.outputMint,
      inAmount: build.inAmount,
      outAmount: build.outAmount,
      otherAmountThreshold: build.otherAmountThreshold,
      slippageBps: build.slippageBps,
      priceImpactPct: build.priceImpactPct,
    };
  }

  async buildSwap(
    inputMint: string,
    outputMint: string,
    inputAmountRaw: bigint,
    slippageBps: number,
    taker: string,
  ): Promise<JupiterSwapBuildResult> {
    if (inputAmountRaw <= 0n) throw new Error('Jupiter input amount must be positive');
    if (!Number.isInteger(slippageBps) || slippageBps < 1) throw new Error('Invalid Jupiter slippage');
    const build = await this.fetchBuild(inputMint, outputMint, inputAmountRaw, slippageBps, taker);
    if (build.tipInstruction) throw new Error('Jupiter returned an unsolicited tip instruction');

    const addressLookupTableAccounts = this.transformLookupTables(build.addressesByLookupTableAddress);
    const instructions = [
      ...build.setupInstructions.map((instruction) => this.toInstruction(instruction)),
      this.toInstruction(build.swapInstruction),
      ...(build.cleanupInstruction ? [this.toInstruction(build.cleanupInstruction)] : []),
      ...build.otherInstructions.map((instruction) => this.toInstruction(instruction)),
    ];
    const recentBlockhash = bs58.encode(Buffer.from(build.blockhashWithMetadata.blockhash));

    const simulationTransaction = this.compileTransaction(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: appSettings.TX_MAX_COMPUTE_UNITS }), ...instructions],
      taker,
      recentBlockhash,
      addressLookupTableAccounts,
    );
    const simulation = await this.connection.simulateTransaction(simulationTransaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    if (simulation.value.err) {
      throw new Error(`Jupiter build simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    if (!simulation.value.unitsConsumed || simulation.value.unitsConsumed <= 0) {
      throw new Error('Jupiter build simulation did not report compute usage');
    }

    const computeUnitLimit = Math.min(
      Math.ceil(simulation.value.unitsConsumed * 1.2),
      appSettings.TX_MAX_COMPUTE_UNITS,
    );
    const transaction = this.compileTransaction(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ...build.computeBudgetInstructions.map((instruction) => this.toInstruction(instruction)),
        ...instructions,
      ],
      taker,
      recentBlockhash,
      addressLookupTableAccounts,
    );

    return {
      transaction,
      lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight,
      addressLookupTableAccounts,
      quote: {
        inputMint: build.inputMint,
        outputMint: build.outputMint,
        inAmount: build.inAmount,
        outAmount: build.outAmount,
        otherAmountThreshold: build.otherAmountThreshold,
        slippageBps: build.slippageBps,
        priceImpactPct: build.priceImpactPct,
      },
    };
  }

  private async fetchBuild(
    inputMint: string,
    outputMint: string,
    inputAmountRaw: bigint,
    slippageBps: number,
    taker: string,
  ): Promise<z.infer<typeof BuildResponseSchema>> {
    if (!this.apiKey) throw new Error('JUPITER_API_KEY is required for Jupiter Swap API V2');
    if (inputAmountRaw <= 0n) throw new Error('Jupiter input amount must be positive');
    if (!Number.isInteger(slippageBps) || slippageBps < 1) throw new Error('Invalid Jupiter slippage');

    await this.waitForRateLimit();
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: inputAmountRaw.toString(),
      taker,
      slippageBps: String(slippageBps),
      wrapAndUnwrapSol: 'true',
      computeUnitPricePercentile: 'medium',
      transactionVersion: '0',
    });
    const response = await fetch(`${this.baseUrl}/build?${params.toString()}`, {
      headers: { 'x-api-key': this.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Jupiter Swap API V2 error (${response.status}): ${await response.text()}`);
    }

    const build = BuildResponseSchema.parse(await response.json());
    this.validateQuote(build, { inputMint, outputMint, inputAmountRaw, slippageBps });
    return build;
  }

  private validateQuote(
    build: z.infer<typeof BuildResponseSchema>,
    requested: { inputMint: string; outputMint: string; inputAmountRaw: bigint; slippageBps: number },
  ): void {
    if (build.inputMint !== requested.inputMint || build.outputMint !== requested.outputMint) {
      throw new Error('Jupiter response mint pair does not match request');
    }
    if (BigInt(build.inAmount) !== requested.inputAmountRaw) {
      throw new Error('Jupiter response input amount does not match request');
    }
    if (build.slippageBps !== requested.slippageBps) {
      throw new Error('Jupiter response slippage does not match request');
    }
    if (BigInt(build.outAmount) <= 0n || BigInt(build.otherAmountThreshold) <= 0n) {
      throw new Error('Jupiter returned a zero output quote');
    }
    const priceImpact = Number(build.priceImpactPct);
    if (!Number.isFinite(priceImpact) || priceImpact < 0) {
      throw new Error('Jupiter returned invalid price impact');
    }
  }

  private compileTransaction(
    instructions: TransactionInstruction[],
    taker: string,
    recentBlockhash: string,
    addressLookupTableAccounts: AddressLookupTableAccount[],
  ): VersionedTransaction {
    const message = new TransactionMessage({
      payerKey: new PublicKey(taker),
      recentBlockhash,
      instructions,
    }).compileToV0Message(addressLookupTableAccounts);
    return new VersionedTransaction(message);
  }

  private toInstruction(instruction: ApiInstruction): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.accounts.map((account) => ({
        pubkey: new PublicKey(account.pubkey),
        isSigner: account.isSigner,
        isWritable: account.isWritable,
      })),
      data: Buffer.from(instruction.data, 'base64'),
    });
  }

  private transformLookupTables(raw: Record<string, string[]> | null): AddressLookupTableAccount[] {
    if (!raw) return [];
    return Object.entries(raw).map(([key, addresses]) => new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: addresses.map((address) => new PublicKey(address)),
      },
    }));
  }

  private async waitForRateLimit(): Promise<void> {
    const nextRequest = this.requestPromise.then(async () => {
      const delay = this.minDelayMs - (Date.now() - this.lastRequestTime);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      this.lastRequestTime = Date.now();
    });
    this.requestPromise = nextRequest.catch(() => undefined);
    await nextRequest;
  }
}
