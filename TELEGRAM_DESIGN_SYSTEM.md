# TELEGRAM DESIGN SYSTEM

## 1. Message Patterns

Every message should follow a strict visual hierarchy:
1. **Header/Title**: Emoji + Bold Text (e.g., `📊 **Dashboard**`)
2. **Context Badges**: E.g., `🟢 [PAPER]` or `⚡ [LIVE]`
3. **Primary Information**: Scannable `Label: Value` rows.
4. **Secondary Information**: Collapsed or visually separated via dividers (`—` or empty lines).
5. **Timestamp/Footnote**: Italicized context at the bottom (e.g., `_Diperbarui: 14:00 WIB_`).

## 2. Keyboard Patterns

- **Primary Navigation Row**: e.g., `[🏠 Dashboard] [📊 Portfolio]`
- **Back Button Pattern**: Always place `[🔙 Kembali]` or `[❌ Batal]` at the bottom or top left of sub-menus.
- **Confirm/Cancel Row**: `[✅ Confirm] [❌ Cancel]`
- **Pagination Row**: `[⬅️ Prev] [Page 1/3] [Next ➡️]`
- **Thumb-friendly**: Max 2 wide buttons or 3 compact buttons per row.

## 3. Status Presentation Rules

- **Success**: `✅` or `🟢` (Green context)
- **Warning**: `⚠️` or `🟡` (Yellow context)
- **Error/Critical**: `❌` or `🔴` (Red context)
- **Neutral/Processing**: `⏳` or `⚪` (Gray context)
- **Mode Indicators**: Use consistent prefixes `🟢 [PAPER]` and `⚡ [LIVE]`.

## 4. Copy Style Guide

- **Tone**: Professional, concise, confident, high-signal.
- **Capitalization**: Title Case for Buttons and Section Headers.
- **Currency formatting**: Format SOL to 4 decimal places (`0.0500 SOL`). Format USD to 2 decimal places (`$150.00`).
- **Terminology**:
  - *Withdrawal submitted* (Not "Withdraw process started")
  - *Position close request confirmed* (Not "Position closed" immediately)
