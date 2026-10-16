// PM2 ecosystem untuk bot scalping Solana Mochi — PAPER TRADING ONLY.
// Dibuat 2026-10-14. JANGAN ubah LIVE_TRADING_ENABLED menjadi true tanpa instruksi eksplisit Mochi.
// Prasyarat sebelum start: TELEGRAM_BOT_TOKEN + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// harus sudah ada di .env (file 0600 di direktori ini), dan Redis jalan di 127.0.0.1:6379.
module.exports = {
  apps: [
    {
      name: 'solana-scalping-paper',
      cwd: '/home/hatch/workspace/bots/solana-scalping',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      env: {
        NODE_ENV: 'development',
        LIVE_TRADING_ENABLED: 'false',
        PRIVATE_KEY_EXPORT_ENABLED: 'false',
        // Proxy egress TANPA kredensial (sesuai /etc/profile.d/hatch-egress.sh).
        // Kredensial proxy sesi berotasi tiap beberapa menit dan menyebabkan 407
        // pada worker pm2; memakai URL polos membuat bot imun terhadap rotasi.
        HTTP_PROXY: 'http://hatch-egress-proxy:3128',
        HTTPS_PROXY: 'http://hatch-egress-proxy:3128',
        http_proxy: 'http://hatch-egress-proxy:3128',
        https_proxy: 'http://hatch-egress-proxy:3128',
        ALL_PROXY: 'http://hatch-egress-proxy:3128',
        all_proxy: 'http://hatch-egress-proxy:3128',
        NO_PROXY: 'localhost,127.0.0.1,::1,[::1],198.19.0.1,198.19.0.2,fd8b:4f84:7d32:99::1,[fd8b:4f84:7d32:99::1],fd8b:4f84:7d32:99::2,[fd8b:4f84:7d32:99::2]',
        no_proxy: 'localhost,127.0.0.1,::1,[::1],198.19.0.1,198.19.0.2,fd8b:4f84:7d32:99::1,[fd8b:4f84:7d32:99::1],fd8b:4f84:7d32:99::2,[fd8b:4f84:7d32:99::2]',
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: '/run/hatch/egress-tls/ca-bundle.pem',
      },
    },
  ],
};
