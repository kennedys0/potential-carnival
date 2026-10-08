import { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';

export interface FillParseResult {
  tokenDeltaRaw: bigint;
  decimals: number;
  solDeltaLamports: bigint;
  feeLamports: bigint;
}

export class FillParser {
  static parseBuyFill(tx: ParsedTransactionWithMeta | null, walletPubkey: string, mint: string): FillParseResult | null {
    if (!tx || !tx.meta || tx.meta.err) {
      return null;
    }

    const accountKeys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey.toBase58());
    const walletIndex = accountKeys.indexOf(walletPubkey);
    
    if (walletIndex === -1) {
      return null;
    }

    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;
    
    const preSol = BigInt(preBalances[walletIndex] ?? 0);
    const postSol = BigInt(postBalances[walletIndex] ?? 0);
    const fee = BigInt(tx.meta.fee ?? 0);
    
    // For buy, we spend SOL (post < pre), so solDelta = pre - post - fee
    // Wait, solDelta is the actual SOL spent on the swap excluding the fee?
    // If wallet balance dropped by X, X = swapCost + fee.
    // So swapCost = pre - post - fee
    // solDeltaLamports represents sol spent.
    const solDeltaLamports = preSol - postSol - fee;

    let preToken = 0n;
    let postToken = 0n;
    let decimals = 0;

    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    const relevantIndices = new Set<number>();
    preTokenBalances.forEach(b => {
      if (b.mint === mint && b.owner === walletPubkey) relevantIndices.add(b.accountIndex);
    });
    postTokenBalances.forEach(b => {
      if (b.mint === mint && b.owner === walletPubkey) relevantIndices.add(b.accountIndex);
    });

    for (const index of relevantIndices) {
      const preInfo = preTokenBalances.find(b => b.accountIndex === index);
      const postInfo = postTokenBalances.find(b => b.accountIndex === index);
      
      const preAmt = preInfo?.uiTokenAmount ? BigInt(preInfo.uiTokenAmount.amount) : 0n;
      const postAmt = postInfo?.uiTokenAmount ? BigInt(postInfo.uiTokenAmount.amount) : 0n;
      
      if (preInfo?.uiTokenAmount) decimals = preInfo.uiTokenAmount.decimals;
      else if (postInfo?.uiTokenAmount) decimals = postInfo.uiTokenAmount.decimals;
      
      preToken += preAmt;
      postToken += postAmt;
    }

    const tokenDeltaRaw = postToken - preToken;

    if (tokenDeltaRaw <= 0n) {
      return null;
    }

    return {
      tokenDeltaRaw,
      decimals,
      solDeltaLamports,
      feeLamports: fee
    };
  }

  static parseSellFill(tx: ParsedTransactionWithMeta | null, walletPubkey: string, mint: string): FillParseResult | null {
    if (!tx || !tx.meta || tx.meta.err) {
      return null;
    }

    const accountKeys = tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey.toBase58());
    const walletIndex = accountKeys.indexOf(walletPubkey);
    
    if (walletIndex === -1) {
      return null;
    }

    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;
    
    const preSol = BigInt(preBalances[walletIndex] ?? 0);
    const postSol = BigInt(postBalances[walletIndex] ?? 0);
    const fee = BigInt(tx.meta.fee ?? 0);
    
    // For sell, we receive SOL (post > pre), so received = post - pre + fee
    // If wallet balance increased by X, X = swapReceived - fee.
    // So swapReceived = post - pre + fee
    const solDeltaLamports = postSol - preSol + fee;

    let preToken = 0n;
    let postToken = 0n;
    let decimals = 0;

    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];

    const relevantIndices = new Set<number>();
    preTokenBalances.forEach(b => {
      if (b.mint === mint && b.owner === walletPubkey) relevantIndices.add(b.accountIndex);
    });
    postTokenBalances.forEach(b => {
      if (b.mint === mint && b.owner === walletPubkey) relevantIndices.add(b.accountIndex);
    });

    for (const index of relevantIndices) {
      const preInfo = preTokenBalances.find(b => b.accountIndex === index);
      const postInfo = postTokenBalances.find(b => b.accountIndex === index);
      
      const preAmt = preInfo?.uiTokenAmount ? BigInt(preInfo.uiTokenAmount.amount) : 0n;
      const postAmt = postInfo?.uiTokenAmount ? BigInt(postInfo.uiTokenAmount.amount) : 0n;
      
      if (preInfo?.uiTokenAmount) decimals = preInfo.uiTokenAmount.decimals;
      else if (postInfo?.uiTokenAmount) decimals = postInfo.uiTokenAmount.decimals;
      
      preToken += preAmt;
      postToken += postAmt;
    }

    // Sell means preToken > postToken
    const tokenDeltaRaw = preToken - postToken;

    if (tokenDeltaRaw <= 0n) {
      return null;
    }

    return {
      tokenDeltaRaw,
      decimals,
      solDeltaLamports,
      feeLamports: fee
    };
  }
}
