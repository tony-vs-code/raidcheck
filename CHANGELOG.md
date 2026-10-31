# Changelog

All notable changes to the SystemAlerts project are documented in this file.

## [v1.0.0] - 2026-10-31
## Overview
Vigil v1.0.0 marks a landmark milestone, evolving Vigil into a unified, zero-overhead **Linux Host Operations & Observability Suite**. This major release introduces full systemd service management, an interactive process explorer, Linux user and group administration, a security and activity audit log system, and an optimized, balanced telemetry dashboard layout.

## Highlights & Enhancements

### 1. Systemctl Services Management
- **Live Daemon Observability**: Real-time status monitoring for systemd service units with active/sub state tracking, instant failed unit alerts, and summary counters.
- **Interactive Lifecycle Controls**: Direct `start`, `stop`, `restart`, `enable`, and `disable` actions with input sanitization and safety guards protecting core system daemons (`systemd`, `dbus`, `vigil`).
- **Integrated Journald Log Viewer**: Built-in modal to stream and inspect recent journalctl service logs directly from the browser.

### 2. Interactive Process Explorer
- **Live Process Telemetry**: Sortable task list detailing PID, Process Name, User, CPU %, RAM %, Thread count, and Status.
- **Visual Utilization Meters**: Mini inline progress bars for per-process CPU and Memory utilization.
- **Dynamic Sorting & Filtering**: Real-time search query filtering and sorting by CPU %, Memory %, PID, or Name.
- **Safe Process Termination**: Secure modal controls to send `SIGTERM` or `SIGKILL` signals, enforced by a safety blacklist guarding PID 1, kernel threads, and the Vigil process itself.

### 3. Linux User & Group Management
- **Host Account Categorization**: Clear distinction between **Human / Regular Users** (`UID >= 1000`) and **System Daemons** (`UID < 1000`), detailing display names, home directories, login shells, and group memberships.
- **Group Administration**: Group explorer displaying GIDs, membership lists, and member management.
- **Account Lifecycle Actions**: Modals to create, modify, and delete host users and groups (`useradd`, `usermod`, `userdel`, `groupadd`, `groupdel`, `gpasswd`).
- **System Protection Locks**: Safeguards preventing deletion of `root`, `sudo`, `wheel`, `shadow`, or `docker` accounts.

### 4. Security & Activity Audit Log
- **Persistent SQLite Event Log**: Dedicated `audit_logs` store capturing operational history, configuration changes, and security events.
- **Authentication Security Tracking**: Automated logging of failed login attempts (with client IP, timestamp, and failure reason), successful logins, user logouts, and initial admin setup.
- **Configuration & Operations Diffs**: Records application settings changes, notification threshold adjustments, systemctl service commands, and process termination signals.
- **Audit Explorer UI**: Filterable timeline by severity (`INFO`, `WARNING`, `SECURITY`), event type, or keyword search with expandable JSON metadata details.

### 5. System Metrics Layout Optimization
- **Enhanced Health Status Ribbon**: Prominent top overview ribbon monitoring **Storage**, **Containers**, **Alerts**, and **Services** with direct navigation links.
- **Balanced Telemetry Grid**: Re-sorted into clean multi-column rows:
  - **Row 1**: CPU Telemetry (overall load, load averages 1m/5m/15m, core count, per-core drilldown) & Memory Telemetry (vector SVG rolling trend chart, breakdown chips: Used, Cached, Free).
  - **Row 2**: Storage & Filesystems table (Root `/` and all mounted storage volumes with capacity gauges) & Host Platform Details (uptime, OS distribution, kernel version, boot time).

### 6. UI Polish & Navigation
- **Collapsed Navbar Fix**: Strict vertical icon stacking for user avatar and logout buttons within `.user-session-box`, ensuring zero border overflow in collapsed sidebar mode.

## [v0.9.7] - 2026-10-30
## Overview
Vigil v0.9.7 introduces a visual overhaul for Discord notifications—featuring high-contrast unicode telemetry gauges, multi-column inline grids, dynamic status banners, and host metadata footers. This release also debuts the zero-friction automated installer (`install.sh`), automatic systemd service deployment (`vigil.service`), and the global `vigil` command-line helper tool.

## Highlights & Enhancements

