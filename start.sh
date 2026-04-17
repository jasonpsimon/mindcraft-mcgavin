#!/usr/bin/env bash
# Start the mindcraft-mcgavin bot in a detached tmux session.
# Safe to re-run: refuses if the session is already active.

set -euo pipefail

SESSION="mindcraft-mcgavin"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' is already running."
  echo "Attach with: tmux attach -t $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -c "$REPO_DIR" 'node main.js'

echo "Started bot in tmux session '$SESSION'."
echo "Attach with: tmux attach -t $SESSION"
