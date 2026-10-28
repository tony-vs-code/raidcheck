#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="systemalerts"
WINDOW_NAME="workspace"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_CTL="$PROJECT_DIR/.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh"

chmod +x "$TMUX_CTL"

# Kill existing session if running
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

echo "Starting tmux session '$SESSION_NAME' with chat-orchestrator (.agents/agents/chat-orchestrator.md)..."

# 1. Create the tmux session with a single initial pane for chat-orchestrator
tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$PROJECT_DIR"

# 2. Launch chat-orchestrator with an initial interactive prompt (-i) so chat-orchestrator
#    reads .agents/agents/, splits the window, starts each subagent (dev-agent, frontend-agent,
#    qa-agent) in its own tmux pane, and is immediately ready to communicate with them.
INIT_PROMPT="Run .agents/skills/tmux-orchestration/scripts/tmux_ctl.sh setup to initialize each subagent from .agents/agents/ in its own tmux pane, then verify their status."

tmux send-keys -t "$SESSION_NAME:$WINDOW_NAME.0" "clear" C-m
tmux send-keys -t "$SESSION_NAME:$WINDOW_NAME.0" "echo '=================================================='" C-m
tmux send-keys -t "$SESSION_NAME:$WINDOW_NAME.0" "echo ' [PANE 3] CHAT ORCHESTRATOR: Main Session'" C-m
tmux send-keys -t "$SESSION_NAME:$WINDOW_NAME.0" "echo '=================================================='" C-m
tmux send-keys -t "$SESSION_NAME:$WINDOW_NAME.0" "export PS1='[chat-orchestrator] \$ '" C-m
tmux send-keys -t "$SESSION_NAME:$WINDOW_NAME.0" "agy --agent chat-orchestrator -i \"$INIT_PROMPT\"" C-m

echo "Tmux session '$SESSION_NAME' started! chat-orchestrator is setting up subagent panes from .agents/agents/."
echo "To attach and watch chat-orchestrator initialize the panes, run: tmux attach -t $SESSION_NAME"
