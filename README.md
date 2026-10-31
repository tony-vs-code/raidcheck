# Vigil — Linux Host Operations & Observability Suite

**Vigil** is a modern, lightweight, self-hosted server management and infrastructure observability suite for Linux systems and container fleets. Built on Python (FastAPI, AsyncIO, and psutil) with zero heavy external runtime agents, Vigil unifies bare-metal hardware telemetry, storage health, Docker container lifecycle controls, and multi-channel alerting into a single responsive cockpit.

---

## Core Capabilities

### 1. Hardware & System Telemetry
* **Per-Core CPU Drill-Down**: Live processor load with an interactive drill-down displaying individual core utilization percentages and mini progress bars, plus system load averages (1m, 5m, 15m) and core counts.
* **Rolling Memory Trend Graph**: Real-time vector SVG trend chart tracking memory utilization history over time, alongside detailed breakdowns of Used, Cached, Buffers, and Free memory.
* **System Uptime & Platform Info**: Prominent uptime tracking with boot timestamps and platform kernel details.

### 2. Storage & RAID Array Management
* **RAID Array Health & Sync Tracking**: Live status for `mdadm` arrays (clean, degraded, resyncing, rebuilding) with active rebuild/resync percentage progress bars and estimated completion times (ETA).
* **Disk Member Breakdown**: Live tracking of working, failed, and spare physical disks in the array.
* **Storage Volumes & Filesystems**: Comprehensive filesystem table detailing every mounted block device (`/`, `/home`, `/mnt/...`), filesystem types (`ext4`, `zfs`, `btrfs`, `xfs`), capacity bars, and free/used space.

### 3. Container Management & Compose Stacks
* **Full Container Lifecycle**: Live container dashboard to inspect, start, stop, restart, view real-time logs, and monitor resource consumption.
* **Compose Stacks**: Manage multi-container Compose stacks directly from the web interface.
* **External Stack Protection**: Automatically identifies containers belonging to external Compose or Docker Swarm managers, guarding against unintended mutations while maintaining full observability.
* **Image Tag & Version Tracking**: Detects remote registry image updates while respecting pinned image tags (e.g. `10.1.0`, `1.24`, `latest`) and semantic versioning.

### 4. Multi-Channel Notification Center
* **Pluggable Providers**: Native support for **Discord** (bot or webhook), **Telegram**, and generic **Webhooks**, unified through an extensible provider architecture.
* **Configurable Delivery Schedules**: Set periodic report schedules directly from the UI (Hourly, Daily at HH:MM, Weekly on [Day] at HH:MM, or Custom Intervals) with automated next-run calculation.
* **Selectable Report Topics**: Granular toggles to include System Metrics, Disk Health, and RAID status in periodic digests.
* **Dynamic Alert Thresholds**: Sliders for RAM %, CPU %, and Disk % triggers with configurable cooldown throttling to prevent notification spam, plus immediate degraded RAID state alerts.

### 5. Security & Persistence
* **Zero `.env` Secrets in Storage**: App settings, notification provider tokens, thresholds, and schedules are stored securely in SQLite (`app_settings`), eliminating sensitive credentials from repository files.
* **Secure Authentication**: Built-in credential-based authentication with cryptographically hashed passwords and session management, plus optional Google OAuth integration.

---

## Quickstart Installation

### 1-Line Automated Installation (Recommended)

Run the single-command installer with root privileges:

```bash
curl -fsSL https://raw.githubusercontent.com/tony-vs-code/vigil/main/install.sh | sudo bash
```

Or from a local git clone:

```bash
git clone https://github.com/tony-vs-code/vigil.git
cd vigil
sudo ./install.sh
```

#### What the installer does automatically:
1. **Validates & Installs Dependencies**: Detects your Linux distribution (`apt`, `dnf`, `yum`, or `pacman`), installs Python >= 3.10, and sets up [uv](https://docs.astral.sh/uv/) for high-speed dependency resolution.
2. **Deploys Application**: Configures `/opt/vigil` with an isolated virtual environment and synced dependencies.
3. **Installs & Starts Systemd Service**: Configures `/etc/systemd/system/vigil.service`, enables it to auto-start on boot, and launches the web dashboard immediately.
4. **Installs Global CLI Helper**: Symlinks `/usr/local/bin/vigil` so you can manage your server from anywhere in the terminal.

Once installation finishes, open **`http://<server-ip>:8000`** in your browser.

---

## Managing Vigil (CLI)

The `vigil` command-line helper allows you to manage the background service, inspect logs, and invoke application utilities directly:

```bash
# Check service health and daemon status
vigil status

# Stream live journald logs in real time
vigil logs

# Restart the service (e.g. after configuration changes)
sudo vigil restart

# Stop or start the daemon
sudo vigil stop
sudo vigil start

# Pull latest release, update dependencies, and restart
sudo vigil update

# Create admin user credentials
vigil create-user admin

# Test alert delivery across configured notification channels
vigil test-notification

# View alert schedule and next delivery times
vigil status
```

---

## Manual Development Setup

If you are developing Vigil or wish to run it in user-space without systemd:

```bash
# 1. Clone repository
git clone https://github.com/tony-vs-code/vigil.git
cd vigil

# 2. Install dependencies with uv
uv sync

# 3. Create initial admin user
uv run main.py create-user admin

# 4. Start development web server
uv run main.py web --host 0.0.0.0 --port 8000
```

---

## Running Test Suite

Vigil features an extensive cross-tier test suite covering backend logic, FastAPI endpoints, WebSocket streams, and UI contracts:

```bash
uv run pytest -v
```

To run the automated cross-tier quality gate script:
```bash
bash .agents/skills/qa-validate/scripts/validate_requirements.sh
```

---

## Upcoming Major Release Roadmap

We are actively expanding Vigil into a complete host administration suite:

* **Systemd Service Layer Monitoring**: Track failed units (`systemctl --failed`), start/stop/restart daemons, and stream live journald logs in the browser.
* **Host OS Package & Security Updates**: Inspect upgradable packages (`apt`/`dnf`), detect pending security advisories, and track reboot requirements (`/var/run/reboot-required`).
* **Interactive Process Explorer**: Real-time `htop`-style process table sorted by CPU and RAM consumption, with search, parent/child process inspection, and safe signal controls (`SIGTERM`/`SIGKILL`).
* **Hardware & Storage Health**: SMART drive diagnostics and automatic NVMe/SATA temperature alerting.
