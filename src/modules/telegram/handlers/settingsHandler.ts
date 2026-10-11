import { Context, InlineKeyboard } from 'grammy';
import { AutopilotRepository } from '../../../database/repositories/autopilotRepository';

const DEFAULT_FIXED_SOL = 0.1;
const DEFAULT_MIN_SCORE = 75;
const DEFAULT_SL_PERCENT = 8;
const DEFAULT_TP1_PERCENT = 15;
const DEFAULT_TP2_PERCENT = 30;
const DEFAULT_TRAIL_DIST = 5;
const DEFAULT_TRAIL_ACT = 20;

function getNumericParam(val: unknown, fallback: number): number {
  return typeof val === 'number' && !Number.isNaN(val) ? val : fallback;
}

export async function handleSettingsMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;

  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const isPaper = config.mode === 'PAPER';
  const modeBadge = isPaper ? '🟢 PAPER TRADING (Simulasi)' : '⚡ LIVE ON-CHAIN';
  const fixedSol = getNumericParam((config.sizing_params as any)?.fixed_sol, DEFAULT_FIXED_SOL);
  const minScore = getNumericParam((config.safety_params as any)?.min_safety_score, DEFAULT_MIN_SCORE);

  const slPercent = getNumericParam((config.exit_params as any)?.sl_percent, DEFAULT_SL_PERCENT);
  const tp1Percent = getNumericParam((config.exit_params as any)?.tp1_percent, DEFAULT_TP1_PERCENT);
  const tp2Percent = getNumericParam((config.exit_params as any)?.tp2_percent, DEFAULT_TP2_PERCENT);
  const trailingEnabled = Boolean((config.exit_params as any)?.trailing_stop_enabled);
  const trailingDistance = getNumericParam(
    (config.exit_params as any)?.trailing_stop_delta_percent ?? (config.exit_params as any)?.trailing_stop_percent,
    DEFAULT_TRAIL_DIST
  );
  const trailingActivation = getNumericParam((config.exit_params as any)?.trailing_activation_percent, DEFAULT_TRAIL_ACT);

  const text = `
⚙️ <b>Pengaturan Scalping & Trading Bot</b>
───────────────────────────
<b>Mode & Eksekusi:</b>
• <b>Mode:</b> ${modeBadge}
• <b>Profil Risiko:</b> ⚖️ <b>${config.risk_profile}</b>
• <b>Default Trade Size:</b> <code>${fixedSol} SOL</code>

<b>Target Profit & Proteksi Kerugian:</b>
• <b>Take Profit (TP1 / TP2):</b> <code>+${tp1Percent}% / +${tp2Percent}%</code>
• <b>Stop Loss (SL):</b> <code>-${slPercent}%</code>
• <b>Trailing Stop:</b> ${trailingEnabled ? '🟢 AKTIF' : '🔴 NONAKTIF'} (Mulai: <code>+${trailingActivation}%</code>, Jarak: <code>${trailingDistance}%</code>)

<b>Filter Keamanan & Scanner:</b>
• <b>Min Security Score:</b> <code>${minScore}/100</code>
• <b>Status Autopilot:</b> ${config.is_active ? '🟢 AKTIF' : '⏸ NONAKTIF'}
───────────────────────────
<i>Pilih kategori di bawah untuk mengatur parameter trading Anda:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(isPaper ? '⚡ Beralih ke LIVE' : '🟢 Beralih ke PAPER', 'settings_toggle_mode')
    .row()
    .text('💰 Ukuran Trade', 'settings_menu_size')
    .text('🛡️ Profil Risiko', 'settings_menu_risk')
    .row()
    .text('🎯 TP & Stop Loss', 'settings_menu_tpsl')
    .text('📈 Trailing Stop', 'settings_menu_trailing')
    .row()
    .text('⚡ Sniper Settings', 'sniper_settings')
    .text('🤖 Autopilot Hub', 'menu_autopilot')
    .row()
    .text('🏠 Dashboard Utama', 'menu_main');

  await renderOrEditMessage(ctx, text, keyboard);
}

export async function handleSettingsSizeMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;
  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const currentSize = getNumericParam((config.sizing_params as any)?.fixed_sol, DEFAULT_FIXED_SOL);

  const sizes = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5];

  const text = `
💰 <b>Pengaturan Ukuran Trade (Trade Size)</b>
───────────────────────────
Ukuran default yang digunakan bot saat membuka posisi baru (Autopilot atau Quick Buy).

• <b>Ukuran Saat Ini:</b> <code>${currentSize} SOL</code>
───────────────────────────
<i>Pilih nominal preset di bawah atau gunakan Custom Input:</i>
`.trim();

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    const isSelected = Math.abs(currentSize - s) < 0.0001;
    const label = isSelected ? `✓ ${s} SOL` : `${s} SOL`;
    keyboard.text(label, `settings_size_${s}`);
    if ((i + 1) % 3 === 0) keyboard.row();
  }

  keyboard
    .text('✍️ Input Nominal Custom', 'settings_custom_size')
    .row()
    .text('🔙 Kembali ke Pengaturan', 'menu_settings');

  await renderOrEditMessage(ctx, text, keyboard);
}

export async function handleSettingsRiskMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;
  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const profile = config.risk_profile || 'MODERATE';

  const text = `
🛡️ <b>Profil Risiko Trading</b>
───────────────────────────
Pilih profil risiko untuk otomatis menyesuaikan parameter keamanan dan TP/SL:

🛡️ <b>Konservatif (Low Risk):</b>
• Min Security Score: 85/100
• Stop Loss ketat (5%), TP moderat (15%)
• Cocok untuk menjaga modal.

