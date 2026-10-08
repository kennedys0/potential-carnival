# TELEGRAM UX CHANGELOG

## Changes Implemented

1. **Dashboard Home Screen (`dashboardHandler.ts`)**
   - Created a new `handleDashboardMenu` to act as a proper home screen.
   - Shows Bot Status, Execution Mode (Paper/Live), Circuit Breaker status, Wallet Balance, Open Positions count, and Realized PnL.
   - Refactored `/start` to show a compact welcome message and redirect to the Dashboard.

2. **Portfolio UX Refactoring (`positionsHandler.ts`)**
   - Refactored the positions list into a clean, scannable overview displaying overall PnL.
   - Implemented "Position Cards" via inline buttons for each active trade.
   - Added a `view_pos:<id>` callback flow that opens a detailed "Position Detail View".
   - The Position Detail View shows the exact entry price, current price, mode, and PnL, with a prominent "Jual Semua (100%)" button to avoid mis-taps.

3. **Wallet & Withdrawal UX Refactoring (`walletHandler.ts`)**
   - Redesigned `handleWalletWithdrawPrompt` to stop using manual command inputs (`/withdraw <MAX>`).
   - Implemented an inline percentage keyboard (25%, 50%, 75%, 100% MAX) for safe and fast withdrawals.
   - Added `withdraw_pct:` callback handler in `router.ts` to calculate amounts (automatically reserving gas fees) and forward to the confirmation screen.

4. **Architecture & Routing (`router.ts`)**
   - Added a `/dashboard` command.
   - Bound `menu_main` to the new Dashboard handler.
   - Reorganized callback handlers to cleanly map `view_pos:` and `withdraw_pct:`.
