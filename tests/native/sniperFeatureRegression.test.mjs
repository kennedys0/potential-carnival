import test from 'node:test';
import assert from 'node:assert/strict';
import { solToLamports, evaluatePoolAge, sniperExitPolicy, failClosedSniperSafety } from '../../src/modules/autopilot/strategyRisk.ts';
import { matchDiscoveredPool } from '../../src/modules/scanner/sniperPoolSelection.ts';

const pool = { tokenAddress: 'TokenMintAddress', pairAddress: 'ExactPair', symbol: 'NEW', poolCreatedAtMs: 1_700_000_000_000 };
const pair = { chainId: 'solana', pairAddress: 'ExactPair', baseToken: { address: pool.tokenAddress, symbol: 'NEW' }, liquidity: { usd: 10000 } };

test('0.01 SOL converts exactly to 10000000 lamports', () => assert.equal(solToLamports('0.01'), 10_000_000n));
test('0.03 SOL daily budget converts to exact integer', () => assert.equal(solToLamports('0.03'), 30_000_000n));
test('reject SOL with sub-lamport precision', () => assert.throws(() => solToLamports('0.0000000001')));
test('pool selection accepts discovered pool identity', () => assert.equal(matchDiscoveredPool(pool, pair), pair));
test('pool selection rejects a larger unrelated pool', () => assert.equal(matchDiscoveredPool(pool, {...pair, pairAddress: 'OldLargerPair'}), null));
test('pool selection rejects a mismatched mint', () => assert.equal(matchDiscoveredPool(pool, {...pair, baseToken: {address: 'OtherMint'}}), null));
test('pool age rejects unknown and future timestamps', () => {
  assert.equal(evaluatePoolAge(null, 1_700_000_000_000, 20, 5), 'UNKNOWN');
  assert.equal(evaluatePoolAge(1_700_000_001_000, 1_700_000_000_000, 20, 5), 'UNKNOWN');
});
test('pool age enforces minimum 20sec and maximum 5min', () => {
  const now = 1_700_000_500_000;
  assert.equal(evaluatePoolAge(now-10_000, now, 20, 5), 'TOO_YOUNG');
  assert.equal(evaluatePoolAge(now-60_000, now, 20, 5), 'READY');
  assert.equal(evaluatePoolAge(now-360_000, now, 20, 5), 'TOO_OLD');
});
test('sniper exit policy is full close at +20% / -10% and no Trending trailing', () => {
  assert.deepEqual(sniperExitPolicy({tp_sl_enabled:true,take_profit_percent:20,stop_loss_percent:10}), {
    enabled:true,tp1_percent:20,tp2_percent:20,sl_percent:10,
    trailing_stop_enabled:false,trailing_stop_percent:0,trailing_activation_percent:0
  });
});
test('safety filter fails closed on critical unverified check', () => {
  assert.match(failClosedSniperSafety({ isHardBlocked:false,hardBlockReasons:[], report:[{ name:'Mint Authority',value:'N/A'}] },true),/Mint Authority/);
});

test('critical sniper safety accepts the canonical sell-route report field', () => {
  const report = [
    { name: 'Mint Authority', value: 'Renounced' },
    { name: 'Freeze Authority', value: 'Renounced' },
    { name: 'Dangerous Extensions', value: 'None' },
    { name: 'Sell Route Quote', value: 'Route Available' },
    { name: 'Liquidity', value: '$10000' },
  ];
  assert.equal(failClosedSniperSafety({ isHardBlocked:false, hardBlockReasons:[], report }, true), null);
});

test('GeckoTerminal new-pools includes creation time and normalizes mint/pool identities', async () => {
  const { GeckoTerminalClient } = await import('../../src/modules/scanner/geckoTerminalClient.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok:true, json:async () => ({
    data: [{attributes: {address: 'NEW_PAIR', pool_created_at:'2026-10-08T07:30:00Z'},
      relationships: {base_token: {data:{type:'token',id:'solana_SOME_NEW_MINT'}}}}],
    included: [{type:'token',id:'solana_SOME_NEW_MINT',attributes:{address:'SOME_NEW_MINT',symbol:'SOME'}}],
  }) });
  try {
    const out = await new GeckoTerminalClient().getNewPools('solana');
    assert.equal(out[0].pairAddress,'NEW_PAIR');
    assert.equal(out[0].tokenAddress,'SOME_NEW_MINT');
    assert.equal(out[0].poolCreatedAtMs, Date.parse('2026-10-08T07:30:00Z'));
  } finally {globalThis.fetch = originalFetch;}
});

test('GeckoTerminal ignores old settlement-token base pairs', async () => {
  const { GeckoTerminalClient } = await import('../../src/modules/scanner/geckoTerminalClient.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true,json:async()=>({data:[{
    attributes:{address:'SOLBASE',pool_created_at:'2026-10-08T07:30:00Z'},
    relationships:{base_token:{data:{type:'token',id:'solana_So11111111111111111111111111111111111111112'}}}
  }],included:[]})});
  try {assert.deepEqual(await new GeckoTerminalClient().getNewPools('solana'),[]);}
  finally {globalThis.fetch=originalFetch;}
});

test('DexScreener exact pair endpoint never selects another more liquid pool', async () => {
  const { DexScreenerClient } = await import('../../src/modules/scanner/dexScreenerClient.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(url, /\/pairs\/solana\/TARGET_PAIR$/);
    return {ok:true,json:async()=>({pairs:[
      {...pair,pairAddress:'OTHER_PAIR',liquidity:{usd:99999999}},
      {...pair,pairAddress:'TARGET_PAIR',liquidity:{usd:10000}},
    ]})};
  };
  try {assert.equal((await new DexScreenerClient().getPairByAddress('TARGET_PAIR'))?.pairAddress,'TARGET_PAIR');}
  finally {globalThis.fetch=originalFetch;}
});