⚖️ <b>Moderat (Balanced - Rekomendasi):</b>
• Min Security Score: 75/100
• Stop Loss (8%), TP (20%)
• Keseimbangan antara peluang dan risiko.

⚡ <b>Agresif (High Frequency / Degen):</b>
• Min Security Score: 65/100
• Stop Loss lebih longgar (12%), TP (35%)
• Menangkap lebih banyak pergerakan volatil.
───────────────────────────
• <b>Profil Aktif:</b> <b>${profile}</b>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(`${profile === 'CONSERVATIVE' ? '✓ ' : ''}🛡️ Konservatif`, 'preset_conservative')
    .row()
    .text(`${profile === 'MODERATE' ? '✓ ' : ''}⚖️ Moderat`, 'preset_moderate')
    .row()
    .text(`${profile === 'AGGRESSIVE' ? '✓ ' : ''}⚡ Agresif`, 'preset_aggressive')
    .row()
    .text('🔙 Kembali ke Pengaturan', 'menu_settings');

  await renderOrEditMessage(ctx, text, keyboard);
}

export async function handleSettingsExitMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;
  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const slPercent = getNumericParam((config.exit_params as any)?.sl_percent, DEFAULT_SL_PERCENT);
  const tp1Percent = getNumericParam((config.exit_params as any)?.tp1_percent, DEFAULT_TP1_PERCENT);

  const text = `
🎯 <b>Pengaturan Take Profit (TP) & Stop Loss (SL)</b>
───────────────────────────
Konfigurasi target keuntungan dan batas toleransi rugi otomatis per transaksi.

• <b>Take Profit (TP1):</b> <code>+${tp1Percent}%</code>
• <b>Stop Loss (SL):</b> <code>-${slPercent}%</code>
───────────────────────────
<i>Tap tombol di bawah untuk memilih nilai yang diinginkan:</i>
`.trim();

  const slPresets = [5, 8, 10, 15, 20];
  const tpPresets = [10, 15, 25, 50, 100];

  const keyboard = new InlineKeyboard();

  // Stop Loss Row
  keyboard.text('🛑 Pilih Stop Loss:', 'noop_sl').row();
  for (const sl of slPresets) {
    const isSelected = slPercent === sl;
    keyboard.text(isSelected ? `✓ -${sl}%` : `-${sl}%`, `settings_set_sl:${sl}`);
  }
  keyboard.row();

  // Take Profit Row
  keyboard.text('🎯 Pilih Take Profit:', 'noop_tp').row();
  for (const tp of tpPresets) {
    const isSelected = tp1Percent === tp;
    keyboard.text(isSelected ? `✓ +${tp}%` : `+${tp}%`, `settings_set_tp:${tp}`);
  }
  keyboard.row();

  keyboard.text('🔙 Kembali ke Pengaturan', 'menu_settings');

  await renderOrEditMessage(ctx, text, keyboard);
}

export async function handleSettingsTrailingMenu(
  ctx: Context,
  autopilotRepo: AutopilotRepository
): Promise<void> {
  if (!ctx.from) return;
  const config = await autopilotRepo.getOrCreateConfig(ctx.from.id);
  const trailingEnabled = Boolean((config.exit_params as any)?.trailing_stop_enabled);
  const trailingDistance = getNumericParam(
    (config.exit_params as any)?.trailing_stop_delta_percent ?? (config.exit_params as any)?.trailing_stop_percent,
    DEFAULT_TRAIL_DIST
  );
  const trailingActivation = getNumericParam((config.exit_params as any)?.trailing_activation_percent, DEFAULT_TRAIL_ACT);

  const text = `
📈 <b>Pengaturan Trailing Stop</b>
───────────────────────────
Trailing Stop mengunci profit saat harga token melonjak tinggi dan otomatis keluar jika harga turun dari puncak.

• <b>Status:</b> ${trailingEnabled ? '🟢 AKTIF' : '🔴 NONAKTIF'}
• <b>Aktivasi Minimal:</b> <code>+${trailingActivation}%</code> (hanya aktif setelah profit mencapai ini)
• <b>Jarak Trailing (Delta):</b> <code>${trailingDistance}%</code> (toleransi retracement dari harga tertinggi)
───────────────────────────
<i>Gunakan tombol di bawah untuk mengatur:</i>
`.trim();

  const keyboard = new InlineKeyboard()
    .text(trailingEnabled ? '🔴 Nonaktifkan Trailing Stop' : '🟢 Aktifkan Trailing Stop', 'settings_toggle_trailing')
    .row();

  keyboard.text('📏 Jarak Trailing:', 'noop_dist').row();
  for (const dist of [3, 5, 8, 10, 15]) {
    const isSelected = trailingDistance === dist;
    keyboard.text(isSelected ? `✓ ${dist}%` : `${dist}%`, `settings_set_trail_dist:${dist}`);
  }
  keyboard.row();

  keyboard.text('🚀 Mulai Aktif Pada:', 'noop_act').row();
  for (const act of [10, 20, 30, 50]) {
    const isSelected = trailingActivation === act;
    keyboard.text(isSelected ? `✓ +${act}%` : `+${act}%`, `settings_set_trail_act:${act}`);
  }
  keyboard.row();

  keyboard.text('🔙 Kembali ke Pengaturan', 'menu_settings');

  await renderOrEditMessage(ctx, text, keyboard);
}

async function renderOrEditMessage(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch (err: any) {
      if (err?.description?.includes('message is not modified')) return;
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
