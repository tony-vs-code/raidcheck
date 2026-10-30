# Release v0.9.1

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
