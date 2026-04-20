#!/usr/bin/env bash
# check-movements-invariant.sh — enforce Rule 7 perimeter for pf.Movements.
#
# Every pathfinder Movements instance must come from createMovements(bot) in
# src/agent/library/skills.js so protected-zone dig/scaffold disable + BT-10j
# maxDropDown=3 are applied uniformly. Raw `new pf.Movements(bot)` outside
# the factory bypasses those guards.
#
# Audit #12 (2026-04-20) closed the perimeter. This script makes the invariant
# machine-checkable so a future refactor can't silently reopen it.
#
# Usage: ./scripts/check-movements-invariant.sh
# Exits non-zero if any raw callsite is found outside the factory.

set -euo pipefail
cd "$(dirname "$0")/.."

# Find all code lines with 'new pf.Movements', excluding:
#   - comments (lines where the match is after // or inside /* */ — matched by
#     leading ' * ' for JSDoc or '//' for line comments)
#   - the one legitimate factory line in createMovements
violations=$(grep -rn 'new pf\.Movements' src/ 2>/dev/null \
    | grep -Ev '^[^:]+:[0-9]+:[[:space:]]*(\*|//)' \
    | grep -Ev 'skills\.js:[0-9]+:[[:space:]]*const m = new pf\.Movements\(bot\);' \
    || true)

if [ -n "$violations" ]; then
    echo "FAIL: raw 'new pf.Movements(bot)' callsites found outside createMovements factory:"
    echo "$violations"
    echo ""
    echo "Use createMovements(bot) from src/agent/library/skills.js instead."
    exit 1
fi

echo "OK: no raw 'new pf.Movements' callsites outside createMovements factory."
