#!/usr/bin/env node
// =============================================================================
// mutation-check: membuktikan bahwa test benar-benar MENJAGA perbaikan keamanan.
//
// Untuk tiap "mutasi" (bug lama yang sengaja dikembalikan) skrip membuat salinan sementara proyek,
// menerapkan mutasi, lalu menjalankan seluruh suite. Mutasi HARUS membuat minimal satu test merah
// ("killed"). Jika test tetap hijau ("survived"), berarti perbaikan itu tidak dijaga -> skrip GAGAL.
//
// - Kode aslimu TIDAK pernah diubah (semua terjadi di folder temp).
// - Jika anchor mutasi tidak ditemukan tepat 1x (kode berubah), skrip GAGAL: jangan diam-diam dilewati.
// - Entri `knownGap: true` = celah test yang sudah diketahui; tidak menggagalkan, tapi selalu dilaporkan.
//
// ATURAN: dilarang mengubah file ini atau menandai mutasi sebagai knownGap demi meloloskan build.
//
// Pakai:  node scripts/mutation-check.mjs [--list] [--only <id>]
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  // ---------------- R1: flag pengaman live ----------------
  { id: 'R1-env-coerce-boolean', desc: "Flag LIVE_TRADING_ENABLED kembali ke z.coerce.boolean() ('false' menjadi true)",
    file: 'src/config/env.ts',
    find: /LIVE_TRADING_ENABLED: z\s*\.enum\([\s\S]*?\.transform\(\(v\) => v === 'true'\),/,
    replace: 'LIVE_TRADING_ENABLED: z.coerce.boolean().default(false),' },

  // ---------------- R2: exit tidak boleh diblokir ----------------
  { id: 'R2-exit-blocked-by-live-flag', desc: 'closePosition live diblokir saat LIVE_TRADING_ENABLED=false',
    file: 'src/modules/trader/traderService.ts',
    find: "    if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');\n    const wallet = await this.walletService.getOrCreateWallet(trade.user_id);",
    replace: "    if (!getEnv().LIVE_TRADING_ENABLED) throw new LiveTradingDisabledError();\n    if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');\n    const wallet = await this.walletService.getOrCreateWallet(trade.user_id);" },
  { id: 'R2-exit-blocked-by-killswitch', desc: 'closePosition live diblokir saat kill-switch aktif',
    file: 'src/modules/trader/traderService.ts',
    find: "    if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');\n    const wallet = await this.walletService.getOrCreateWallet(trade.user_id);",
    replace: "    if ((await getRedisConnection().get('killswitch:global')) === '1') throw new KillSwitchActiveError();\n    if (!this.jupiterClient) throw new Error('Jupiter client required for live trade execution');\n    const wallet = await this.walletService.getOrCreateWallet(trade.user_id);" },
  { id: 'K1-killswitch-allows-buy', desc: 'Kill-switch tidak lagi menolak BUY',
    file: 'src/modules/trader/traderService.ts',
    find: "isKillSwitchActive === '1' && side === 'BUY'", replace: "false && side === 'BUY'" },

  // ---------------- R3: tidak boleh ada posisi yatim ----------------
  { id: 'R3-exit-result-marks-FAILED', desc: 'Exit FAILED_ONCHAIN/UNKNOWN menandai posisi FAILED (token masih di wallet)',
    file: 'src/modules/trader/traderService.ts',
    find: "last_exit_error: result.status === 'FAILED_ONCHAIN' ?",
    replace: "status: 'FAILED' as any, last_exit_error: result.status === 'FAILED_ONCHAIN' ?" },
  { id: 'R3-exit-throw-marks-FAILED', desc: 'Error sebelum kirim saat exit menandai posisi FAILED',
    file: 'src/modules/trader/traderService.ts',
    find: "last_exit_error: e.message,", replace: "status: 'FAILED' as any, last_exit_error: e.message," },
  { id: 'B1-buy-unknown-marks-FAILED', desc: 'Beli dengan hasil UNKNOWN langsung ditandai FAILED',
    file: 'src/modules/trader/traderService.ts',
    find: '// Leave as PENDING for reconciliation',
    replace: "await this.tradeRepo.updateTradeStatus(tradeRecord.id!, { status: 'FAILED' } as any);" },
  { id: 'B2-buy-onchain-fail-not-FAILED', desc: 'Beli yang gagal on-chain tidak ditandai FAILED',
    file: 'src/modules/trader/traderService.ts',
    find: /status: 'FAILED',(\s*)failure_reason: `On-chain failure:/,
    replace: "status: 'PENDING' as any,$1failure_reason: `On-chain failure:" },
  { id: 'B3-buy-sent-then-error-marks-FAILED', desc: 'signature tidak dicatat di memori -> error setelah kirim menandai FAILED padahal tx mungkin masuk',
    file: 'src/modules/trader/traderService.ts',
    find: 'tradeRecord.pending_signature = sig;', replace: '' },

  // ---------------- R4: konfirmasi transaksi ----------------
  { id: 'T1-txsender-ignores-onchain-err', desc: 'TxSender mengabaikan status.err (tx gagal dianggap sukses)',
    file: 'src/modules/wallet/txSender.ts',
    find: 'if (status.err) {', replace: 'if (false && status.err) {' },

  // ---------------- paper mode / kurs ----------------
  { id: 'P1-paper-hardcoded-sol-price', desc: 'Paper mode memakai harga SOL hardcoded',
    file: 'src/modules/trader/traderService.ts',
    find: 'const usdPerSol = currencyService.getUsdPerSol();', replace: 'const usdPerSol: number | null = 150;' },
  { id: 'C1-currency-serves-stale-rates', desc: 'Kurs basi tetap dianggap segar',
    file: 'src/utils/currencyService.ts',
    find: 'return this.lastSuccessAt !== 0 && Date.now() - this.lastSuccessAt <= appSettings.CURRENCY_MAX_STALE_MS;',
    replace: 'return true;' },

  // ---------------- monitor / double-sell ----------------
  { id: 'M1-monitor-no-lock', desc: 'Lock Redis di monitorWorker dihapus',
    file: 'src/queue/workers/monitorWorker.ts', find: 'if (!locked) {', replace: 'if (false && !locked) {' },
  { id: 'M2-monitor-ignores-status', desc: 'monitorWorker memproses trade berstatus apa pun',
    file: 'src/queue/workers/monitorWorker.ts',
    find: "!['OPEN', 'PARTIAL_EXIT'].includes(trade.status)", replace: 'false' },
  { id: 'RC1-reconcile-ignores-failed-tx', desc: 'Reconcile mengabaikan tx yang gagal on-chain',
    file: 'src/queue/workers/reconcileWorker.ts', find: 'if (status.err) {', replace: 'if (false && status.err) {' },

  // ---------------- security filter ----------------
  { id: 'S1-no-hardblock-mint-authority', desc: 'Mint authority aktif tidak lagi hard-block',
    file: 'src/modules/security/scoreCalculator.ts',
    find: '} else if (input.mintAuthorityActive.value) {', replace: '} else if (false) {' },
  { id: 'S2-no-hardblock-honeypot', desc: 'Simulasi jual gagal (honeypot) tidak lagi hard-block',
    file: 'src/modules/security/scoreCalculator.ts',
    find: '} else if (!input.sellSimulationSuccess.value) {', replace: '} else if (false) {' },

  // ---------------- autopilot ----------------
  { id: 'A1-autopilot-ignores-held-token', desc: 'Autopilot membeli token yang sudah dipegang',
    file: 'src/modules/autopilot/autopilotEngine.ts',
    find: 'if (currentState.heldMints?.includes(tokenMint)) {', replace: 'if (false) {' },
  { id: 'A2-autopilot-ignores-circuit-breaker', desc: 'Autopilot mengabaikan circuit breaker',
    file: 'src/modules/autopilot/autopilotEngine.ts',
    find: 'if (cbCheck.isBreached) {', replace: 'if (false) {' },

  // ---------------- CELAH TEST YANG DIKETAHUI (dilaporkan, belum menggagalkan) ----------------
  { id: 'W1-whitelist-fails-open', desc: 'Whitelist kosong membuka akses untuk semua orang (fail-open)',
    file: 'src/modules/telegram/bot.ts',
    find: 'whitelistedUsers.length === 0 || ', replace: '' },
];

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.knownGap ? '[gap] ' : '      '}${m.id}  — ${m.desc}`);
  process.exit(0);
}
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const selected = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
if (only && selected.length === 0) { console.error(`Mutasi '${only}' tidak ada. Pakai --list.`); process.exit(2); }

// ---- siapkan salinan sementara ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mutcheck-'));
for (const item of ['src', 'tests', 'package.json', 'tsconfig.json', 'vitest.config.ts']) {
  if (fs.existsSync(path.join(ROOT, item))) fs.cpSync(path.join(ROOT, item), path.join(TMP, item), { recursive: true });
}
const NM_LINK = path.join(TMP, 'node_modules');
fs.symlinkSync(path.join(ROOT, 'node_modules'), NM_LINK, 'junction');

function cleanup() {
  try { fs.unlinkSync(NM_LINK); } catch { try { fs.rmdirSync(NM_LINK); } catch { /* ignore */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--bail=1', '--reporter=dot'], {
    cwd: TMP, shell: true, encoding: 'utf8', timeout: 240000, env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  });
  return { status: r.status, timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM', out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function countMatches(text, find) {
  if (typeof find === 'string') return text.split(find).length - 1;
  return (text.match(new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g')) ?? []).length;
}

console.log(`Mutation check — ${selected.length} mutasi, salinan sementara: ${TMP}\n`);
process.stdout.write('Baseline (tanpa mutasi) ... ');
const base = runSuite();
if (base.status !== 0) {
  console.log('MERAH');
  console.log(base.out.split('\n').slice(-25).join('\n'));
  console.error('\nBaseline harus hijau sebelum mutation-check berarti. Perbaiki test dulu.');
  process.exit(1);
}
console.log('hijau\n');

const rows = [];
let bad = 0;
for (const m of selected) {
  const orig = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
  const n = countMatches(orig, m.find);
  if (n !== 1) {
    rows.push({ m, verdict: 'ANCHOR-HILANG', detail: `anchor cocok ${n}x (harus 1x) — skrip ini perlu diperbarui manual` });
    bad++;
    continue;
  }
  const mutated = typeof m.find === 'string' ? orig.replace(m.find, () => m.replace) : orig.replace(m.find, m.replace);
  fs.writeFileSync(path.join(TMP, m.file), mutated);
  const t0 = Date.now();
  const r = runSuite();
  fs.writeFileSync(path.join(TMP, m.file), orig); // pulihkan salinan
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const killed = r.status !== 0;
  let verdict;
  if (killed) verdict = m.knownGap ? 'KILLED-PROMOTE' : 'KILLED';
  else verdict = m.knownGap ? 'GAP-DIKETAHUI' : 'SURVIVED';
  if (verdict === 'SURVIVED') bad++;
  rows.push({ m, verdict, detail: `${secs}s${r.timedOut ? ' (timeout dianggap killed)' : ''}` });
  const icon = { KILLED: '✅', 'KILLED-PROMOTE': '🆙', 'GAP-DIKETAHUI': '🟡', SURVIVED: '❌' }[verdict];
  console.log(`${icon} ${verdict.padEnd(14)} ${m.id}  (${secs}s)`);
}

console.log('\n================ RINGKASAN ================');
const c = (v) => rows.filter((r) => r.verdict === v).length;
console.log(`Killed (dijaga test) : ${c('KILLED')}`);
console.log(`SURVIVED (TIDAK dijaga): ${c('SURVIVED')}`);
console.log(`Anchor hilang        : ${c('ANCHOR-HILANG')}`);
console.log(`Celah dikenal        : ${c('GAP-DIKETAHUI')}`);
if (c('KILLED-PROMOTE')) console.log(`Celah yang kini terjaga: ${c('KILLED-PROMOTE')} -> hapus flag knownGap dari mutasinya`);
for (const r of rows.filter((x) => ['SURVIVED', 'ANCHOR-HILANG'].includes(x.verdict))) console.log(`\n❌ ${r.m.id}: ${r.m.desc}\n   ${r.detail}`);
for (const r of rows.filter((x) => x.verdict === 'GAP-DIKETAHUI')) console.log(`\n🟡 CELAH TEST: ${r.m.id}: ${r.m.desc}`);

if (bad) { console.error(`\nGAGAL: ${bad} mutasi tidak dijaga test / tidak bisa diterapkan.`); process.exit(1); }
console.log('\nLOLOS: semua mutasi wajib tertangkap test.');
