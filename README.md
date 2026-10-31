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

## Quickstart

### Prerequisites
* Linux OS (Debian/Ubuntu, RHEL/Fedora, Arch, etc.)
* Python >= 3.11
* [uv](https://docs.astral.sh/uv/) (recommended for fast, deterministic dependency management)
* Docker (optional, for container & stack management)

### 1. Clone the Repository
```bash
git clone https://github.com/tony-vs-code/raidcheck.git vigil
cd vigil
```

### 2. Install Dependencies
```bash
uv sync
```
This sets up a dedicated virtual environment with all required dependencies locked from `pyproject.toml`.

### 3. Initialize Initial Admin User
```bash
uv run main.py create-user admin
```
You will be prompted to set a secure password for the admin account. (You can also perform this setup on the web UI when first accessing the application).

### 4. Start the Web Dashboard
```bash
uv run main.py web --host 0.0.0.0 --port 8000
```
Open [http://localhost:8000](http://localhost:8000) in your browser and sign in.

---

## Command-Line Usage

Vigil can also be invoked as a standalone CLI or headless daemon:

```bash
# Run the background monitoring daemon
uv run main.py

# Check notification state and schedule from terminal
uv run main.py status

# Inspect recent notification history logs
uv run main.py logs --limit 20

# Test notification delivery across configured channels
uv run main.py test-notification
```

---

## Running as a Systemd Service

Pre-configured systemd unit files are provided in `systemd/` for continuous background operation:

1. Copy the service unit files to `/etc/systemd/system/`:
   ```bash
   sudo cp systemd/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

2. Enable and start the Vigil web service:
   ```bash
   sudo systemctl enable --now raidcheck-web.service
   ```

3. Enable the background alerting worker (optional if running standalone web):
   ```bash
   sudo systemctl enable --now raidcheck.service
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
* **Zero-Friction One-Line Installer**: Single `curl | bash` installation script with automatic systemd setup, architecture detection, and port configuration.
