# Changelog

All notable changes to the SystemAlerts project are documented in this file.

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
