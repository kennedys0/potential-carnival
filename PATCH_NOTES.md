# Patch notes (round 4 hardening)

Perubahan deterministik di atas hasil round 4:
- `currencyService`: tanpa throw & tanpa fallback; kurs basi/absen = `null` -> UI menampilkan "N/A", trade paper ditolak.
- Paper mode memakai kurs SOL/USD nyata (MOCK_SOL_PRICE_USD dihapus).
- Bug nyata di `executeOrder`: `pending_signature` tidak pernah di-set di memori sehingga error APA PUN setelah tx dikirim
  menandai trade FAILED walau token sudah dibeli. Diperbaiki + test.
- `TradeRepository.db` kembali `private`; `tsconfig` `noEmitOnError: true`.
- `npm run verify` lintas-OS (tanpa path bash Windows); `scripts/grep-guards.mjs` (baseline anti-regresi) dan `scripts/mutation-check.mjs`.
- Test penjaga baru: flag env, exit live saat flag mati/kill-switch, lifecycle beli/jual, kurs, honeypot hard-block.
- Dihapus: `scratch/` (laporan self-audit yang tidak akurat + skrip rewrite), badge test statis di README.

Belum dikerjakan (sengaja, lihat round 5): posisi OPEN dengan remaining_raw=0 / PENDING tanpa kedaluwarsa, cost basis PnL,
level DANGER/UNVERIFIED, wiring circuit breaker persisten, callback withdraw >64 byte + cooldown alamat, sumber penemuan token,
lock monitor 30 dtk, trailing/time-stop/exit darurat.
