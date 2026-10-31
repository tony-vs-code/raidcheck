#!/usr/bin/env bash
# ==============================================================================
# Vigil — Automated Installer and Systemd Service Setup
# https://github.com/tony-vs-code/vigil
# ==============================================================================
set -euo pipefail

REPO_URL="https://github.com/tony-vs-code/vigil.git"
DEFAULT_INSTALL_DIR="/opt/vigil"
DEFAULT_PORT=8000
IN_PLACE=false
PORT="$DEFAULT_PORT"

# Parse CLI arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --in-place)
            IN_PLACE=true
            shift
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        --dir)
            DEFAULT_INSTALL_DIR="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: sudo ./install.sh [options]"
            echo ""
            echo "Options:"
            echo "  --in-place       Install service pointing to current repository directory"
            echo "  --port <port>    Web dashboard port (default: 8000)"
            echo "  --dir <path>     Target installation directory (default: /opt/vigil)"
            echo "  -h, --help       Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# Root privilege check
if [ "$EUID" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        echo "==> Elevating privileges with sudo..."
        exec sudo bash "$0" "$@"
    else
        echo "ERROR: This installer must be run as root or with sudo." >&2
        exit 1
    fi
fi

echo "================================================================================"
echo "                   Vigil — System Operations & Observability                    "
echo "================================================================================"
echo "==> Starting automated installation..."

# OS and Distro Detection
DISTRO="unknown"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO="${ID:-unknown}"
fi

echo "==> Detected OS: ${PRETTY_NAME:-$DISTRO} ($(uname -m))"

# Install System Prerequisites
echo "==> Checking required system packages..."
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip curl git ca-certificates >/dev/null
elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q python3 python3-pip curl git ca-certificates
elif command -v yum >/dev/null 2>&1; then
    yum install -y -q python3 python3-pip curl git ca-certificates
elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm python python-pip curl git ca-certificates >/dev/null
else
    echo "==> Notice: Unsupported package manager. Please ensure Python >= 3.10, curl, and git are installed."
fi

# Ensure Python version is >= 3.10
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 could not be found." >&2
    exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    echo "ERROR: Vigil requires Python 3.10 or newer (detected Python $PY_VER)." >&2
    exit 1
fi
echo "==> Verified Python version: $PY_VER"

# Ensure Astral uv is installed (fast package management)
if ! command -v uv >/dev/null 2>&1 && [ ! -f /root/.local/bin/uv ] && [ ! -f /usr/local/bin/uv ]; then
    echo "==> Installing uv package manager..."
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh || true
fi

# Ensure uv is in PATH for this script session
export PATH="/usr/local/bin:/root/.local/bin:$PATH"

if command -v uv >/dev/null 2>&1; then
    echo "==> Using uv package manager ($(uv --version))"
    USE_UV=true
else
    echo "==> uv not found; falling back to python3 -m venv."
    USE_UV=false
fi

# Target Directory Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IS_LOCAL_REPO=false
if [ -f "$SCRIPT_DIR/pyproject.toml" ] && [ -f "$SCRIPT_DIR/main.py" ]; then
    IS_LOCAL_REPO=true
fi

if [ "$IN_PLACE" = "true" ] && [ "$IS_LOCAL_REPO" = "true" ]; then
    INSTALL_DIR="$SCRIPT_DIR"
    echo "==> Installing in-place at repository path: $INSTALL_DIR"
else
    INSTALL_DIR="$DEFAULT_INSTALL_DIR"
    echo "==> Target installation directory: $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"

    if [ "$IS_LOCAL_REPO" = "true" ] && [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
        echo "==> Copying application files to $INSTALL_DIR..."
        if command -v rsync >/dev/null 2>&1; then
            rsync -a --exclude='.venv' --exclude='.git' --exclude='.agents' --exclude='__pycache__' "$SCRIPT_DIR/" "$INSTALL_DIR/"
        else
            cp -r "$SCRIPT_DIR/." "$INSTALL_DIR/"
            rm -rf "$INSTALL_DIR/.venv" "$INSTALL_DIR/.git" "$INSTALL_DIR/.agents"
        fi
    elif [ ! -f "$INSTALL_DIR/pyproject.toml" ]; then
        echo "==> Cloning Vigil repository from $REPO_URL..."
        git clone "$REPO_URL" "$INSTALL_DIR"
    else
        echo "==> Found existing installation in $INSTALL_DIR. Pulling latest release..."
        (cd "$INSTALL_DIR" && git pull --ff-only origin main || true)
    fi
fi

# Build Virtual Environment and Dependencies
echo "==> Setting up Python virtual environment and dependencies in $INSTALL_DIR..."
cd "$INSTALL_DIR"

if [ "$USE_UV" = "true" ]; then
    uv venv --python python3 "$INSTALL_DIR/.venv"
    uv pip install --python "$INSTALL_DIR/.venv/bin/python" -e .
else
    python3 -m venv "$INSTALL_DIR/.venv"
    "$INSTALL_DIR/.venv/bin/pip" install --upgrade pip setuptools wheel
    "$INSTALL_DIR/.venv/bin/pip" install -e .
fi

# Ensure Configuration Directory Exists
mkdir -p /etc/vigil
if [ ! -f /etc/vigil/vigil.env ]; then
    echo "==> Generating initial environment configuration at /etc/vigil/vigil.env..."
    cat <<EOF > /etc/vigil/vigil.env
# Vigil Host Operations Environment Configuration
PYTHONUNBUFFERED=1
PORT=${PORT}
HOST=0.0.0.0
EOF
    chmod 600 /etc/vigil/vigil.env
fi

# Install Systemd Service Unit
echo "==> Installing systemd service unit (/etc/systemd/system/vigil.service)..."
cat <<EOF > /etc/systemd/system/vigil.service
[Unit]
Description=Vigil — Linux Host Operations & Observability Suite
Documentation=https://github.com/tony-vs-code/vigil
After=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
Environment="PYTHONUNBUFFERED=1"
EnvironmentFile=-/etc/vigil/vigil.env
ExecStart=${INSTALL_DIR}/.venv/bin/python ${INSTALL_DIR}/main.py web --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=5
TimeoutStopSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

# Install Vigil CLI Helper Symlink
echo "==> Installing 'vigil' command-line helper at /usr/local/bin/vigil..."
cat <<'EOF' > /usr/local/bin/vigil
#!/usr/bin/env bash
set -e

INSTALL_DIR="/opt/vigil"
if [ ! -d "$INSTALL_DIR" ] && [ -f "/etc/systemd/system/vigil.service" ]; then
    INSTALL_DIR=$(grep 'WorkingDirectory=' /etc/systemd/system/vigil.service | cut -d= -f2)
fi

PYTHON_EXEC="${INSTALL_DIR}/.venv/bin/python"
MAIN_SCRIPT="${INSTALL_DIR}/main.py"

case "${1:-}" in
    status)
        systemctl status vigil.service
        ;;
    start)
        systemctl start vigil.service
        ;;
    stop)
        systemctl stop vigil.service
        ;;
    restart)
        systemctl restart vigil.service
        ;;
    logs)
        shift || true
        journalctl -u vigil.service -f "$@"
        ;;
    update)
        echo "==> Updating Vigil to latest release..."
        cd "$INSTALL_DIR"
        git pull origin main --tags
        if command -v uv >/dev/null 2>&1; then
            uv pip install --python "$PYTHON_EXEC" -e .
        else
            "$PYTHON_EXEC" -m pip install -e .
        fi
        systemctl restart vigil.service
        echo "==> Vigil updated and restarted successfully!"
        ;;
    help|--help|-h|"")
        echo "Vigil — Linux Host Operations & Observability Suite"
        echo ""
        echo "Usage: vigil <command> [arguments]"
        echo ""
        echo "Service Commands:"
        echo "  status       Check systemd service status"
        echo "  start        Start background Vigil service"
        echo "  stop         Stop background Vigil service"
        echo "  restart      Restart background Vigil service"
        echo "  logs         Stream live journald service logs"
        echo "  update       Pull latest release, upgrade dependencies, and restart"
        echo ""
        echo "Application Commands:"
        echo "  create-user <username>   Create admin credentials"
        echo "  test-notification        Trigger test delivery across notification channels"
        echo "  logs                     Inspect recent alert history audit logs"
        echo "  status                   Inspect alert schedule and next delivery times"
        ;;
    *)
        cd "$INSTALL_DIR"
        "$PYTHON_EXEC" "$MAIN_SCRIPT" "$@"
        ;;
esac
EOF
chmod +x /usr/local/bin/vigil

# Reload and Enable Service
echo "==> Reloading systemd daemon and enabling vigil.service..."
systemctl daemon-reload
systemctl enable --now vigil.service

# Detect Host IP
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo "================================================================================"
echo "                      Vigil Installation Successful!                           "
echo "================================================================================"
echo "  Web Dashboard:     http://${SERVER_IP}:${PORT} (or http://localhost:${PORT})"
echo "  Service Status:    sudo systemctl status vigil.service"
echo "  Live Logs:         sudo journalctl -u vigil.service -f"
echo "  CLI Management:    vigil --help"
echo "================================================================================"
