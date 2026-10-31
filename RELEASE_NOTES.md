# Release v0.9.7

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
  curl -fsSL https://raw.githubusercontent.com/tony-vs-code/raidcheck/main/install.sh | sudo bash
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
