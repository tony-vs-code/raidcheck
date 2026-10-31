const AUTO_REFRESH_INTERVAL_MS = 10000;
const WS_RECONNECT_DELAY_MS = 3000;
const SESSION_TOKEN_STORAGE_KEY = "systemalerts_session_token";
const VALID_RAID_STATES = new Set([
  "clean",
  "active",
  "degraded",
  "recovering",
  "resyncing",
  "failed",
  "error",
  "unknown",
  "none",
]);

let refreshTimerId = null;
let wsConnection = null;
let wsReconnectTimerId = null;
let localTickerTimerId = null;
let currentBootTime = null;
let currentWeeklyDueAt = null;
let isFetching = false;
let isAuthenticated = false;
let currentGoogleClientId = "";
let currentViewTab = "overview";
let currentDockerSubtab = "stacks";
let dockerStatusCache = null;
let activeLogContainerId = null;
let activeLogContainerName = "";
let logsTimerId = null;
let cachedDockerContainers = [];
let cachedDockerVolumes = [];
let cachedDockerUpdates = null;
let cachedStorageDisks = null;

const MEMORY_HISTORY_LIMIT = 30;
const memoryHistoryBuffer = [];

let isFetchingDockerStatus = false;
let isFetchingDockerStacks = false;
let isFetchingDockerContainers = false;
let isFetchingDockerImages = false;
let isFetchingDockerVolumes = false;
let isFetchingDockerNetworks = false;
let isFetchingDockerUpdates = false;
let isFetchingContainerLogs = false;
let isFetchingUpdateSchedule = false;

let lastDockerSubtabFetchTime = 0;
let dockerSubtabThrottleTimer = null;
const DOCKER_SUBTAB_THROTTLE_MS = 800;

let lastContainersRenderKey = "";
let lastStacksRenderKey = "";
let lastDockerUpdatesRenderKey = "";

/**
 * Retrieve stored session token if present.
 */
function getStoredToken() {
  try {
    return localStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/**
 * Save or clear session token in localStorage.
 */
function setStoredToken(token) {
  try {
    if (token) {
      localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors in restricted browsing modes
  }
}

/**
 * Wrapper around fetch() that attaches session credentials and handles 401 responses.
 */
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  const token = getStoredToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const fetchOptions = {
    ...options,
    headers,
    credentials: "same-origin",
  };

  const response = await fetch(url, fetchOptions);
  if (response.status === 401 && !url.startsWith("/api/auth/")) {
    await handleUnauthorized();
  }
  return response;
}

/**
 * Format raw byte count into human-readable GB/TB string.
 * Supports numbers or pre-formatted strings gracefully.
 */
function formatBytes(bytes) {
  if (typeof bytes === "string" && isNaN(Number(bytes)) && bytes.trim().length > 0) {
    return bytes.trim();
  }
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) {
    return "--";
  }
  if (num === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    Math.floor(Math.log(num) / Math.log(1024)),
    units.length - 1
  );
  const value = num / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

/**
 * Generate ASCII progress bar e.g. [======>     ] for RAID rebuild/sync.
 */
function generateAsciiProgressBar(percent, innerLength = 12) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (p >= 100) {
    return `[${"=".repeat(innerLength)}]`;
  }
  const equalsCount = Math.min(
    innerLength - 1,
    Math.max(0, Math.round((p / 100) * (innerLength - 1)))
  );
  const equals = "=".repeat(equalsCount);
  const spaces = " ".repeat(Math.max(0, innerLength - 1 - equalsCount));
  return `[${equals}>${spaces}]`;
}

/**
 * Extract active RAID sync/rebuild info from sysfs attributes or status.
 */
function getRaidSyncInfo(raid) {
  if (!raid || typeof raid !== "object") return null;

  const rawAction = String(raid.sync_action || "").trim().toLowerCase();
  const statusStr = String(raid.status || "").trim().toLowerCase();
  const checkStatus = String(raid.check_status || "").trim().toLowerCase();

  const isSyncing =
    ["resync", "recover", "recovering", "check", "checking", "repair", "syncing"].includes(rawAction) ||
    ["recovering", "resyncing"].includes(statusStr) ||
    checkStatus.includes("sync") ||
    checkStatus.includes("recover") ||
    checkStatus.includes("check");

  let percent = null;
  if (raid.sync_percent !== undefined && raid.sync_percent !== null && raid.sync_percent !== "") {
    const p = parseFloat(String(raid.sync_percent).replace("%", ""));
    if (Number.isFinite(p)) percent = Math.max(0, Math.min(100, p));
  } else if (raid.sync_completed !== undefined && raid.sync_completed !== null) {
    if (typeof raid.sync_completed === "string" && raid.sync_completed.includes("/")) {
      const parts = raid.sync_completed.split("/").map((s) => parseFloat(s.trim()));
      if (parts.length === 2 && parts[1] > 0) {
        percent = Math.max(0, Math.min(100, (parts[0] / parts[1]) * 100));
      }
    } else if (Number.isFinite(Number(raid.sync_completed))) {
      percent = parseFloat(raid.sync_completed);
    }
  }

  if (percent === null) {
    const combined = `${checkStatus} ${statusStr} ${String(raid.full_state || "")}`;
    const match = combined.match(/(\d+(?:\.\d+)?)%/);
    if (match) {
      percent = parseFloat(match[1]);
    }
  }

  if (!isSyncing && (percent === null || percent <= 0)) {
    return null;
  }

  let actionName = "Resyncing";
  if (rawAction.includes("recover") || statusStr.includes("recover") || checkStatus.includes("recover")) {
    actionName = "Recovering";
  } else if (rawAction.includes("check") || statusStr.includes("check") || checkStatus.includes("check")) {
    actionName = "Checking";
  } else if (rawAction.includes("repair") || checkStatus.includes("repair")) {
    actionName = "Repairing";
  } else if (rawAction.includes("sync") || statusStr.includes("sync") || checkStatus.includes("sync")) {
    actionName = "Resyncing";
  }

  return {
    action: actionName,
    percent: percent !== null ? percent : 0,
    speed: raid.sync_speed || null,
    eta: raid.sync_eta || null,
  };
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

const TIMEZONE_STORAGE_KEY = "systemalerts_user_timezone";

function getStoredTimezone() {
  try {
    return localStorage.getItem(TIMEZONE_STORAGE_KEY) || "auto";
  } catch {
    return "auto";
  }
}

function setStoredTimezone(tz) {
  try {
    if (tz) {
      localStorage.setItem(TIMEZONE_STORAGE_KEY, tz);
    } else {
      localStorage.removeItem(TIMEZONE_STORAGE_KEY);
    }
  } catch {}
}

function getEffectiveTimezone() {
  const stored = getStoredTimezone();
  if (!stored || stored === "auto") {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }
  return stored;
}

/**
 * Centralized date/time formatter that formats timestamps across the dashboard
 * according to the configured timezone.
 */
function formatDateTime(val, options = {}) {
  if (val === null || val === undefined || val === "" || val === 0) {
    return "--";
  }
  let date = null;
  if (val instanceof Date) {
    date = val;
  } else if (typeof val === "number" || (!isNaN(val) && !String(val).includes("-") && !String(val).includes("T") && !String(val).includes(":"))) {
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0) return "--";
    date = new Date(num > 1e11 ? num : num * 1000);
  } else if (typeof val === "string") {
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) {
      date = new Date(parsed);
    } else {
      return val;
    }
  }

  if (!date || isNaN(date.getTime())) {
    return String(val || "--");
  }

  const tz = getEffectiveTimezone();
  try {
    const defaultOptions = {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    };
    return new Intl.DateTimeFormat(undefined, { ...defaultOptions, ...options }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function formatTimeOnly(val) {
  return formatDateTime(val, {
    year: undefined,
    month: undefined,
    day: undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Format unix timestamp seconds into local date-time string.
 */
function formatTimestampLocal(unixSeconds) {
  return formatDateTime(unixSeconds);
}

/**
 * Format timestamp into human-readable relative time (e.g. "just now", "5 mins ago", "2 hrs ago", "yesterday").
 */
function formatRelativeTime(val) {
  if (!val) return "--";
  let date = null;
  if (val instanceof Date) {
    date = val;
  } else if (typeof val === "number") {
    date = new Date(val > 1e11 ? val : val * 1000);
  } else if (typeof val === "string") {
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) {
      date = new Date(parsed);
    }
  }

  if (!date || isNaN(date.getTime())) {
    return String(val);
  }

  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1 min ago";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mins ago`;
  if (diffSec < 7200) return "1 hr ago";
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hrs ago`;
  if (diffSec < 172800) return "yesterday";
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days} days ago`;
  return formatDateTime(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

  const label = state === "none" ? "NO RAID" : state.toUpperCase();
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
 * Render rolling historical SVG trend line & area chart for memory usage.
 */
function renderMemoryHistoryChart(history) {
  const chartEl = document.getElementById("memory-history-chart");
  if (!chartEl) return;
  if (!Array.isArray(history) || history.length === 0) return;

  const width = 240;
  const height = 44;
  const padTop = 3;
  const padBottom = 3;
  const usableHeight = height - padTop - padBottom;
  const n = history.length;

  const points = history.map((val, idx) => {
    const x = n > 1 ? (idx / (n - 1)) * width : width;
    const clamped = Math.max(0, Math.min(100, Number(val) || 0));
    const y = height - padBottom - (clamped / 100) * usableHeight;
    return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
  });

  const pathLine = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const firstP = points[0];
  const lastP = points[points.length - 1];
  const pathArea = `${pathLine} L ${lastP.x} ${height} L ${firstP.x} ${height} Z`;

  const areaEl = document.getElementById("memory-chart-area");
  const lineEl = document.getElementById("memory-chart-line");
  if (areaEl && lineEl) {
    areaEl.setAttribute("d", pathArea);
    lineEl.setAttribute("d", pathLine);
  }
}

/**
 * Render Storage Volumes & Filesystems table on #view-raid.
 * Populates from system.disks or falls back to /api/system/storage.
 */
async function renderStorageMounts(disks) {
  const tbody = document.getElementById("storage-mounts-tbody");
  if (!tbody) return;

  if (Array.isArray(disks) && disks.length > 0) {
    cachedStorageDisks = disks;
  } else if (!cachedStorageDisks) {
    try {
      const resp = await apiFetch("/api/system/storage");
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.disks) && data.disks.length > 0) {
          cachedStorageDisks = data.disks;
          disks = data.disks;
        }
      }
    } catch (err) {
      console.debug("Failed to fetch storage mounts fallback:", err);
    }
  } else {
    disks = cachedStorageDisks;
  }

  const countBadge = document.getElementById("storage-mounts-count-badge");
  if (!disks || !Array.isArray(disks) || disks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No storage volumes detected.</td></tr>`;
    if (countBadge) countBadge.textContent = "0 volumes";
    return;
  }

  if (countBadge) {
    countBadge.textContent = `${disks.length} ${disks.length === 1 ? "volume" : "volumes"}`;
  }

  tbody.innerHTML = disks
    .map((d) => {
      const percent = Math.max(0, Math.min(100, Number(d.percent) || 0));
      let barClass = "progress-fill";
      if (percent >= 90) barClass += " danger";
      else if (percent >= 75) barClass += " warn";

      const usedFormatted = formatBytes(d.used);
      const totalFormatted = formatBytes(d.total);
      const freeFormatted = formatBytes(d.free);

      return `
      <tr>
        <td><strong class="mono-text">${escapeHtml(d.device || "-")}</strong></td>
        <td><span class="mono-text mount-point">${escapeHtml(d.mountpoint || "-")}</span></td>
        <td><span class="kind-badge kind-network">${escapeHtml(d.fstype || "-")}</span></td>
        <td>
          <div class="storage-usage-cell">
            <div class="progress-track">
              <div class="${barClass}" style="width: ${percent.toFixed(1)}%"></div>
            </div>
            <span class="mono-text storage-usage-val">${percent.toFixed(1)}%</span>
          </div>
        </td>
        <td class="mono-text storage-capacity-cell">${usedFormatted} / ${totalFormatted} <span class="text-muted">(${freeFormatted} free)</span></td>
        <td><span class="mono-text opts-text" title="${escapeHtml(d.opts || "")}">${escapeHtml(d.opts || "-")}</span></td>
      </tr>
    `;
    })
    .join("");
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

  // CPU Cores Badge and Load Average
  const cpuCoresBadge = document.getElementById("cpu-cores-badge");
  if (cpuCoresBadge) {
    const logicalCores =
      system.cpu_count_logical ||
      (Array.isArray(system.cpu_cores) ? system.cpu_cores.length : 1);
    cpuCoresBadge.textContent = `${logicalCores} ${logicalCores === 1 ? "Core" : "Cores"}`;
  }

  const cpuLoadEl = document.getElementById("cpu-load-detail");
  if (cpuLoadEl) {
    if (Array.isArray(system.load_avg) && system.load_avg.length > 0) {
      cpuLoadEl.textContent = `Load avg: ${system.load_avg.map((v) => Number(v).toFixed(2)).join(", ")}`;
    } else {
      cpuLoadEl.textContent = "Load avg: --";
    }
  }

  // CPU per-core drilldown grid
  const coresGrid = document.getElementById("cpu-cores-grid");
  if (coresGrid) {
    const cores =
      Array.isArray(system.cpu_cores) && system.cpu_cores.length > 0
        ? system.cpu_cores
        : [cpuPercent];

    coresGrid.innerHTML = cores
      .map((coreVal, idx) => {
        const cPercent = Math.max(0, Math.min(100, Number(coreVal) || 0));
        let barClass = "progress-fill";
        if (cPercent >= 90) barClass += " danger";
        else if (cPercent >= 75) barClass += " warn";

        return `
        <div class="cpu-core-item">
          <div class="cpu-core-header">
            <span class="cpu-core-label">Core ${idx}</span>
            <span class="cpu-core-percent mono-text">${cPercent.toFixed(1)}%</span>
          </div>
          <div class="progress-track cpu-core-track">
            <div class="${barClass}" style="width: ${cPercent.toFixed(1)}%"></div>
          </div>
        </div>
      `;
      })
      .join("");
  }

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

  // Memory breakdown chips
  const chipUsed = document.getElementById("memory-chip-used");
  const chipCached = document.getElementById("memory-chip-cached");
  const chipFree = document.getElementById("memory-chip-free");
  if (chipUsed) chipUsed.textContent = `Used: ${formatBytes(mem.used)}`;
  if (chipCached) chipCached.textContent = `Cached: ${formatBytes(mem.cached || 0)}`;
  if (chipFree) chipFree.textContent = `Free: ${formatBytes(mem.free || 0)}`;

  // Memory rolling historical trend chart
  memoryHistoryBuffer.push(memPercent);
  if (memoryHistoryBuffer.length > MEMORY_HISTORY_LIMIT) {
    memoryHistoryBuffer.shift();
  }
  renderMemoryHistoryChart(memoryHistoryBuffer);

  // Disk / Direct Storage (POSIX statvfs / psutil)
  const disk = system.disk || system.storage || {};
  const diskPercent = Number(disk.percent ?? disk.percentage) || 0;
  const diskValEl = document.getElementById("disk-percent-value");
  const diskBarEl = document.getElementById("disk-progress-bar");
  const diskDetailEl = document.getElementById("disk-detail");
  if (diskValEl) diskValEl.textContent = `${diskPercent.toFixed(1)}%`;
  updateProgressBar(diskBarEl, diskPercent);
  if (diskDetailEl) {
    const usedFormatted = formatBytes(disk.used ?? disk.used_bytes);
    const totalFormatted = formatBytes(disk.total ?? disk.total_bytes);
    const freeFormatted = formatBytes(disk.free ?? disk.free_bytes ?? disk.available);
    const mountLabel = disk.mount || disk.mount_path || disk.path;
    const prefix = mountLabel ? `[${mountLabel}] ` : "";
    diskDetailEl.textContent = `${prefix}${usedFormatted} / ${totalFormatted} (${freeFormatted} free)`;
  }

  // Uptime & Host Platform Telemetry
  if (system.boot_time) {
    currentBootTime = system.boot_time;
  }
  const uptimeValEl = document.getElementById("uptime-value");
  const bootDetailEl = document.getElementById("boot-time-detail");
  if (uptimeValEl) {
    uptimeValEl.textContent = formatUptimeFromBoot(system.boot_time);
  }
  if (bootDetailEl) {
    bootDetailEl.textContent = `Booted: ${formatTimestampLocal(system.boot_time)}`;
  }
  const uptimeLoadBadge = document.getElementById("uptime-load-badge");
  if (uptimeLoadBadge) {
    if (Array.isArray(system.load_avg) && system.load_avg.length > 0) {
      uptimeLoadBadge.textContent = `Load: ${system.load_avg.map((v) => Number(v).toFixed(2)).join(", ")}`;
      uptimeLoadBadge.style.display = "";
    } else {
      uptimeLoadBadge.textContent = "Load: --";
    }
  }

  const hostOsEl = document.getElementById("host-os-detail");
  if (hostOsEl) {
    hostOsEl.textContent = system.os_distro || system.platform || "Linux";
  }
  const hostKernelEl = document.getElementById("host-kernel-detail");
  if (hostKernelEl) {
    hostKernelEl.textContent = system.kernel || "--";
  }

  // Network Telemetry
  const net = system.network || {};
  const ifaces = Array.isArray(net.interfaces) ? net.interfaces : [];
  const primaryIface =
    ifaces.find((i) => i.is_up && i.ip) ||
    ifaces.find((i) => i.is_up) ||
    ifaces[0] ||
    {};

  const ifaceNameEl = document.getElementById("host-network-interface");
  if (ifaceNameEl) {
    ifaceNameEl.textContent = primaryIface.interface || (ifaces.length > 0 ? ifaces[0].interface : "--");
  }

  const ifaceIpEl = document.getElementById("host-network-ip");
  if (ifaceIpEl) {
    ifaceIpEl.textContent = primaryIface.ip || (primaryIface.interface ? "No IPv4" : "--");
  }

  const netRxEl = document.getElementById("host-network-rx");
  if (netRxEl) {
    const rxBytes = Number(net.total_bytes_recv ?? primaryIface.bytes_recv) || 0;
    netRxEl.textContent = formatBytes(rxBytes);
  }

  const netTxEl = document.getElementById("host-network-tx");
  if (netTxEl) {
    const txBytes = Number(net.total_bytes_sent ?? primaryIface.bytes_sent) || 0;
    netTxEl.textContent = formatBytes(txBytes);
  }

  const netStatusEl = document.getElementById("host-network-status");
  if (netStatusEl) {
    const isOnline = ifaces.some((i) => i.is_up) || (Number(net.total_bytes_recv) > 0);
    netStatusEl.textContent = isOnline ? "CONNECTED" : "DISCONNECTED";
    netStatusEl.className = `status-badge ${isOnline ? "status-ok" : "status-failed"}`;
  }

  // Mounted Storage Volumes Mini-List on Overview Card 3 (if present and visible)
  const mountsListEl = document.getElementById("overview-mounts-list");
  if (mountsListEl && !mountsListEl.classList.contains("hidden")) {
    const disks = Array.isArray(system.disks) ? system.disks : (Array.isArray(system.filesystems) ? system.filesystems : []);
    if (disks.length > 0) {
      mountsListEl.innerHTML = disks.map((d) => {
        const pct = Math.max(0, Math.min(100, Number(d.percent) || 0));
        let barClass = "progress-fill";
        if (pct >= 90) barClass += " danger";
        else if (pct >= 75) barClass += " warn";
        return `
          <div class="overview-mount-item">
            <div class="mount-item-row">
              <span class="mount-point-name mono-text">${escapeHtml(d.mountpoint || "/")}</span>
              <span class="mount-fs-type">${escapeHtml(d.fstype || "ext4")}</span>
              <span class="mount-usage-subtext mono-text">${pct.toFixed(1)}% (${formatBytes(d.used)} / ${formatBytes(d.total)})</span>
            </div>
            <div class="progress-track" style="height: 4px;">
              <div class="${barClass}" style="width: ${pct.toFixed(1)}%"></div>
            </div>
          </div>
        `;
      }).join("");
    } else {
      mountsListEl.innerHTML = `<div class="empty-state-mini">No additional mounted volumes.</div>`;
    }
  }

  // Storage Volumes breakdown table on #view-raid
  if (Array.isArray(system.disks) && system.disks.length > 0) {
    cachedStorageDisks = system.disks;
    renderStorageMounts(system.disks);
  }

  // Services Ribbon Summary
  if (system.services_summary) {
    renderServicesSummary(system.services_summary);
  }

  // Packages & Reboot Summary
  if (system.reboot_status) {
    renderPackagesOverviewRibbon(system.reboot_status, cachedPackageUpdates);
  }
}

/**
 * Render RAID Array Details card and Active Disks table.
 */
function renderRaidDetails(raid) {
  if (!raid) return;

  const status = raid.status || "unknown";
  const isNoRaid = normalizeRaidState(status) === "none";

  // Header & Card badges
  const raidStatusBadge = document.getElementById("raid-status-badge");
  if (raidStatusBadge) {
    applyStatusBadge(
      raidStatusBadge,
      document.getElementById("raid-status-text"),
      status
    );
  }
  applyStatusBadge(document.getElementById("raid-card-badge"), null, status);

  // Live Sysfs RAID Rebuild & Sync Progress Bar
  const syncInfo = getRaidSyncInfo(raid);
  const syncContainer = document.getElementById("raid-sync-container");
  const syncLabel = document.getElementById("raid-sync-label");
  const syncFill = document.getElementById("raid-sync-progress-fill");
  const syncEta = document.getElementById("raid-sync-eta");

  if (syncContainer) {
    if (syncInfo && !isNoRaid) {
      syncContainer.classList.remove("hidden");
      const asciiBar = generateAsciiProgressBar(syncInfo.percent, 12);
      if (syncLabel) {
        syncLabel.textContent = `${syncInfo.action}: ${syncInfo.percent.toFixed(1)}% ${asciiBar}`;
      }
      if (syncFill) {
        syncFill.style.width = `${syncInfo.percent.toFixed(1)}%`;
      }
      if (syncEta) {
        let etaText = "";
        if (syncInfo.speed) etaText += `${syncInfo.speed} `;
        if (syncInfo.eta) etaText += `(ETA: ${syncInfo.eta})`;
        syncEta.textContent = etaText.trim();
      }
    } else {
      syncContainer.classList.add("hidden");
    }
  }

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

  if (isNoRaid) {
    setField("raid-device", "No RAID array detected");
    setField("raid-level", "--");
    setField("raid-array-size", "--");
    setField("raid-devices-summary", "--");
    setField("raid-storage-info", "--");
    setField("raid-check-status", "--");
    setField("raid-full-state", "No RAID array detected");
    setField("raid-persistence", "--");
    setField("raid-uuid", "--");
    setField("raid-update-time", "--");
    setField("raid-layout-chunk", "--");
    setField("raid-consistency-events", "--");
  } else {
    setField("raid-device", raid.raid_device);
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
  }

  // Active Disks table
  const devices = Array.isArray(raid.devices) ? raid.devices : [];
  const disksBadge = document.getElementById("disks-count-badge");
  if (disksBadge) {
    disksBadge.textContent = `${devices.length} ${devices.length === 1 ? "disk" : "disks"}`;
  }

  const tbody = document.getElementById("active-disks-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (isNoRaid || devices.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty-state";
    td.textContent = isNoRaid
      ? "No RAID array configured or detected on this host"
      : "No active member disks detected";
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

  // Overview summary card
  const overviewRaidBadge = document.getElementById("overview-raid-status-badge");
  if (overviewRaidBadge) {
    applyStatusBadge(overviewRaidBadge, null, status);
  }
  const overviewRaidSummary = document.getElementById("overview-raid-summary");
  if (overviewRaidSummary) {
    if (isNoRaid) {
      overviewRaidSummary.textContent = "No RAID array configured or detected";
    } else {
      const level = (raid.raid_level || "RAID").toUpperCase();
      const size = raid.array_size || "--";
      const act = raid.active_devices ?? 0;
      const tot = raid.working_devices ?? act;
      overviewRaidSummary.textContent = `${level} • ${size} • ${act}/${tot} disks active`;
    }
  }
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
    currentWeeklyDueAt = null;
    applyStatusBadge(badgeEl, null, "unknown");
    if (badgeEl) badgeEl.textContent = "NOT RECORDED";
    if (sentAtEl) sentAtEl.textContent = "No weekly summary sent yet";
    if (dueAtEl) dueAtEl.textContent = "Due on next clean/active check";
    if (lastStatusEl) lastStatusEl.textContent = "--";
    if (countdownEl) countdownEl.textContent = "Due immediately on next check";
    return;
  }

  currentWeeklyDueAt =
    notificationState.due_at !== undefined && notificationState.due_at !== null
      ? Number(notificationState.due_at)
      : null;

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

    // Kind / Weekly / Test
    const tdKind = document.createElement("td");
    const kindSpan = document.createElement("span");
    const isWeekly = Boolean(entry.weekly) || entry.kind === "weekly summary";
    const isTest = entry.kind === "test notification" || entry.status === "test";

    let badgeClass = "kind-alert";
    if (isTest) {
      badgeClass = "kind-test";
    } else if (isWeekly) {
      badgeClass = "kind-weekly";
    }

    kindSpan.className = `kind-badge ${badgeClass}`;
    kindSpan.textContent =
      entry.kind ||
      (isTest ? "test notification" : (isWeekly ? "weekly summary" : "alert"));
    tdKind.appendChild(kindSpan);

    // Status
    const tdStatus = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = "status-badge";
    if (entry.status === "test") {
      statusBadge.classList.add("status-test");
      statusBadge.textContent = "TEST";
    } else {
      applyStatusBadge(statusBadge, null, entry.status);
    }
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
 * Update the header version badge.
 */
function updateVersionBadge(versionInfo) {
  if (!versionInfo) return;
  const badge = document.getElementById("version-badge");
  if (!badge) return;

  const ver =
    versionInfo.current_version ||
    versionInfo.version ||
    badge.textContent ||
    "v0.1.0";
  const formattedVer = String(ver).startsWith("v") ? ver : `v${ver}`;
  const commit = versionInfo.current_commit || versionInfo.commit || "";
  badge.textContent = commit ? `${formattedVer} (${commit})` : formattedVer;
}

/**
 * Fetch both /api/status and /api/history?limit=20 and update the UI.
 */
async function refreshDashboard() {
  if (isFetching || !isAuthenticated) return;
  isFetching = true;

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");

  try {
    const [statusResp, historyResp] = await Promise.all([
      apiFetch("/api/status"),
      apiFetch("/api/history?limit=20"),
    ]);

    if (statusResp.status === 401 || historyResp.status === 401) {
      return;
    }

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

    setModuleLastUpdated("system");
    setModuleLastUpdated("raid");
    setModuleLastUpdated("notifications");

    if (statusData.raid) {
      const raidStatus = String(statusData.raid.status || "").toLowerCase();
      updateRaidAdaptiveBadge(
        ["recovering", "resyncing", "degraded"].includes(raidStatus)
      );
    }
    if (statusData.refresh_intervals) {
      syncIntervalSelects(statusData.refresh_intervals);
    }

    if (statusData.version || statusData.version_info) {
      updateVersionBadge(statusData.version_info || statusData.version);
    }

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

/* =========================================================================
 * 1. Authentication Gate (#auth-overlay)
 * ========================================================================= */

function showAuthError(message) {
  const errEl = document.getElementById("auth-error");
  if (!errEl) return;
  if (message) {
    errEl.textContent = message;
    errEl.classList.remove("hidden");
  } else {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }
}

function stopPolling() {
  if (refreshTimerId) {
    window.clearInterval(refreshTimerId);
    refreshTimerId = null;
  }
}

function startPolling({ immediate = true } = {}) {
  stopPolling();
  if (immediate) {
    refreshDashboard();
  }
  refreshTimerId = window.setInterval(refreshDashboard, AUTO_REFRESH_INTERVAL_MS);
}

/**
 * Update #auto-refresh-indicator and #live-stream-indicator to reflect WebSocket / stream state.
 */
function updateConnectionIndicator(state) {
  const indicator = document.getElementById("auto-refresh-indicator");
  const streamIndicator = document.getElementById("live-stream-indicator");
  const streamText = document.getElementById("live-stream-text");

  if (indicator) {
    indicator.classList.remove("ws-live", "ws-reconnecting");
    if (state === "live") {
      indicator.textContent = "LIVE (WebSocket)";
      indicator.classList.add("ws-live");
    } else if (state === "reconnecting") {
      indicator.textContent = "Reconnecting...";
      indicator.classList.add("ws-reconnecting");
    } else {
      indicator.textContent = "Auto-refresh: 10s";
    }
  }

  if (streamIndicator) {
    streamIndicator.classList.remove("stream-active", "stream-reconnecting", "stream-paused");
    if (state === "live") {
      streamIndicator.classList.add("stream-active");
      if (streamText) streamText.textContent = "Stream: Active";
      streamIndicator.setAttribute("title", "Direct system event streaming active (POSIX statvfs, sysfs RAID, Docker socket)");
    } else if (state === "reconnecting") {
      streamIndicator.classList.add("stream-reconnecting");
      if (streamText) streamText.textContent = "Stream: Reconnecting";
      streamIndicator.setAttribute("title", "Reconnecting to direct system event stream...");
    } else {
      streamIndicator.classList.add("stream-paused");
      if (streamText) streamText.textContent = "Stream: Polling";
      streamIndicator.setAttribute("title", "HTTP fallback polling mode");
    }
  }
}

/**
 * Cleanly close the active WebSocket connection and cancel pending reconnect timers.
 */
function closeWebSocket() {
  if (wsReconnectTimerId) {
    window.clearTimeout(wsReconnectTimerId);
    wsReconnectTimerId = null;
  }
  if (wsConnection) {
    wsConnection.onopen = null;
    wsConnection.onmessage = null;
    wsConnection.onerror = null;
    wsConnection.onclose = null;
    try {
      wsConnection.close();
    } catch {
      // Ignore close errors
    }
    wsConnection = null;
  }
}

/**
 * Set the last-updated label for a specific module and stop button loading state.
 */
function setModuleLastUpdated(moduleName) {
  const el = document.getElementById(`${moduleName}-last-updated`);
  if (el) {
    el.textContent = `Updated ${formatTimeOnly(new Date())}`;
  }
  const btn = document.getElementById(`refresh-${moduleName}-btn`);
  if (btn) {
    btn.classList.remove("loading");
  }
}

/**
 * Toggle the RAID rebuild boost indicator badge.
 */
function updateRaidAdaptiveBadge(isAdaptive) {
  const badge = document.getElementById("raid-adaptive-badge");
  if (badge) {
    badge.classList.toggle("hidden", !isAdaptive);
  }
}

/**
 * Sync the per-module interval <select> dropdowns from server settings.
 */
function syncIntervalSelects(intervals) {
  if (!intervals || typeof intervals !== "object") return;
  const sysEl = document.getElementById("system-interval-select");
  const raidEl = document.getElementById("raid-interval-select");
  const notifEl = document.getElementById("notifications-interval-select");
  const dockerEl = document.getElementById("docker-interval-select");

  if (sysEl && intervals.system !== undefined && intervals.system !== null) {
    sysEl.value = String(intervals.system);
  }
  if (raidEl && intervals.raid !== undefined && intervals.raid !== null) {
    raidEl.value = String(intervals.raid);
  }
  if (
    notifEl &&
    intervals.notifications !== undefined &&
    intervals.notifications !== null
  ) {
    notifEl.value = String(intervals.notifications);
  }
  if (
    dockerEl &&
    intervals.docker !== undefined &&
    intervals.docker !== null
  ) {
    dockerEl.value = String(intervals.docker);
  }
}

/**
 * Send updated refresh intervals over WebSocket or fall back to /api/settings.
 */
async function handleIntervalChange() {
  const sysVal = Number(
    document.getElementById("system-interval-select")?.value ?? 1
  );
  const raidVal = Number(
    document.getElementById("raid-interval-select")?.value ?? 15
  );
  const notifVal = Number(
    document.getElementById("notifications-interval-select")?.value ?? 60
  );
  const dockerVal = Number(
    document.getElementById("docker-interval-select")?.value ?? 5
  );

  const intervals = {
    system: sysVal,
    raid: raidVal,
    notifications: notifVal,
    docker: dockerVal,
  };

  if (
    wsConnection &&
    typeof window.WebSocket === "function" &&
    wsConnection.readyState === window.WebSocket.OPEN
  ) {
    try {
      wsConnection.send(
        JSON.stringify({ action: "set_intervals", intervals })
      );
      return;
    } catch (err) {
      console.error("Failed to send set_intervals over WebSocket:", err);
    }
  }

  // Fall back to POST /api/settings if WebSocket is closed
  try {
    await apiFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_system_sec: sysVal,
        refresh_raid_sec: raidVal,
        refresh_notifications_sec: notifVal,
        refresh_docker_sec: dockerVal,
      }),
    });
  } catch (err) {
    console.error("Failed to save intervals via /api/settings:", err);
  }
}

/**
 * Request an instant refresh for a specific module over WebSocket or HTTP.
 */
function requestModuleRefresh(moduleName) {
  const btn = document.getElementById(`refresh-${moduleName}-btn`);
  if (btn) btn.classList.add("loading");

  if (
    wsConnection &&
    typeof window.WebSocket === "function" &&
    wsConnection.readyState === window.WebSocket.OPEN
  ) {
    try {
      wsConnection.send(
        JSON.stringify({ action: "refresh_module", module: moduleName })
      );
      if (moduleName === "docker" && currentViewTab === "containers") {
        refreshDockerSubtab(currentDockerSubtab);
      }
      return;
    } catch {
      // Fall back below
    }
  }

  if (moduleName === "docker") {
    fetchDockerStatus();
    if (currentViewTab === "containers") {
      refreshDockerSubtab(currentDockerSubtab);
    }
  } else {
    refreshDashboard();
  }
}

/**
 * Request instant Docker module refresh over WebSocket or HTTP.
 */
function requestDockerRefresh() {
  requestModuleRefresh("docker");
}

/**
 * 1-second UI ticker to keep uptime and weekly countdown ticking smoothly.
 */
function updateLiveTickers() {
  if (currentBootTime) {
    const uptimeValEl = document.getElementById("uptime-value");
    if (uptimeValEl) {
      uptimeValEl.textContent = formatUptimeFromBoot(currentBootTime);
    }
  }
  if (currentWeeklyDueAt !== null && currentWeeklyDueAt !== undefined) {
    const countdownEl = document.getElementById("weekly-countdown");
    if (countdownEl) {
      const nowSec = Date.now() / 1000;
      const remaining = Math.floor(currentWeeklyDueAt - nowSec);
      if (!Number.isFinite(currentWeeklyDueAt) || remaining <= 0) {
        countdownEl.textContent = "Due on the next clean/active RAID check";
      } else {
        const days = Math.floor(remaining / 86400);
        const hours = Math.floor((remaining % 86400) / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        countdownEl.textContent = `${days}d ${hours}h ${minutes}m remaining`;
      }
    }
  }
}

/**
 * Show a subtle, non-intrusive toast notification.
 */
function showToast(options, legacyType = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  let title = "Notification";
  let message = "";
  let type = "info";
  let duration = 4500;

  if (typeof options === "string") {
    message = options;
    type = legacyType === "error" ? "danger" : legacyType;
    title = type === "danger" ? "Error" : (type === "success" ? "Success" : "Notice");
  } else if (options && typeof options === "object") {
    title = options.title || "Notification";
    message = options.message || "";
    type = options.type || "info";
    duration = options.duration || 4500;
  }

  while (container.children.length >= 4) {
    const oldest = container.firstChild;
    if (oldest) oldest.remove();
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "alert");

  let iconSvg = "";
  if (type === "success") {
    iconSvg = `<svg viewBox="0 0 24 24" class="toast-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
  } else if (type === "danger") {
    iconSvg = `<svg viewBox="0 0 24 24" class="toast-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  } else if (type === "warning") {
    iconSvg = `<svg viewBox="0 0 24 24" class="toast-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
  } else {
    iconSvg = `<svg viewBox="0 0 24 24" class="toast-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }

  const safeTitle = escapeHtml(title || "Docker Event");
  const safeMessage = escapeHtml(message || "");

  toast.innerHTML = `
    ${iconSvg}
    <div class="toast-content">
      <div class="toast-title">${safeTitle}</div>
      <div class="toast-message">${safeMessage}</div>
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss notification">&times;</button>
  `;

  const closeBtn = toast.querySelector(".toast-close");
  const dismiss = () => {
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-hiding");
    window.setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 260);
  };

  if (closeBtn) closeBtn.addEventListener("click", dismiss);

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("toast-visible");
  });

  if (duration > 0) {
    window.setTimeout(dismiss, duration);
  }
}

/**
 * Trigger visual pulse on Docker container table and highlight specific container row.
 */
function pulseContainerTable(targetId) {
  const table = document.getElementById("docker-containers-table");
  if (table) {
    table.classList.remove("table-pulse");
    void table.offsetWidth; // force reflow
    table.classList.add("table-pulse");
    window.setTimeout(() => {
      table.classList.remove("table-pulse");
    }, 1000);
  }

  if (targetId) {
    const tbody = document.getElementById("docker-containers-tbody");
    if (tbody) {
      const rows = tbody.querySelectorAll("tr");
      rows.forEach((row) => {
        if (row.textContent.includes(targetId)) {
          row.classList.remove("row-highlight");
          void row.offsetWidth;
          row.classList.add("row-highlight");
          window.setTimeout(() => {
            row.classList.remove("row-highlight");
          }, 2000);
        }
      });
    }
  }
}

/**
 * Handle incoming real-time Docker events stream.
 */
function handleDockerEvent(msg) {
  if (!msg || typeof msg !== "object") return;

  const event = msg.event || msg;
  const actionRaw = String(
    event.action || event.Action || event.status || msg.action || msg.status || ""
  ).trim();
  const action = actionRaw.toLowerCase();

  const actor = event.Actor || event.actor || msg.actor || {};
  const attrs = actor.Attributes || actor.attributes || {};
  const containerName =
    attrs.name ||
    event.container_name ||
    event.container ||
    event.name ||
    msg.container_name ||
    msg.name ||
    "Container";
  const containerId =
    actor.ID ||
    event.container_id ||
    event.id ||
    msg.container_id ||
    msg.id ||
    "";

  let toastType = "info";
  let title = `Container Event`;
  let message = `${containerName}: ${actionRaw || "state updated"}`;

  if (action === "die" || action === "kill" || action === "stop") {
    toastType = "danger";
    title = `Container Stopped`;
    message = `${containerName} (${actionRaw})`;
  } else if (action === "start") {
    toastType = "success";
    title = `Container Started`;
    message = `${containerName} is now running`;
  } else if (action === "restart") {
    toastType = "warning";
    title = `Container Restarted`;
    message = `${containerName} was restarted`;
  } else if (action.includes("unhealthy")) {
    toastType = "danger";
    title = `Container Unhealthy`;
    message = `${containerName} became unhealthy!`;
  } else if (action.includes("healthy")) {
    toastType = "success";
    title = `Container Healthy`;
    message = `${containerName} reported healthy`;
  } else if (action === "destroy" || action === "delete") {
    toastType = "warning";
    title = `Container Removed`;
    message = `${containerName} was deleted`;
  } else if (action === "create") {
    toastType = "info";
    title = `Container Created`;
    message = `${containerName} was created`;
  }

  showToast({ title, message, type: toastType });

  pulseContainerTable(containerId);

  // Invalidate containers render cache & refresh containers table in real-time
  lastContainersRenderKey = null;
  if (typeof fetchDockerContainers === "function") {
    fetchDockerContainers(containerId);
  }
  if (typeof fetchDockerStatus === "function") {
    fetchDockerStatus();
  }
}

/**
 * Process incoming JSON messages from /api/ws ('snapshot' or 'module_update').
 */
function handleWebSocketMessage(rawData) {
  let msg;
  try {
    msg = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
  } catch (err) {
    console.error("Invalid WebSocket JSON payload:", err);
    return;
  }
  if (!msg || typeof msg !== "object") return;

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) refreshBtn.classList.remove("loading");

  if (msg.type === "intervals_updated" || msg.refresh_intervals) {
    syncIntervalSelects(msg.refresh_intervals);
  }

  // Real-time Docker Events Toast & Live Table Update
  if (msg.type === "docker_event" || msg.docker_event) {
    handleDockerEvent(msg.docker_event || msg);
    return;
  }
  if (
    (msg.module === "docker" || msg.module === "containers") &&
    (msg.action || msg.event || msg.type === "event")
  ) {
    handleDockerEvent(msg);
    return;
  }

  if (msg.type === "module_update") {
    if (msg.system || msg.module === "system") {
      renderSystemMetrics(msg.system);
      setModuleLastUpdated("system");
    }
    if (msg.raid || msg.module === "raid") {
      renderRaidDetails(msg.raid);
      setModuleLastUpdated("raid");
      const isAdaptive =
        Boolean(msg.adaptive_fast) ||
        (msg.raid &&
          ["recovering", "resyncing", "degraded"].includes(
            String(msg.raid.status || "").toLowerCase()
          ));
      updateRaidAdaptiveBadge(isAdaptive);
    }
    if (
      "notification_state" in msg ||
      msg.history ||
      msg.module === "notifications"
    ) {
      if ("notification_state" in msg) {
        renderWeeklyNotificationState(msg.notification_state ?? null);
      }
      if (msg.history) {
        renderNotificationHistory(msg.history);
      }
      setModuleLastUpdated("notifications");
    }
    if (msg.version || msg.version_info) {
      updateVersionBadge(msg.version_info || msg.version);
    }
    if (msg.docker || msg.module === "docker" || msg.module === "containers") {
      if (msg.event || msg.action) {
        handleDockerEvent(msg);
      }
      renderDockerStatus(msg.docker || msg);
      setModuleLastUpdated("docker");
      if (currentViewTab === "containers") {
        throttledRefreshDockerSubtab(currentDockerSubtab);
      }
    }
  } else {
    // 'snapshot' or full payload
    if (msg.refresh_intervals) {
      syncIntervalSelects(msg.refresh_intervals);
    }
    if (msg.raid) {
      renderRaidDetails(msg.raid);
      setModuleLastUpdated("raid");
      const isAdaptive =
        Boolean(msg.adaptive_fast) ||
        ["recovering", "resyncing", "degraded"].includes(
          String(msg.raid.status || "").toLowerCase()
        );
      updateRaidAdaptiveBadge(isAdaptive);
    }
    if (msg.system) {
      renderSystemMetrics(msg.system);
      setModuleLastUpdated("system");
    }
    if ("notification_state" in msg) {
      renderWeeklyNotificationState(msg.notification_state ?? null);
      setModuleLastUpdated("notifications");
    }
    if (msg.history) {
      renderNotificationHistory(msg.history);
      setModuleLastUpdated("notifications");
    }
    if (msg.version || msg.version_info) {
      updateVersionBadge(msg.version_info || msg.version);
    }
    if (msg.docker) {
      renderDockerStatus(msg.docker);
      setModuleLastUpdated("docker");
      if (currentViewTab === "containers") {
        throttledRefreshDockerSubtab(currentDockerSubtab);
      }
    }
  }

  setErrorState(null);

  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${formatTimeOnly(new Date())}`;
  }
}

/**
 * Connect to ws:// (or wss://) + window.location.host + '/api/ws' for real-time updates.
 */
function connectWebSocket() {
  if (!isAuthenticated || typeof window.WebSocket !== "function") return;

  closeWebSocket();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const authToken = getStoredToken();
  const query = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  const wsUrl = `${protocol}//${window.location.host}/api/ws${query}`;

  try {
    wsConnection = new window.WebSocket(wsUrl);
  } catch (err) {
    console.error("WebSocket creation error:", err);
    updateConnectionIndicator("reconnecting");
    startPolling({ immediate: false });
    wsReconnectTimerId = window.setTimeout(
      connectWebSocket,
      WS_RECONNECT_DELAY_MS
    );
    return;
  }

  wsConnection.onopen = () => {
    updateConnectionIndicator("live");
    // Pause the 10s HTTP polling timer while WebSocket is open
    stopPolling();
  };

  wsConnection.onmessage = (event) => {
    handleWebSocketMessage(event.data);
  };

  wsConnection.onerror = () => {
    // Let onclose handle reconnection and fallback polling
  };

  wsConnection.onclose = (event) => {
    wsConnection = null;
    if (event && event.code === 4401) {
      handleUnauthorized();
      return;
    }
    if (!isAuthenticated) {
      return;
    }
    updateConnectionIndicator("reconnecting");
    startPolling({ immediate: false });
    wsReconnectTimerId = window.setTimeout(
      connectWebSocket,
      WS_RECONNECT_DELAY_MS
    );
  };
}

/**
 * Trigger an immediate refresh over WebSocket when connected, or fall back to HTTP.
 */
function handleManualRefresh() {
  if (
    wsConnection &&
    typeof window.WebSocket === "function" &&
    wsConnection.readyState === window.WebSocket.OPEN
  ) {
    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) refreshBtn.classList.add("loading");
    try {
      wsConnection.send(JSON.stringify({ action: "refresh" }));
      return;
    } catch {
      // Fall back to HTTP refresh below if send fails
    }
  }
  refreshDashboard();
  if (currentViewTab === "containers") {
    fetchDockerStatus();
    refreshDockerSubtab(currentDockerSubtab);
  }
}

/**
 * Initialize Google Identity Services button when google_client_id is configured.
 */
function setupGoogleSignIn(clientId) {
  const section = document.getElementById("google-auth-section");
  const btnContainer = document.getElementById("google-signin-btn");
  if (!section || !btnContainer) return;

  if (!clientId) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  currentGoogleClientId = clientId;

  const renderGsi = () => {
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      return false;
    }
    btnContainer.innerHTML = "";
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleCredentialResponse,
    });
    window.google.accounts.id.renderButton(btnContainer, {
      theme: "filled_black",
      size: "large",
      width: 340,
      text: "signin_with",
    });
    return true;
  };

  if (!renderGsi()) {
    let attempts = 0;
    const waitTimer = window.setInterval(() => {
      attempts += 1;
      if (renderGsi() || attempts > 25) {
        window.clearInterval(waitTimer);
      }
    }, 200);
  }
}

