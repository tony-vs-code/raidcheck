const AUTO_REFRESH_INTERVAL_MS = 10000;
const VALID_RAID_STATES = new Set([
  "clean",
  "active",
  "degraded",
  "recovering",
  "resyncing",
  "failed",
  "error",
  "unknown",
]);

let refreshTimerId = null;
let isFetching = false;

/**
 * Format raw byte count into human-readable GiB/MiB/TiB string.
 */
function formatBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) {
    return "--";
  }
  if (num === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(
    Math.floor(Math.log(num) / Math.log(1024)),
    units.length - 1
  );
  const value = num / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

/**
 * Format uptime duration from boot_time (unix seconds) to "Xd Xh Xm".
 */
function formatUptimeFromBoot(bootTimeSeconds) {
  const boot = Number(bootTimeSeconds);
  if (!Number.isFinite(boot) || boot <= 0) {
    return "--";
  }
  const nowSeconds = Date.now() / 1000;
  const elapsed = Math.max(0, Math.floor(nowSeconds - boot));
  const days = Math.floor(elapsed / 86400);
  const hours = Math.floor((elapsed % 86400) / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Format unix timestamp seconds into local date-time string.
 */
function formatTimestampLocal(unixSeconds) {
  const sec = Number(unixSeconds);
  if (!Number.isFinite(sec) || sec <= 0) {
    return "--";
  }
  return new Date(sec * 1000).toLocaleString();
}

/**
 * Normalize RAID status string to one of the supported states.
 */
function normalizeRaidState(rawState) {
  const cleaned = String(rawState || "unknown").trim().toLowerCase();
  return VALID_RAID_STATES.has(cleaned) ? cleaned : "unknown";
}

/**
 * Apply status badge classes and text for a given RAID state.
 */
function applyStatusBadge(badgeEl, textEl, rawState) {
  if (!badgeEl) return;
  const state = normalizeRaidState(rawState);

  VALID_RAID_STATES.forEach((s) => badgeEl.classList.remove(`status-${s}`));
  badgeEl.classList.add(`status-${state}`);
  badgeEl.setAttribute("data-state", state);

  const label = state.toUpperCase();
  if (textEl) {
    textEl.textContent = label;
  } else {
    badgeEl.textContent = label;
  }
}

/**
 * Update a progress bar width and threshold color class.
 */
function updateProgressBar(barEl, percent) {
  if (!barEl) return;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  barEl.style.width = `${clamped.toFixed(1)}%`;
  barEl.classList.remove("warn", "danger");
  if (clamped >= 90) {
    barEl.classList.add("danger");
  } else if (clamped >= 75) {
    barEl.classList.add("warn");
  }
}

/**
 * Render System Metrics section from /api/status system payload.
 */
function renderSystemMetrics(system) {
  if (!system) return;

  // CPU
  const cpuPercent = Number(system.cpu_percent) || 0;
  const cpuValEl = document.getElementById("cpu-percent-value");
  const cpuBarEl = document.getElementById("cpu-progress-bar");
  if (cpuValEl) cpuValEl.textContent = `${cpuPercent.toFixed(1)}%`;
  updateProgressBar(cpuBarEl, cpuPercent);

  // Memory
  const mem = system.memory || {};
  const memPercent = Number(mem.percent) || 0;
  const memValEl = document.getElementById("memory-percent-value");
  const memBarEl = document.getElementById("memory-progress-bar");
  const memDetailEl = document.getElementById("memory-detail");
  if (memValEl) memValEl.textContent = `${memPercent.toFixed(1)}%`;
  updateProgressBar(memBarEl, memPercent);
  if (memDetailEl) {
    memDetailEl.textContent = `${formatBytes(mem.used)} / ${formatBytes(mem.total)} used (${formatBytes(mem.available)} avail)`;
  }

  // Disk
  const disk = system.disk || {};
  const diskPercent = Number(disk.percent) || 0;
  const diskValEl = document.getElementById("disk-percent-value");
  const diskBarEl = document.getElementById("disk-progress-bar");
  const diskDetailEl = document.getElementById("disk-detail");
  if (diskValEl) diskValEl.textContent = `${diskPercent.toFixed(1)}%`;
  updateProgressBar(diskBarEl, diskPercent);
  if (diskDetailEl) {
    diskDetailEl.textContent = `${formatBytes(disk.used)} / ${formatBytes(disk.total)} used (${formatBytes(disk.free)} free)`;
  }

  // Uptime
  const uptimeValEl = document.getElementById("uptime-value");
  const bootDetailEl = document.getElementById("boot-time-detail");
  if (uptimeValEl) {
    uptimeValEl.textContent = formatUptimeFromBoot(system.boot_time);
  }
  if (bootDetailEl) {
    bootDetailEl.textContent = `Booted: ${formatTimestampLocal(system.boot_time)}`;
  }
}

/**
 * Render RAID Array Details card and Active Disks table.
 */
function renderRaidDetails(raid) {
  if (!raid) return;

  const status = raid.status || "unknown";

  // Header & Card badges
  applyStatusBadge(
    document.getElementById("raid-status-badge"),
    document.getElementById("raid-status-text"),
    status
  );
  applyStatusBadge(document.getElementById("raid-card-badge"), null, status);

  // Device count boxes
  const activeCount = String(raid.active_devices ?? "0");
  const workingCount = String(raid.working_devices ?? "0");
  const failedCount = String(raid.failed_devices ?? "0");
  const spareCount = String(raid.spare_devices ?? "0");

  const activeEl = document.getElementById("raid-active-devices");
  const workingEl = document.getElementById("raid-working-devices");
  const failedEl = document.getElementById("raid-failed-devices");
  const spareEl = document.getElementById("raid-spare-devices");

  if (activeEl) activeEl.textContent = activeCount;
  if (workingEl) workingEl.textContent = workingCount;
  if (failedEl) {
    failedEl.textContent = failedCount;
    failedEl.classList.toggle("count-danger", Number(failedCount) > 0);
  }
  if (spareEl) spareEl.textContent = spareCount;

  // Details definition list
  const setField = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value || "--";
  };

  setField("raid-level", (raid.raid_level || "unknown").toUpperCase());
  setField("raid-array-size", raid.array_size);
  setField(
    "raid-devices-summary",
    `${activeCount} active, ${workingCount} working, ${failedCount} failed, ${spareCount} spare`
  );
  setField("raid-storage-info", raid.storage_info);
  setField("raid-check-status", raid.check_status);
  setField("raid-full-state", raid.full_state || status);
  setField("raid-persistence", raid.persistence);
  setField("raid-uuid", raid.uuid);
  setField("raid-update-time", raid.update_time);
  setField(
    "raid-layout-chunk",
    `${raid.layout || "unknown"} / ${raid.chunk_size || "unknown"}`
  );
  setField(
    "raid-consistency-events",
    `${raid.consistency_policy || "unknown"} (Events: ${raid.events || "unknown"})`
  );

  // Active Disks table
  const devices = Array.isArray(raid.devices) ? raid.devices : [];
  const disksBadge = document.getElementById("disks-count-badge");
  if (disksBadge) {
    disksBadge.textContent = `${devices.length} ${devices.length === 1 ? "disk" : "disks"}`;
  }

  const tbody = document.getElementById("active-disks-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (devices.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty-state";
    td.textContent = "No active member disks detected";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  devices.forEach((item) => {
    const tr = document.createElement("tr");

    const tdDev = document.createElement("td");
    tdDev.className = "mono-text";
    tdDev.textContent = item.device || "unknown";

    const tdPath = document.createElement("td");
    tdPath.className = "mono-text";
    const devName = item.device || "";
    tdPath.textContent = devName.startsWith("/dev/")
      ? devName
      : `/dev/${devName}`;

    const tdState = document.createElement("td");
    const stateBadge = document.createElement("span");
    const stateStr = String(item.state || "unknown").toLowerCase();
    const isHealthy =
      stateStr.includes("active") ||
      stateStr.includes("sync") ||
      stateStr.includes("clean");
    const isFaulty =
      stateStr.includes("faulty") ||
      stateStr.includes("failed") ||
      stateStr.includes("removed");

    stateBadge.className = `status-badge ${
      isFaulty
        ? "status-failed"
        : isHealthy
          ? "status-clean"
          : "status-degraded"
    }`;
    stateBadge.textContent = item.state || "unknown";
    tdState.appendChild(stateBadge);

    tr.appendChild(tdDev);
    tr.appendChild(tdPath);
    tr.appendChild(tdState);
    tbody.appendChild(tr);
  });
}

/**
 * Render Weekly Notification State card.
 */
function renderWeeklyNotificationState(notificationState) {
  const badgeEl = document.getElementById("weekly-state-badge");
  const sentAtEl = document.getElementById("weekly-sent-at");
  const dueAtEl = document.getElementById("weekly-due-at");
  const lastStatusEl = document.getElementById("weekly-last-status");
  const countdownEl = document.getElementById("weekly-countdown");

  if (!notificationState) {
    applyStatusBadge(badgeEl, null, "unknown");
    if (badgeEl) badgeEl.textContent = "NOT RECORDED";
    if (sentAtEl) sentAtEl.textContent = "No weekly summary sent yet";
    if (dueAtEl) dueAtEl.textContent = "Due on next clean/active check";
    if (lastStatusEl) lastStatusEl.textContent = "--";
    if (countdownEl) countdownEl.textContent = "Due immediately on next check";
    return;
  }

  const stateStatus = notificationState.status || "unknown";
  applyStatusBadge(badgeEl, null, stateStatus);

  if (sentAtEl) {
    sentAtEl.textContent =
      notificationState.sent_at_formatted ||
      formatTimestampLocal(notificationState.sent_at);
  }
  if (dueAtEl) {
    dueAtEl.textContent =
      notificationState.due_at_formatted ||
      formatTimestampLocal(notificationState.due_at);
  }
  if (lastStatusEl) {
    lastStatusEl.textContent = stateStatus.toUpperCase();
  }

  if (countdownEl) {
    const dueAtSec = Number(notificationState.due_at);
    const nowSec = Date.now() / 1000;
    const remaining = Math.floor(dueAtSec - nowSec);
    if (!Number.isFinite(dueAtSec) || remaining <= 0) {
      countdownEl.textContent = "Due on the next clean/active RAID check";
    } else {
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor((remaining % 86400) / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      countdownEl.textContent = `${days}d ${hours}h ${minutes}m remaining`;
    }
  }
}

/**
 * Render Notification History table from /api/history?limit=20 payload.
 */
function renderNotificationHistory(historyPayload) {
  const records = Array.isArray(historyPayload)
    ? historyPayload
    : Array.isArray(historyPayload?.history)
      ? historyPayload.history
      : [];

  const countBadge = document.getElementById("history-count-badge");
  if (countBadge) {
    countBadge.textContent = `${records.length} ${records.length === 1 ? "record" : "records"}`;
  }

  const tbody = document.getElementById("notification-history-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (records.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty-state";
    td.textContent = "No notifications recorded yet";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  records.forEach((entry) => {
    const tr = document.createElement("tr");

    // Timestamp
    const tdTime = document.createElement("td");
    tdTime.className = "mono-text";
    tdTime.textContent =
      entry.sent_at_formatted || formatTimestampLocal(entry.sent_at);

    // Kind / Weekly
    const tdKind = document.createElement("td");
    const kindSpan = document.createElement("span");
    const isWeekly = Boolean(entry.weekly) || entry.kind === "weekly summary";
    kindSpan.className = `kind-badge ${isWeekly ? "kind-weekly" : "kind-alert"}`;
    kindSpan.textContent = entry.kind || (isWeekly ? "weekly summary" : "alert");
    tdKind.appendChild(kindSpan);

    // Status
    const tdStatus = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = "status-badge";
    applyStatusBadge(statusBadge, null, entry.status);
    tdStatus.appendChild(statusBadge);

    tr.appendChild(tdTime);
    tr.appendChild(tdKind);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  });
}

/**
 * Show or hide the error banner.
 */
function setErrorState(message) {
  const banner = document.getElementById("error-banner");
  const msgEl = document.getElementById("error-message");
  if (!banner) return;

  if (message) {
    if (msgEl) msgEl.textContent = message;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

/**
 * Fetch both /api/status and /api/history?limit=20 and update the UI.
 */
async function refreshDashboard() {
  if (isFetching) return;
  isFetching = true;

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");

  try {
    const [statusResp, historyResp] = await Promise.all([
      fetch("/api/status", { headers: { Accept: "application/json" } }),
      fetch("/api/history?limit=20", { headers: { Accept: "application/json" } }),
    ]);

    if (!statusResp.ok) {
      throw new Error(`GET /api/status failed with HTTP ${statusResp.status}`);
    }
    if (!historyResp.ok) {
      throw new Error(`GET /api/history failed with HTTP ${historyResp.status}`);
    }

    const statusData = await statusResp.json();
    const historyData = await historyResp.json();

    renderRaidDetails(statusData.raid || statusData);
    renderSystemMetrics(statusData.system || statusData);
    renderWeeklyNotificationState(statusData.notification_state ?? null);
    renderNotificationHistory(historyData);

    setErrorState(null);

    const lastUpdatedEl = document.getElementById("last-updated");
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
  } catch (err) {
    console.error("Dashboard refresh error:", err);
    setErrorState(
      `Failed to refresh dashboard data: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    isFetching = false;
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

/**
 * Initialize listeners and 10-second polling timer.
 */
function initDashboard() {
  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshDashboard();
    });
  }

  refreshDashboard();
  refreshTimerId = window.setInterval(refreshDashboard, AUTO_REFRESH_INTERVAL_MS);
}

document.addEventListener("DOMContentLoaded", initDashboard);
