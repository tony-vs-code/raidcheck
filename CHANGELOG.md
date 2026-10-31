# Changelog

All notable changes to the SystemAlerts project are documented in this file.

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