async function handleGoogleCredentialResponse(response) {
  if (!response || !response.credential) return;
  showAuthError(null);
  try {
    const resp = await apiFetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || "Google authentication failed");
    }
    if (data.token) {
      setStoredToken(data.token);
    }
    onAuthenticatedSuccess(data.username || "google-user");
  } catch (err) {
    showAuthError(err instanceof Error ? err.message : String(err));
  }
}

function openAuthOverlay({ setupRequired = false, googleClientId = "" } = {}) {
  isAuthenticated = false;
  closeWebSocket();
  stopPolling();

  const viewLogin = document.getElementById("view-login");
  const appShell = document.getElementById("app-shell");
  const overlay = document.getElementById("auth-overlay");
  const titleEl = document.getElementById("auth-modal-title");
  const subtitleEl = document.getElementById("auth-modal-subtitle");
  const setupForm = document.getElementById("auth-setup-form");
  const loginForm = document.getElementById("auth-login-form");
  const userBox = document.getElementById("user-session-box");

  if (appShell) appShell.classList.add("hidden");
  if (viewLogin) viewLogin.classList.remove("hidden");
  if (overlay) overlay.classList.remove("hidden");
  if (userBox) userBox.classList.add("hidden");
  showAuthError(null);

  if (setupRequired) {
    if (titleEl) titleEl.textContent = "Initial Admin Setup";
    if (subtitleEl) {
      subtitleEl.textContent =
        "Create the primary administrator account to secure your dashboard";
    }
    if (setupForm) setupForm.classList.remove("hidden");
    if (loginForm) loginForm.classList.add("hidden");
  } else {
    if (titleEl) titleEl.textContent = "Sign In";
    if (subtitleEl) {
      subtitleEl.textContent =
        "Authenticate to access SystemAlerts Server Manager";
    }
    if (setupForm) setupForm.classList.add("hidden");
    if (loginForm) loginForm.classList.remove("hidden");
    setupGoogleSignIn(googleClientId);
  }
}

function onAuthenticatedSuccess(username) {
  isAuthenticated = true;
  const viewLogin = document.getElementById("view-login");
  const appShell = document.getElementById("app-shell");
  const overlay = document.getElementById("auth-overlay");
  const userBox = document.getElementById("user-session-box");
  const usernameEl = document.getElementById("auth-username");

  if (viewLogin) viewLogin.classList.add("hidden");
  if (overlay) overlay.classList.add("hidden");
  if (appShell) appShell.classList.remove("hidden");
  if (usernameEl) usernameEl.textContent = username || "admin";
  if (userBox) userBox.classList.remove("hidden");

  startPolling();
  connectWebSocket();
  fetchDiscordSettings();
  fetchNotificationCenterConfig();
  checkForUpdates({ silent: true });
  fetchDockerUpdatesConfig();
  // Preload container updates, package updates, and installed packages in background
  fetchDockerUpdates({ background: true });
  fetchPackageUpdates();
  fetchInstalledPackages("", 1);
}

async function handleUnauthorized() {
  setStoredToken("");
  await checkAuthStatus();
}

/**
 * Check GET /api/auth/status on startup and whenever 401 occurs.
 */
async function checkAuthStatus() {
  try {
    const resp = await apiFetch("/api/auth/status");
    if (!resp.ok) {
      throw new Error(`Auth check failed with HTTP ${resp.status}`);
    }
    const data = await resp.json();

    if (data.setup_required) {
      openAuthOverlay({
        setupRequired: true,
        googleClientId: data.google_client_id || "",
      });
      return;
    }

    if (!data.authenticated) {
      openAuthOverlay({
        setupRequired: false,
        googleClientId: data.google_client_id || "",
      });
      return;
    }

    onAuthenticatedSuccess(data.username || "admin");
  } catch (err) {
    console.error("Failed to check auth status:", err);
    openAuthOverlay({ setupRequired: false });
    showAuthError("Unable to verify authentication status with server.");
  }
}

async function handleSetupSubmit(event) {
  event.preventDefault();
  showAuthError(null);

  const username = document.getElementById("setup-username")?.value.trim() || "";
  const password = document.getElementById("setup-password")?.value || "";
  const email = document.getElementById("setup-email")?.value.trim() || "";

  if (!username || !password) {
    showAuthError("Username and password are required.");
    return;
  }

  try {
    const resp = await apiFetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, email }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || "Initial admin setup failed");
    }
    if (data.token) {
      setStoredToken(data.token);
    }
    onAuthenticatedSuccess(data.username || username);
  } catch (err) {
    showAuthError(err instanceof Error ? err.message : String(err));
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  showAuthError(null);

  const username = document.getElementById("login-username")?.value.trim() || "";
  const password = document.getElementById("login-password")?.value || "";

  if (!username || !password) {
    showAuthError("Please enter both username and password.");
    return;
  }

  try {
    const resp = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || "Invalid username or password");
    }
    if (data.token) {
      setStoredToken(data.token);
    }
    onAuthenticatedSuccess(data.username || username);
  } catch (err) {
    showAuthError(err instanceof Error ? err.message : String(err));
  }
}

async function handleLogout() {
  closeWebSocket();
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Ignore network errors during logout
  }
  setStoredToken("");
  await checkAuthStatus();
}

/* =========================================================================
 * 2. Release-Tag Updater & Modal (#nav-update-notice-btn, #update-modal)
 * ========================================================================= */

let latestUpdateInfo = null;
let isViewingFullChangelog = false;

/**
 * Format inline markdown: bold (**text**) and code (`code`).
 */
function formatInlineMarkdown(text) {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  return escaped;
}

/**
 * Lightweight markdown parser that renders #, ##, ### headings,
 * bullet lists (- or *), bold text, and inline code into clean semantic HTML.
 */
