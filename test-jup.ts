import { Connection, Keypair } from '@solana/web3.js';
import { createJupiterApiClient } from '@jup-ag/api';

async function test() {
  const connection = new Connection('https://solana-mainnet.g.alchemy.com/v2/alch__4ozS8uObQ_qQT4AANn-a');
  const api = createJupiterApiClient();
  const tokenMint = '5tCju6YNxHq5zrA6tGndr6F7TK42mpUFmeE31cSFpump';
  const wsol = 'So11111111111111111111111111111111111111112';
  
  try {
    const quote = await api.quoteGet({
      inputMint: tokenMint,
      outputMint: wsol,
      amount: 1000000,
      slippageBps: 200,
    });
    console.log('Quote:', quote ? 'OK' : 'NULL');

    const dummyPubkey = '11111111111111111111111111111111';
    const swap = await api.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: dummyPubkey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }
    });
    console.log('Swap:', swap ? 'OK' : 'NULL');

    const { VersionedTransaction } = require('@solana/web3.js');
    const swapTransactionBuf = Buffer.from(swap.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    console.log('Simulating transaction...');
    const simulation = await connection.simulateTransaction(transaction);
    console.log('Simulation Result Err:', simulation.value.err);
    if (simulation.value.logs) {
      console.log('Logs:', simulation.value.logs.slice(-5));
    }
  } catch (err: any) {
    console.error('ERROR:', err.message);
    if (err.response) {
      console.error('RESPONSE:', await err.response.text());
    }
  }
}

test();
