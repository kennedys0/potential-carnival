#!/bin/bash
set -e

echo "Running grep guards..."

ERRORS=0

check() {
  local pattern="$1"
  local desc="$2"
  local ignore="$3"
  
  echo "Checking: $desc"
  
  if [ -z "$ignore" ]; then
    RES=$(grep -rnE "$pattern" src/ || true)
  else
    RES=$(grep -rnE "$pattern" src/ | grep -vE "$ignore" || true)
  fi
  
  if [ -n "$RES" ]; then
    echo "❌ Found forbidden pattern ($desc):"
    echo "$RES"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ Clean ($desc)"
  fi
}

# Clean up all violations (R4-7)
check "z\.coerce\.boolean" "z.coerce.boolean"
check "token-boosts" "token-boosts"
check "new grammy\.Bot" "new grammy.Bot"
check "require\(" "require("
check "console\.(log|warn|error)" "console.*"
check "PAPER_TRADE_SOL_PRICE" "PAPER_TRADE_SOL_PRICE"
check "autopilot_budget_sol[[:space:]]*\|\|[[:space:]]*Infinity" "Infinity in autopilot budget"
check "\|\|[[:space:]]*[0-9]+" "|| angka di jalur trading"

if [ $ERRORS -gt 0 ]; then
  echo "Grep guards failed with $ERRORS errors."
  exit 1
fi

echo "All grep guards passed!"
exit 0