function parseMarkdown(mdText) {
  if (!mdText || typeof mdText !== "string") {
    return "<p>No release notes available.</p>";
  }

  const lines = mdText.split(/\r?\n/);
  const htmlParts = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if (inList) {
        htmlParts.push("</ul>");
        inList = false;
      }
      continue;
    }

    // List item: - or * followed by whitespace
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        htmlParts.push("<ul>");
        inList = true;
      }
      const itemContent = trimmed.replace(/^[-*]\s+/, "");
      htmlParts.push(`<li>${formatInlineMarkdown(itemContent)}</li>`);
      continue;
    }

    if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }

    if (trimmed.startsWith("### ")) {
      htmlParts.push(`<h3>${formatInlineMarkdown(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith("## ")) {
      htmlParts.push(`<h2>${formatInlineMarkdown(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith("# ")) {
      htmlParts.push(`<h1>${formatInlineMarkdown(trimmed.slice(2))}</h1>`);
    } else {
      htmlParts.push(`<p>${formatInlineMarkdown(trimmed)}</p>`);
    }
  }

  if (inList) {
    htmlParts.push("</ul>");
  }

  return htmlParts.join("\n");
}

/**
 * Update the header notice button and populate update modal content.
 */
function renderUpdateNotice(data) {
  latestUpdateInfo = data || null;

  const noticeBtn = document.getElementById("nav-update-notice-btn");
  const noticeLabel = document.getElementById("nav-update-version-label");

  const banner = document.getElementById("update-banner");
  const latestVerEl = document.getElementById("update-latest-version");
  const changelogEl = document.getElementById("update-changelog");

  if (data && data.update_available) {
    const rawTarget = String(data.latest_version || "");
    const formattedTarget = rawTarget.startsWith("v")
      ? rawTarget
      : `v${rawTarget || "--"}`;

    if (noticeLabel) {
      noticeLabel.textContent = `${formattedTarget} available`;
    }
    if (noticeBtn) {
      noticeBtn.classList.remove("hidden");
    }

    if (latestVerEl) {
      latestVerEl.textContent = data.latest_version || "latest";
    }
    if (changelogEl) {
      changelogEl.textContent =
        data.changelog || "New tagged release available on origin.";
    }
    if (banner) {
      banner.classList.add("hidden");
    }

    populateUpdateModal(data);
  } else {
    if (noticeBtn) {
      noticeBtn.classList.add("hidden");
    }
    if (banner) {
      banner.classList.add("hidden");
    }
  }
}

/**
 * Backward-compatible alias for renderUpdateBanner.
 */
function renderUpdateBanner(data) {
  renderUpdateNotice(data);
}

/**
 * Populate values inside #update-modal.
 */
function populateUpdateModal(data) {
  if (!data) return;

  const currentVerEl = document.getElementById("modal-current-version");
  const latestVerEl = document.getElementById("modal-latest-version");
  const notesEl = document.getElementById("modal-release-notes");

  if (currentVerEl) {
    const rawCur = String(data.current_version || "");
    currentVerEl.textContent = rawCur.startsWith("v")
      ? rawCur
      : `v${rawCur || "--"}`;
  }

  if (latestVerEl) {
    const rawTarget = String(data.latest_version || "");
    latestVerEl.textContent = rawTarget.startsWith("v")
      ? rawTarget
      : `v${rawTarget || "--"}`;
  }

  if (notesEl && !isViewingFullChangelog) {
    const rawNotes =
      data.release_notes ||
      data.changelog ||
      "New release available on origin.";
    notesEl.innerHTML = parseMarkdown(rawNotes);
  }
}

function openUpdateModal() {
  const modal = document.getElementById("update-modal");
  if (!modal) return;

  isViewingFullChangelog = false;
  const toggleBtnText = document.getElementById("modal-toggle-changelog-text");
  if (toggleBtnText) toggleBtnText.textContent = "View Full Changelog";
  const notesHeading = document.getElementById("modal-notes-heading");
  if (notesHeading) notesHeading.textContent = "Release Notes";

  clearModalUpdateStatus();

  if (latestUpdateInfo) {
    populateUpdateModal(latestUpdateInfo);
  }

  modal.classList.remove("hidden");
}

function closeUpdateModal() {
  const modal = document.getElementById("update-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function showModalUpdateStatus(message, type = "info") {
  const statusEl = document.getElementById("modal-update-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `modal-update-status status-${type}`;
  statusEl.classList.remove("hidden");
}

function clearModalUpdateStatus() {
  const statusEl = document.getElementById("modal-update-status");
  if (!statusEl) return;
  statusEl.textContent = "";
  statusEl.className = "modal-update-status hidden";
}

async function toggleFullChangelog() {
  const notesEl = document.getElementById("modal-release-notes");
  const toggleBtnText = document.getElementById("modal-toggle-changelog-text");
  const notesHeading = document.getElementById("modal-notes-heading");

  if (!isViewingFullChangelog) {
    if (notesEl) {
      notesEl.innerHTML = "<p>Loading full changelog...</p>";
    }
    try {
      const resp = await apiFetch("/api/changelog");
      const data = await resp.json().catch(() => ({}));
      const fullText =
        data.changelog || "# Changelog\nNo full changelog available.";
      if (notesEl) {
        notesEl.innerHTML = parseMarkdown(fullText);
      }
      if (toggleBtnText) toggleBtnText.textContent = "View Release Notes";
      if (notesHeading) notesHeading.textContent = "Full Changelog";
      isViewingFullChangelog = true;
    } catch (err) {
      if (notesEl) {
        notesEl.innerHTML = `<p>Failed to load full changelog: ${escapeHtml(err.message)}</p>`;
      }
    }
  } else {
    if (notesEl && latestUpdateInfo) {
      const rawNotes =
        latestUpdateInfo.release_notes ||
        latestUpdateInfo.changelog ||
        "New release available on origin.";
      notesEl.innerHTML = parseMarkdown(rawNotes);
    }
    if (toggleBtnText) toggleBtnText.textContent = "View Full Changelog";
    if (notesHeading) notesHeading.textContent = "Release Notes";
    isViewingFullChangelog = false;
  }
}

async function checkForUpdates({ silent = false } = {}) {
  const checkBtn = document.getElementById("check-update-btn");
  if (checkBtn && !silent) {
    checkBtn.disabled = true;
    checkBtn.textContent = "Checking...";
  }

  try {
    const resp = await apiFetch("/api/update/check");
    if (resp.status === 401) return;
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || `Update check failed (${resp.status})`);
    }

    updateVersionBadge(data);
    renderUpdateNotice(data);

    if (data.update_available) {
      if (!silent) {
        openUpdateModal();
      }
    } else {
      if (checkBtn && !silent) {
        checkBtn.textContent = "Up to date";
        window.setTimeout(() => {
          if (checkBtn) checkBtn.textContent = "Check Updates";
        }, 2500);
      }
    }
  } catch (err) {
    console.error("Update check error:", err);
    if (!silent) {
      setErrorState(
        `Update check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } finally {
    if (checkBtn && !silent) {
      checkBtn.disabled = false;
      if (checkBtn.textContent === "Checking...") {
        checkBtn.textContent = "Check Updates";
      }
    }
  }
}

async function applyReleaseUpdate() {
  const modalApplyBtn = document.getElementById("modal-apply-update-btn");
  const modalApplyLabel = document.getElementById("modal-apply-btn-label");
  const modalDismissBtn = document.getElementById("modal-dismiss-btn");
  const bannerApplyBtn = document.getElementById("apply-update-btn");

  if (modalApplyBtn) modalApplyBtn.disabled = true;
  if (modalApplyLabel) modalApplyLabel.textContent = "Updating...";
  if (modalDismissBtn) modalDismissBtn.disabled = true;
  if (bannerApplyBtn) {
    bannerApplyBtn.disabled = true;
    bannerApplyBtn.textContent = "Updating & Restarting Services...";
  }

  showModalUpdateStatus(
    "Applying update and restarting services. Please stand by...",
    "info"
  );

  try {
    const resp = await apiFetch("/api/update/apply", { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || `Update failed (HTTP ${resp.status})`);
    }

    showModalUpdateStatus(
      "Update successfully applied. Restarting services and reconnecting...",
      "success"
    );

    closeWebSocket();
    stopPolling();
    pollUntilServerRestarts();
  } catch (err) {
    console.error("Failed to apply update:", err);
    const msg = `Failed to apply update: ${err instanceof Error ? err.message : String(err)}`;
    showModalUpdateStatus(msg, "error");
    setErrorState(msg);

    if (modalApplyBtn) modalApplyBtn.disabled = false;
    if (modalApplyLabel) modalApplyLabel.textContent = "Update & Restart Services";
    if (modalDismissBtn) modalDismissBtn.disabled = false;
    if (bannerApplyBtn) {
      bannerApplyBtn.disabled = false;
      bannerApplyBtn.textContent = "Update & Restart Services";
    }
  }
}

function pollUntilServerRestarts() {
  let attempts = 0;
  const maxAttempts = 40;
  const pollTimer = window.setInterval(async () => {
    attempts += 1;
    try {
      const resp = await fetch("/api/auth/status", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (resp.ok && attempts >= 2) {
        window.clearInterval(pollTimer);
        window.location.reload();
      }
    } catch {
      // Server is restarting; keep polling
    }

    if (attempts >= maxAttempts) {
      window.clearInterval(pollTimer);
      window.location.reload();
    }
  }, 2000);
}

/* =========================================================================
 * 3. SQLite Settings Modal (#settings-modal)
 * ========================================================================= */

function showSettingsFeedback(message, isSuccess = false) {
  const el = document.getElementById("settings-feedback");
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("success");
    return;
  }
  el.textContent = message;
  el.classList.toggle("success", isSuccess);
  el.classList.remove("hidden");
}

async function openSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (!modal) return;
  showSettingsFeedback(null);
  modal.classList.remove("hidden");

  try {
    const resp = await apiFetch("/api/settings");
    if (resp.status === 401) {
      modal.classList.add("hidden");
      return;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || `Failed to load settings (${resp.status})`);
    }

    populateSettingsForm(data);
  } catch (err) {
    showSettingsFeedback(
      err instanceof Error ? err.message : String(err),
      false
    );
  }
}

function populateSettingsForm(data) {
  const raidInput =
    document.getElementById("settings-raid-device") ||
    document.getElementById("setting-raid-device");
  const raidDatalist = document.getElementById("raid-devices-list");
  const raidHint = document.getElementById("raid-devices-hint");
  const mountInput = document.getElementById("setting-mount-path");
  const googleClientInput = document.getElementById("setting-google-client-id");
  const allowedEmailsInput = document.getElementById(
    "setting-allowed-google-emails"
  );

  if (raidInput) raidInput.value = data.raid_device || "auto";

  const availableDevices = Array.isArray(data.available_raid_devices)
    ? data.available_raid_devices
    : [];

  if (raidDatalist) {
    raidDatalist.innerHTML = "";
    const options = ["auto", ...availableDevices];
    const seen = new Set();
    options.forEach((optValue) => {
      if (!optValue || seen.has(optValue)) return;
      seen.add(optValue);
      const optionEl = document.createElement("option");
      optionEl.value = optValue;
      optionEl.textContent =
        optValue === "auto"
          ? "auto (Auto-detect active md array)"
          : optValue;
      raidDatalist.appendChild(optionEl);
    });
  }

  if (raidHint) {
    if (availableDevices.length === 0 && !data.resolved_raid_device) {
      raidHint.textContent = "Detected on host: No RAID arrays detected";
    } else {
      const detectedText =
        availableDevices.length > 0
          ? availableDevices.join(", ")
          : "none detected";
      const resolvedDevice =
        data.resolved_raid_device || data.raid_device || "none";
      raidHint.textContent = `Detected arrays: ${detectedText} | Resolved: ${resolvedDevice}`;
    }
  }

  if (mountInput) mountInput.value = data.mount_path || "/mnt/media/";
  if (googleClientInput) googleClientInput.value = data.google_client_id || "";
  if (allowedEmailsInput) {
    allowedEmailsInput.value = data.allowed_google_emails || "";
  }

  if (data.refresh_intervals) {
    syncIntervalSelects(data.refresh_intervals);
  }

  const tzSelect = document.getElementById("setting-timezone");
  const tzHint = document.getElementById("timezone-hint");
  if (tzSelect) {
    tzSelect.value = getStoredTimezone();
  }
  if (tzHint) {
    tzHint.textContent = `Current resolved timezone: ${getEffectiveTimezone()}`;
  }

  populateDiscordForm(data);
}

const populateSettingsModal = populateSettingsForm;

function closeSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (modal) modal.classList.add("hidden");
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  showSettingsFeedback(null);

  const raidInputEl =
    document.getElementById("settings-raid-device") ||
    document.getElementById("setting-raid-device");
  const payload = {
    raid_device: raidInputEl?.value.trim() || "auto",
    mount_path:
      document.getElementById("setting-mount-path")?.value.trim() ||
      "/mnt/media/",
    google_client_id:
      document.getElementById("setting-google-client-id")?.value.trim() || "",
    allowed_google_emails:
      document.getElementById("setting-allowed-google-emails")?.value.trim() ||
      "",
  };

  const saveBtn = document.getElementById("save-settings-btn");
  if (saveBtn) saveBtn.disabled = true;

  try {
    const resp = await apiFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || `Failed to save settings (${resp.status})`);
    }

    const tzSelect = document.getElementById("setting-timezone");
    if (tzSelect) {
      setStoredTimezone(tzSelect.value);
      const tzHint = document.getElementById("timezone-hint");
      if (tzHint) {
        tzHint.textContent = `Current resolved timezone: ${getEffectiveTimezone()}`;
      }
    }

    populateSettingsForm(data);
    showSettingsFeedback("Settings saved to SQLite.", true);
    handleManualRefresh();
  } catch (err) {
    showSettingsFeedback(
      err instanceof Error ? err.message : String(err),
      false
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Cache for app settings (Discord status, channel, tokens)
 */
let cachedDiscordSettings = null;

/**
 * Fetch settings from SQLite API to update Discord controls card.
 */
let cachedNotificationCenterConfig = null;

let notifFeedbackTimerId = null;

/**
 * Show feedback message in Notification Center (renders strictly to a single banner).
 */
function showNotificationFeedback(message, isSuccess = true) {
  const notifFeedback = document.getElementById("notif-feedback");
  const discordFeedback = document.getElementById("discord-feedback");
  const primary = notifFeedback || discordFeedback;
  if (!primary) return;

  if (notifFeedbackTimerId) {
    window.clearTimeout(notifFeedbackTimerId);
    notifFeedbackTimerId = null;
  }

  // Ensure secondary legacy element is ALWAYS cleared and hidden
  if (discordFeedback && discordFeedback !== primary) {
    discordFeedback.textContent = "";
    discordFeedback.className = "hidden";
    discordFeedback.style.display = "none";
  }

  if (!message) {
    primary.textContent = "";
    primary.classList.add("hidden");
    primary.classList.remove("feedback-success", "feedback-error");
    return;
  }

  primary.textContent = message;
  primary.classList.remove("hidden", "feedback-success", "feedback-error");
  primary.classList.add(isSuccess ? "feedback-success" : "feedback-error");

  if (isSuccess) {
    notifFeedbackTimerId = window.setTimeout(() => {
      primary.textContent = "";
      primary.classList.add("hidden");
      primary.classList.remove("feedback-success", "feedback-error");
    }, 5000);
  }
}

const showDiscordFeedback = showNotificationFeedback;
const showTestNotificationFeedback = showNotificationFeedback;

/**
 * Update next run info text based on schedule form controls.
 */
function updateNextRunDisplay(schedule = null) {
  const nextRunEl = document.getElementById("notif-schedule-next-run");
  if (!nextRunEl) return;

  const scheduleToggle = document.getElementById("notif-schedule-enable");
  const enabled = scheduleToggle ? scheduleToggle.checked : true;
  if (!enabled) {
    nextRunEl.textContent = "Scheduled reports disabled";
    return;
  }

  const freqEl = document.getElementById("notif-schedule-freq");
  const freq = freqEl ? freqEl.value : (schedule?.frequency || "daily");
  const dayEl = document.getElementById("notif-schedule-day");
  const day = dayEl ? dayEl.value : (schedule?.day || "monday");
  const timeEl = document.getElementById("notif-schedule-time");
  const time = timeEl ? timeEl.value : (schedule?.time || "09:00");

  let desc = `Daily at ${time}`;
  if (freq === "weekly") {
    const capitalizedDay = day ? (day.charAt(0).toUpperCase() + day.slice(1)) : "Monday";
    desc = `Every ${capitalizedDay} at ${time}`;
  } else if (freq === "hourly") {
    desc = `Every hour at :00`;
  } else if (freq === "6h") {
    desc = `Every 6 hours`;
  } else if (freq === "12h") {
    desc = `Every 12 hours`;
  }

  nextRunEl.textContent = `Next report scheduled: ${desc}`;
}

/**
 * Populate all Notification Center form controls from GET /api/notifications/center payload.
 */
function populateNotificationCenter(config) {
  if (!config || typeof config !== "object") return;
  cachedNotificationCenterConfig = config;

  const channels = config.channels || {};
  const discordCh = channels.discord || {};
  const telegramCh = channels.telegram || {};
  const webhookCh = channels.webhook || {};
  const schedule = config.schedule || {};
  const topics = config.topics || {};
  const thresholds = config.thresholds || {};

  // 1. Discord Channel
  const notifDiscordToggle = document.getElementById("notif-channel-discord-enable");
  const discordLegacyToggle = document.getElementById("discord-enabled-toggle");
  const discordEnabled = Boolean(
    discordCh.enabled !== undefined
      ? discordCh.enabled
      : (config.discord_enabled !== undefined ? config.discord_enabled : false)
  );
  if (notifDiscordToggle) notifDiscordToggle.checked = discordEnabled;
  if (discordLegacyToggle) discordLegacyToggle.checked = discordEnabled;

  const notifDiscordToken = document.getElementById("notif-discord-token-input");
  const discordLegacyToken = document.getElementById("discord-token-input");
  const discordTokenBadge = document.getElementById("discord-token-status");
  const isTokenConfigured = Boolean(
    discordCh.token_configured !== undefined
      ? discordCh.token_configured
      : config.discord_token_configured
  );
  const tokenMasked = discordCh.token_masked || config.discord_token_masked || "";

  if (notifDiscordToken) {
    notifDiscordToken.value = "";
    notifDiscordToken.placeholder = isTokenConfigured
      ? `Configured (${tokenMasked || "••••••••"}) — type to replace`
      : "Leave blank to keep existing token";
  }
  if (discordLegacyToken) {
    discordLegacyToken.value = "";
    discordLegacyToken.placeholder = notifDiscordToken ? notifDiscordToken.placeholder : "";
  }
  if (discordTokenBadge) {
    if (isTokenConfigured) {
      discordTokenBadge.textContent = tokenMasked ? `Configured (${tokenMasked})` : "Configured";
      discordTokenBadge.classList.add("configured");
    } else {
      discordTokenBadge.textContent = "Not configured";
      discordTokenBadge.classList.remove("configured");
    }
  }

  const notifDiscordChannel = document.getElementById("notif-discord-channel-input");
  const discordLegacyChannel = document.getElementById("discord-channel-input");
  const channelId = discordCh.channel_id || config.channel_id || "";
  if (notifDiscordChannel) notifDiscordChannel.value = channelId;
  if (discordLegacyChannel) discordLegacyChannel.value = channelId;

  const discordStatusBadge = document.getElementById("discord-status-badge");
  if (discordStatusBadge) {
    discordStatusBadge.classList.remove(
      "status-clean",
      "status-degraded",
      "status-unknown",
      "status-enabled",
      "status-disabled"
    );
    if (discordEnabled) {
      discordStatusBadge.classList.add("status-clean", "status-enabled");
      discordStatusBadge.textContent = "ENABLED";
      discordStatusBadge.setAttribute("data-state", "enabled");
    } else {
      discordStatusBadge.classList.add("status-degraded", "status-disabled");
      discordStatusBadge.textContent = "DISABLED";
      discordStatusBadge.setAttribute("data-state", "disabled");
    }
  }

  const overviewDiscordBadge = document.getElementById("overview-discord-badge");
  if (overviewDiscordBadge) {
    overviewDiscordBadge.className = `status-badge ${discordEnabled ? "status-clean" : "status-degraded"}`;
    overviewDiscordBadge.textContent = discordEnabled ? "ENABLED" : "DISABLED";
  }
  const overviewDiscordSummary = document.getElementById("overview-discord-summary");
  if (overviewDiscordSummary) {
    overviewDiscordSummary.textContent = discordEnabled
      ? `Active Discord alerts channel: ${channelId || "configured"}`
      : "Discord notifications are currently disabled";
  }

  // 2. Telegram Channel
  const notifTelegramToggle = document.getElementById("notif-channel-telegram-enable");
  if (notifTelegramToggle) notifTelegramToggle.checked = Boolean(telegramCh.enabled);

  const notifTelegramToken = document.getElementById("notif-telegram-token-input");
  const notifTelegramBadge = document.getElementById("notif-telegram-token-badge");
  const isTgConfigured = Boolean(telegramCh.token_configured);
  if (notifTelegramToken) {
    notifTelegramToken.value = "";
    notifTelegramToken.placeholder = isTgConfigured
      ? `Configured (${telegramCh.token_masked || "••••••••"}) — type to replace`
      : "e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  }
  if (notifTelegramBadge) {
    if (isTgConfigured) {
      notifTelegramBadge.textContent = telegramCh.token_masked
        ? `Configured (${telegramCh.token_masked})`
        : "Configured";
      notifTelegramBadge.classList.add("configured");
    } else {
      notifTelegramBadge.textContent = "Not configured";
      notifTelegramBadge.classList.remove("configured");
    }
  }

  const notifTelegramChatId = document.getElementById("notif-telegram-chat-id-input");
  if (notifTelegramChatId) notifTelegramChatId.value = telegramCh.chat_id || "";

  // 3. Generic Webhook Channel
  const notifWebhookToggle = document.getElementById("notif-channel-webhook-enable");
  if (notifWebhookToggle) notifWebhookToggle.checked = Boolean(webhookCh.enabled);

  const notifWebhookUrl = document.getElementById("notif-webhook-url-input");
  if (notifWebhookUrl) notifWebhookUrl.value = webhookCh.url || "";

  // 4. Automated Report Schedule
  const scheduleToggle = document.getElementById("notif-schedule-enable");
  if (scheduleToggle) scheduleToggle.checked = Boolean(schedule.enabled ?? true);

  const scheduleFreq = document.getElementById("notif-schedule-freq");
  if (scheduleFreq && schedule.frequency) scheduleFreq.value = schedule.frequency;

  const scheduleDay = document.getElementById("notif-schedule-day");
  if (scheduleDay && schedule.day) scheduleDay.value = schedule.day;

  const scheduleDayGroup = document.getElementById("notif-schedule-day-group");
  if (scheduleDayGroup) {
    scheduleDayGroup.classList.toggle("hidden", (scheduleFreq?.value || "daily") !== "weekly");
  }

  const scheduleTime = document.getElementById("notif-schedule-time");
  if (scheduleTime && schedule.time) scheduleTime.value = schedule.time;

  updateNextRunDisplay(schedule);

  // 5. Topics
  const topicSys = document.getElementById("notif-topic-system");
  if (topicSys) topicSys.checked = Boolean(topics.system ?? true);

  const topicDisks = document.getElementById("notif-topic-disks");
  if (topicDisks) topicDisks.checked = Boolean(topics.disks ?? true);

  const topicRaid = document.getElementById("notif-topic-raid");
  if (topicRaid) topicRaid.checked = Boolean(topics.raid ?? true);

  // 6. Thresholds
  const ramTh = thresholds.ram || {};
  const notifRamEnable = document.getElementById("notif-threshold-ram-enable");
  const notifRamVal = document.getElementById("notif-threshold-ram-value");
  const notifRamSlider = document.getElementById("notif-threshold-ram-slider");
  if (notifRamEnable) notifRamEnable.checked = Boolean(ramTh.enabled ?? true);
  const ramVal = Number(ramTh.value ?? 90);
  if (notifRamVal) notifRamVal.value = ramVal;
  if (notifRamSlider) notifRamSlider.value = ramVal;

  const cpuTh = thresholds.cpu || {};
  const notifCpuEnable = document.getElementById("notif-threshold-cpu-enable");
  const notifCpuVal = document.getElementById("notif-threshold-cpu-value");
  const notifCpuSlider = document.getElementById("notif-threshold-cpu-slider");
  if (notifCpuEnable) notifCpuEnable.checked = Boolean(cpuTh.enabled ?? true);
  const cpuVal = Number(cpuTh.value ?? 90);
  if (notifCpuVal) notifCpuVal.value = cpuVal;
  if (notifCpuSlider) notifCpuSlider.value = cpuVal;

  const diskTh = thresholds.disk || {};
  const notifDiskEnable = document.getElementById("notif-threshold-disk-enable");
  const notifDiskVal = document.getElementById("notif-threshold-disk-value");
  const notifDiskSlider = document.getElementById("notif-threshold-disk-slider");
  if (notifDiskEnable) notifDiskEnable.checked = Boolean(diskTh.enabled ?? true);
  const diskVal = Number(diskTh.value ?? 85);
  if (notifDiskVal) notifDiskVal.value = diskVal;
  if (notifDiskSlider) notifDiskSlider.value = diskVal;

  const raidTh = thresholds.raid || {};
  const notifRaidEnable = document.getElementById("notif-threshold-raid-enable");
  if (notifRaidEnable) notifRaidEnable.checked = Boolean(raidTh.enabled ?? true);

  // Update Notification Center ribbon status indicators
  const telegramStatusBadge = document.getElementById("telegram-status-badge");
  if (telegramStatusBadge) {
    const tgActive = Boolean(telegramCh.enabled);
    telegramStatusBadge.textContent = tgActive ? "ENABLED" : "DISABLED";
    telegramStatusBadge.className = `status-badge ${tgActive ? "status-clean" : "status-disabled"}`;
  }

  const webhookStatusBadge = document.getElementById("webhook-status-badge");
  if (webhookStatusBadge) {
    const whActive = Boolean(webhookCh.enabled);
    webhookStatusBadge.textContent = whActive ? "ENABLED" : "DISABLED";
    webhookStatusBadge.className = `status-badge ${whActive ? "status-clean" : "status-disabled"}`;
  }

  const ribbonRam = document.getElementById("ribbon-thresh-ram-val");
  if (ribbonRam) ribbonRam.textContent = `${ramVal}%`;
  const ribbonCpu = document.getElementById("ribbon-thresh-cpu-val");
  if (ribbonCpu) ribbonCpu.textContent = `${cpuVal}%`;
  const ribbonDisk = document.getElementById("ribbon-thresh-disk-val");
  if (ribbonDisk) ribbonDisk.textContent = `${diskVal}%`;
}

/* =========================================================================
 * Notification Center Modal Controllers
 * ========================================================================= */

function openNotifChannelsModal() {
  const modal = document.getElementById("modal-notif-channels");
  if (modal) modal.classList.remove("hidden");
}

function closeNotifChannelsModal() {
  const modal = document.getElementById("modal-notif-channels");
  if (modal) modal.classList.add("hidden");
}

function openNotifScheduleModal() {
  const modal = document.getElementById("modal-notif-schedule");
  if (modal) modal.classList.remove("hidden");
}

function closeNotifScheduleModal() {
  const modal = document.getElementById("modal-notif-schedule");
  if (modal) modal.classList.add("hidden");
}

function openNotifThresholdsModal() {
  const modal = document.getElementById("modal-notif-thresholds");
  if (modal) modal.classList.remove("hidden");
}

function closeNotifThresholdsModal() {
  const modal = document.getElementById("modal-notif-thresholds");
  if (modal) modal.classList.add("hidden");
}

/**
 * Legacy populator kept for backwards compatibility with tests.
 */
function populateDiscordForm(settings) {
  if (!settings) return;
  cachedDiscordSettings = settings;
  populateNotificationCenter(settings);
}

const renderDiscordStatusCard = populateDiscordForm;

/**
 * Fetch full Notification Center configuration from GET /api/notifications/center.
 */
async function fetchNotificationCenterConfig() {
  if (!isAuthenticated) return;
  try {
    const resp = await apiFetch("/api/notifications/center");
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      populateNotificationCenter(data);
      return;
    }
  } catch (err) {
    console.debug("GET /api/notifications/center error, checking fallback:", err);
  }

  // Fallback to /api/settings if needed
  try {
    const respSettings = await apiFetch("/api/settings");
    if (respSettings.ok) {
      const settingsData = await respSettings.json().catch(() => ({}));
      populateDiscordForm(settingsData);
    }
  } catch (err) {
    console.warn("Fallback fetch settings error:", err);
  }
}

async function fetchDiscordSettings() {
  await fetchNotificationCenterConfig();
}

/**
 * Collect form controls and save to POST /api/notifications/center.
 */
async function saveNotificationCenterConfig() {
  const saveBtn = document.getElementById("save-notifications-btn");
  if (saveBtn) saveBtn.disabled = true;
  showNotificationFeedback(null);

  const discordToggle = document.getElementById("notif-channel-discord-enable");
  const discordToken = document.getElementById("notif-discord-token-input");
  const discordChannel = document.getElementById("notif-discord-channel-input");

  const telegramToggle = document.getElementById("notif-channel-telegram-enable");
  const telegramToken = document.getElementById("notif-telegram-token-input");
  const telegramChatId = document.getElementById("notif-telegram-chat-id-input");

  const webhookToggle = document.getElementById("notif-channel-webhook-enable");
  const webhookUrl = document.getElementById("notif-webhook-url-input");

  const scheduleToggle = document.getElementById("notif-schedule-enable");
  const scheduleFreq = document.getElementById("notif-schedule-freq");
  const scheduleDay = document.getElementById("notif-schedule-day");
  const scheduleTime = document.getElementById("notif-schedule-time");

  const topicSys = document.getElementById("notif-topic-system");
  const topicDisks = document.getElementById("notif-topic-disks");
  const topicRaid = document.getElementById("notif-topic-raid");

  const ramToggle = document.getElementById("notif-threshold-ram-enable");
  const ramVal = document.getElementById("notif-threshold-ram-value");
  const cpuToggle = document.getElementById("notif-threshold-cpu-enable");
  const cpuVal = document.getElementById("notif-threshold-cpu-value");
  const diskToggle = document.getElementById("notif-threshold-disk-enable");
  const diskVal = document.getElementById("notif-threshold-disk-value");
  const raidToggle = document.getElementById("notif-threshold-raid-enable");

  const discordPayload = {
    enabled: Boolean(discordToggle ? discordToggle.checked : false),
    channel_id: discordChannel ? discordChannel.value.trim() : "",
  };
  if (discordToken && discordToken.value.trim().length > 0) {
    discordPayload.token = discordToken.value.trim();
  }

  const telegramPayload = {
    enabled: Boolean(telegramToggle ? telegramToggle.checked : false),
    chat_id: telegramChatId ? telegramChatId.value.trim() : "",
  };
  if (telegramToken && telegramToken.value.trim().length > 0) {
    telegramPayload.token = telegramToken.value.trim();
  }

  const webhookPayload = {
    enabled: Boolean(webhookToggle ? webhookToggle.checked : false),
    url: webhookUrl ? webhookUrl.value.trim() : "",
  };

  const payload = {
    channels: {
      discord: discordPayload,
      telegram: telegramPayload,
      webhook: webhookPayload,
    },
    schedule: {
      enabled: Boolean(scheduleToggle ? scheduleToggle.checked : false),
      frequency: scheduleFreq ? scheduleFreq.value : "daily",
      day: scheduleDay ? scheduleDay.value : "monday",
      time: scheduleTime ? scheduleTime.value : "09:00",
    },
    topics: {
      system: Boolean(topicSys ? topicSys.checked : false),
      disks: Boolean(topicDisks ? topicDisks.checked : false),
      raid: Boolean(topicRaid ? topicRaid.checked : false),
    },
    thresholds: {
      ram: {
        enabled: Boolean(ramToggle ? ramToggle.checked : false),
        value: Number(ramVal ? ramVal.value : 90) || 90,
      },
      cpu: {
        enabled: Boolean(cpuToggle ? cpuToggle.checked : false),
        value: Number(cpuVal ? cpuVal.value : 90) || 90,
      },
      disk: {
        enabled: Boolean(diskToggle ? diskToggle.checked : false),
        value: Number(diskVal ? diskVal.value : 85) || 85,
      },
      raid: {
        enabled: Boolean(raidToggle ? raidToggle.checked : false),
      },
    },
  };

  try {
    const resp = await apiFetch("/api/notifications/center", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));

    if (resp.status === 401) {
      showNotificationFeedback("Authentication required. Please sign in again.", false);
      return;
    }

    if (!resp.ok) {
      throw new Error(
        data.detail || `Failed to save Notification Center settings (${resp.status})`
      );
    }

    populateNotificationCenter(data);
    showNotificationFeedback("Notification Center configuration saved successfully.", true);
    closeNotifScheduleModal();
    closeNotifThresholdsModal();
  } catch (err) {
    showNotificationFeedback(
      err instanceof Error ? err.message : String(err),
      false
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Save Delivery Channels configuration (Discord, Telegram, Webhook)
 * from Delivery Channels card. Retains #save-discord-btn for contract compatibility.
 */
async function handleSaveDiscordSettings() {
  const saveBtn = document.getElementById("save-discord-btn");
  if (saveBtn) saveBtn.disabled = true;
  showNotificationFeedback(null);

  const discordToggle = document.getElementById("notif-channel-discord-enable");
  const discordToken = document.getElementById("notif-discord-token-input");
  const discordChannel = document.getElementById("notif-discord-channel-input");

  const telegramToggle = document.getElementById("notif-channel-telegram-enable");
  const telegramToken = document.getElementById("notif-telegram-token-input");
  const telegramChatId = document.getElementById("notif-telegram-chat-id-input");

  const webhookToggle = document.getElementById("notif-channel-webhook-enable");
  const webhookUrl = document.getElementById("notif-webhook-url-input");

  const discordPayload = {
    enabled: Boolean(discordToggle ? discordToggle.checked : false),
    channel_id: discordChannel ? discordChannel.value.trim() : "",
  };
  if (discordToken && discordToken.value.trim().length > 0) {
    discordPayload.token = discordToken.value.trim();
  }

  const telegramPayload = {
    enabled: Boolean(telegramToggle ? telegramToggle.checked : false),
    chat_id: telegramChatId ? telegramChatId.value.trim() : "",
  };
  if (telegramToken && telegramToken.value.trim().length > 0) {
    telegramPayload.token = telegramToken.value.trim();
  }

  const webhookPayload = {
    enabled: Boolean(webhookToggle ? webhookToggle.checked : false),
    url: webhookUrl ? webhookUrl.value.trim() : "",
  };

  const payload = {
    channels: {
      discord: discordPayload,
      telegram: telegramPayload,
      webhook: webhookPayload,
    },
  };

  try {
    const resp = await apiFetch("/api/notifications/center", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));

    if (resp.status === 401) {
      showNotificationFeedback("Authentication required. Please sign in again.", false);
      return;
    }

    if (!resp.ok) {
      throw new Error(data.detail || `Failed to save delivery channels (${resp.status})`);
    }

    populateNotificationCenter(data);
    showNotificationFeedback("Delivery channels saved successfully.", true);
    closeNotifChannelsModal();
  } catch (err) {
    showNotificationFeedback(
      err instanceof Error ? err.message : String(err),
      false
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Send test notification to target channel ("all", "discord", "telegram", "webhook").
 */
async function handleSendTestNotification() {
  const btn = document.getElementById("send-test-notification-btn");
  if (!btn || btn.disabled) return;

  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add("loading");
  btn.innerHTML = `
    <svg class="refresh-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10"></polyline>
      <polyline points="1 20 1 14 7 14"></polyline>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
    <span>Sending test notification...</span>
  `;

  showNotificationFeedback(null);

  const testSelect = document.getElementById("notif-test-channel-select");
  const selectedChannel = testSelect ? testSelect.value : "all";

  try {
    const resp = await apiFetch("/api/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: selectedChannel }),
    });
    const data = await resp.json().catch(() => ({}));

    if (resp.status === 401) {
      showNotificationFeedback("Authentication required. Please sign in again.", false);
      return;
    }

    if (!resp.ok) {
      const errMsg =
        data.detail || data.message || `Server returned error (${resp.status})`;
      showNotificationFeedback(errMsg, false);
      return;
    }

    if (data.success) {
      showNotificationFeedback(
        data.message || `Test notification sent successfully to ${selectedChannel}!`,
        true
      );
    } else {
      showNotificationFeedback(
        data.message || "Failed to send test notification.",
        false
      );
    }

    // Automatically refresh notification history so the new test log appears immediately
    await refreshNotificationHistory();
  } catch (err) {
    showNotificationFeedback(
      `Error sending test notification: ${err instanceof Error ? err.message : String(err)}`,
      false
    );
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.innerHTML = originalHtml;
  }
}

const sendTestNotification = handleSendTestNotification;

/**
 * Refresh notification history table via WebSocket or HTTP fallback.
 */
async function refreshNotificationHistory() {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    try {
      wsConnection.send(
        JSON.stringify({ action: "refresh_module", module: "notifications" })
      );
    } catch (_) {}
  }
  try {
    const resp = await apiFetch("/api/history?limit=20");
    if (resp.ok) {
      const historyData = await resp.json().catch(() => ({}));
      renderNotificationHistory(historyData);
      setModuleLastUpdated("notifications");
    }
  } catch (err) {
    console.warn("Failed to fetch updated notification history:", err);
  }
}

/**
 * Escape HTML to prevent XSS when rendering user or container data.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Switch view panel between 'overview', 'raid', 'notifications', 'containers', 'services', 'processes', 'users', and 'audit'.
 */
function switchViewTab(tabName, updateHash = true) {
  const normTab = (tabName || "").toLowerCase();
  const isNotifications = normTab === "notifications";
  const isContainers = normTab === "containers";
  const isRaid = normTab === "raid" || normTab === "storage" || normTab === "disks";
  const isServices = normTab === "services";
  const isProcesses = normTab === "processes";
  const isUsers = normTab === "users";
  const isAudit = normTab === "audit";
  const isPackages = normTab === "packages" || normTab === "updates" || normTab === "dpkg" || normTab === "apt";
  currentViewTab = isRaid ? "raid" : (normTab || "overview");

  const overviewTab = document.getElementById("nav-tab-overview");
  const raidTab = document.getElementById("nav-tab-raid");
  const notificationsTab = document.getElementById("nav-tab-notifications");
  const containersTab = document.getElementById("nav-tab-containers");
  const servicesTab = document.getElementById("nav-tab-services");
  const processesTab = document.getElementById("nav-tab-processes");
  const usersTab = document.getElementById("nav-tab-users");
  const auditTab = document.getElementById("nav-tab-audit");
  const packagesTab = document.getElementById("nav-tab-packages");

  const overviewView = document.getElementById("view-overview");
  const raidView = document.getElementById("view-raid");
  const notificationsView = document.getElementById("view-notifications");
  const containersView = document.getElementById("view-containers");
  const servicesView = document.getElementById("view-services");
  const processesView = document.getElementById("view-processes");
  const usersView = document.getElementById("view-users");
  const auditView = document.getElementById("view-audit");
  const packagesView = document.getElementById("view-packages");

  const pageTitle = document.getElementById("page-title");

  overviewTab?.classList.remove("active");
  overviewTab?.setAttribute("aria-selected", "false");
  raidTab?.classList.remove("active");
  raidTab?.setAttribute("aria-selected", "false");
  notificationsTab?.classList.remove("active");
  notificationsTab?.setAttribute("aria-selected", "false");
  containersTab?.classList.remove("active");
  containersTab?.setAttribute("aria-selected", "false");
  servicesTab?.classList.remove("active");
  servicesTab?.setAttribute("aria-selected", "false");
  processesTab?.classList.remove("active");
  processesTab?.setAttribute("aria-selected", "false");
  usersTab?.classList.remove("active");
  usersTab?.setAttribute("aria-selected", "false");
  auditTab?.classList.remove("active");
  auditTab?.setAttribute("aria-selected", "false");
  packagesTab?.classList.remove("active");
  packagesTab?.setAttribute("aria-selected", "false");

  overviewView?.classList.add("hidden");
  raidView?.classList.add("hidden");
  notificationsView?.classList.add("hidden");
  containersView?.classList.add("hidden");
  servicesView?.classList.add("hidden");
  processesView?.classList.add("hidden");
  usersView?.classList.add("hidden");
  auditView?.classList.add("hidden");
  packagesView?.classList.add("hidden");

  // Automatically close mobile sidebar if opened
  document.getElementById("app-sidebar")?.classList.remove("open");
  document.getElementById("sidebar-backdrop")?.classList.remove("active");

  if (isContainers) {
    containersTab?.classList.add("active");
    containersTab?.setAttribute("aria-selected", "true");
    containersView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Container Management";

    if (updateHash && !window.location.hash.startsWith("#containers")) {
      history.replaceState(null, "", `#containers/${currentDockerSubtab}`);
    }

    if (isAuthenticated) {
      fetchDockerStatus();
      refreshDockerSubtab(currentDockerSubtab);
      if (!cachedDockerUpdates || cachedDockerUpdates.length === 0) {
        fetchDockerUpdates({ background: true });
      }
    }
  } else if (isRaid) {
    raidTab?.classList.add("active");
    raidTab?.setAttribute("aria-selected", "true");
    raidView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Storage";

    if (updateHash && window.location.hash !== "#storage" && window.location.hash !== "#raid" && window.location.hash !== "#disks") {
      history.replaceState(null, "", "#storage");
    }

    renderStorageMounts(cachedStorageDisks);
  } else if (isNotifications) {
    notificationsTab?.classList.add("active");
    notificationsTab?.setAttribute("aria-selected", "true");
    notificationsView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Notifications";

    if (updateHash && window.location.hash !== "#notifications") {
      history.replaceState(null, "", "#notifications");
    }

    if (isAuthenticated) {
      fetchNotificationCenterConfig();
    }
  } else if (isServices) {
    servicesTab?.classList.add("active");
    servicesTab?.setAttribute("aria-selected", "true");
    servicesView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "System Services";

    if (updateHash && window.location.hash !== "#services") {
      history.replaceState(null, "", "#services");
    }

    if (isAuthenticated) {
      fetchSystemServices();
    }
  } else if (isProcesses) {
    processesTab?.classList.add("active");
    processesTab?.setAttribute("aria-selected", "true");
    processesView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Process Explorer";

    if (updateHash && window.location.hash !== "#processes") {
      history.replaceState(null, "", "#processes");
    }

    if (isAuthenticated) {
      fetchProcesses();
    }
  } else if (isUsers) {
    usersTab?.classList.add("active");
    usersTab?.setAttribute("aria-selected", "true");
    usersView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Users & Groups";

    if (updateHash && !window.location.hash.startsWith("#users")) {
      history.replaceState(null, "", "#users");
    }

    if (isAuthenticated) {
      switchUsersSubtab(currentUsersSubtab);
    }
  } else if (isAudit) {
    auditTab?.classList.add("active");
    auditTab?.setAttribute("aria-selected", "true");
    auditView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Security & Audit Logs";

    if (updateHash && window.location.hash !== "#audit") {
      history.replaceState(null, "", "#audit");
    }

    if (isAuthenticated) {
      fetchAuditLogs();
    }
  } else if (isPackages) {
    packagesTab?.classList.add("active");
    packagesTab?.setAttribute("aria-selected", "true");
    packagesView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "Packages & System Updates";

    if (updateHash && !window.location.hash.startsWith("#packages") && !window.location.hash.startsWith("#updates")) {
      history.replaceState(null, "", "#packages");
    }

    if (isAuthenticated) {
      refreshPackagesView();
    }
  } else {
    overviewTab?.classList.add("active");
    overviewTab?.setAttribute("aria-selected", "true");
    overviewView?.classList.remove("hidden");
    if (pageTitle) pageTitle.textContent = "System Overview";

    if (updateHash && window.location.hash !== "" && window.location.hash !== "#overview") {
      history.replaceState(null, "", "#overview");
    }
  }
}

/**
 * Synchronize view tab state from location.hash or location.pathname.
 */
function syncTabFromHash() {
  const hash = (window.location.hash || "").replace("#", "").toLowerCase().trim();
  const path = (window.location.pathname || "").toLowerCase().replace(/^\/+|\/+$/g, "").trim();
  const route = hash || path;

  if (route.startsWith("containers")) {
    const parts = route.split("/");
    const subtab = parts[1] || currentDockerSubtab || "stacks";
    switchViewTab("containers", false);
    switchDockerSubtab(subtab, false);
  } else if (route === "raid" || route === "storage" || route === "disks") {
    switchViewTab("raid", false);
  } else if (route === "services" || route === "systemctl") {
    switchViewTab("services", false);
  } else if (route === "processes" || route === "proc" || route === "tasks") {
    switchViewTab("processes", false);
  } else if (route.startsWith("users") || route.startsWith("groups")) {
    switchViewTab("users", false);
    if (route.includes("groups")) {
      switchUsersSubtab("groups");
    } else {
      switchUsersSubtab("users");
    }
  } else if (route === "audit" || route === "security" || route === "audit-log") {
    switchViewTab("audit", false);
  } else if (route.startsWith("packages") || route.startsWith("updates") || route === "dpkg" || route === "apt") {
    switchViewTab("packages", false);
  } else if (route === "logs" || route === "vigil-logs" || route === "system-logs") {
    openVigilLogsModal();
  } else if (route === "notifications" || route === "notifications-logs") {
    switchViewTab("notifications", false);
  } else {
    switchViewTab("overview", false);
  }
}

/* =========================================================================
 * Services Summary Ribbon Helper
 * ========================================================================= */
function renderServicesSummary(summary) {
  if (!summary) return;
  const running = Number(summary.running) || 0;
  const failed = Number(summary.failed) || 0;
  const badge = document.getElementById("overview-services-badge");
  const summaryEl = document.getElementById("overview-services-summary");
  if (badge) {
    if (failed > 0) {
      badge.textContent = `${failed} FAILED`;
      badge.className = "status-badge status-danger";
    } else if (running > 0) {
      badge.textContent = "ACTIVE";
      badge.className = "status-badge status-ok";
    } else {
      badge.textContent = "OK";
      badge.className = "status-badge status-ok";
    }
  }
  if (summaryEl) {
    summaryEl.textContent = `${running} Running, ${failed} Failed`;
  }
}

/* =========================================================================
 * Systemctl Services Monitoring View (#view-services)
 * ========================================================================= */
let cachedServicesData = null;
let servicesFilterState = "all";
let servicesSearchTerm = "";
let currentViewingService = null;

async function fetchSystemServices() {
  const refreshBtn = document.getElementById("refresh-services-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");
  try {
    const resp = await apiFetch("/api/services");
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(
          "Endpoint not found (HTTP 404). If you just updated Vigil, please restart the Vigil service ('sudo systemctl restart vigil' or 'vigil restart') to load backend endpoints."
        );
      }
      throw new Error(`Failed to fetch services (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedServicesData = data;
    renderSystemServices(data);
  } catch (err) {
    console.error("fetchSystemServices error:", err);
    showToast({
      title: "Services Error",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

function renderSystemServices(data) {
  if (!data) return;

  const lastUpdatedEl = document.getElementById("services-last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  const summary = data.summary || {};
  const totalCount = Number(summary.total) || (Array.isArray(data.services) ? data.services.length : 0);
  const runningCount = Number(summary.running) || 0;
  const failedCount = Number(summary.failed) || 0;
  const inactiveCount = Number(summary.inactive) || 0;

  const totalEl = document.getElementById("services-total-count");
  if (totalEl) totalEl.textContent = String(totalCount);

  const runningEl = document.getElementById("services-running-count");
  if (runningEl) runningEl.textContent = String(runningCount);

  const failedEl = document.getElementById("services-failed-count");
  if (failedEl) failedEl.textContent = String(failedCount);

  const failedBadge = document.getElementById("services-failed-badge");
  if (failedBadge) {
    if (failedCount > 0) {
      failedBadge.className = "status-badge status-danger";
    } else {
      failedBadge.className = "status-badge status-ok";
    }
  }

  const inactiveEl = document.getElementById("services-inactive-count");
  if (inactiveEl) inactiveEl.textContent = String(inactiveCount);

  renderServicesSummary(summary);

  const navBadge = document.getElementById("nav-tab-services-badge");
  if (navBadge) {
    if (failedCount > 0) {
      navBadge.textContent = `${failedCount}`;
      navBadge.className = "nav-tab-badge danger";
      navBadge.classList.remove("hidden");
    } else {
      navBadge.classList.add("hidden");
    }
  }

  // Filter & Render Table
  const tbody = document.getElementById("services-table-body");
  if (!tbody) return;

  const services = Array.isArray(data.services) ? data.services : [];
  const term = (servicesSearchTerm || "").toLowerCase().trim();
  const stateFilter = (servicesFilterState || "all").toLowerCase();

  const filtered = services.filter((s) => {
    if (stateFilter === "running") {
      if (s.active_state !== "active" || s.sub_state !== "running") return false;
    } else if (stateFilter === "failed") {
      if (s.active_state !== "failed") return false;
    } else if (stateFilter === "inactive") {
      if (!["inactive", "dead"].includes(s.active_state)) return false;
    }

    if (term) {
      const matchUnit = (s.unit || "").toLowerCase().includes(term);
      const matchName = (s.name || "").toLowerCase().includes(term);
      const matchDesc = (s.description || "").toLowerCase().includes(term);
      if (!matchUnit && !matchName && !matchDesc) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No matching services found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((s) => {
    const isFailed = s.active_state === "failed";
    const isActive = s.active_state === "active";
    let stateBadgeClass = "status-badge status-muted";
    if (isFailed) stateBadgeClass = "status-badge status-danger";
    else if (isActive) stateBadgeClass = "status-badge status-ok";

    const isRunning = s.sub_state === "running";
    const safeUnit = escapeHtml(s.unit || "");

    return `
      <tr>
        <td class="mono-text font-bold">${safeUnit}</td>
        <td><span class="${stateBadgeClass}">${escapeHtml(s.active_state || "unknown")}</span></td>
        <td><span class="kind-badge">${escapeHtml(s.sub_state || "-")}</span></td>
        <td class="text-secondary" style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(s.description || "-")}</td>
        <td>
          <div class="table-actions-cell">
            <button class="btn-action-sm btn-service-restart" data-service="${safeUnit}" title="Restart Service">Restart</button>
            ${isRunning
              ? `<button class="btn-action-sm btn-action-danger btn-service-stop" data-service="${safeUnit}" title="Stop Service">Stop</button>`
              : `<button class="btn-action-sm btn-action-success btn-service-start" data-service="${safeUnit}" title="Start Service">Start</button>`
            }
            <button class="btn-action-sm btn-service-logs" data-service="${safeUnit}" title="Inspect Journal Logs">Logs</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-service-restart").forEach((btn) => {
    btn.addEventListener("click", () => handleServiceAction(btn.getAttribute("data-service"), "restart"));
  });
  tbody.querySelectorAll(".btn-service-stop").forEach((btn) => {
    btn.addEventListener("click", () => handleServiceAction(btn.getAttribute("data-service"), "stop"));
  });
  tbody.querySelectorAll(".btn-service-start").forEach((btn) => {
    btn.addEventListener("click", () => handleServiceAction(btn.getAttribute("data-service"), "start"));
  });
  tbody.querySelectorAll(".btn-service-logs").forEach((btn) => {
    btn.addEventListener("click", () => openServiceLogsModal(btn.getAttribute("data-service")));
  });
}

