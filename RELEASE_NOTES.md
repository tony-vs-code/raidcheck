# Release v1.0.0

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
