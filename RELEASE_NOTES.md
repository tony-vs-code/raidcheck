# Release v0.9.0

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