### 1. Modernized Discord Notification Embeds
- **Unicode Telemetry Gauges**: Real-time progress bars (`▰▰▰▰▰▱▱▱▱▱`) and humanized byte scaling for CPU, RAM, and storage mounts.
- **Dynamic Status Banners**: Top-level alert banner reflecting array and system health (`🟢 All Systems Operational`, `🟡 RAID Array REBUILDING`, `🔴 Attention: RAID Array DEGRADED`).
- **Multi-Column Inline Grids**: Structured parallel field cards displaying CPU load with core counts, memory usage with exact GB metrics, and uptime with load averages.
- **Host Context & Native Timestamps**: Author header with host badge (`Vigil System Monitor [<hostname>]`), system footer (`Vigil v0.9.7 • <OS/Kernel> • <hostname>`), and native Discord ISO timestamps.
- **Color-Coded Severity Palette**: Test/Healthy (Emerald `0x2ECC71`), Warnings/Elevated (Amber `0xF59E0B`), and Critical alerts (Coral Red `0xEF4444`).
- **Modernized RAID Embeds**: Replaced raw text blocks with structured status cards, device breakdown metrics, and drive health indicators.

### 2. Zero-Friction Automated Installer (`install.sh`)
- **Single-Line Quickstart**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/tony-vs-code/vigil/main/install.sh | sudo bash
  ```
- **Universal Linux Support**: Automated package detection and prerequisite installation across Debian/Ubuntu (`apt`), Fedora/RHEL (`dnf`/`yum`), and Arch (`pacman`).
- **Astral `uv` Virtual Environment**: High-speed, reproducible dependency isolation with automatic fallback to standard Python `venv`.
- **Automated Systemd Deployment**: Configures, enables, and starts `/etc/systemd/system/vigil.service` with automatic restarts and secure environment file handling.

### 3. Global `vigil` CLI Management Tool
- Symlinks `/usr/local/bin/vigil` for instant server management from any shell:
  - `vigil status`: Service health and uptime
  - `vigil logs`: Live streaming journald service logs
  - `sudo vigil restart`: Immediate daemon reload
  - `sudo vigil update`: Automated pull, dependency sync, and service restart
  - Application subcommands: `vigil create-user`, `vigil test-notification`, `vigil status`

### 4. Documentation & Repository Cleanup
- Updated `README.md` with the 1-line installer and `vigil` CLI commands.
- Removed legacy `systemd/raidcheck*.service` files and replaced them with the unified `vigil.service`.

## [v0.9.5] - 2026-10-30
## Overview
Vigil v0.9.5 delivers a major layout and observability upgrade featuring decondensed system telemetry, a collapsible side navigation bar, CPU per-core drilldowns, memory SVG trend visualization, storage filesystem mounts, real-time alert data, and streamlined notification delivery channel management.

## Highlights & Enhancements
- **Brand Identity**: Complete evolution to **Vigil: Lightweight Linux Host Operations & Observability Suite** across documentation, interfaces, and metadata.
- **Decondensed System Metrics Layout**: Re-spaced overview metrics into a spacious 2-column desktop layout, giving CPU and memory telemetry ample breathing room.
- **Health Status Ribbon**: Replaced redundant bottom status summary cards with a sleek, low-profile status ribbon on System Metrics with live array, container, and alert status indicators.
- **Collapsible Side Navigation**: Shrinks smoothly to a 68px icon-only mini bar with tooltips and `localStorage` state persistence.
- **CPU & Memory Telemetry Drilldowns**: Interactive per-core CPU load grid, logical core count badges, and rolling SVG memory usage trend charts with detailed Used/Cached/Free memory chips.
- **Storage Volumes & Filesystems**: Dedicated storage breakdown card in RAID view tracking mount capacities, available space, and filesystem types.
- **Stack Status Clean-up**: Stripped container count strings from Compose stack statuses for cleaner state visualization.
- **Unified Notification Management**: Combined automated report cadence and topic selection into one unified card, and expanded the Notification Audit History table to full width.
- **Delivery Channels Persistence**: Renamed channel save control to **"Save Delivery Channels"**, saving Discord, Telegram, and Generic Webhook settings simultaneously.
- **Live Test Notifications**: Test alerts compile and transmit real host metrics, storage capacity, and RAID status.

## Reliability & Fixes
- **Single Feedback Banner**: Resolved duplicate and triplicate flash message banners by strictly targeting a single DOM feedback banner with a 5-second auto-clear timer.
- **Static Asset Cache Busting**: Automated asset version stamping (`?v=0.9.5`) to eliminate stale cached scripts in client browsers.
- **Test Suite Verification**: All 101 unit and integration test assertions pass with 100% contract compliance.

## [v0.9.1] - 2026-10-30
## Overview
Accurate Docker container update detection, instant update schedule loading, and automated update frequency persistence.

## Highlights & Enhancements
- Remote Registry Digest Resolution: Multi-stage remote image manifest inspection via buildx imagetools inspect --raw and Docker manifest inspect matching host architecture.
- Container Update Accuracy: Accurately compares remote manifest digest against local image RepoDigests, replacing the hardcoded false flag so container updates are reliably discovered and flagged.
- Decoupled Update Schedule Loading: Decoupled update schedule and settings fetching from registry network scans, eliminating UI lag and enabling instantaneous tab switching.
- Concurrent Update Checking & Caching: Added 120-second TTL caching and a 5-worker thread pool for concurrent remote registry checks with manual refresh bypass.

## Reliability & Fixes
- Container Update Action Guard: The "Update" button now only appears on containers with pullable image updates, showing a clean "Current" badge on up-to-date containers.
- "Update All" Toggle: The "Update All" button automatically disables when no container updates are available, preventing unnecessary pull jobs.
- Auto-Check Persistence: Added immediate auto-save on select change for Docker image check frequency with persistent SQLite storage.
- Comprehensive Test Coverage: All 80 unit and integration tests passing.

## [v0.9.0] - 2026-10-30
## Overview
Direct Linux sysfs and Docker Unix socket streaming, interactive update modal, in-app changelog, and clean SVG icons.

## Highlights & Enhancements
- Direct POSIX statvfs implementation replacing duf and df subprocess calls with microsecond-level disk capacity metrics.
- Direct Linux Sysfs RAID inspection reading /sys/block/md* for zero-fork kernel status and real-time resync/rebuild progress.
- Docker Engine Unix domain socket client (/var/run/docker.sock) in DockerManager for zero-subprocess container inspections, stats, volumes, and networks.
- Real-time Docker container lifecycle event listener (/events) broadcasting instant WebSocket updates on container failure or status change.
- Redesigned update experience featuring an unobtrusive header notice button and an interactive Software Update modal.
- In-app Changelog viewer with an authenticated GET /api/changelog endpoint and automatic CHANGELOG.md maintenance on every release.
- Professional typographic styling and crisp SVG vector stroke icons across all components, eliminating emojis entirely.

## Reliability & Fixes
- Added authenticated GET /api/docker/updates/config and auto-save on select change for Docker image auto-check frequency.
- Restricted the container Update action button to only appear on containers with pullable image updates.
- Added comprehensive unit and integration tests covering sysfs RAID parsing, statvfs metrics, Docker socket requests, and changelog endpoints.
- Self-testing workflow enforcement across all subagents.
- Automated Pull Request creation and branch management via GitHub CLI.

## [v0.8.1] - 2026-10-30
### Highlights & Enhancements
- Docker refresh latency optimizations and background stats caching.
- Enhanced real-time container metrics.

## [v0.8.0] - 2026-10-30
### Highlights & Enhancements
- Rebrand UI to SystemAlerts Server Manager.
- Consolidated system and container monitoring views.

## [v0.7.1] - 2026-10-29
### Highlights & Enhancements
- Real-time WebSocket live streaming and badges for Docker containers and subtabs.

## [v0.7.0] - 2026-10-29
### Highlights & Enhancements
- Container stack and status filtering.
- Volume inspection modal with disk usage breakdowns.
- Automated update scheduling and account timezone support.
- External stack protections.

## [v0.6.0] - 2026-10-28
### Highlights & Enhancements
- Docker Container and Compose Stack management with UI and automated tests.

## [v0.5.2] - 2026-10-28
### Reliability & Fixes
- Test suite hermeticity improvements for CI environments.

## [v0.5.1] - 2026-10-28
### Highlights & Enhancements
- Discord test notifications in web mode via REST API fallback.
- Discord setup moved into Notifications tab with asset cache-busting.

## [v0.5.0] - 2026-10-28
### Highlights & Enhancements
- Dedicated Notifications & Logs dashboard.
- Discord toggle in settings and on-demand test notifications.

## [v0.4.0] - 2026-10-28
### Highlights & Enhancements
- Multi-rate per-module refresh controls.
- Adaptive RAID WebSocket streaming during resync or recovery.

## [v0.3.0] - 2026-10-28
### Highlights & Enhancements
- WebSocket real-time modular dashboard streaming (/api/ws).

## [v0.2.3] - 2026-10-28
### Reliability & Fixes
- Resilient release updater when uv is outside systemd PATH.

## [v0.2.2] - 2026-10-28
### Reliability & Fixes
- Release self-updater handling for dirty lockfile checkouts.

## [v0.2.1] - 2026-10-28
### Reliability & Fixes
- Release packaging and version alignment.

## [v0.2.0] - 2026-10-28
### Highlights & Enhancements
- SQLite authentication, web settings modal, and dynamic md RAID device detection.
- Release-tag self-updater.
