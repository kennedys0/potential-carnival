#!/usr/bin/env node
// =============================================================================
// grep-guards: penjaga pola terlarang di src/ (lintas OS, tanpa bash).
//
// CARA KERJA: setiap aturan dihitung jumlah kemunculannya dan dibandingkan dengan
// scripts/guards-baseline.json. Hutang yang SUDAH ADA dicatat di baseline; hutang BARU
// (jumlah > baseline) membuat skrip GAGAL. Baseline hanya boleh TURUN.
//
// ATURAN UNTUK AI/KONTRIBUTOR: dilarang mengubah folder scripts/ atau menaikkan angka baseline
// demi meloloskan build. Menamai ulang / mengganti operator (mis. `|| 15` -> `?? 15`,
// PAPER_ -> MOCK_) TIDAK menghilangkan masalah, karena aturan di bawah memeriksa maknanya.
//
// Pakai:  node scripts/grep-guards.mjs            -> periksa
//         node scripts/grep-guards.mjs --update   -> tulis ulang baseline (HANYA manusia, setelah review)
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const BASELINE_FILE = path.join(ROOT, 'scripts', 'guards-baseline.json');

const RULES = [
  { id: 'coerce-boolean', re: /z\.coerce\.boolean/g, why: "z.coerce.boolean: string 'false'/'0' menjadi true. Pakai z.enum(['true','false']).transform." },
  { id: 'console-calls', re: /console\.(log|warn|error|info|debug)\s*\(/g, why: 'Pakai logger (pino), bukan console.' },
  { id: 'inline-require', re: /\brequire\s*\(/g, why: 'require() inline: pakai import statis / dependency injection.' },
  { id: 'new-bot-instance', re: /new\s+(?:grammy\.)?Bot\s*\(/g, exclude: ['src/modules/telegram/bot.ts'], why: 'Instance Bot hanya dibuat di bot.ts.' },
  { id: 'fake-or-mock-prices', re: /MOCK_|FAKE_|DUMMY|PAPER_TRADE_SOL_PRICE/g, why: 'Nama/nilai harga palsu di kode produksi.' },
  { id: 'ts-escape-hatch', re: /@ts-ignore|@ts-nocheck/g, why: 'Jangan membungkam compiler.' },
  { id: 'repo-db-exposed', re: /public\s+(?:readonly\s+)?db\b/g, why: 'Client DB tidak boleh dibuka dari repository.' },
  // ---- hutang yang sudah ada (angka dikunci di baseline; hanya boleh turun) ----
  { id: 'debt-hardcoded-or-default', re: /\|\|\s*\d/g, why: 'Default numerik dengan ||. Pindahkan ke config Zod.' },
  { id: 'debt-hardcoded-nullish-default', re: /\?\?\s*(?!0(?![\d.]))\d+(?:\.\d+)?/g, why: 'Angka default non-nol di kode keputusan (mis. ?? 15). Pindahkan ke config Zod, jangan hanya ganti operator.' },
  { id: 'debt-unbounded-limit', re: /MAX_SAFE_INTEGER|Infinity/g, why: 'Batas tak terbatas (mis. budget autopilot). Wajib konfigurasi eksplisit.' },
  { id: 'debt-bot-created-per-call', re: /createTelegramBot\s*\(/g, exclude: ['src/modules/telegram/bot.ts', 'src/index.ts'], why: 'Bot baru per notifikasi. Inject satu bot.api.' },
  { id: 'debt-inline-dynamic-import', re: /await\s+import\s*\(/g, why: 'import() dinamis inline (workaround sirkular). Gunakan dependency injection.' },
  { id: 'debt-paid-discovery-feed', re: /token-boosts|token-profiles/g, why: 'Sumber token DexScreener berbasis promosi/profil berbayar, bukan penemuan organik.' },
];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));

function count(rule) {
  const hits = [];
  for (const f of files) {
    if (rule.exclude?.includes(f.rel)) continue;
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return; // abaikan komentar murni
      rule.re.lastIndex = 0;
      const m = line.match(rule.re);
      if (m) for (let k = 0; k < m.length; k++) hits.push(`${f.rel}:${i + 1}`);
    });
  }
  return hits;
}

const results = Object.fromEntries(RULES.map((r) => [r.id, count(r)]));

if (process.argv.includes('--update')) {
  const base = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length]));
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(base, null, 2) + '\n');
  console.log('Baseline ditulis ulang:', base);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : {};
let failed = 0;
console.log('grep-guards (angka = jumlah temuan / batas baseline)\n');
for (const r of RULES) {
  const n = results[r.id].length;
  const allowed = baseline[r.id] ?? 0;
  const isDebt = r.id.startsWith('debt-');
  if (n > allowed) {
    failed++;
    console.log(`❌ ${r.id}: ${n} > ${allowed}  — ${r.why}`);
    results[r.id].slice(0, 12).forEach((h) => console.log('     ' + h));
  } else if (n < allowed) {
    console.log(`⬇️  ${r.id}: ${n} < ${allowed}  (hutang berkurang — turunkan baseline lewat --update setelah review)`);
  } else if (n === 0) {
    console.log(`✅ ${r.id}: 0`);
  } else {
    console.log(`${isDebt ? '🟡' : '⚠️ '} ${r.id}: ${n} (hutang dikenal, tidak boleh bertambah) — ${r.why}`);
  }
}
if (failed) {
  console.log(`\nGAGAL: ${failed} aturan melebihi baseline.`);
  process.exit(1);
}
console.log('\nSemua guard lolos (tidak ada hutang baru).');
