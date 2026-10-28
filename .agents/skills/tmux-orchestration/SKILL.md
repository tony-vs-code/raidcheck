---
name: tmux-orchestration
description: Setup, manage, and communicate with subagents (dev-agent, frontend-agent, qa-agent) running in dedicated tmux panes using definitions from .agents/agents/.
---

# Tmux Multi-Agent Orchestration Skill

Use this skill whenever `chat-orchestrator` needs to initialize subagents in their own `tmux` panes or communicate with `dev-agent`, `frontend-agent`, and `qa-agent` across panes in the `systemalerts` tmux session.

## Pane & Agent Mapping (`.agents/agents/`)
- **Pane 0 (`systemalerts:workspace.0`)**: `dev-agent` (`.agents/agents/dev-agent.md`) — Backend, FastAPI (`api.py`), `psutil`, RAID monitoring (`main.py`).
- **Pane 1 (`systemalerts:workspace.1`)**: `frontend-agent` (`.agents/agents/frontend-agent.md`) — Web Dashboard UI and static assets (`static/`).
- **Pane 2 (`systemalerts:workspace.2`)**: `qa-agent` (`.agents/agents/qa-agent.md`) — Test suite (`test_main.py`, `pytest`) and validation.
- **Pane 3 (`systemalerts:workspace.3`)**: `chat-orchestrator` (`.agents/agents/chat-orchestrator.md`) — Main coordinator session.

## Commands

All operations are performed via `.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh`:

### 1. Setup / Verify Subagent Panes
```bash
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh setup
```
Creates the 2x2 grid in `systemalerts:workspace` (if not already split) and launches `agy --agent <name> --mode auto` in each pane using the definitions in `.agents/agents/`.

### 2. Check Subagent Pane Status
```bash
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh status
```

### 3. Send a Task/Prompt to a Subagent Pane
```bash
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh send dev-agent "Implement GET /api/status in api.py"
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh send frontend-agent "Create the dashboard view in static/index.html"
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh send qa-agent "Run uv run pytest -v and verify all tests pass"
```

### 4. Read Output / Response from a Subagent Pane
```bash
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh read dev-agent 100
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh read frontend-agent 100
.agents/skills/tmux-orchestration/scripts/tmux_ctl.sh read qa-agent 100
```
