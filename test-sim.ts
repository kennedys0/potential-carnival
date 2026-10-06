import { Connection } from '@solana/web3.js';
import { JupiterClient } from './src/modules/trader/jupiterClient';
import { HoneypotSimulator } from './src/modules/security/honeypotSimulator';

async function run() {
  const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=29cb0e8e-c450-402b-b533-5687b3754fa3');
  const jup = new JupiterClient(connection);
  const sim = new HoneypotSimulator(jup, connection);
  
  const tokenMint = '5tCju6YNxHq5zrA6tGndr6F7TK42mpUFmeE31cSFpump';
  const res = await sim.simulateSell(tokenMint);
  console.log(JSON.stringify(res, null, 2));
}

run();
