# Usulan Mutasi

Dokumen ini berisi usulan mutasi (perubahan sengaja yang akan merusak logika aplikasi) untuk memverifikasi bahwa test suite (guard) benar-benar melindungi aturan bisnis kritis.
Setiap usulan memuat:
- `id`: Identifikasi mutasi
- `file`: File yang diubah
- `find`: String persis atau regex yang cocok tepat 1x
- `replace`: Kode pengganti yang merusak logika
- `deskripsi`: Penjelasan bug yang dikembalikan / efek dari mutasi
- `test`: Nama test yang seharusnya menjadi MERAH ketika mutasi ini diterapkan

*(Daftar mutasi akan ditambahkan pada fase-fase berikutnya sesuai instruksi)*
