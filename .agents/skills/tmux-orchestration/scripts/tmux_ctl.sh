#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${TMUX_SESSION_NAME:-systemalerts}"
WINDOW_NAME="${TMUX_WINDOW_NAME:-workspace}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
AGENTS_DIR="$PROJECT_DIR/.agents/agents"
ORCHESTRATOR_FILE="$AGENTS_DIR/chat-orchestrator.md"

if [[ ! -f "$ORCHESTRATOR_FILE" ]]; then
    echo "Error: Orchestrator definition not found at $ORCHESTRATOR_FILE" >&2
    exit 1
fi

# Dynamically discover subagents from .agents/agents/*.md (in order: dev-agent, frontend-agent, qa-agent, plus any others)
SUBAGENTS=()
for preferred in dev-agent frontend-agent qa-agent; do
    if [[ -f "$AGENTS_DIR/$preferred.md" ]]; then
        SUBAGENTS+=("$preferred")
    fi
done
for agent_file in "$AGENTS_DIR"/*.md; do
    agent_name="$(basename "$agent_file" .md)"
    if [[ "$agent_name" != "chat-orchestrator" && ! " ${SUBAGENTS[*]} " =~ " ${agent_name} " ]]; then
        SUBAGENTS+=("$agent_name")
    fi
done

get_pane_for_agent() {
    local query="$1"
    if [[ "$query" =~ ^[0-9]+$ ]]; then
        echo "$query"
        return 0
    fi
    local idx=0
    for sub in "${SUBAGENTS[@]}"; do
        if [[ "$sub" == "$query" ]]; then
            echo "$idx"
            return 0
        fi
        idx=$((idx + 1))
    done
    if [[ "$query" == "chat-orchestrator" ]]; then
        echo "${#SUBAGENTS[@]}"
        return 0
    fi
    echo "Error: Unknown agent '$query'. Subagents configured in $ORCHESTRATOR_FILE: ${SUBAGENTS[*]}" >&2
    return 1
}

get_agent_for_pane() {
    local pane="$1"
    if [[ "$pane" -ge 0 && "$pane" -lt "${#SUBAGENTS[@]}" ]]; then
        echo "${SUBAGENTS[$pane]}"
        return 0
    elif [[ "$pane" -eq "${#SUBAGENTS[@]}" ]]; then
        echo "chat-orchestrator"
        return 0
    fi
    return 1
}

get_banner_for_agent() {
    local pane_idx="$1"
    local agent="$2"
    local title
    title="$(awk '/^# /{sub(/^# /, ""); print; exit}' "$AGENTS_DIR/$agent.md" 2>/dev/null || echo "$agent")"
    echo "[PANE $pane_idx] $title ($agent)"
}

is_agy_running_in_pane() {
    local pane_idx="$1"
    local pane_pid
    pane_pid="$(tmux list-panes -t "$SESSION_NAME:$WINDOW_NAME" -F '#{pane_index}:#{pane_pid}' 2>/dev/null | awk -F: -v idx="$pane_idx" '$1 == idx {print $2}')"
    if [[ -z "$pane_pid" ]]; then
        return 1
    fi
    if ps --ppid "$pane_pid" -o comm= 2>/dev/null | grep -Eq '^(agy|agentapi)$'; then
        return 0
    fi
    return 1
}

init_agent_in_pane() {
    local pane_idx="$1"
    local agent_name="$2"
    local target="$SESSION_NAME:$WINDOW_NAME.$pane_idx"
    local banner
    banner="$(get_banner_for_agent "$pane_idx" "$agent_name")"

    if [[ ! -f "$AGENTS_DIR/$agent_name.md" ]]; then
        echo "Error: Agent definition not found at $AGENTS_DIR/$agent_name.md" >&2
        return 1
    fi

    # Check if agy is already running as a child process of this pane's shell
    if is_agy_running_in_pane "$pane_idx"; then
        echo "Pane $pane_idx ($agent_name) already has an active agy session."
        return 0
    fi

    tmux send-keys -t "$target" "clear" C-m
    tmux send-keys -t "$target" "echo '=================================================='" C-m
    tmux send-keys -t "$target" "echo ' $banner'" C-m
    tmux send-keys -t "$target" "echo '=================================================='" C-m
    tmux send-keys -t "$target" "export PS1='[$agent_name] \$ '" C-m
    tmux send-keys -t "$target" "agy --agent $agent_name" C-m
    echo "Initialized $agent_name in $target (from .agents/agents/$agent_name.md)"
}

cmd_setup() {
    for sub in "${SUBAGENTS[@]}" "chat-orchestrator"; do
        if [[ ! -f "$AGENTS_DIR/$sub.md" ]]; then
            echo "Error: Missing required agent definition $AGENTS_DIR/$sub.md" >&2
            exit 1
        fi
    done

    # Create session if it doesn't exist yet
    if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$PROJECT_DIR"
    fi

    local pane_count
    pane_count="$(tmux list-panes -t "$SESSION_NAME:$WINDOW_NAME" | wc -l)"

    # If only 1 pane exists (chat-orchestrator started in Pane 0 and is now setting up its subagents):
    if [[ "$pane_count" -eq 1 ]]; then
        if is_agy_running_in_pane 0; then
            # Split around chat-orchestrator so Panes 0, 1, 2 are created for subagents and chat-orchestrator lands in Pane 3 (Bottom-Right)
            tmux split-window -v -b -d -t "$SESSION_NAME:$WINDOW_NAME.0" -c "$PROJECT_DIR"
            tmux split-window -h -d -t "$SESSION_NAME:$WINDOW_NAME.0" -c "$PROJECT_DIR"
            tmux split-window -h -b -d -t "$SESSION_NAME:$WINDOW_NAME.2" -c "$PROJECT_DIR"
        else
            tmux split-window -h -d -t "$SESSION_NAME:$WINDOW_NAME.0" -c "$PROJECT_DIR"
            tmux split-window -v -d -t "$SESSION_NAME:$WINDOW_NAME.0" -c "$PROJECT_DIR"
            tmux split-window -v -d -t "$SESSION_NAME:$WINDOW_NAME.1" -c "$PROJECT_DIR"
        fi
        tmux select-layout -t "$SESSION_NAME:$WINDOW_NAME" tiled
    fi

    # Initialize each subagent from .agents/agents/chat-orchestrator.md in its own pane
    local idx=0
    for sub in "${SUBAGENTS[@]}"; do
        init_agent_in_pane "$idx" "$sub" "auto"
        idx=$((idx + 1))
    done

    # Ensure chat-orchestrator is running in the final pane
    init_agent_in_pane "$idx" "chat-orchestrator" "auto"

    tmux select-layout -t "$SESSION_NAME:$WINDOW_NAME" tiled
    tmux select-pane -t "$SESSION_NAME:$WINDOW_NAME.$idx"
    echo "All subagent panes configured from $AGENTS_DIR."
}

cmd_send() {
    if [[ $# -lt 2 ]]; then
        echo "Usage: $0 send <agent-name|pane-index> <message...>" >&2
        exit 1
    fi
    local agent_or_pane="$1"
    shift
    local message="$*"
    local pane_idx
    pane_idx="$(get_pane_for_agent "$agent_or_pane")"
    local agent_name
    agent_name="$(get_agent_for_pane "$pane_idx")"
    local target="$SESSION_NAME:$WINDOW_NAME.$pane_idx"

    # Ensure subagent is running in target pane
    init_agent_in_pane "$pane_idx" "$agent_name" "auto" >/dev/null

    # Send literal prompt text to the subagent's interactive agy TUI and submit with Enter
    tmux send-keys -t "$target" -l "$message"
    sleep 0.2
    tmux send-keys -t "$target" C-m
    echo "Sent message to $agent_name (Pane $pane_idx)."
}

cmd_read() {
    if [[ $# -lt 1 ]]; then
        echo "Usage: $0 read <agent-name|pane-index> [lines]" >&2
        exit 1
    fi
    local agent_or_pane="$1"
    local lines="${2:-80}"
    local pane_idx
    pane_idx="$(get_pane_for_agent "$agent_or_pane")"
    local agent_name
    agent_name="$(get_agent_for_pane "$pane_idx")"
    local target="$SESSION_NAME:$WINDOW_NAME.$pane_idx"

    echo "=== Output from $agent_name (Pane $pane_idx) ==="
    tmux capture-pane -p -S "-$lines" -t "$target"
}

cmd_status() {
    echo "=== Tmux Session '$SESSION_NAME:$WINDOW_NAME' Multi-Agent Status ==="
    local total=$(( ${#SUBAGENTS[@]} + 1 ))
    for (( pane_idx=0; pane_idx<total; pane_idx++ )); do
        local agent_name
        agent_name="$(get_agent_for_pane "$pane_idx")"
        if tmux list-panes -t "$SESSION_NAME:$WINDOW_NAME" -F '#{pane_index}' 2>/dev/null | grep -qx "$pane_idx"; then
            if is_agy_running_in_pane "$pane_idx"; then
                echo "Pane $pane_idx [$agent_name] (.agents/agents/$agent_name.md): ACTIVE (agy running)"
            else
                echo "Pane $pane_idx [$agent_name] (.agents/agents/$agent_name.md): IDLE (shell)"
            fi
        else
            echo "Pane $pane_idx [$agent_name] (.agents/agents/$agent_name.md): NOT CREATED"
        fi
    done
}

ACTION="${1:-status}"
shift || true

case "$ACTION" in
    setup)  cmd_setup "$@" ;;
    send)   cmd_send "$@" ;;
    read)   cmd_read "$@" ;;
    status) cmd_status "$@" ;;
    *)
        echo "Usage: $0 {setup|send|read|status}" >&2
        exit 1
        ;;
esac
