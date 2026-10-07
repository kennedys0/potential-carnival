# scripts/ — gerbang kualitas (JANGAN diubah oleh AI)

Folder ini adalah "pagar" yang menjaga agar perbaikan keamanan tidak diam-diam hilang. Hanya manusia yang boleh mengubahnya,
dan setiap perubahan harus terlihat di review diff.

| Perintah | Isi | Waktu |
|---|---|---|
| `npm run verify` | `tsc --noEmit` + `vitest run` + `grep-guards` | ~15 dtk |
| `npm run verify:full` | `verify` + `mutation-check` | ~3 mnt |
| `npm run guards` | hanya grep-guards | <1 dtk |
| `npm run mutation` | hanya mutation-check (`-- --list`, `-- --only <id>`) | ~3 mnt |

## grep-guards.mjs
Menghitung pola terlarang di `src/` dan membandingkannya dengan `guards-baseline.json`.
- Aturan tanpa awalan `debt-` harus **0**.
- Aturan `debt-*` adalah hutang yang SUDAH ada; angkanya dikunci di baseline dan **tidak boleh naik**.
- Mengganti nama/operator (mis. `|| 15` -> `?? 15`, `PAPER_` -> `MOCK_`) tidak menghapus masalah; aturan memeriksa maknanya.
- Jika hutang turun, jalankan `node scripts/grep-guards.mjs --update` **setelah review manusia** untuk menurunkan baseline.

## mutation-check.mjs
Mengembalikan bug lama secara sengaja di salinan sementara, lalu memastikan test menjadi **merah**.
- `KILLED` = perbaikan dijaga test. `SURVIVED` = test tidak menjaga -> build gagal.
- `ANCHOR-HILANG` = kode berubah dan mutasi tidak bisa diterapkan -> perbarui skrip secara manual (jangan dilewati).
- `knownGap` = celah test yang diketahui, selalu dilaporkan. Jangan menambah `knownGap` demi meloloskan build.
- Kode aslimu tidak pernah diubah (semua di folder temp; `node_modules` ditautkan, bukan disalin).

## Saat menambah perbaikan keamanan baru
Tambahkan test **dan** satu entri mutasi yang mengembalikan bug itu. Fitur keamanan tanpa mutasi dianggap belum dijaga.
