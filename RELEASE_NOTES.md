# Release v0.9.5

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