async function handleServiceAction(serviceName, action) {
  if (!serviceName || !action) return;
  try {
    const resp = await apiFetch("/api/services/" + encodeURIComponent(serviceName) + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `Action failed with HTTP ${resp.status}`);
    }
    showToast({
      title: "Service Action Executed",
      message: `${serviceName}: ${action} completed successfully`,
      type: "success",
    });
    fetchSystemServices();
  } catch (err) {
    showToast({
      title: "Action Failed",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  }
}

async function openVigilLogsModal() {
  await openServiceLogsModal("vigil.service");
}

async function openServiceLogsModal(serviceName) {
  currentViewingService = serviceName;
  const modal = document.getElementById("service-logs-modal");
  const title = document.getElementById("service-logs-title");
  const content = document.getElementById("service-logs-content");
  const feedback = document.getElementById("service-logs-feedback");

  const isVigil = serviceName === "vigil.service" || serviceName === "vigil";
  if (title) title.textContent = isVigil ? "Vigil System & Service Logs" : `Journal Logs: ${serviceName}`;
  if (content) content.textContent = "Loading journald execution logs...";
  if (feedback) feedback.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");

  await fetchServiceLogs(serviceName);
}

function closeServiceLogsModal() {
  const modal = document.getElementById("service-logs-modal");
  if (modal) modal.classList.add("hidden");
  currentViewingService = null;
}

async function fetchServiceLogs(serviceName) {
  if (!serviceName) return;
  const content = document.getElementById("service-logs-content");
  const feedback = document.getElementById("service-logs-feedback");
  const linesSelect = document.getElementById("service-logs-lines-select");
  const linesVal = linesSelect ? linesSelect.value : "100";

  try {
    const isVigil = serviceName === "vigil.service" || serviceName === "vigil";
    const endpoint = isVigil
      ? `/api/vigil/logs?lines=${encodeURIComponent(linesVal)}`
      : `/api/services/${encodeURIComponent(serviceName)}/logs?lines=${encodeURIComponent(linesVal)}`;

    const resp = await apiFetch(endpoint);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    const lines = Array.isArray(data.logs) ? data.logs : [];
    if (content) {
      content.textContent = lines.length > 0 ? lines.join("\n") : "No recent journal entries recorded for this service unit.";
      content.scrollTop = content.scrollHeight;
    }
  } catch (err) {
    if (feedback) {
      feedback.textContent = `Error reading journal: ${err instanceof Error ? err.message : String(err)}`;
      feedback.classList.remove("hidden");
    }
  }
}

/* =========================================================================
 * Process Explorer View (#view-processes)
 * ========================================================================= */
let cachedProcessesData = null;
let processesSort = "cpu";
let processesLimit = 50;
let processesSearchTerm = "";
let processToKill = null;

async function fetchProcesses() {
  const refreshBtn = document.getElementById("refresh-processes-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");
  try {
    const query = "?sort=" + encodeURIComponent(processesSort) + "&limit=" + encodeURIComponent(processesLimit) + (processesSearchTerm ? "&q=" + encodeURIComponent(processesSearchTerm) : "");
    const resp = await apiFetch("/api/processes" + query);
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(
          "Endpoint not found (HTTP 404). If you just updated Vigil, please restart the Vigil service ('sudo systemctl restart vigil' or 'vigil restart') to load backend endpoints."
        );
      }
      throw new Error(`Failed to fetch processes (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedProcessesData = data;
    renderProcesses(data);
  } catch (err) {
    console.error("fetchProcesses error:", err);
    showToast({
      title: "Process Explorer Error",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

function renderProcesses(data) {
  if (!data) return;

  const lastUpdatedEl = document.getElementById("processes-last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  const summary = data.summary || {};
  const totalProcesses = Number(summary.total_processes) || 0;
  const runningCount = Number(summary.running_count) || 0;
  const sleepingCount = Number(summary.sleeping_count) || 0;

  const totalEl = document.getElementById("proc-total-count");
  if (totalEl) totalEl.textContent = String(totalProcesses);

  const runningEl = document.getElementById("proc-running-count");
  if (runningEl) runningEl.textContent = String(runningCount);

  const sleepingEl = document.getElementById("proc-sleeping-count");
  if (sleepingEl) sleepingEl.textContent = String(sleepingCount);

  const topCpuEl = document.getElementById("proc-top-cpu");
  if (topCpuEl) topCpuEl.textContent = summary.top_cpu_process || "--";

  const topMemEl = document.getElementById("proc-top-memory");
  if (topMemEl) topMemEl.textContent = summary.top_memory_process || "--";

  const tbody = document.getElementById("processes-table-body");
  if (!tbody) return;

  const procs = Array.isArray(data.processes) ? data.processes : [];
  if (procs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No matching processes found.</td></tr>`;
    return;
  }

  tbody.innerHTML = procs.map((p) => {
    const cpuPct = Math.max(0, Math.min(100, Number(p.cpu_percent) || 0));
    const memPct = Math.max(0, Math.min(100, Number(p.memory_percent) || 0));

    let cpuBarClass = "proc-mini-bar-fill";
    if (cpuPct >= 75) cpuBarClass += " danger";
    else if (cpuPct >= 40) cpuBarClass += " warn";

    let memBarClass = "proc-mini-bar-fill";
    if (memPct >= 75) memBarClass += " danger";
    else if (memPct >= 40) memBarClass += " warn";

    const isRunning = (p.status || "").toLowerCase() === "running";
    const statusBadgeClass = isRunning ? "status-badge status-ok" : "status-badge status-muted";

    return `
      <tr>
        <td class="mono-text font-bold">${p.pid}</td>
        <td class="font-bold">${escapeHtml(p.name || "unknown")}</td>
        <td class="text-secondary mono-text">${escapeHtml(p.username || "-")}</td>
        <td class="proc-metric-cell">
          <div class="proc-metric-row">
            <span class="mono-text">${cpuPct.toFixed(1)}%</span>
          </div>
          <div class="proc-mini-bar">
            <div class="${cpuBarClass}" style="width: ${cpuPct.toFixed(1)}%"></div>
          </div>
        </td>
        <td class="proc-metric-cell">
          <div class="proc-metric-row">
            <span class="mono-text">${memPct.toFixed(1)}%</span>
          </div>
          <div class="proc-mini-bar">
            <div class="${memBarClass}" style="width: ${memPct.toFixed(1)}%"></div>
          </div>
        </td>
        <td><span class="${statusBadgeClass}">${escapeHtml(p.status || "-")}</span></td>
        <td class="mono-text">${p.num_threads || 1}</td>
        <td>
          <div class="table-actions-cell">
            <button class="btn-action-sm btn-action-danger btn-kill-proc" data-pid="${p.pid}" data-name="${escapeHtml(p.name || "")}" title="Terminate Process">Kill</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-kill-proc").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pid = parseInt(btn.getAttribute("data-pid") || "0", 10);
      const name = btn.getAttribute("data-name") || "";
      openProcessKillModal({ pid, name });
    });
  });
}

function openProcessKillModal(proc) {
  processToKill = proc;
  const modal = document.getElementById("process-kill-modal");
  const pidEl = document.getElementById("kill-process-pid");
  const nameEl = document.getElementById("kill-process-name");
  const feedback = document.getElementById("kill-process-feedback");
  const sigSelect = document.getElementById("kill-signal-select");

  if (pidEl) pidEl.textContent = String(proc.pid);
  if (nameEl) nameEl.textContent = proc.name || "--";
  if (sigSelect) sigSelect.value = "SIGTERM";
  if (feedback) feedback.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");
}

function closeProcessKillModal() {
  const modal = document.getElementById("process-kill-modal");
  if (modal) modal.classList.add("hidden");
  processToKill = null;
}

async function handleKillProcess() {
  if (!processToKill) return;
  const sigSelect = document.getElementById("kill-signal-select");
  const signal = sigSelect ? sigSelect.value : "SIGTERM";
  const feedback = document.getElementById("kill-process-feedback");

  try {
    const resp = await apiFetch("/api/processes/" + processToKill.pid + "/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "Process Terminated",
      message: `PID ${processToKill.pid} (${processToKill.name}) sent ${signal}`,
      type: "warning",
    });
    closeProcessKillModal();
    fetchProcesses();
  } catch (err) {
    if (feedback) {
      feedback.textContent = err instanceof Error ? err.message : String(err);
      feedback.classList.remove("hidden");
    }
  }
}

/* =========================================================================
 * Linux Users & Groups View (#view-users)
 * ========================================================================= */
let currentUsersSubtab = "users";
let cachedUsersData = null;
let cachedGroupsData = null;
let usersRegularOnly = true;
let usersSearchTerm = "";
let groupsSearchTerm = "";
let editingUser = null;
let managingGroup = null;

function switchUsersSubtab(subtab) {
  currentUsersSubtab = subtab;
  const isUsers = subtab === "users";
  const usersBtn = document.getElementById("subtab-users-btn");
  const groupsBtn = document.getElementById("subtab-groups-btn");
  const usersPanel = document.getElementById("users-subtab-panel");
  const groupsPanel = document.getElementById("groups-subtab-panel");

  if (isUsers) {
    usersBtn?.classList.add("active");
    usersBtn?.setAttribute("aria-selected", "true");
    groupsBtn?.classList.remove("active");
    groupsBtn?.setAttribute("aria-selected", "false");
    usersPanel?.classList.remove("hidden");
    groupsPanel?.classList.add("hidden");
    fetchSystemUsers();
  } else {
    groupsBtn?.classList.add("active");
    groupsBtn?.setAttribute("aria-selected", "true");
    usersBtn?.classList.remove("active");
    usersBtn?.setAttribute("aria-selected", "false");
    groupsPanel?.classList.remove("hidden");
    usersPanel?.classList.add("hidden");
    fetchSystemGroups();
  }
}

async function fetchSystemUsers() {
  const refreshBtn = document.getElementById("refresh-users-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");
  try {
    const resp = await apiFetch("/api/system/users");
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(
          "Endpoint not found (HTTP 404). If you just updated Vigil, please restart the Vigil service ('sudo systemctl restart vigil' or 'vigil restart') to load backend endpoints."
        );
      }
      throw new Error(`Failed to fetch users (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedUsersData = data;
    renderSystemUsers(data);
  } catch (err) {
    console.error("fetchSystemUsers error:", err);
    showToast({
      title: "Users Error",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

function renderSystemUsers(data) {
  if (!data) return;

  const lastUpdatedEl = document.getElementById("users-last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  const summary = data.summary || {};
  const totalCount = Number(summary.total_users) || 0;
  const regularCount = Number(summary.regular_users_count) || 0;
  const systemCount = Number(summary.system_users_count) || 0;

  const totalEl = document.getElementById("users-total-count");
  if (totalEl) totalEl.textContent = String(totalCount);

  const regEl = document.getElementById("users-regular-count");
  if (regEl) regEl.textContent = String(regularCount);

  const sysEl = document.getElementById("users-system-count");
  if (sysEl) sysEl.textContent = String(systemCount);

  const badgeEl = document.getElementById("subtab-users-badge");
  if (badgeEl) badgeEl.textContent = String(regularCount);

  const tbody = document.getElementById("users-table-body");
  if (!tbody) return;

  const users = Array.isArray(data.users) ? data.users : [];
  const term = (usersSearchTerm || "").toLowerCase().trim();

  const filtered = users.filter((u) => {
    if (usersRegularOnly && u.is_system) return false;
    if (term) {
      const matchUser = (u.username || "").toLowerCase().includes(term);
      const matchName = (u.name || "").toLowerCase().includes(term);
      const matchShell = (u.shell || "").toLowerCase().includes(term);
      const matchHome = (u.home || "").toLowerCase().includes(term);
      if (!matchUser && !matchName && !matchShell && !matchHome) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No matching users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((u) => {
    const isSys = Boolean(u.is_system);
    const typeBadge = isSys
      ? `<span class="kind-badge">System</span>`
      : `<span class="status-badge status-ok">Human</span>`;

    const groups = Array.isArray(u.groups) ? u.groups : [];
    const groupChips = groups.length > 0
      ? groups.map((g) => `<span class="chip-tag">${escapeHtml(g)}</span>`).join("")
      : `<span class="text-muted">-</span>`;

    const safeUser = escapeHtml(u.username || "");

    return `
      <tr>
        <td class="mono-text font-bold">${safeUser}</td>
        <td class="mono-text text-secondary">${u.uid} / ${u.gid}</td>
        <td>${escapeHtml(u.name || "-")}</td>
        <td class="mono-text text-secondary">${escapeHtml(u.home || "-")}</td>
        <td class="mono-text">${escapeHtml(u.shell || "-")}</td>
        <td><div class="chips-wrap">${groupChips}</div></td>
        <td>${typeBadge}</td>
        <td>
          <div class="table-actions-cell">
            <button class="btn-action-sm btn-edit-user" data-user='${JSON.stringify({ username: u.username, shell: u.shell, groups: u.groups })}'>Edit</button>
            ${isSys ? "" : `<button class="btn-action-sm btn-action-danger btn-delete-user" data-username="${safeUser}">Delete</button>`}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-edit-user").forEach((btn) => {
    btn.addEventListener("click", () => {
      try {
        const udata = JSON.parse(btn.getAttribute("data-user") || "{}");
        openEditUserModal(udata);
      } catch (e) {}
    });
  });

  tbody.querySelectorAll(".btn-delete-user").forEach((btn) => {
    btn.addEventListener("click", () => {
      const username = btn.getAttribute("data-username");
      if (username) handleDeleteUser(username);
    });
  });
}

async function fetchSystemGroups() {
  const refreshBtn = document.getElementById("refresh-users-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");
  try {
    const resp = await apiFetch("/api/system/groups");
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(
          "Endpoint not found (HTTP 404). If you just updated Vigil, please restart the Vigil service ('sudo systemctl restart vigil' or 'vigil restart') to load backend endpoints."
        );
      }
      throw new Error(`Failed to fetch groups (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedGroupsData = data;
    renderSystemGroups(data);
  } catch (err) {
    console.error("fetchSystemGroups error:", err);
    showToast({
      title: "Groups Error",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

function renderSystemGroups(data) {
  if (!data) return;

  const summary = data.summary || {};
  const totalCount = Number(summary.total_groups) || 0;
  const regularCount = Number(summary.regular_groups_count) || 0;

  const totalEl = document.getElementById("groups-total-count");
  if (totalEl) totalEl.textContent = String(totalCount);

  const regEl = document.getElementById("groups-regular-count");
  if (regEl) regEl.textContent = String(regularCount);

  const badgeEl = document.getElementById("subtab-groups-badge");
  if (badgeEl) badgeEl.textContent = String(regularCount);

  const tbody = document.getElementById("groups-table-body");
  if (!tbody) return;

  const groups = Array.isArray(data.groups) ? data.groups : [];
  const term = (groupsSearchTerm || "").toLowerCase().trim();

  const filtered = groups.filter((g) => {
    if (term) {
      const matchName = (g.name || "").toLowerCase().includes(term);
      const matchMember = Array.isArray(g.members) && g.members.some((m) => m.toLowerCase().includes(term));
      if (!matchName && !matchMember) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No matching groups found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((g) => {
    const members = Array.isArray(g.members) ? g.members : [];
    const memberChips = members.length > 0
      ? members.map((m) => `<span class="chip-tag chip-primary">${escapeHtml(m)}</span>`).join("")
      : `<span class="text-muted">No members</span>`;

    const safeGroup = escapeHtml(g.name || "");
    const isSys = Boolean(g.is_system);

    return `
      <tr>
        <td class="mono-text font-bold">${safeGroup}</td>
        <td class="mono-text text-secondary">${g.gid}</td>
        <td><div class="chips-wrap">${memberChips}</div></td>
        <td>
          <div class="table-actions-cell">
            <button class="btn-action-sm btn-manage-members" data-group="${safeGroup}">Members</button>
            ${isSys ? "" : `<button class="btn-action-sm btn-action-danger btn-delete-group" data-group="${safeGroup}">Delete</button>`}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-manage-members").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gname = btn.getAttribute("data-group");
      if (gname) openGroupMemberModal(gname);
    });
  });

  tbody.querySelectorAll(".btn-delete-group").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gname = btn.getAttribute("data-group");
      if (gname) handleDeleteGroup(gname);
    });
  });
}

function openAddUserModal() {
  const modal = document.getElementById("modal-add-user");
  const form = document.getElementById("form-add-user");
  const feedback = document.getElementById("add-user-feedback");
  if (form) form.reset();
  const shellInput = document.getElementById("input-add-user-shell");
  if (shellInput) shellInput.value = "/bin/bash";
  const homeCheck = document.getElementById("input-add-user-home");
  if (homeCheck) homeCheck.checked = true;
  if (feedback) feedback.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");
}

function closeAddUserModal() {
  const modal = document.getElementById("modal-add-user");
  if (modal) modal.classList.add("hidden");
}

async function handleAddUserSubmit(e) {
  e.preventDefault();
  const usernameInput = document.getElementById("input-add-user-name");
  const shellInput = document.getElementById("input-add-user-shell");
  const groupsInput = document.getElementById("input-add-user-groups");
  const homeCheck = document.getElementById("input-add-user-home");
  const feedback = document.getElementById("add-user-feedback");

  const username = (usernameInput?.value || "").trim();
  const shell = (shellInput?.value || "").trim() || "/bin/bash";
  const rawGroups = (groupsInput?.value || "").trim();
  const groups = rawGroups ? rawGroups.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const create_home = homeCheck ? homeCheck.checked : true;

  try {
    const resp = await apiFetch("/api/system/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, shell, groups, create_home }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "User Created",
      message: `User '${username}' created successfully`,
      type: "success",
    });
    closeAddUserModal();
    fetchSystemUsers();
  } catch (err) {
    if (feedback) {
      feedback.textContent = err instanceof Error ? err.message : String(err);
      feedback.classList.remove("hidden");
    }
  }
}

function openEditUserModal(udata) {
  editingUser = udata;
  const modal = document.getElementById("modal-edit-user");
  const nameDisp = document.getElementById("edit-user-name-display");
  const shellInput = document.getElementById("input-edit-user-shell");
  const groupsInput = document.getElementById("input-edit-user-groups");
  const lockedCheck = document.getElementById("input-edit-user-locked");
  const feedback = document.getElementById("edit-user-feedback");

  if (nameDisp) nameDisp.textContent = udata.username;
  if (shellInput) shellInput.value = udata.shell || "/bin/bash";
  if (groupsInput) groupsInput.value = Array.isArray(udata.groups) ? udata.groups.join(",") : "";
  if (lockedCheck) lockedCheck.checked = false;
  if (feedback) feedback.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");
}

function closeEditUserModal() {
  const modal = document.getElementById("modal-edit-user");
  if (modal) modal.classList.add("hidden");
  editingUser = null;
}

async function handleEditUserSubmit(e) {
  e.preventDefault();
  if (!editingUser) return;
  const shellInput = document.getElementById("input-edit-user-shell");
  const groupsInput = document.getElementById("input-edit-user-groups");
  const lockedCheck = document.getElementById("input-edit-user-locked");
  const feedback = document.getElementById("edit-user-feedback");

  const shell = (shellInput?.value || "").trim();
  const rawGroups = (groupsInput?.value || "").trim();
  const groups = rawGroups ? rawGroups.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const locked = lockedCheck ? lockedCheck.checked : false;

  try {
    const resp = await apiFetch("/api/system/users/" + encodeURIComponent(editingUser.username), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell, groups, locked }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "User Updated",
      message: `User '${editingUser.username}' updated successfully`,
      type: "success",
    });
    closeEditUserModal();
    fetchSystemUsers();
  } catch (err) {
    if (feedback) {
      feedback.textContent = err instanceof Error ? err.message : String(err);
      feedback.classList.remove("hidden");
    }
  }
}

async function handleDeleteUser(username) {
  if (!confirm(`Are you sure you want to delete user '${username}'?`)) return;
  try {
    const resp = await apiFetch("/api/system/users/" + encodeURIComponent(username), {
      method: "DELETE",
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "User Deleted",
      message: `User '${username}' deleted successfully`,
      type: "warning",
    });
    fetchSystemUsers();
  } catch (err) {
    showToast({
      title: "Delete Failed",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  }
}

function openAddGroupModal() {
  const modal = document.getElementById("modal-add-group");
  const form = document.getElementById("form-add-group");
  const feedback = document.getElementById("add-group-feedback");
  if (form) form.reset();
  if (feedback) feedback.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");
}

function closeAddGroupModal() {
  const modal = document.getElementById("modal-add-group");
  if (modal) modal.classList.add("hidden");
}

async function handleAddGroupSubmit(e) {
  e.preventDefault();
  const nameInput = document.getElementById("input-add-group-name");
  const gidInput = document.getElementById("input-add-group-gid");
  const feedback = document.getElementById("add-group-feedback");

  const name = (nameInput?.value || "").trim();
  const gidVal = gidInput?.value ? parseInt(gidInput.value, 10) : null;

  try {
    const payload = { name };
    if (gidVal !== null && !isNaN(gidVal)) payload.gid = gidVal;
    const resp = await apiFetch("/api/system/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "Group Created",
      message: `Group '${name}' created successfully`,
      type: "success",
    });
    closeAddGroupModal();
    fetchSystemGroups();
  } catch (err) {
    if (feedback) {
      feedback.textContent = err instanceof Error ? err.message : String(err);
      feedback.classList.remove("hidden");
    }
  }
}

function openGroupMemberModal(groupname) {
  managingGroup = { name: groupname };
  const modal = document.getElementById("modal-group-member");
  const form = document.getElementById("form-group-member");
  const nameDisp = document.getElementById("member-group-name-display");
  const feedback = document.getElementById("group-member-feedback");
  if (form) form.reset();
  if (nameDisp) nameDisp.textContent = groupname;
  if (feedback) feedback.classList.add("hidden");
  if (modal) modal.classList.remove("hidden");
}

function closeGroupMemberModal() {
  const modal = document.getElementById("modal-group-member");
  if (modal) modal.classList.add("hidden");
  managingGroup = null;
}

async function handleGroupMemberSubmit(e) {
  e.preventDefault();
  if (!managingGroup) return;
  const actionSelect = document.getElementById("input-member-action");
  const usernameInput = document.getElementById("input-member-username");
  const feedback = document.getElementById("group-member-feedback");

  const action = actionSelect?.value || "add";
  const username = (usernameInput?.value || "").trim();

  try {
    const resp = await apiFetch("/api/system/groups/" + encodeURIComponent(managingGroup.name) + "/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, username }),
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "Membership Updated",
      message: `User '${username}' ${action}ed to group '${managingGroup.name}'`,
      type: "success",
    });
    closeGroupMemberModal();
    fetchSystemGroups();
  } catch (err) {
    if (feedback) {
      feedback.textContent = err instanceof Error ? err.message : String(err);
      feedback.classList.remove("hidden");
    }
  }
}

async function handleDeleteGroup(groupname) {
  if (!confirm(`Are you sure you want to delete group '${groupname}'?`)) return;
  try {
    const resp = await apiFetch("/api/system/groups/" + encodeURIComponent(groupname), {
      method: "DELETE",
    });
    const result = await resp.json();
    if (!resp.ok) {
      throw new Error(result.detail || `HTTP ${resp.status}`);
    }
    showToast({
      title: "Group Deleted",
      message: `Group '${groupname}' deleted successfully`,
      type: "warning",
    });
    fetchSystemGroups();
  } catch (err) {
    showToast({
      title: "Delete Failed",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  }
}

/* =========================================================================
 * Security & Audit Logs View (#view-audit)
 * ========================================================================= */
let cachedAuditData = null;
let auditSeverityFilter = "";
let auditSearchTerm = "";
let auditLimit = 50;
let auditOffset = 0;

async function fetchAuditLogs() {
  const refreshBtn = document.getElementById("refresh-audit-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");
  try {
    const query = "?limit=" + encodeURIComponent(auditLimit) + "&offset=" + encodeURIComponent(auditOffset) + (auditSeverityFilter ? "&severity=" + encodeURIComponent(auditSeverityFilter) : "") + (auditSearchTerm ? "&q=" + encodeURIComponent(auditSearchTerm) : "");
    const resp = await apiFetch("/api/audit/logs" + query);
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error(
          "Endpoint not found (HTTP 404). If you just updated Vigil, please restart the Vigil service ('sudo systemctl restart vigil' or 'vigil restart') to load backend endpoints."
        );
      }
      throw new Error(`Failed to fetch audit logs (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedAuditData = data;
    renderAuditLogs(data);
  } catch (err) {
    console.error("fetchAuditLogs error:", err);
    showToast({
      title: "Audit Logs Error",
      message: err instanceof Error ? err.message : String(err),
      type: "danger",
    });
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

function renderAuditLogs(data) {
  if (!data) return;

  const lastUpdatedEl = document.getElementById("audit-last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  const logs = Array.isArray(data.logs) ? data.logs : [];
  const total = Number(data.total) || logs.length;

  const totalEl = document.getElementById("audit-total-count");
  if (totalEl) totalEl.textContent = String(total);

  const securityCount = logs.filter((l) => ["warning", "security"].includes(String(l.severity || "").toLowerCase())).length;
  const secEl = document.getElementById("audit-security-count");
  if (secEl) {
    secEl.textContent = `${securityCount} Flagged`;
    if (securityCount > 0) {
      secEl.className = "status-badge status-warning";
    } else {
      secEl.className = "status-badge status-ok";
    }
  }

  const tbody = document.getElementById("audit-table-body");
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No security audit logs recorded.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((log) => {
    const sev = String(log.severity || "info").toLowerCase();
    let badgeClass = "badge-audit-info";
    if (sev === "warning") badgeClass = "badge-audit-warning";
    else if (sev === "security") badgeClass = "badge-audit-security";

    const hasMeta = Boolean(log.metadata && Object.keys(log.metadata).length > 0);
    const metaJson = hasMeta ? JSON.stringify(log.metadata, null, 2) : "";

    return `
      <tr>
        <td class="mono-text text-secondary">${formatTimestampLocal(log.timestamp)}</td>
        <td><span class="status-badge ${badgeClass}">${sev.toUpperCase()}</span></td>
        <td><span class="kind-badge font-bold">${escapeHtml(log.event_type || "-")}</span></td>
        <td class="mono-text font-bold">${escapeHtml(log.actor || "system")}</td>
        <td class="mono-text text-secondary">${escapeHtml(log.ip_address || "--")}</td>
        <td>
          <div style="font-size: 0.82rem;">${escapeHtml(log.description || "-")}</div>
          ${hasMeta ? `<pre class="audit-meta-pre hidden" id="meta-log-${log.id}">${escapeHtml(metaJson)}</pre>` : ""}
        </td>
        <td>
          <div class="table-actions-cell">
            ${hasMeta
              ? `<button class="btn-action-sm btn-toggle-meta" data-id="${log.id}">Details</button>`
              : `<span class="text-muted" style="font-size: 0.75rem;">-</span>`
            }
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-toggle-meta").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lid = btn.getAttribute("data-id");
      const pre = document.getElementById(`meta-log-${lid}`);
      if (pre) pre.classList.toggle("hidden");
    });
  });
}

/**
 * Switch Docker sub-tabs ('stacks', 'containers', 'images', 'volumes', 'networks', 'updates')
 */
function switchDockerSubtab(subtabName, updateHash = true) {
  const validSubtabs = ["stacks", "containers", "images", "volumes", "networks", "updates"];
  if (!validSubtabs.includes(subtabName)) {
    subtabName = "stacks";
  }
  currentDockerSubtab = subtabName;

  validSubtabs.forEach((st) => {
    const tabEl = document.getElementById(`subtab-docker-${st}`);
    const viewEl = document.getElementById(`subview-docker-${st}`);
    if (st === subtabName) {
      tabEl?.classList.add("active");
      tabEl?.setAttribute("aria-selected", "true");
      viewEl?.classList.remove("hidden");
    } else {
      tabEl?.classList.remove("active");
      tabEl?.setAttribute("aria-selected", "false");
      viewEl?.classList.add("hidden");
    }
  });

  if (updateHash && window.location.hash.startsWith("#containers")) {
    history.replaceState(null, "", `#containers/${subtabName}`);
  }

  if (isAuthenticated) {
    refreshDockerSubtab(subtabName);
  }
}

/**
 * Check if the active or specified Docker subtab request is currently in-flight.
 */
function isDockerSubtabInFlight(subtabName = currentDockerSubtab) {
  switch (subtabName) {
    case "stacks":
      return isFetchingDockerStacks;
    case "containers":
      return isFetchingDockerContainers;
    case "images":
      return isFetchingDockerImages;
    case "volumes":
      return isFetchingDockerVolumes;
    case "networks":
      return isFetchingDockerNetworks;
    case "updates":
      return isFetchingDockerUpdates;
    default:
      return false;
  }
}

/**
 * Throttled subtab refresh to prevent rapid WebSocket ticks from spamming HTTP requests.
 * Only the active "containers" subtab receives continuous live tick updates.
 * Updates, stacks, images, volumes, and networks are decoupled and fetched on tab switch
 * or after mutation actions, avoiding tab flickering and continuous heavy polling.
 */
function throttledRefreshDockerSubtab(subtabName = currentDockerSubtab) {
  if (subtabName !== "containers") return;
  if (isDockerSubtabInFlight("containers")) return;
  const now = Date.now();
  const elapsed = now - lastDockerSubtabFetchTime;
  if (elapsed >= DOCKER_SUBTAB_THROTTLE_MS) {
    if (dockerSubtabThrottleTimer) {
      clearTimeout(dockerSubtabThrottleTimer);
      dockerSubtabThrottleTimer = null;
    }
    refreshDockerSubtab("containers");
  } else if (!dockerSubtabThrottleTimer) {
    dockerSubtabThrottleTimer = setTimeout(() => {
      dockerSubtabThrottleTimer = null;
      if (currentViewTab === "containers" && currentDockerSubtab === "containers" && !isDockerSubtabInFlight("containers")) {
        refreshDockerSubtab("containers");
      }
    }, DOCKER_SUBTAB_THROTTLE_MS - elapsed);
  }
}

/**
 * Fetch data for active Docker subtab.
 */
function refreshDockerSubtab(subtabName) {
  lastDockerSubtabFetchTime = Date.now();
  switch (subtabName) {
    case "stacks":
      fetchDockerStacks();
      break;
    case "containers":
      fetchDockerContainers();
      break;
    case "images":
      fetchDockerImages();
      break;
    case "volumes":
      fetchDockerVolumes();
      break;
    case "networks":
      fetchDockerNetworks();
      break;
    case "updates":
      fetchDockerUpdatesConfig();
      fetchUpdateSchedule();
      if (!cachedDockerUpdates || cachedDockerUpdates.length === 0) {
        fetchDockerUpdates();
      } else {
        renderDockerUpdates(cachedDockerUpdates);
      }
      break;
  }
}

/**
 * Render Docker daemon status, quick stats, and navigation/subtab badges.
 */
function renderDockerStatus(data) {
  if (!data || typeof data !== "object") return;
  dockerStatusCache = data;

  const daemonBadge = document.getElementById("docker-daemon-badge");
  const installBanner = document.getElementById("docker-install-banner");
  const stoppedBanner = document.getElementById("docker-stopped-banner");
  const versionInfo = document.getElementById("docker-version-info");
  const lastUpdated = document.getElementById("docker-last-updated");

  if (daemonBadge) {
    daemonBadge.className = "status-badge";
    if (!data.installed) {
      daemonBadge.classList.add("status-failed");
      daemonBadge.textContent = "NOT INSTALLED";
    } else if (!data.running) {
      daemonBadge.classList.add("status-degraded");
      daemonBadge.textContent = "STOPPED";
    } else {
      daemonBadge.classList.add("status-clean");
      daemonBadge.textContent = "RUNNING";
    }
  }

  if (installBanner) {
    if (!data.installed) {
      installBanner.classList.remove("hidden");
    } else {
      installBanner.classList.add("hidden");
    }
  }

  if (stoppedBanner) {
    if (data.installed && !data.running) {
      stoppedBanner.classList.remove("hidden");
    } else {
      stoppedBanner.classList.add("hidden");
    }
  }

  if (versionInfo) {
    const v = data.version || "--";
    const cv = data.compose_version || "--";
    versionInfo.textContent = `Docker: ${v} | Compose: ${cv}`;
  }

  if (lastUpdated) {
    const now = new Date();
    lastUpdated.textContent = `Updated ${formatTimeOnly(now)}`;
  }

  const stats = data.stats || {};
  const stacksCount = stats.stacks ?? 0;
  const containersCount = stats.containers ?? 0;
  const runningCount = stats.running ?? 0;
  const stoppedCount = stats.stopped ?? 0;
  const imagesCount = stats.images ?? 0;
  const volumesCount = stats.volumes ?? 0;
  const networksCount = stats.networks ?? 0;

  const sVal = document.getElementById("docker-stat-stacks");
  const cVal = document.getElementById("docker-stat-containers");
  const rVal = document.getElementById("docker-stat-running");
  const stVal = document.getElementById("docker-stat-stopped");
  const cDetail = document.getElementById("docker-stat-containers-detail");
  const iVal = document.getElementById("docker-stat-images");
  const vVal = document.getElementById("docker-stat-volumes");
  const nVal = document.getElementById("docker-stat-networks");

  if (sVal) sVal.textContent = stacksCount;
  if (cVal) cVal.textContent = containersCount;
  if (rVal) rVal.textContent = runningCount;
  if (stVal) stVal.textContent = stoppedCount;
  if (cDetail && (!rVal || !stVal)) {
    cDetail.textContent = `${runningCount} running, ${stoppedCount} stopped`;
  }
  if (iVal) iVal.textContent = imagesCount;
  if (vVal) vVal.textContent = volumesCount;
  if (nVal) nVal.textContent = networksCount;

  // Main navigation tab badge: active (running) containers
  const navBadge = document.getElementById("nav-tab-containers-badge");
  if (navBadge) {
    navBadge.textContent = runningCount;
  }

  // Overview summary card
  const overviewDockerBadge = document.getElementById("overview-docker-badge");
  if (overviewDockerBadge) {
    overviewDockerBadge.className = "status-badge";
    if (!data.installed) {
      overviewDockerBadge.classList.add("status-failed");
      overviewDockerBadge.textContent = "NOT INSTALLED";
    } else if (!data.running) {
      overviewDockerBadge.classList.add("status-degraded");
      overviewDockerBadge.textContent = "STOPPED";
    } else {
      overviewDockerBadge.classList.add("status-clean");
      overviewDockerBadge.textContent = "RUNNING";
    }
  }
  const overviewDockerSummary = document.getElementById("overview-docker-summary");
  if (overviewDockerSummary) {
    overviewDockerSummary.textContent = `${runningCount}/${containersCount} containers running • ${stacksCount} stacks`;
  }

  // Subtab badges
  const bStacks = document.getElementById("subtab-badge-stacks");
  const bContainers = document.getElementById("subtab-badge-containers");
  const bImages = document.getElementById("subtab-badge-images");
  const bVolumes = document.getElementById("subtab-badge-volumes");
  const bNetworks = document.getElementById("subtab-badge-networks");
  const bUpdates = document.getElementById("subtab-badge-updates");

  if (bStacks) bStacks.textContent = stacksCount;
  if (bContainers) bContainers.textContent = containersCount;
  if (bImages) bImages.textContent = imagesCount;
  if (bVolumes) bVolumes.textContent = volumesCount;
  if (bNetworks) bNetworks.textContent = networksCount;
  if (bUpdates && stats.updates !== undefined && stats.updates !== null) {
    bUpdates.textContent = stats.updates;
    if (stats.updates > 0) {
      bUpdates.classList.remove("hidden");
    } else {
      bUpdates.classList.add("hidden");
    }
  }

  const refreshBtn = document.getElementById("refresh-docker-btn");
  if (refreshBtn) refreshBtn.classList.remove("loading");
}

/**
 * Fetch Docker daemon status and quick stats.
 */
async function fetchDockerStatus() {
  if (isFetchingDockerStatus) return;
  isFetchingDockerStatus = true;
  const refreshBtn = document.getElementById("refresh-docker-btn");
  if (refreshBtn) refreshBtn.classList.add("loading");

  try {
    const resp = await apiFetch("/api/docker/status");
    if (!resp.ok) return;
    const data = await resp.json();
    renderDockerStatus(data);
  } catch (err) {
    console.warn("Failed to fetch Docker status:", err);
  } finally {
    isFetchingDockerStatus = false;
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

/**
 * Trigger Docker installation script when missing.
 */
async function handleInstallDocker() {
  const btn = document.getElementById("btn-install-docker");
  const feedback = document.getElementById("docker-install-feedback");
  if (btn) btn.disabled = true;

  if (feedback) {
    feedback.className = "auth-alert";
    feedback.textContent = "Triggering Docker installation script in background...";
    feedback.classList.remove("hidden");
  }

  try {
    const resp = await apiFetch("/api/docker/install", { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      if (feedback) {
        feedback.classList.add("feedback-success");
        feedback.textContent = data.message || "Docker installation initiated. Checking status...";
      }
      setTimeout(fetchDockerStatus, 4000);
    } else {
      if (feedback) {
        feedback.classList.add("feedback-error");
        feedback.textContent = data.detail || "Failed to trigger Docker installation.";
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.classList.add("feedback-error");
      feedback.textContent = `Error: ${err.message}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Fetch and render Docker Stacks.
 */
async function fetchDockerStacks() {
  const tbody = document.getElementById("docker-stacks-tbody");
  if (!tbody) return;
  if (isFetchingDockerStacks) return;
  isFetchingDockerStacks = true;

  try {
    const resp = await apiFetch("/api/docker/stacks");
    if (!resp.ok) return;
    const data = await resp.json();
    const stacks = data.stacks || [];

    const stacksKey = JSON.stringify(stacks);
    if (lastStacksRenderKey === stacksKey && tbody.children.length > 0) {
      return;
    }
    lastStacksRenderKey = stacksKey;

    if (stacks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No Compose stacks configured yet. Click 'Deploy New Stack' to add one.</td></tr>`;
      return;
    }

    tbody.innerHTML = stacks.map((s) => {
      const isRunning = s.status === "running" || (Number(s.running_count || 0) > 0);
      const statusClass = isRunning ? "status-clean" : (s.status === "stopped" || s.status === "down" ? "status-degraded" : "status-none");
      const isManaged = Boolean(s.managed);
      const managedBadge = isManaged
        ? `<span class="kind-badge kind-weekly" title="Managed in SQLite">Managed</span>`
        : `<span class="kind-badge" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8;">External</span>`;
      
      const safeName = escapeHtml(s.name);
      const actionsContent = isManaged
        ? `<div class="btn-action-group">
            ${
              isRunning
                ? `<button type="button" class="btn-action" data-stack-action="restart" data-stack="${safeName}">Restart</button>
                   <button type="button" class="btn-action" data-stack-action="stop" data-stack="${safeName}">Stop</button>`
                : `<button type="button" class="btn-action btn-action-success" data-stack-action="start" data-stack="${safeName}">Start</button>`
            }
            <button type="button" class="btn-action" data-stack-action="down" data-stack="${safeName}">Down</button>
            <button type="button" class="btn-action" data-stack-action="pull" data-stack="${safeName}">Pull</button>
            <button type="button" class="btn-action" data-stack-action="edit" data-stack="${safeName}">Edit</button>
            <button type="button" class="btn-action btn-action-danger" data-stack-action="delete" data-stack="${safeName}">Delete</button>
          </div>`
        : `<span class="kind-badge" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8;" title="Managed outside SystemAlerts. Manage individual containers in Containers tab.">Read-Only (External)</span>`;

      return `<tr>
        <td><strong>${safeName}</strong></td>
        <td>
          <span class="status-badge ${statusClass}">
            <span class="status-dot"></span>
            ${escapeHtml((s.status || "unknown").replace(/\s*\(\d+(?:\/\d+)?\)/g, "").trim())}
          </span>
        </td>
        <td>${Number(s.running_count || 0)} / ${Number(s.containers_count || 0)} running</td>
        <td>${managedBadge}</td>
        <td class="actions-col">${actionsContent}</td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("button[data-stack-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-stack-action");
        const stackName = btn.getAttribute("data-stack");
        if (action === "edit") {
          openStackEditor(stackName);
        } else if (action === "delete") {
          handleDeleteStack(stackName);
        } else {
          handleStackAction(stackName, action, btn);
        }
      });
    });
  } catch (err) {
    console.warn("Failed to fetch Docker stacks:", err);
  } finally {
    isFetchingDockerStacks = false;
  }
}

/**
 * Execute stack action: start, stop, restart, down, pull.
 */
async function handleStackAction(stackName, action, buttonEl) {
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = "...";
  }

  try {
    const resp = await apiFetch(`/api/docker/stacks/${encodeURIComponent(stackName)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      alert(`Stack action '${action}' failed: ${errData.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error executing stack action: ${err.message}`);
  } finally {
    lastStacksRenderKey = "";
    fetchDockerStacks();
    fetchDockerStatus();
  }
}

/**
 * Delete Compose stack with container teardown.
 */
async function handleDeleteStack(stackName) {
  if (!confirm(`Are you sure you want to delete stack "${stackName}"? This will tear down all its containers.`)) {
    return;
  }

  try {
    const resp = await apiFetch(`/api/docker/stacks/${encodeURIComponent(stackName)}?down=true`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      alert(`Failed to delete stack: ${errData.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error deleting stack: ${err.message}`);
  } finally {
    lastStacksRenderKey = "";
    fetchDockerStacks();
    fetchDockerStatus();
  }
}

/**
 * Open Stack Editor modal for creating or updating a stack.
 */
async function openStackEditor(stackName = null) {
  const modal = document.getElementById("stack-editor-modal");
  const title = document.getElementById("stack-editor-title");
  const nameInput = document.getElementById("stack-name-input");
  const yamlInput = document.getElementById("stack-yaml-input");
  const saveText = document.getElementById("save-stack-text");
  const feedback = document.getElementById("stack-editor-feedback");

  if (feedback) feedback.classList.add("hidden");

  if (stackName) {
    if (title) title.textContent = `Edit Compose Stack: ${stackName}`;
    if (nameInput) {
      nameInput.value = stackName;
      nameInput.disabled = true;
    }
    if (saveText) saveText.textContent = "Update Stack";
    if (yamlInput) yamlInput.value = "Loading compose file...";

    try {
      const resp = await apiFetch(`/api/docker/stacks/${encodeURIComponent(stackName)}`);
      if (resp.ok) {
        const data = await resp.json();
        if (yamlInput) yamlInput.value = data.stack?.compose_yaml || "";
      } else {
        if (yamlInput) yamlInput.value = "";
      }
    } catch {
      if (yamlInput) yamlInput.value = "";
    }
  } else {
    if (title) title.textContent = "Deploy New Compose Stack";
    if (nameInput) {
      nameInput.value = "";
      nameInput.disabled = false;
    }
    if (saveText) saveText.textContent = "Deploy Stack";
    if (yamlInput) yamlInput.value = "";
  }

  modal?.classList.remove("hidden");
}

function closeStackEditor() {
  document.getElementById("stack-editor-modal")?.classList.add("hidden");
}

function insertExampleYaml() {
  const yamlInput = document.getElementById("stack-yaml-input");
  if (!yamlInput) return;
  yamlInput.value = `services:
  app:
    image: nginx:alpine
    ports:
      - "8088:80"
    restart: unless-stopped
`;
}

/**
 * Save & optionally deploy stack via POST /api/docker/stacks.
 */
async function handleSaveStack() {
  const nameInput = document.getElementById("stack-name-input");
  const yamlInput = document.getElementById("stack-yaml-input");
  const deployToggle = document.getElementById("stack-deploy-toggle");
  const feedback = document.getElementById("stack-editor-feedback");
  const saveBtn = document.getElementById("save-stack-btn");

  const name = (nameInput?.value || "").trim();
  const compose_yaml = (yamlInput?.value || "").trim();
  const deploy = !!deployToggle?.checked;

  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = "Stack name must contain only letters, numbers, dashes, and underscores.";
      feedback.classList.remove("hidden");
    }
    return;
  }

  if (!compose_yaml) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = "Compose YAML cannot be empty.";
      feedback.classList.remove("hidden");
    }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;

  try {
    const resp = await apiFetch("/api/docker/stacks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, compose_yaml, deploy }),
    });

    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      lastStacksRenderKey = "";
      closeStackEditor();
      fetchDockerStacks();
      fetchDockerStatus();
    } else {
      if (feedback) {
        feedback.className = "auth-alert feedback-error";
        let errMsg = data.detail || "Failed to save Compose stack.";
        if (typeof errMsg === "object") {
          try {
            errMsg = JSON.stringify(errMsg, null, 2);
          } catch {
            errMsg = String(errMsg);
          }
        }
        feedback.textContent = errMsg;
        feedback.classList.remove("hidden");
        feedback.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = `Error: ${err.message}`;
      feedback.classList.remove("hidden");
      feedback.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Fetch and render Docker Containers.
 */
async function fetchDockerContainers(highlightCid = null) {
  const tbody = document.getElementById("docker-containers-tbody");
  if (!tbody) return;
  if (isFetchingDockerContainers) return;
  isFetchingDockerContainers = true;

  try {
    const resp = await apiFetch(`/api/docker/containers?all=true`);
    if (!resp.ok) return;
    const data = await resp.json();
    cachedDockerContainers = data.containers || [];

    // Populate stack filter dropdown only if options changed
    const stackFilterEl = document.getElementById("containers-filter-stack");
    if (stackFilterEl) {
      const currentSelected = stackFilterEl.value || "all";
      const stacks = new Set();
      cachedDockerContainers.forEach((c) => {
        if (c.stack && String(c.stack).trim() !== "") {
          stacks.add(String(c.stack).trim());
        }
      });
      const sortedStacks = Array.from(stacks).sort();
      let optionsHtml = `<option value="all">All Stacks</option><option value="standalone">Standalone (No Stack)</option>`;
      sortedStacks.forEach((st) => {
        const safeSt = escapeHtml(st);
        optionsHtml += `<option value="${safeSt}">${safeSt}</option>`;
      });
      if (stackFilterEl.dataset.renderedOptions !== optionsHtml) {
        stackFilterEl.dataset.renderedOptions = optionsHtml;
        stackFilterEl.innerHTML = optionsHtml;
        if (currentSelected === "all" || currentSelected === "standalone" || stacks.has(currentSelected)) {
          stackFilterEl.value = currentSelected;
        } else {
          stackFilterEl.value = "all";
        }
      }
    }

    renderDockerContainers(highlightCid);
  } catch (err) {
    console.warn("Failed to fetch Docker containers:", err);
  } finally {
    isFetchingDockerContainers = false;
  }
}

function renderDockerContainers(highlightCid = null) {
  const tbody = document.getElementById("docker-containers-tbody");
  if (!tbody) return;

  const searchInput =
    document.getElementById("containers-search-input") ||
    document.getElementById("docker-container-search");
  const query = (searchInput?.value || "").trim().toLowerCase();

  const statusFilterEl = document.getElementById("containers-filter-status");
  const statusFilter = statusFilterEl?.value || "all";

  const stackFilterEl = document.getElementById("containers-filter-stack");
  const stackFilter = stackFilterEl?.value || "all";

  const renderKey = JSON.stringify({
    query,
    statusFilter,
    stackFilter,
    highlightCid,
    containers: cachedDockerContainers,
  });
  if (lastContainersRenderKey === renderKey && tbody.children.length > 0) {
    return;
  }
  lastContainersRenderKey = renderKey;

  let filtered = cachedDockerContainers;

  // 1. Text Search Filter
  if (query) {
    filtered = filtered.filter((c) =>
      (c.name || "").toLowerCase().includes(query) ||
      (c.id || "").toLowerCase().includes(query) ||
      (c.image || "").toLowerCase().includes(query) ||
      (c.stack || "").toLowerCase().includes(query) ||
      (c.ports || "").toLowerCase().includes(query)
    );
  }

  // 2. Status Filter: "all", "running", "stopped"
  if (statusFilter === "running") {
    filtered = filtered.filter((c) => {
      const st = (c.state || "").toLowerCase();
      const statusStr = (c.status || "").toLowerCase();
      return st === "running" || statusStr.includes("up");
    });
  } else if (statusFilter === "stopped") {
    filtered = filtered.filter((c) => {
      const st = (c.state || "").toLowerCase();
      const statusStr = (c.status || "").toLowerCase();
      return st !== "running" && !statusStr.includes("up");
    });
  }

  // 3. Stack Filter: "all", "standalone", or specific stack name
  if (stackFilter === "standalone") {
    filtered = filtered.filter((c) => !c.stack || String(c.stack).trim() === "");
  } else if (stackFilter !== "all") {
    filtered = filtered.filter((c) => String(c.stack).trim() === stackFilter);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${query || statusFilter !== "all" || stackFilter !== "all" ? "No containers matching current filters." : "No containers found."}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    const state = (c.state || "").toLowerCase();
    const statusStr = (c.status || "").toLowerCase();
    let statusClass = "status-none";
    if (statusStr.includes("unhealthy")) {
      statusClass = "status-unhealthy";
    } else if (state === "running" || statusStr.includes("up")) {
      statusClass = statusStr.includes("starting") ? "status-recovering" : "status-clean";
    } else if (state === "paused" || state === "restarting") {
      statusClass = "status-degraded";
    } else if (state === "dead" || state === "failed" || state === "exited" || statusStr.includes("exit")) {
      statusClass = (statusStr.includes("exit (0)") || statusStr.includes("exited (0)")) ? "status-none" : "status-failed";
    }

    const isRunning = state === "running" || (statusStr.includes("up") && !state);
    const isPaused = state === "paused";

    const safeId = escapeHtml(c.id);
    const safeName = escapeHtml(c.name);
    const safeImage = escapeHtml(c.image);
    const safePorts = escapeHtml(c.ports || "-");
    const safeStack = escapeHtml(c.stack || "-");
    const safeStatus = escapeHtml(c.status || c.state || "unknown");

    const isHighlighted = highlightCid && (c.id === highlightCid || (c.name && c.name === highlightCid) || (highlightCid.includes(c.id)));
    const rowClass = isHighlighted ? ' class="row-highlight"' : "";

    return `<tr${rowClass}>
      <td><strong>${safeName}</strong></td>
      <td><span class="mono-text">${safeId}</span></td>
      <td><span class="mono-text" style="color: var(--accent-primary);">${safeImage}</span></td>
      <td>
        <span class="status-badge ${statusClass}">
          <span class="status-dot"></span>
          ${safeStatus}
        </span>
      </td>
      <td><span class="mono-text">${safePorts}</span></td>
      <td>${safeStack !== "-" ? `<span class="kind-badge kind-weekly">${safeStack}</span>` : "-"}</td>
      <td class="actions-col">
        <div class="btn-action-group">
          ${
            isRunning
              ? `<button type="button" class="btn-action" data-c-action="restart" data-cid="${safeId}">Restart</button>
                 <button type="button" class="btn-action" data-c-action="stop" data-cid="${safeId}">Stop</button>
                 <button type="button" class="btn-action" data-c-action="pause" data-cid="${safeId}">Pause</button>`
              : (isPaused
                  ? `<button type="button" class="btn-action btn-action-success" data-c-action="unpause" data-cid="${safeId}">Unpause</button>`
                  : `<button type="button" class="btn-action btn-action-success" data-c-action="start" data-cid="${safeId}">Start</button>`)
          }
          <button type="button" class="btn-action" data-c-action="logs" data-cid="${safeId}" data-cname="${safeName}">Logs</button>
          <button type="button" class="btn-action btn-action-danger" data-c-action="remove" data-cid="${safeId}" data-cname="${safeName}">Remove</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("button[data-c-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-c-action");
      const cid = btn.getAttribute("data-cid");
      const cname = btn.getAttribute("data-cname") || cid;
      if (action === "logs") {
        openContainerLogs(cid, cname);
      } else if (action === "remove") {
        handleRemoveContainer(cid, cname);
      } else {
        handleContainerAction(cid, action, btn);
      }
    });
  });
}

/**
 * Execute container action: start, stop, restart, pause, unpause.
 */
async function handleContainerAction(containerId, action, buttonEl) {
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = "...";
  }

  try {
    const resp = await apiFetch(`/api/docker/containers/${encodeURIComponent(containerId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(`Container action '${action}' failed: ${err.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error executing container action: ${err.message}`);
  } finally {
    lastContainersRenderKey = "";
    fetchDockerContainers();
    fetchDockerStatus();
  }
}

/**
 * Remove container.
 */
async function handleRemoveContainer(containerId, containerName) {
  if (!confirm(`Are you sure you want to remove container "${containerName}"?`)) {
    return;
  }

  try {
    const resp = await apiFetch(`/api/docker/containers/${encodeURIComponent(containerId)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove" }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(`Failed to remove container: ${err.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error removing container: ${err.message}`);
  } finally {
    lastContainersRenderKey = "";
    fetchDockerContainers();
    fetchDockerStatus();
  }
}

/**
 * Container Logs Modal Viewer.
 */
function openContainerLogs(containerId, containerName) {
  activeLogContainerId = containerId;
  activeLogContainerName = containerName;

  const modal = document.getElementById("container-logs-modal");
  const title = document.getElementById("container-logs-title");
  const subtitle = document.getElementById("container-logs-subtitle");
  const viewer = document.getElementById("container-logs-viewer");

  if (title) title.textContent = `Container Logs: ${containerName}`;
  if (subtitle) subtitle.textContent = `Container ID: ${containerId}`;
  if (viewer) viewer.textContent = "Loading logs...";

  modal?.classList.remove("hidden");
  fetchContainerLogs();

  if (logsTimerId) {
    clearInterval(logsTimerId);
    logsTimerId = null;
  }

  const autoToggle = document.getElementById("logs-autorefresh-toggle");
  if (autoToggle?.checked) {
    logsTimerId = setInterval(fetchContainerLogs, 3000);
  }
}

function closeContainerLogs() {
  if (logsTimerId) {
    clearInterval(logsTimerId);
    logsTimerId = null;
  }
  activeLogContainerId = null;
  document.getElementById("container-logs-modal")?.classList.add("hidden");
}

async function fetchContainerLogs() {
  if (!activeLogContainerId) return;
  if (isFetchingContainerLogs) return;
  isFetchingContainerLogs = true;

  const tailSelect = document.getElementById("logs-tail-select");
  const tsToggle = document.getElementById("logs-timestamps-toggle");
  const viewer = document.getElementById("container-logs-viewer");

  const tail = tailSelect ? tailSelect.value : "200";
  const timestamps = tsToggle ? !!tsToggle.checked : true;

  try {
    const resp = await apiFetch(`/api/docker/containers/${encodeURIComponent(activeLogContainerId)}/logs?tail=${tail}&timestamps=${timestamps}`);
    if (!resp.ok) {
      if (viewer) viewer.textContent = `Unable to fetch logs (HTTP ${resp.status})`;
      return;
    }
    const data = await resp.json();
    if (viewer) {
      const isScrolledToBottom = viewer.scrollHeight - viewer.clientHeight <= viewer.scrollTop + 50;
      viewer.textContent = data.logs || "(No log output emitted)";
      if (isScrolledToBottom) {
        viewer.scrollTop = viewer.scrollHeight;
      }
    }
  } catch (err) {
    if (viewer) viewer.textContent = `Error fetching logs: ${err.message}`;
  } finally {
    isFetchingContainerLogs = false;
  }
}

function copyContainerLogs() {
  const viewer = document.getElementById("container-logs-viewer");
  if (viewer && viewer.textContent) {
    navigator.clipboard.writeText(viewer.textContent).then(() => {
      const copyBtn = document.getElementById("copy-logs-btn");
      if (copyBtn) {
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      }
    }).catch(() => {});
  }
}

function scrollLogsToBottom() {
  const viewer = document.getElementById("container-logs-viewer");
  if (viewer) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}

/**
 * Images Tab: Fetch, Pull, Prune, Remove.
 */
async function fetchDockerImages() {
  const tbody = document.getElementById("docker-images-tbody");
  if (!tbody) return;
  if (isFetchingDockerImages) return;
  isFetchingDockerImages = true;

  try {
    const resp = await apiFetch("/api/docker/images");
    if (!resp.ok) return;
    const data = await resp.json();
    const images = data.images || [];

    if (images.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No images found on host.</td></tr>`;
      return;
    }

    tbody.innerHTML = images.map((img) => {
      const safeId = escapeHtml(img.id);
      const safeRepo = escapeHtml(img.repository);
      const safeTag = escapeHtml(img.tag);
      const safeSize = escapeHtml(img.size);
      const safeCreated = escapeHtml(img.created);

      return `<tr>
        <td><span class="mono-text">${safeId}</span></td>
        <td><strong>${safeRepo}</strong></td>
        <td><span class="mono-text">${safeTag}</span></td>
        <td>${safeSize}</td>
        <td>${safeCreated}</td>
        <td class="actions-col">
          <button type="button" class="btn-action btn-action-danger" data-img-delete="${safeId}" data-img-tag="${safeRepo}:${safeTag}">Remove</button>
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("button[data-img-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-img-delete");
        const tag = btn.getAttribute("data-img-tag");
        handleRemoveImage(id, tag);
      });
    });
  } catch (err) {
    console.warn("Failed to fetch Docker images:", err);
  } finally {
    isFetchingDockerImages = false;
  }
}

async function handlePullImage() {
  const input = document.getElementById("docker-image-pull-input");
  const btn = document.getElementById("btn-pull-image");
  const feedback = document.getElementById("docker-image-feedback");

  const tag = (input?.value || "").trim();
  if (!tag) {
    alert("Please enter an image name to pull (e.g. nginx:alpine)");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Pulling...";
  }

  if (feedback) {
    feedback.className = "auth-alert";
    feedback.textContent = `Pulling image '${tag}'... This may take a minute.`;
    feedback.classList.remove("hidden");
  }

  try {
    const resp = await apiFetch("/api/docker/images/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: tag }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      if (feedback) {
        feedback.className = "auth-alert feedback-success";
        feedback.textContent = `Successfully pulled image '${tag}'.`;
      }
      if (input) input.value = "";
      fetchDockerImages();
      fetchDockerStatus();
    } else {
      if (feedback) {
        feedback.className = "auth-alert feedback-error";
        feedback.textContent = data.detail || `Failed to pull image '${tag}'.`;
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = `Error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Pull Image";
    }
  }
}

async function handlePruneImages() {
  if (!confirm("Are you sure you want to prune all dangling and unused Docker images?")) {
    return;
  }

  const feedback = document.getElementById("docker-image-feedback");
  try {
    const resp = await apiFetch("/api/docker/images/prune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: false }),
    });
    if (resp.ok) {
      if (feedback) {
        feedback.className = "auth-alert feedback-success";
        feedback.textContent = "Unused images pruned successfully.";
        feedback.classList.remove("hidden");
      }
      fetchDockerImages();
      fetchDockerStatus();
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function handleRemoveImage(imageId, imageTag) {
  if (!confirm(`Are you sure you want to remove image "${imageTag || imageId}"?`)) {
    return;
  }

  try {
    const resp = await apiFetch(`/api/docker/images/${encodeURIComponent(imageId)}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      alert(`Failed to remove image: ${data.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    fetchDockerImages();
    fetchDockerStatus();
  }
}

/**
 * Volumes Tab: Fetch, Inspect, Remove.
 */
async function fetchDockerVolumes() {
  const tbody = document.getElementById("docker-volumes-tbody");
  if (!tbody) return;
  if (isFetchingDockerVolumes) return;
  isFetchingDockerVolumes = true;

  try {
    const resp = await apiFetch("/api/docker/volumes");
    if (!resp.ok) return;
    const data = await resp.json();
    const volumes = data.volumes || [];
    cachedDockerVolumes = volumes;

    if (volumes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No persistent volumes found.</td></tr>`;
      return;
    }

    tbody.innerHTML = volumes.map((v) => {
      const safeName = escapeHtml(v.name);
      const safeDriver = escapeHtml(v.driver || "local");
      const safeScope = escapeHtml(v.scope || "local");
      const safeSize = escapeHtml(v.size || "--");
      const safeMount = escapeHtml(v.mountpoint || "-");
      const safeCreated = formatDateTime(v.created_at);

      // Check attached containers
      const attached = [];
      if (Array.isArray(v.containers) && v.containers.length > 0) {
        attached.push(...v.containers);
      } else {
        cachedDockerContainers.forEach((c) => {
          if (c.ports && c.ports.includes(v.name)) attached.push(c.name || c.id);
        });
      }
      const inUseBadge = attached.length > 0
        ? `<span class="kind-badge kind-weekly" title="In use by: ${attached.map(escapeHtml).join(', ')}">${attached.length} in use</span>`
        : `<span style="color: var(--text-muted); font-size: 0.76rem;">Unattached</span>`;

      return `<tr data-vol-row="${safeName}">
        <td><strong class="vol-name-link" data-vol-inspect="${safeName}" style="cursor: pointer; color: var(--accent-primary);">${safeName}</strong></td>
        <td><span class="mono-text">${safeDriver}</span></td>
        <td>${safeScope}</td>
        <td>${safeSize}</td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 3px;">
            <span class="mono-text" style="font-size: 0.74rem;" title="${safeMount}">${safeMount}</span>
            <div>${inUseBadge}</div>
          </div>
        </td>
        <td>${safeCreated}</td>
        <td class="actions-col">
          <div class="btn-action-group">
            <button type="button" class="btn-action" data-vol-inspect="${safeName}">Inspect</button>
            <button type="button" class="btn-action btn-action-danger" data-vol-delete="${safeName}">Remove</button>
          </div>
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("button[data-vol-delete]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = btn.getAttribute("data-vol-delete");
        handleRemoveVolume(name);
      });
    });

    tbody.querySelectorAll("[data-vol-inspect]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const name = el.getAttribute("data-vol-inspect");
        openVolumeDetails(name);
      });
    });

    tbody.querySelectorAll("tr[data-vol-row]").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("a")) return;
        const name = tr.getAttribute("data-vol-row");
        if (name) openVolumeDetails(name);
      });
    });
  } catch (err) {
    console.warn("Failed to fetch Docker volumes:", err);
  } finally {
    isFetchingDockerVolumes = false;
  }
}

async function handleRemoveVolume(volumeName) {
  if (!confirm(`Are you sure you want to remove volume "${volumeName}"? Data on this volume will be lost.`)) {
    return;
  }

  try {
    const resp = await apiFetch(`/api/docker/volumes/${encodeURIComponent(volumeName)}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      alert(`Failed to remove volume: ${data.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    fetchDockerVolumes();
    fetchDockerStatus();
  }
}

/**
 * Volume Details Modal: Inspection of volume attributes and attachments.
 */
async function openVolumeDetails(volumeName) {
  const modal = document.getElementById("volume-details-modal");
  const title = document.getElementById("volume-details-title");
  const nameEl = document.getElementById("vol-detail-name");
  const driverEl = document.getElementById("vol-detail-driver");
  const scopeEl = document.getElementById("vol-detail-scope");
  const mountEl = document.getElementById("vol-detail-mountpoint");
  const sizeEl = document.getElementById("vol-detail-size");
  const createdEl = document.getElementById("vol-detail-created");
  const labelsEl = document.getElementById("vol-detail-labels");
  const containersEl = document.getElementById("vol-detail-containers");

  if (title) title.textContent = `Volume: ${volumeName}`;
  if (nameEl) nameEl.textContent = volumeName;

  const cachedVol = cachedDockerVolumes.find((v) => v.name === volumeName) || {};
  if (driverEl) driverEl.textContent = cachedVol.driver || "--";
  if (scopeEl) scopeEl.textContent = cachedVol.scope || "--";
  if (mountEl) mountEl.textContent = cachedVol.mountpoint || "--";
  if (sizeEl) sizeEl.textContent = cachedVol.size || "N/A";
  if (createdEl) createdEl.textContent = formatDateTime(cachedVol.created_at);
  if (labelsEl) labelsEl.textContent = "None";
  if (containersEl) containersEl.textContent = "Scanning attached containers...";

  modal?.classList.remove("hidden");

  try {
    const resp = await apiFetch(`/api/docker/volumes/${encodeURIComponent(volumeName)}`);
    if (resp.ok) {
      const data = await resp.json();
      const v = data.volume || data;
      if (nameEl) nameEl.textContent = v.name || volumeName;
      if (driverEl) driverEl.textContent = v.driver || "--";
      if (scopeEl) scopeEl.textContent = v.scope || "--";
      if (mountEl) mountEl.textContent = v.mountpoint || "--";
      if (sizeEl) sizeEl.textContent = v.size || "N/A";
      if (createdEl) createdEl.textContent = formatDateTime(v.created_at || v.created);

      if (labelsEl) {
        if (v.labels && typeof v.labels === "object" && Object.keys(v.labels).length > 0) {
          labelsEl.innerHTML = Object.entries(v.labels)
            .map(([k, val]) => `<span class="kind-badge">${escapeHtml(k)}=${escapeHtml(val)}</span>`)
            .join(" ");
        } else {
          labelsEl.textContent = "None";
        }
      }

      if (containersEl) {
        const attached = Array.isArray(v.containers) ? v.containers : [];
        if (attached.length > 0) {
          containersEl.innerHTML = attached
            .map((c) => `<span class="kind-badge kind-weekly">${escapeHtml(typeof c === 'string' ? c : (c.name || c.id))}</span>`)
            .join(" ");
        } else {
          containersEl.textContent = "No containers currently attached to this volume.";
        }
      }
      return;
    }
  } catch (err) {
    console.debug("Could not fetch detailed volume endpoint:", err);
  }

  // Fallback to local scan
  if (containersEl) {
    const attached = [];
    cachedDockerContainers.forEach((c) => {
      if (c.ports && c.ports.includes(volumeName)) attached.push(c.name || c.id);
    });
    if (attached.length > 0) {
      containersEl.innerHTML = attached
        .map((c) => `<span class="kind-badge kind-weekly">${escapeHtml(c)}</span>`)
        .join(" ");
    } else {
      containersEl.textContent = "No containers currently attached to this volume.";
    }
  }
}

function closeVolumeDetails() {
  document.getElementById("volume-details-modal")?.classList.add("hidden");
}

/**
 * Networks Tab: Fetch, Remove.
 */
async function fetchDockerNetworks() {
  const tbody = document.getElementById("docker-networks-tbody");
  if (!tbody) return;
  if (isFetchingDockerNetworks) return;
  isFetchingDockerNetworks = true;

  try {
    const resp = await apiFetch("/api/docker/networks");
    if (!resp.ok) return;
    const data = await resp.json();
    const networks = data.networks || [];

    if (networks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No networks found.</td></tr>`;
      return;
    }

    tbody.innerHTML = networks.map((n) => {
      const safeId = escapeHtml(n.id);
      const safeName = escapeHtml(n.name);
      const safeDriver = escapeHtml(n.driver);
      const safeScope = escapeHtml(n.scope);
      const safeInternal = escapeHtml(n.internal);

      const isDefault = ["bridge", "host", "none"].includes(n.name);

      return `<tr>
        <td><span class="mono-text">${safeId}</span></td>
        <td><strong>${safeName}</strong></td>
        <td><span class="mono-text">${safeDriver}</span></td>
        <td>${safeScope}</td>
        <td>${safeInternal}</td>
        <td class="actions-col">
          ${
            !isDefault
              ? `<button type="button" class="btn-action btn-action-danger" data-net-delete="${safeId}" data-net-name="${safeName}">Remove</button>`
              : `<span style="color: var(--text-muted); font-size: 0.76rem;">Default</span>`
          }
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll("button[data-net-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-net-delete");
        const name = btn.getAttribute("data-net-name");
        handleRemoveNetwork(id, name);
      });
    });
  } catch (err) {
    console.warn("Failed to fetch Docker networks:", err);
  } finally {
    isFetchingDockerNetworks = false;
  }
}

async function handleRemoveNetwork(networkId, networkName) {
  if (!confirm(`Are you sure you want to remove network "${networkName}"?`)) {
    return;
  }

  try {
    const resp = await apiFetch(`/api/docker/networks/${encodeURIComponent(networkId)}`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      alert(`Failed to remove network: ${data.detail || resp.statusText}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    fetchDockerNetworks();
    fetchDockerStatus();
  }
}

/**
 * Updates Tab: Fetch, Config, Apply.
 */
async function fetchDockerUpdatesConfig() {
  const freqSelect = document.getElementById("docker-auto-update-freq");
  if (!freqSelect) return;

  try {
    const resp = await apiFetch("/api/docker/updates/config");
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.frequency) {
      freqSelect.value = data.frequency;
    }
  } catch (err) {
    console.debug("Failed to fetch Docker updates config:", err);
  }
}

function generateUpdateRowHtml(u) {
  const safeName = escapeHtml(u.container_name || u.container_id);
  const safeImg = escapeHtml(u.image);
  const safeTag = escapeHtml(u.image_tag || "latest");
  const safeVer = u.image_version ? escapeHtml(u.image_version) : "";
  const safeStack = escapeHtml(u.stack || "-");
  const safeCur = escapeHtml(u.current_id || "--");
  const safeLat = escapeHtml(u.latest_id || "--");

  const badgeHtml = u.update_available
    ? `<span class="status-badge status-degraded"><span class="status-dot"></span>Update Available</span>`
    : `<span class="status-badge status-clean"><span class="status-dot"></span>Up to date</span>`;

  // External stack detection: if stack is present and managed_stack is false or not updatable
  const isExternalStack = Boolean(
    u.stack && (u.managed_stack === false || (!u.managed_stack && (u.can_update === false || u.update_available)))
  );

  let actionHtml = "";
  if (isExternalStack) {
    actionHtml = `<span class="kind-badge external-stack-badge" style="color: var(--text-muted); border-color: var(--border-color);" title="This container belongs to an external stack and cannot be managed or updated here">External Stack</span>`;
  } else if (u.update_available && u.can_update !== false) {
    actionHtml = `<button type="button" class="btn-action btn-action-success" data-update-cid="${escapeHtml(u.container_id)}" data-update-stack="${escapeHtml(u.stack || '')}">Update</button>`;
  } else {
    actionHtml = `<span style="color: var(--text-muted); font-size: 0.8rem;">Current</span>`;
  }

  const tagVersionHtml = `
    <span class="kind-badge kind-tag">${safeTag}</span>
    ${safeVer ? `<div class="tag-version-detail mono-text">${safeVer}</div>` : ""}
  `;

  return `
    <td><strong>${safeName}</strong></td>
    <td><span class="mono-text" style="color: var(--accent-primary);">${safeImg}</span></td>
    <td>${tagVersionHtml}</td>
    <td>${safeStack !== "-" ? `<span class="kind-badge kind-weekly">${safeStack}</span>` : "-"}</td>
    <td><span class="mono-text">${safeCur}</span></td>
    <td><span class="mono-text">${safeLat}</span></td>
    <td>${badgeHtml}</td>
    <td class="actions-col">
      ${actionHtml}
    </td>
  `;
}

function renderDockerUpdates(updates) {
  const tbody = document.getElementById("docker-updates-tbody");
  if (!tbody) return;

  const renderKey = JSON.stringify(updates);
  if (lastDockerUpdatesRenderKey === renderKey && tbody.querySelectorAll("tr[data-container-id]").length === updates.length) {
    return;
  }

  if (!updates || updates.length === 0) {
    lastDockerUpdatesRenderKey = renderKey;
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No running containers detected to scan for updates.</td></tr>`;
    return;
  }

  // Remove placeholder rows (empty-state, loading-state)
  tbody.querySelectorAll(".empty-state, .loading-state").forEach((el) => {
    const tr = el.closest("tr");
    if (tr) tr.remove();
  });

  const existingRowMap = new Map();
  tbody.querySelectorAll("tr[data-container-id]").forEach((tr) => {
    existingRowMap.set(tr.dataset.containerId, tr);
  });

  const activeCids = new Set();

  updates.forEach((u, index) => {
    const cid = String(u.container_id || index);
    activeCids.add(cid);

    const rowContent = generateUpdateRowHtml(u);
    const rowKey = `${u.container_name}|${u.image}|${u.image_tag}|${u.image_version}|${u.stack}|${u.current_id}|${u.latest_id}|${u.update_available}|${u.managed_stack}|${u.can_update}`;

    let row = existingRowMap.get(cid);
    if (row) {
      if (row.dataset.rowKey !== rowKey) {
        row.innerHTML = rowContent;
        row.dataset.rowKey = rowKey;
        row.setAttribute("data-row-key", rowKey);
      }
    } else {
      row = document.createElement("tr");
      row.dataset.containerId = cid;
      row.setAttribute("data-container-id", cid);
      row.dataset.rowKey = rowKey;
      row.setAttribute("data-row-key", rowKey);
      row.innerHTML = rowContent;
      existingRowMap.set(cid, row);
    }

    if (tbody.children[index] !== row) {
      tbody.insertBefore(row, tbody.children[index] || null);
    }
  });

  existingRowMap.forEach((row, cid) => {
    if (!activeCids.has(cid)) {
      row.remove();
    }
  });

  lastDockerUpdatesRenderKey = renderKey;
}

async function fetchDockerUpdates({ force = false, background = false } = {}) {
  const tbody = document.getElementById("docker-updates-tbody");
  if (!tbody) return;
  if (isFetchingDockerUpdates) return;
  isFetchingDockerUpdates = true;

  const btnCheckUpdates = document.getElementById("btn-check-docker-updates");
  let originalBtnHtml = "";
  const isViewingUpdatesTab = currentDockerSubtab === "updates";

  if (btnCheckUpdates && !background && isViewingUpdatesTab) {
    originalBtnHtml = btnCheckUpdates.innerHTML;
    btnCheckUpdates.disabled = true;
    btnCheckUpdates.classList.add("loading");
    btnCheckUpdates.innerHTML = `
      <svg class="refresh-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block; margin-right:6px; vertical-align:text-bottom;">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
      <span>Scanning...</span>
    `;
  }

  // Only show an initial loading placeholder if tbody is completely empty on initial load
  const hasExistingRows = tbody.querySelectorAll("tr[data-container-id]").length > 0;
  if (!background && isViewingUpdatesTab && !hasExistingRows && (tbody.children.length === 0 || (!cachedDockerUpdates && tbody.querySelector(".empty-state")))) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-state" style="text-align:center; padding: 24px; color: var(--text-muted);"><span class="spinner" style="display:inline-block; margin-right:8px;"></span> Checking container images for updates...</td></tr>`;
  }

  try {
    const url = force ? "/api/docker/updates?force=true" : "/api/docker/updates";
    const resp = await apiFetch(url);
    if (!resp.ok) return;
    const data = await resp.json();

    const freqSelect = document.getElementById("docker-auto-update-freq");
    if (freqSelect && data.config?.frequency) {
      freqSelect.value = data.config.frequency;
    }

    const updates = Array.isArray(data.updates) ? data.updates : [];
    cachedDockerUpdates = updates;

    const hasAnyRawUpdates = updates.some((u) => Boolean(u.update_available));
    const updatesAvailableCount = updates.filter(
      (u) => Boolean(u.update_available) && u.can_update !== false
    ).length;

    const badge = document.getElementById("subtab-badge-updates");
    if (badge) {
      badge.textContent = updatesAvailableCount;
      if (updatesAvailableCount > 0) {
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }

    const applyAllBtn = document.getElementById("btn-apply-all-updates");
    if (applyAllBtn) {
      if (updatesAvailableCount === 0) {
        applyAllBtn.disabled = true;
        if (hasAnyRawUpdates) {
          applyAllBtn.title = "No managed container updates available";
        } else {
          applyAllBtn.title = "No updates available to pull";
        }
      } else {
        applyAllBtn.disabled = false;
        applyAllBtn.title = "Apply updates for all containers";
      }
    }

    renderDockerUpdates(updates);
  } catch (err) {
    console.warn("Failed to fetch Docker updates:", err);
  } finally {
    isFetchingDockerUpdates = false;
    if (btnCheckUpdates) {
      btnCheckUpdates.disabled = false;
      btnCheckUpdates.classList.remove("loading");
      btnCheckUpdates.innerHTML = originalBtnHtml || "Check Now";
    }
  }
}

async function handleSaveUpdateFrequency() {
  const freqSelect = document.getElementById("docker-auto-update-freq");
  const feedback = document.getElementById("docker-updates-feedback");
  const freq = freqSelect?.value || "disabled";

  try {
    const resp = await apiFetch("/api/docker/updates/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frequency: freq }),
    });
    if (resp.ok) {
      if (feedback) {
        feedback.className = "auth-alert feedback-success";
        feedback.textContent = `Auto-check set to ${freq}.`;
        feedback.classList.remove("hidden");
        setTimeout(() => {
          feedback.classList.add("hidden");
        }, 3500);
      }
    } else {
      const errData = await resp.json().catch(() => ({}));
      if (feedback) {
        feedback.className = "auth-alert feedback-error";
        feedback.textContent = `Failed to save auto-check frequency: ${errData.detail || resp.statusText}`;
        feedback.classList.remove("hidden");
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = `Error: ${err.message}`;
      feedback.classList.remove("hidden");
    } else {
      alert(`Error: ${err.message}`);
    }
  }
}

async function handleApplyUpdates(containers = null, stacks = null) {
  const feedback = document.getElementById("docker-updates-feedback");
  if (feedback) {
    feedback.className = "auth-alert";
    feedback.textContent = "Applying container / stack updates...";
    feedback.classList.remove("hidden");
  }

  try {
    const resp = await apiFetch("/api/docker/updates/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containers, stacks }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      if (feedback) {
        feedback.className = "auth-alert feedback-success";
        feedback.textContent = "Updates applied successfully.";
      }
      lastDockerUpdatesRenderKey = "";
      fetchDockerUpdates({ force: true });
      fetchDockerContainers();
      fetchDockerStatus();
    } else {
      if (feedback) {
        feedback.className = "auth-alert feedback-error";
        feedback.textContent = data.detail || "Failed to apply updates.";
      }
    }
  } catch (err) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = `Error: ${err.message}`;
    }
  }
}

async function fetchUpdateSchedule() {
  if (isFetchingUpdateSchedule) return;
  isFetchingUpdateSchedule = true;

  const enabledToggle = document.getElementById("schedule-enabled-toggle");
  const daySelect = document.getElementById("schedule-day-select");
  const timeInput = document.getElementById("schedule-time-input");
  const badge = document.getElementById("update-schedule-badge");
  const nextRunEl = document.getElementById("schedule-next-run");

  try {
    const resp = await apiFetch("/api/docker/updates/schedule");
    if (resp.ok) {
      const data = await resp.json();
      const schedule = data.schedule || data;
      if (enabledToggle && schedule.enabled !== undefined) {
        enabledToggle.checked = Boolean(schedule.enabled);
      }
      if (daySelect && schedule.day) daySelect.value = schedule.day;
      if (timeInput && schedule.time) timeInput.value = schedule.time;
      if (badge) {
        badge.className = "status-badge";
        if (schedule.enabled) {
          badge.classList.add("status-clean");
          badge.textContent = "ENABLED";
        } else {
          badge.classList.add("status-disabled");
          badge.textContent = "DISABLED";
        }
      }
      if (nextRunEl) {
        nextRunEl.textContent = schedule.next_run
          ? `Next run: ${formatDateTime(schedule.next_run)}`
          : (schedule.enabled ? `Scheduled (${schedule.day || 'daily'} at ${schedule.time || '03:00'})` : "Schedule disabled");
      }
      return;
    }
  } catch (err) {
    console.debug("Schedule API fetch error, checking local store:", err);
  } finally {
    isFetchingUpdateSchedule = false;
  }

  // Fallback from localStorage
  try {
    const stored = JSON.parse(localStorage.getItem("systemalerts_update_schedule") || "{}");
    if (stored) {
      if (enabledToggle && stored.enabled !== undefined) enabledToggle.checked = Boolean(stored.enabled);
      if (daySelect && stored.day) daySelect.value = stored.day;
      if (timeInput && stored.time) timeInput.value = stored.time;
      if (badge) {
        badge.className = "status-badge";
        if (stored.enabled) {
          badge.classList.add("status-clean");
          badge.textContent = "ENABLED";
        } else {
          badge.classList.add("status-disabled");
          badge.textContent = "DISABLED";
        }
      }
      if (nextRunEl) {
        nextRunEl.textContent = stored.enabled
          ? `Scheduled: ${stored.day || 'daily'} at ${stored.time || '03:00'}`
          : "Schedule disabled";
      }
    }
  } catch {}
}

async function handleSaveUpdateSchedule() {
  const enabledToggle = document.getElementById("schedule-enabled-toggle");
  const daySelect = document.getElementById("schedule-day-select");
  const timeInput = document.getElementById("schedule-time-input");
  const feedback = document.getElementById("schedule-feedback");
  const badge = document.getElementById("update-schedule-badge");
  const nextRunEl = document.getElementById("schedule-next-run");
  const saveBtn = document.getElementById("btn-save-schedule");

  const enabled = Boolean(enabledToggle?.checked);
  const day = daySelect?.value || "daily";
  const time = timeInput?.value || "03:00";

  const payload = { enabled, day, time };

  if (saveBtn) saveBtn.disabled = true;

  try {
    const resp = await apiFetch("/api/docker/updates/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      if (feedback) {
        feedback.className = "auth-alert feedback-success";
        feedback.textContent = data.message || "Automated update schedule saved.";
        feedback.classList.remove("hidden");
      }
      if (badge) {
        badge.className = "status-badge";
        if (enabled) {
          badge.classList.add("status-clean");
          badge.textContent = "ENABLED";
        } else {
          badge.classList.add("status-disabled");
          badge.textContent = "DISABLED";
        }
      }
      if (nextRunEl) {
        nextRunEl.textContent = data.next_run
          ? `Next run: ${formatDateTime(data.next_run)}`
          : (enabled ? `Scheduled (${day} at ${time})` : "Schedule disabled");
      }
      return;
    }
  } catch (err) {
    console.debug("Schedule POST endpoint fallback:", err);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }

  // Graceful fallback to localStorage
  try {
    localStorage.setItem("systemalerts_update_schedule", JSON.stringify(payload));
    if (feedback) {
      feedback.className = "auth-alert feedback-success";
      feedback.textContent = `Automated update schedule saved (${day} at ${time}).`;
      feedback.classList.remove("hidden");
    }
    if (badge) {
      badge.className = "status-badge";
      if (enabled) {
        badge.classList.add("status-clean");
        badge.textContent = "ENABLED";
      } else {
        badge.classList.add("status-disabled");
        badge.textContent = "DISABLED";
      }
    }
    if (nextRunEl) {
      nextRunEl.textContent = enabled ? `Scheduled: ${day} at ${time}` : "Schedule disabled";
    }
  } catch (err) {
    if (feedback) {
      feedback.className = "auth-alert feedback-error";
      feedback.textContent = `Error saving schedule: ${err.message}`;
      feedback.classList.remove("hidden");
    }
  }
}

/* =========================================================================
 * Packages & Updates Manager View (#view-packages)
 * ========================================================================= */
let currentPackagesSubtab = "updates";
let cachedPackageUpdates = null;
let cachedInstalledPackages = null;
let currentPkgSearchQuery = "";
let currentPkgPage = 1;
let currentPkgTotalPages = 1;
let pkgInstalledSearchDebounceTimer = null;

function switchPackagesSubtab(subtab) {
  currentPackagesSubtab = subtab || "updates";
  const btnUpdates = document.getElementById("subtab-pkg-updates-btn");
  const btnInstalled = document.getElementById("subtab-pkg-installed-btn");
  const panelUpdates = document.getElementById("pkg-updates-subtab-panel");
  const panelInstalled = document.getElementById("pkg-installed-subtab-panel");

  if (currentPackagesSubtab === "installed") {
    btnUpdates?.classList.remove("active");
    btnUpdates?.setAttribute("aria-selected", "false");
    btnInstalled?.classList.add("active");
    btnInstalled?.setAttribute("aria-selected", "true");
    panelUpdates?.classList.add("hidden");
    panelInstalled?.classList.remove("hidden");
    if (!cachedInstalledPackages) {
      fetchInstalledPackages(currentPkgSearchQuery, currentPkgPage);
    }
  } else {
    btnInstalled?.classList.remove("active");
    btnInstalled?.setAttribute("aria-selected", "false");
    btnUpdates?.classList.add("active");
    btnUpdates?.setAttribute("aria-selected", "true");
    panelInstalled?.classList.add("hidden");
    panelUpdates?.classList.remove("hidden");
    if (!cachedPackageUpdates) {
      fetchPackageUpdates();
    }
  }
}

function renderPackagesOverviewRibbon(rebootStatus, updatesData) {
  const badge = document.getElementById("overview-packages-badge");
  const summary = document.getElementById("overview-packages-summary");
  const navBadge = document.getElementById("nav-tab-packages-badge");

  const rebootRequired = Boolean(rebootStatus && rebootStatus.reboot_required);
  const totalUpdates = updatesData ? (Number(updatesData.total_updates) || 0) : 0;
  const securityUpdates = updatesData ? (Number(updatesData.security_updates) || 0) : 0;
  const standardUpdates = updatesData ? (Number(updatesData.standard_updates) || 0) : 0;

  if (navBadge) {
    if (totalUpdates > 0) {
      navBadge.textContent = totalUpdates > 99 ? "99+" : String(totalUpdates);
      navBadge.classList.remove("hidden");
      if (securityUpdates > 0) {
        navBadge.className = "nav-tab-badge badge-crit";
      } else {
        navBadge.className = "nav-tab-badge";
      }
    } else {
      navBadge.classList.add("hidden");
    }
  }

  if (badge && summary) {
    if (rebootRequired) {
      badge.textContent = "REBOOT REQ";
      badge.className = "status-badge status-danger";
      const pkgCount = rebootStatus.packages?.length || 0;
      summary.textContent = pkgCount > 0 ? `${pkgCount} package(s) require reboot` : "System restart required";
    } else if (totalUpdates > 0) {
      if (securityUpdates > 0) {
        badge.textContent = `${totalUpdates} UPDATES`;
        badge.className = "status-badge status-danger";
        summary.textContent = `${securityUpdates} security, ${standardUpdates} standard`;
      } else {
        badge.textContent = `${totalUpdates} UPDATES`;
        badge.className = "status-badge status-warn";
        summary.textContent = `${standardUpdates} update(s) available`;
      }
    } else {
      badge.textContent = "CLEAN";
      badge.className = "status-badge status-ok";
      summary.textContent = "0 updates, system clean";
    }
  }
}

async function fetchPackageUpdates(force = false) {
  const refreshBtn = document.getElementById("btn-refresh-packages");
  if (refreshBtn) refreshBtn.classList.add("loading");
  try {
    const url = `/api/packages/updates${force ? "?force=true" : ""}`;
    const resp = await apiFetch(url);
    if (!resp.ok) {
      if (resp.status === 404) {
        throw new Error("Update manager endpoint not found (HTTP 404). Please ensure Vigil backend is up to date.");
      }
      throw new Error(`Failed to load updates (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedPackageUpdates = data;

    // Render metrics strip
    const totalEl = document.getElementById("pkg-count-total");
    const secEl = document.getElementById("pkg-count-security");
    const stdEl = document.getElementById("pkg-count-standard");
    const subtabBadge = document.getElementById("subtab-pkg-updates-badge");
    const lastUpdatedEl = document.getElementById("packages-last-updated");

    if (totalEl) totalEl.textContent = data.total_updates || 0;
    if (secEl) secEl.textContent = data.security_updates || 0;
    if (stdEl) stdEl.textContent = data.standard_updates || 0;
    if (subtabBadge) subtabBadge.textContent = data.total_updates || 0;
    if (lastUpdatedEl) {
      const stamp = data.checked_at || data.last_checked;
      if (stamp) {
        lastUpdatedEl.textContent = `Catalog checked ${formatRelativeTime(stamp)}`;
      } else {
        lastUpdatedEl.textContent = `Updated ${formatTimeOnly(new Date())}`;
      }
    }

    // Render reboot banner
    const rebootBanner = document.getElementById("pkg-reboot-banner");
    const rebootStatusText = document.getElementById("pkg-reboot-status-text");
    const rebootPkgsWrapper = document.getElementById("pkg-reboot-pkgs-wrapper");
    const rebootPkgsList = document.getElementById("pkg-reboot-pkgs-list");

    const reboot = data.reboot_status || {};
    if (reboot.reboot_required) {
      rebootBanner?.classList.remove("hidden");
      if (rebootStatusText) {
        rebootStatusText.textContent = "REQUIRED";
        rebootStatusText.className = "status-badge status-danger";
      }
      if (reboot.packages && reboot.packages.length > 0) {
        rebootPkgsWrapper?.classList.remove("hidden");
        if (rebootPkgsList) {
          rebootPkgsList.innerHTML = reboot.packages
            .map((pkg) => `<span class="reboot-pkg-chip">${escapeHtml(pkg)}</span>`)
            .join("");
        }
      } else {
        rebootPkgsWrapper?.classList.add("hidden");
      }
    } else {
      rebootBanner?.classList.add("hidden");
      if (rebootStatusText) {
        rebootStatusText.textContent = "CLEAN";
        rebootStatusText.className = "status-badge status-ok";
      }
    }

    renderPackagesOverviewRibbon(reboot, data);
    renderPackageUpdatesTable(data.updates || []);
  } catch (err) {
    console.error("fetchPackageUpdates error:", err);
    showToast({
      title: "Package Updates Error",
      message: err.message,
      type: "error",
    });
  } finally {
    if (refreshBtn) refreshBtn.classList.remove("loading");
  }
}

function renderPackageUpdatesTable(updates) {
  const tbody = document.getElementById("pkg-updates-tbody");
  if (!tbody) return;

  const filter = (document.getElementById("pkg-updates-search")?.value || "").toLowerCase().trim();
  const filtered = filter
    ? updates.filter((u) => (u.package && u.package.toLowerCase().includes(filter)) || (u.origin && u.origin.toLowerCase().includes(filter)))
    : updates;

  if (filtered.length === 0) {
    if (updates.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">All packages are up to date! System is clean.</td></tr>`;
    } else {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No updates match filter "${escapeHtml(filter)}".</td></tr>`;
    }
    return;
  }

  tbody.innerHTML = filtered
    .map((item) => {
      const isSecurity = Boolean(item.is_security);
      const badgeClass = isSecurity ? "pkg-type-security" : "pkg-type-standard";
      const typeLabel = isSecurity ? "SECURITY" : "STANDARD";
      return `
        <tr>
          <td>
            <strong class="mono-text">${escapeHtml(item.package)}</strong>
            ${item.architecture ? `<span class="text-muted text-xs"> (${escapeHtml(item.architecture)})</span>` : ""}
          </td>
          <td><span class="${badgeClass}">${typeLabel}</span></td>
          <td class="mono-text">${escapeHtml(item.current_version || "--")}</td>
          <td class="mono-text font-bold text-ok">${escapeHtml(item.candidate_version || "--")}</td>
          <td class="text-sm text-muted">${escapeHtml(item.origin || "apt")}</td>
          <td style="text-align: right;">
            <button
              type="button"
              class="btn-sm btn-secondary btn-upgrade-single"
              data-pkg="${escapeHtml(item.package)}"
              title="Simulate upgrade for ${escapeHtml(item.package)}"
            >
              Simulate
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".btn-upgrade-single").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pkg = btn.getAttribute("data-pkg");
      simulatePackageUpgrade(pkg);
    });
  });
}

async function fetchInstalledPackages(query = "", page = 1) {
  currentPkgSearchQuery = query || "";
  currentPkgPage = page < 1 ? 1 : page;
  const tbody = document.getElementById("pkg-installed-tbody");
  if (tbody && currentPackagesSubtab === "installed" && !cachedInstalledPackages) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading installed packages...</td></tr>`;
  }

  try {
    const url = `/api/packages/installed?q=${encodeURIComponent(currentPkgSearchQuery)}&page=${currentPkgPage}&limit=50`;
    const resp = await apiFetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to load installed packages (HTTP ${resp.status})`);
    }
    const data = await resp.json();
    cachedInstalledPackages = data;

    const countPill = document.getElementById("pkg-installed-count-pill");
    const subtabBadge = document.getElementById("subtab-pkg-installed-badge");
    const paginationInfo = document.getElementById("pkg-pagination-info");
    const pageIndicator = document.getElementById("pkg-page-indicator");
    const btnPrev = document.getElementById("btn-pkg-prev");
    const btnNext = document.getElementById("btn-pkg-next");

    const total = Number(data.total) || 0;
    const pageNum = Number(data.page) || 1;
    const limit = Number(data.limit) || 50;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    currentPkgTotalPages = totalPages;

    if (countPill) countPill.textContent = `${total.toLocaleString()} package${total === 1 ? "" : "s"}`;
    if (subtabBadge) subtabBadge.textContent = total > 999 ? `${(total / 1000).toFixed(1)}k` : String(total);

    const startIdx = total === 0 ? 0 : (pageNum - 1) * limit + 1;
    const endIdx = Math.min(pageNum * limit, total);
    if (paginationInfo) {
      paginationInfo.textContent = `Showing ${startIdx}-${endIdx} of ${total.toLocaleString()}`;
    }
    if (pageIndicator) {
      pageIndicator.textContent = `Page ${pageNum} of ${totalPages}`;
    }
    if (btnPrev) btnPrev.disabled = pageNum <= 1;
    if (btnNext) btnNext.disabled = pageNum >= totalPages;

    renderInstalledPackagesTable(data.packages || []);
  } catch (err) {
    console.error("fetchInstalledPackages error:", err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state error-text">Error loading packages: ${escapeHtml(err.message)}</td></tr>`;
    }
    showToast({
      title: "Package Inventory Error",
      message: err.message,
      type: "error",
    });
  }
}

function renderInstalledPackagesTable(packages) {
  const tbody = document.getElementById("pkg-installed-tbody");
  if (!tbody) return;

  if (packages.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No installed packages found matching query.</td></tr>`;
    return;
  }

  tbody.innerHTML = packages
    .map((pkg) => `
      <tr>
        <td><strong class="mono-text">${escapeHtml(pkg.name)}</strong></td>
        <td class="mono-text">${escapeHtml(pkg.version)}</td>
        <td class="text-muted mono-text text-sm">${escapeHtml(pkg.architecture || "--")}</td>
        <td><span class="status-badge status-ok">${escapeHtml(pkg.status || "installed")}</span></td>
        <td class="text-sm text-muted">${escapeHtml(pkg.summary || "")}</td>
      </tr>
    `)
    .join("");
}

async function refreshAptCache() {
  const btn = document.getElementById("btn-refresh-apt-cache");
  if (btn) btn.classList.add("loading");
  showToast({
    title: "Updating Catalog",
    message: "Running apt-get update to refresh repository package lists...",
    type: "info",
  });

  try {
    const resp = await apiFetch("/api/packages/refresh", { method: "POST" });
    if (!resp.ok) {
      throw new Error(`Failed to update catalog (HTTP ${resp.status})`);
    }
    const result = await resp.json();
    if (result.success) {
      showToast({
        title: "Catalog Updated",
        message: "Successfully synchronized package indices.",
        type: "success",
      });
      await fetchPackageUpdates(true);
    } else {
      showToast({
        title: "Catalog Update Warning",
        message: result.error || result.output || "apt update finished with non-zero status.",
        type: "warning",
      });
    }
  } catch (err) {
    showToast({
      title: "Update Failed",
      message: err.message,
      type: "error",
    });
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

async function simulatePackageUpgrade(packageName = null) {
  const modal = document.getElementById("pkg-upgrade-modal");
  const modalTitle = document.getElementById("pkg-upgrade-modal-title");
  const modalSubtitle = document.getElementById("pkg-upgrade-modal-subtitle");
  const terminal = document.getElementById("pkg-upgrade-terminal");

  if (modalTitle) {
    modalTitle.textContent = packageName
      ? `Simulate Upgrade: ${packageName}`
      : "Simulated System Upgrade";
  }
  if (modalSubtitle) {
    modalSubtitle.textContent = packageName
      ? `Dry run: apt-get -s install --only-upgrade ${packageName}`
      : "Dry run: apt-get -s dist-upgrade (safe, non-destructive)";
  }
  if (terminal) {
    terminal.textContent = "Executing simulation in background...\n\n";
  }
  modal?.classList.remove("hidden");

  try {
    const payload = {
      packages: packageName ? [packageName] : [],
      dry_run: true,
    };
    const resp = await apiFetch("/api/packages/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`Simulation request failed (HTTP ${resp.status})`);
    }
    const result = await resp.json();
    if (terminal) {
      terminal.textContent = result.output || "Simulation completed with no output.";
    }
  } catch (err) {
    if (terminal) {
      terminal.textContent += `\nError executing simulation: ${err.message}`;
    }
  }
}

function closePackageUpgradeModal() {
  document.getElementById("pkg-upgrade-modal")?.classList.add("hidden");
}

function refreshPackagesView() {
  fetchPackageUpdates();
  // Preload installed packages in background so its badge and list are preloaded
  fetchInstalledPackages(currentPkgSearchQuery, currentPkgPage);
}

/**
 * Initialize listeners and run startup authentication check.
 */
function initDashboard() {
  // Main Navigation Tabs
  document
    .getElementById("nav-tab-overview")
    ?.addEventListener("click", () => switchViewTab("overview", true));

  document
    .getElementById("nav-tab-raid")
    ?.addEventListener("click", () => switchViewTab("raid", true));

  document
    .getElementById("nav-tab-containers")
    ?.addEventListener("click", () => switchViewTab("containers", true));

  document
    .getElementById("nav-tab-services")
    ?.addEventListener("click", () => switchViewTab("services", true));

  document
    .getElementById("nav-tab-processes")
    ?.addEventListener("click", () => switchViewTab("processes", true));

  document
    .getElementById("nav-tab-users")
    ?.addEventListener("click", () => switchViewTab("users", true));

  document
    .getElementById("nav-tab-packages")
    ?.addEventListener("click", () => switchViewTab("packages", true));

  document
    .getElementById("nav-tab-notifications")
    ?.addEventListener("click", () => switchViewTab("notifications", true));

  document
    .getElementById("nav-tab-audit")
    ?.addEventListener("click", () => switchViewTab("audit", true));

  // Overview Quick Link Actions
  document
    .getElementById("btn-goto-raid")
    ?.addEventListener("click", () => switchViewTab("raid", true));

  document
    .getElementById("btn-goto-storage")
    ?.addEventListener("click", () => switchViewTab("raid", true));

  document
    .getElementById("btn-goto-containers")
    ?.addEventListener("click", () => switchViewTab("containers", true));

  document
    .getElementById("btn-goto-services")
    ?.addEventListener("click", () => switchViewTab("services", true));

  document
    .getElementById("btn-goto-packages")
    ?.addEventListener("click", () => switchViewTab("packages", true));

  document
    .getElementById("btn-goto-notifications")
    ?.addEventListener("click", () => switchViewTab("notifications", true));

  // Packages & Updates Listeners
  document
    .getElementById("btn-refresh-packages")
    ?.addEventListener("click", () => fetchPackageUpdates(true));

  document
    .getElementById("btn-refresh-apt-cache")
    ?.addEventListener("click", refreshAptCache);

  document
    .getElementById("btn-simulate-upgrade")
    ?.addEventListener("click", () => simulatePackageUpgrade());

  document
    .getElementById("btn-close-pkg-upgrade-modal")
    ?.addEventListener("click", closePackageUpgradeModal);

  document
    .getElementById("btn-dismiss-pkg-upgrade-modal")
    ?.addEventListener("click", closePackageUpgradeModal);

  document
    .getElementById("subtab-pkg-updates-btn")
    ?.addEventListener("click", () => switchPackagesSubtab("updates"));

  document
    .getElementById("subtab-pkg-installed-btn")
    ?.addEventListener("click", () => switchPackagesSubtab("installed"));

  document
    .getElementById("pkg-updates-search")
    ?.addEventListener("input", () => renderPackageUpdatesTable(cachedPackageUpdates?.updates || []));

  const pkgInstalledSearchInput = document.getElementById("pkg-installed-search");
  pkgInstalledSearchInput?.addEventListener("input", (e) => {
    clearTimeout(pkgInstalledSearchDebounceTimer);
    pkgInstalledSearchDebounceTimer = setTimeout(() => {
      fetchInstalledPackages(e.target.value.trim(), 1);
    }, 300);
  });

  document
    .getElementById("btn-pkg-prev")
    ?.addEventListener("click", () => {
      if (currentPkgPage > 1) {
        fetchInstalledPackages(currentPkgSearchQuery, currentPkgPage - 1);
      }
    });

  document
    .getElementById("btn-pkg-next")
    ?.addEventListener("click", () => {
      if (currentPkgPage < currentPkgTotalPages) {
        fetchInstalledPackages(currentPkgSearchQuery, currentPkgPage + 1);
      }
    });

  // CPU Cores Drilldown Toggle
  const btnToggleCpuCores = document.getElementById("btn-toggle-cpu-cores");
  const cpuCoresDrilldown = document.getElementById("cpu-cores-drilldown");
  if (btnToggleCpuCores && cpuCoresDrilldown) {
    btnToggleCpuCores.addEventListener("click", () => {
      const isHidden = cpuCoresDrilldown.classList.toggle("hidden");
      btnToggleCpuCores.setAttribute("aria-expanded", String(!isHidden));
      btnToggleCpuCores.classList.toggle("expanded", !isHidden);
      cpuCoresDrilldown.setAttribute("aria-hidden", String(isHidden));
    });
  }

  // Desktop Collapsible Sidebar Toggle & Persistence
  const appShell = document.getElementById("app-shell");
  const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
  if (btnToggleSidebar && appShell) {
    const savedState = localStorage.getItem("vigil_sidebar_collapsed");
    if (savedState === "1") {
      appShell.classList.add("sidebar-collapsed");
      btnToggleSidebar.setAttribute("title", "Expand Sidebar");
      btnToggleSidebar.setAttribute("aria-label", "Expand Sidebar");
    }

    btnToggleSidebar.addEventListener("click", () => {
      const isCollapsed = appShell.classList.toggle("sidebar-collapsed");
      btnToggleSidebar.setAttribute("title", isCollapsed ? "Expand Sidebar" : "Collapse Sidebar");
      btnToggleSidebar.setAttribute("aria-label", isCollapsed ? "Expand Sidebar" : "Collapse Sidebar");
      localStorage.setItem("vigil_sidebar_collapsed", isCollapsed ? "1" : "0");
    });
  }

  // Mobile Sidebar Toggle & Backdrop
  document
    .getElementById("sidebar-toggle-btn")
    ?.addEventListener("click", () => {
      document.getElementById("app-sidebar")?.classList.toggle("open");
      document.getElementById("sidebar-backdrop")?.classList.toggle("active");
    });

  document
    .getElementById("sidebar-backdrop")
    ?.addEventListener("click", () => {
      document.getElementById("app-sidebar")?.classList.remove("open");
      document.getElementById("sidebar-backdrop")?.classList.remove("active");
    });

  // Docker Sub-Tabs
  const subtabs = ["stacks", "containers", "images", "volumes", "networks", "updates"];
  subtabs.forEach((st) => {
    document
      .getElementById(`subtab-docker-${st}`)
      ?.addEventListener("click", () => switchDockerSubtab(st, true));
  });

  // Quick Stat Cards Navigation
  document.querySelectorAll(".docker-stat-card[data-subtab]").forEach((card) => {
    card.addEventListener("click", () => {
      const st = card.getAttribute("data-subtab");
      if (st) switchDockerSubtab(st, true);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const st = card.getAttribute("data-subtab");
        if (st) switchDockerSubtab(st, true);
      }
    });
  });

  // Docker Actions & Buttons
  document
    .getElementById("btn-install-docker")
    ?.addEventListener("click", handleInstallDocker);

  document
    .getElementById("refresh-docker-btn")
    ?.addEventListener("click", () => {
      requestDockerRefresh();
    });

  // Stacks
  document
    .getElementById("btn-new-stack")
    ?.addEventListener("click", () => openStackEditor());

  document
    .getElementById("close-stack-editor-btn")
    ?.addEventListener("click", closeStackEditor);

  document
    .getElementById("cancel-stack-editor-btn")
    ?.addEventListener("click", closeStackEditor);

  document
    .getElementById("save-stack-btn")
    ?.addEventListener("click", handleSaveStack);

  document
    .getElementById("stack-template-btn")
    ?.addEventListener("click", insertExampleYaml);

  // Containers Filters & Search
  const searchInput =
    document.getElementById("containers-search-input") ||
    document.getElementById("docker-container-search");
  searchInput?.addEventListener("input", renderDockerContainers);

  document
    .getElementById("containers-filter-stack")
    ?.addEventListener("change", renderDockerContainers);

  document
    .getElementById("containers-filter-status")
    ?.addEventListener("change", renderDockerContainers);

  document
    .getElementById("docker-containers-all-toggle")
    ?.addEventListener("change", fetchDockerContainers);

  // Images
  document
    .getElementById("btn-pull-image")
    ?.addEventListener("click", handlePullImage);

  document
    .getElementById("btn-prune-images")
    ?.addEventListener("click", handlePruneImages);

  // Updates & Schedule
  document
    .getElementById("docker-auto-update-freq")
    ?.addEventListener("change", handleSaveUpdateFrequency);

  document
    .getElementById("btn-save-update-freq")
    ?.addEventListener("click", handleSaveUpdateFrequency);

  document
    .getElementById("btn-check-docker-updates")
    ?.addEventListener("click", () => fetchDockerUpdates({ force: true }));

  document
    .getElementById("btn-apply-all-updates")
    ?.addEventListener("click", () => handleApplyUpdates());

  document
    .getElementById("docker-updates-tbody")
    ?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-update-cid]");
      if (btn) {
        const cid = btn.getAttribute("data-update-cid");
        const stack = btn.getAttribute("data-update-stack");
        handleApplyUpdates(cid ? [cid] : null, stack ? [stack] : null);
      }
    });

  document
    .getElementById("btn-save-schedule")
    ?.addEventListener("click", handleSaveUpdateSchedule);

  document
    .getElementById("schedule-enabled-toggle")
    ?.addEventListener("change", (e) => {
      const badge = document.getElementById("update-schedule-badge");
      if (badge) {
        badge.className = "status-badge";
        if (e.target.checked) {
          badge.classList.add("status-clean");
          badge.textContent = "ENABLED";
        } else {
          badge.classList.add("status-disabled");
          badge.textContent = "DISABLED";
        }
      }
    });

  // Logs Modal
  document
    .getElementById("close-container-logs-btn")
    ?.addEventListener("click", closeContainerLogs);

  document
    .getElementById("refresh-logs-btn")
    ?.addEventListener("click", fetchContainerLogs);

  document
    .getElementById("copy-logs-btn")
    ?.addEventListener("click", copyContainerLogs);

  document
    .getElementById("scroll-bottom-logs-btn")
    ?.addEventListener("click", scrollLogsToBottom);

  document
    .getElementById("logs-tail-select")
    ?.addEventListener("change", fetchContainerLogs);

  document
    .getElementById("logs-timestamps-toggle")
    ?.addEventListener("change", fetchContainerLogs);

  document
    .getElementById("logs-autorefresh-toggle")
    ?.addEventListener("change", (e) => {
      if (logsTimerId) {
        clearInterval(logsTimerId);
        logsTimerId = null;
      }
      if (e.target.checked && activeLogContainerId) {
        logsTimerId = setInterval(fetchContainerLogs, 3000);
      }
    });

  // Volume Details Modal
  document
    .getElementById("close-volume-details-btn")
    ?.addEventListener("click", closeVolumeDetails);

  document
    .getElementById("close-vol-modal-btn")
    ?.addEventListener("click", closeVolumeDetails);

  // Global Escape Key to dismiss modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeUpdateModal();
      closeSettingsModal();
      closeStackEditor();
      closeContainerLogs();
      closeVolumeDetails();
      closeNotifChannelsModal();
      closeNotifScheduleModal();
      closeNotifThresholdsModal();
    }
  });

  // Timezone Setting Change
  const tzSelect = document.getElementById("setting-timezone");
  if (tzSelect) {
    tzSelect.value = getStoredTimezone();
    const tzHint = document.getElementById("timezone-hint");
    if (tzHint) {
      tzHint.textContent = `Current resolved timezone: ${getEffectiveTimezone()}`;
    }
    tzSelect.addEventListener("change", (e) => {
      setStoredTimezone(e.target.value);
      if (tzHint) {
        tzHint.textContent = `Current resolved timezone: ${getEffectiveTimezone()}`;
      }
      handleManualRefresh();
      if (currentViewTab === "containers") {
        refreshDockerSubtab(currentDockerSubtab);
      }
    });
  }

  // Notification Center Modals Opening & Closing
  document.getElementById("btn-open-notif-channels")?.addEventListener("click", openNotifChannelsModal);
  document.getElementById("btn-close-notif-channels")?.addEventListener("click", closeNotifChannelsModal);
  document.getElementById("btn-cancel-notif-channels")?.addEventListener("click", closeNotifChannelsModal);

  document.getElementById("btn-open-notif-schedule")?.addEventListener("click", openNotifScheduleModal);
  document.getElementById("btn-close-notif-schedule")?.addEventListener("click", closeNotifScheduleModal);
  document.getElementById("btn-cancel-notif-schedule")?.addEventListener("click", closeNotifScheduleModal);
  document.getElementById("btn-save-notif-schedule")?.addEventListener("click", async () => {
    await saveNotificationCenterConfig();
    closeNotifScheduleModal();
  });

  document.getElementById("btn-open-notif-thresholds")?.addEventListener("click", openNotifThresholdsModal);
  document.getElementById("btn-close-notif-thresholds")?.addEventListener("click", closeNotifThresholdsModal);
  document.getElementById("btn-cancel-notif-thresholds")?.addEventListener("click", closeNotifThresholdsModal);
  document.getElementById("btn-save-notif-thresholds")?.addEventListener("click", async () => {
    await saveNotificationCenterConfig();
    closeNotifThresholdsModal();
  });

  // Modal backdrop click handlers
  ["modal-notif-channels", "modal-notif-schedule", "modal-notif-thresholds"].forEach((modalId) => {
    const modalEl = document.getElementById(modalId);
    if (modalEl) {
      modalEl.addEventListener("click", (e) => {
        if (e.target === modalEl) modalEl.classList.add("hidden");
      });
    }
  });

  // Notifications & Notification Center
  document
    .getElementById("save-notifications-btn")
    ?.addEventListener("click", saveNotificationCenterConfig);

  document
    .getElementById("send-test-notification-btn")
    ?.addEventListener("click", handleSendTestNotification);

  document
    .getElementById("save-discord-btn")
    ?.addEventListener("click", handleSaveDiscordSettings);

  // Sync Discord legacy controls bidirectionally
  const notifDiscordToggle = document.getElementById("notif-channel-discord-enable");
  const discordLegacyToggle = document.getElementById("discord-enabled-toggle");
  if (notifDiscordToggle && discordLegacyToggle) {
    notifDiscordToggle.addEventListener("change", (e) => {
      discordLegacyToggle.checked = e.target.checked;
    });
    discordLegacyToggle.addEventListener("change", (e) => {
      notifDiscordToggle.checked = e.target.checked;
    });
  }

  const notifDiscordToken = document.getElementById("notif-discord-token-input");
  const discordLegacyToken = document.getElementById("discord-token-input");
  if (notifDiscordToken && discordLegacyToken) {
    notifDiscordToken.addEventListener("input", (e) => {
      discordLegacyToken.value = e.target.value;
    });
    discordLegacyToken.addEventListener("input", (e) => {
      notifDiscordToken.value = e.target.value;
    });
  }

  const notifDiscordChannel = document.getElementById("notif-discord-channel-input");
  const discordLegacyChannel = document.getElementById("discord-channel-input");
  if (notifDiscordChannel && discordLegacyChannel) {
    notifDiscordChannel.addEventListener("input", (e) => {
      discordLegacyChannel.value = e.target.value;
    });
    discordLegacyChannel.addEventListener("input", (e) => {
      notifDiscordChannel.value = e.target.value;
    });
  }

  // Schedule controls handlers
  const schedFreqSelect = document.getElementById("notif-schedule-freq");
  const schedDayGroup = document.getElementById("notif-schedule-day-group");
  if (schedFreqSelect) {
    schedFreqSelect.addEventListener("change", (e) => {
      if (schedDayGroup) {
        schedDayGroup.classList.toggle("hidden", e.target.value !== "weekly");
      }
      updateNextRunDisplay();
    });
  }
  document.getElementById("notif-schedule-day")?.addEventListener("change", () => updateNextRunDisplay());
  document.getElementById("notif-schedule-time")?.addEventListener("input", () => updateNextRunDisplay());
  document.getElementById("notif-schedule-enable")?.addEventListener("change", () => updateNextRunDisplay());

  // Threshold sliders and number inputs sync
  const wireThresholdInputs = (sliderId, numberId) => {
    const slider = document.getElementById(sliderId);
    const num = document.getElementById(numberId);
    if (!slider || !num) return;
    slider.addEventListener("input", (e) => {
      num.value = e.target.value;
    });
    num.addEventListener("input", (e) => {
      slider.value = e.target.value;
    });
  };
  wireThresholdInputs("notif-threshold-ram-slider", "notif-threshold-ram-value");
  wireThresholdInputs("notif-threshold-cpu-slider", "notif-threshold-cpu-value");
  wireThresholdInputs("notif-threshold-disk-slider", "notif-threshold-disk-value");

  window.addEventListener("hashchange", syncTabFromHash);
  syncTabFromHash();

  document
    .getElementById("refresh-btn")
    ?.addEventListener("click", () => handleManualRefresh());

  document
    .getElementById("system-interval-select")
    ?.addEventListener("change", handleIntervalChange);

  document
    .getElementById("raid-interval-select")
    ?.addEventListener("change", handleIntervalChange);

  document
    .getElementById("notifications-interval-select")
    ?.addEventListener("change", handleIntervalChange);

  document
    .getElementById("docker-interval-select")
    ?.addEventListener("change", handleIntervalChange);

  document
    .getElementById("refresh-system-btn")
    ?.addEventListener("click", () => requestModuleRefresh("system"));

  document
    .getElementById("refresh-raid-btn")
    ?.addEventListener("click", () => requestModuleRefresh("raid"));

  document
    .getElementById("refresh-notifications-btn")
    ?.addEventListener("click", () => requestModuleRefresh("notifications"));

  // Systemctl Services Listeners
  document
    .getElementById("refresh-services-btn")
    ?.addEventListener("click", fetchSystemServices);

  document
    .getElementById("services-search-input")
    ?.addEventListener("input", (e) => {
      servicesSearchTerm = e.target.value;
      if (cachedServicesData) renderSystemServices(cachedServicesData);
    });

  document
    .getElementById("services-state-filter")
    ?.addEventListener("change", (e) => {
      servicesFilterState = e.target.value;
      if (cachedServicesData) renderSystemServices(cachedServicesData);
    });

  document
    .getElementById("btn-topbar-vigil-logs")
    ?.addEventListener("click", openVigilLogsModal);

  document
    .getElementById("btn-sidebar-vigil-logs")
    ?.addEventListener("click", openVigilLogsModal);

  document
    .getElementById("service-logs-lines-select")
    ?.addEventListener("change", () => {
      if (currentViewingService) fetchServiceLogs(currentViewingService);
    });

  document
    .getElementById("btn-copy-service-logs")
    ?.addEventListener("click", async () => {
      const content = document.getElementById("service-logs-content");
      if (content && content.textContent) {
        try {
          await navigator.clipboard.writeText(content.textContent);
          showToast("Vigil service logs copied to clipboard", "success");
        } catch {
          showToast("Failed to copy logs to clipboard", "error");
        }
      }
    });

  document
    .getElementById("btn-close-service-logs")
    ?.addEventListener("click", closeServiceLogsModal);

  document
    .getElementById("btn-dismiss-service-logs")
    ?.addEventListener("click", closeServiceLogsModal);

  document
    .getElementById("btn-refresh-service-logs")
    ?.addEventListener("click", () => {
      if (currentViewingService) fetchServiceLogs(currentViewingService);
    });

  const serviceLogsModal = document.getElementById("service-logs-modal");
  serviceLogsModal?.addEventListener("click", (e) => {
    if (e.target === serviceLogsModal) closeServiceLogsModal();
  });

  // Process Explorer Listeners
  document
    .getElementById("refresh-processes-btn")
    ?.addEventListener("click", fetchProcesses);

  let procSearchDebounce = null;
  document
    .getElementById("processes-search-input")
    ?.addEventListener("input", (e) => {
      processesSearchTerm = e.target.value;
      clearTimeout(procSearchDebounce);
      procSearchDebounce = setTimeout(() => fetchProcesses(), 250);
    });

  document
    .getElementById("processes-sort-select")
    ?.addEventListener("change", (e) => {
      processesSort = e.target.value;
      fetchProcesses();
    });

  document
    .getElementById("processes-limit-select")
    ?.addEventListener("change", (e) => {
      processesLimit = parseInt(e.target.value, 10) || 50;
      fetchProcesses();
    });

  document
    .getElementById("btn-close-kill-modal")
    ?.addEventListener("click", closeProcessKillModal);

  document
    .getElementById("btn-cancel-kill-process")
    ?.addEventListener("click", closeProcessKillModal);

  document
    .getElementById("btn-confirm-kill-process")
    ?.addEventListener("click", handleKillProcess);

  const processKillModal = document.getElementById("process-kill-modal");
  processKillModal?.addEventListener("click", (e) => {
    if (e.target === processKillModal) closeProcessKillModal();
  });

  // Users & Groups Listeners
  document
    .getElementById("refresh-users-btn")
    ?.addEventListener("click", () => switchUsersSubtab(currentUsersSubtab));

  document
    .getElementById("subtab-users-btn")
    ?.addEventListener("click", () => switchUsersSubtab("users"));

  document
    .getElementById("subtab-groups-btn")
    ?.addEventListener("click", () => switchUsersSubtab("groups"));

  document
    .getElementById("users-regular-only-toggle")
    ?.addEventListener("change", (e) => {
      usersRegularOnly = Boolean(e.target.checked);
      if (cachedUsersData) renderSystemUsers(cachedUsersData);
    });

  document
    .getElementById("users-search-input")
    ?.addEventListener("input", (e) => {
      usersSearchTerm = e.target.value;
      if (cachedUsersData) renderSystemUsers(cachedUsersData);
    });

  document
    .getElementById("groups-search-input")
    ?.addEventListener("input", (e) => {
      groupsSearchTerm = e.target.value;
      if (cachedGroupsData) renderSystemGroups(cachedGroupsData);
    });

  document
    .getElementById("btn-open-add-user")
    ?.addEventListener("click", openAddUserModal);

  document
    .getElementById("btn-close-add-user")
    ?.addEventListener("click", closeAddUserModal);

  document
    .getElementById("btn-cancel-add-user")
    ?.addEventListener("click", closeAddUserModal);

  document
    .getElementById("form-add-user")
    ?.addEventListener("submit", handleAddUserSubmit);

  document
    .getElementById("btn-close-edit-user")
    ?.addEventListener("click", closeEditUserModal);

  document
    .getElementById("btn-cancel-edit-user")
    ?.addEventListener("click", closeEditUserModal);

  document
    .getElementById("form-edit-user")
    ?.addEventListener("submit", handleEditUserSubmit);

  document
    .getElementById("btn-open-add-group")
    ?.addEventListener("click", openAddGroupModal);

  document
    .getElementById("btn-close-add-group")
    ?.addEventListener("click", closeAddGroupModal);

  document
    .getElementById("btn-cancel-add-group")
    ?.addEventListener("click", closeAddGroupModal);

  document
    .getElementById("form-add-group")
    ?.addEventListener("submit", handleAddGroupSubmit);

  document
    .getElementById("btn-close-group-member")
    ?.addEventListener("click", closeGroupMemberModal);

  document
    .getElementById("btn-cancel-group-member")
    ?.addEventListener("click", closeGroupMemberModal);

  document
    .getElementById("form-group-member")
    ?.addEventListener("submit", handleGroupMemberSubmit);

  // Security & Audit Logs Listeners
  document
    .getElementById("refresh-audit-btn")
    ?.addEventListener("click", fetchAuditLogs);

  let auditSearchDebounce = null;
  document
    .getElementById("audit-search-input")
    ?.addEventListener("input", (e) => {
      auditSearchTerm = e.target.value;
      clearTimeout(auditSearchDebounce);
      auditSearchDebounce = setTimeout(() => fetchAuditLogs(), 250);
    });

  document
    .getElementById("audit-severity-filter")
    ?.addEventListener("change", (e) => {
      auditSeverityFilter = e.target.value;
      fetchAuditLogs();
    });

  document
    .getElementById("auth-setup-form")
    ?.addEventListener("submit", handleSetupSubmit);

  document
    .getElementById("auth-login-form")
    ?.addEventListener("submit", handleLoginSubmit);

  document
    .getElementById("btn-logout")
    ?.addEventListener("click", handleLogout);

  document
    .getElementById("logout-btn")
    ?.addEventListener("click", handleLogout);

  document
    .getElementById("nav-update-notice-btn")
    ?.addEventListener("click", openUpdateModal);

  document
    .getElementById("close-update-modal-btn")
    ?.addEventListener("click", closeUpdateModal);

  document
    .getElementById("modal-dismiss-btn")
    ?.addEventListener("click", closeUpdateModal);

  document
    .getElementById("modal-apply-update-btn")
    ?.addEventListener("click", applyReleaseUpdate);

  document
    .getElementById("modal-toggle-changelog-btn")
    ?.addEventListener("click", toggleFullChangelog);

  const updateModal = document.getElementById("update-modal");
  updateModal?.addEventListener("click", (e) => {
    if (e.target === updateModal) {
      closeUpdateModal();
    }
  });

  document
    .getElementById("check-update-btn")
    ?.addEventListener("click", () => checkForUpdates({ silent: false }));

  document
    .getElementById("apply-update-btn")
    ?.addEventListener("click", applyReleaseUpdate);

  document
    .getElementById("nav-settings-btn")
    ?.addEventListener("click", openSettingsModal);

  document
    .getElementById("settings-btn")
    ?.addEventListener("click", openSettingsModal);

  document
    .getElementById("close-settings-btn")
    ?.addEventListener("click", closeSettingsModal);

  document
    .getElementById("cancel-settings-btn")
    ?.addEventListener("click", closeSettingsModal);

  document
    .getElementById("settings-form")
    ?.addEventListener("submit", handleSettingsSubmit);

  if (!localTickerTimerId) {
    localTickerTimerId = window.setInterval(updateLiveTickers, 1000);
  }

  checkAuthStatus();
}

document.addEventListener("DOMContentLoaded", initDashboard);
