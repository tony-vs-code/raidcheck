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
let isFetching = false;
let isAuthenticated = false;
let currentGoogleClientId = "";

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

  const isNoRaid = normalizeRaidState(status) === "none";

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
 * Update #auto-refresh-indicator to reflect WebSocket or fallback polling state.
 */
function updateConnectionIndicator(state) {
  const indicator = document.getElementById("auto-refresh-indicator");
  if (!indicator) return;

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

  if (msg.type === "module_update") {
    if (msg.system || msg.module === "system") {
      renderSystemMetrics(msg.system);
    }
    if (msg.raid || msg.module === "raid") {
      renderRaidDetails(msg.raid);
    }
    if ("notification_state" in msg || msg.module === "notification_state") {
      renderWeeklyNotificationState(msg.notification_state ?? null);
    }
    if (msg.history || msg.module === "history") {
      renderNotificationHistory(msg.history);
    }
    if (msg.version || msg.version_info) {
      updateVersionBadge(msg.version_info || msg.version);
    }
  } else {
    // 'snapshot' or full payload
    if (msg.raid) renderRaidDetails(msg.raid);
    if (msg.system) renderSystemMetrics(msg.system);
    if ("notification_state" in msg) {
      renderWeeklyNotificationState(msg.notification_state ?? null);
    }
    if (msg.history) renderNotificationHistory(msg.history);
    if (msg.version || msg.version_info) {
      updateVersionBadge(msg.version_info || msg.version);
    }
  }

  setErrorState(null);

  const lastUpdatedEl = document.getElementById("last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
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

  const overlay = document.getElementById("auth-overlay");
  const titleEl = document.getElementById("auth-modal-title");
  const subtitleEl = document.getElementById("auth-modal-subtitle");
  const setupForm = document.getElementById("auth-setup-form");
  const loginForm = document.getElementById("auth-login-form");
  const userBox = document.getElementById("user-session-box");

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
        "Authenticate to access the SystemAlerts dashboard";
    }
    if (setupForm) setupForm.classList.add("hidden");
    if (loginForm) loginForm.classList.remove("hidden");
    setupGoogleSignIn(googleClientId);
  }

  if (overlay) overlay.classList.remove("hidden");
}

function onAuthenticatedSuccess(username) {
  isAuthenticated = true;
  const overlay = document.getElementById("auth-overlay");
  const userBox = document.getElementById("user-session-box");
  const usernameEl = document.getElementById("auth-username");

  if (overlay) overlay.classList.add("hidden");
  if (usernameEl) usernameEl.textContent = username || "admin";
  if (userBox) userBox.classList.remove("hidden");

  startPolling();
  connectWebSocket();
  checkForUpdates({ silent: true });
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
 * 2. Release-Tag Updater (#version-badge, #check-update-btn, #update-banner)
 * ========================================================================= */

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

    const banner = document.getElementById("update-banner");
    const latestVerEl = document.getElementById("update-latest-version");
    const changelogEl = document.getElementById("update-changelog");

    if (data.update_available) {
      if (latestVerEl) {
        latestVerEl.textContent = data.latest_version || "latest";
      }
      if (changelogEl) {
        changelogEl.textContent =
          data.changelog || "New tagged release available on origin.";
      }
      if (banner) banner.classList.remove("hidden");
    } else {
      if (banner) banner.classList.add("hidden");
      if (checkBtn && !silent) {
        checkBtn.textContent = "Up to date";
        window.setTimeout(() => {
          if (checkBtn) checkBtn.textContent = "Check Updates";
        }, 2500);
        return;
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
  const applyBtn = document.getElementById("apply-update-btn");
  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "Updating & Restarting Services...";
  }

  try {
    const resp = await apiFetch("/api/update/apply", { method: "POST" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.detail || `Update failed (HTTP ${resp.status})`);
    }

    closeWebSocket();
    stopPolling();
    pollUntilServerRestarts();
  } catch (err) {
    console.error("Failed to apply update:", err);
    setErrorState(
      `Failed to apply update: ${err instanceof Error ? err.message : String(err)}`
    );
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Update & Restart Services";
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
  const tokenInput = document.getElementById("setting-discord-token");
  const tokenBadge = document.getElementById("discord-token-status");
  const channelInput = document.getElementById("setting-channel-id");
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

  if (tokenInput) {
    tokenInput.value = "";
    tokenInput.placeholder = data.discord_token_configured
      ? `Configured (${data.discord_token_masked || "********"}) — type to replace`
      : "Enter Discord Bot Token";
  }

  if (tokenBadge) {
    if (data.discord_token_configured) {
      tokenBadge.textContent = data.discord_token_masked
        ? `Configured (${data.discord_token_masked})`
        : "Configured";
      tokenBadge.classList.add("configured");
    } else {
      tokenBadge.textContent = "Not configured";
      tokenBadge.classList.remove("configured");
    }
  }

  if (channelInput) channelInput.value = data.channel_id || "";
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
  const tokenVal =
    document.getElementById("setting-discord-token")?.value.trim() || "";
  const payload = {
    channel_id:
      document.getElementById("setting-channel-id")?.value.trim() || "",
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

  // Only overwrite discord_token if user typed a new token
  if (tokenVal.length > 0) {
    payload.discord_token = tokenVal;
  }

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
 * Initialize listeners and run startup authentication check.
 */
function initDashboard() {
  document
    .getElementById("refresh-btn")
    ?.addEventListener("click", () => handleManualRefresh());

  document
    .getElementById("auth-setup-form")
    ?.addEventListener("submit", handleSetupSubmit);

  document
    .getElementById("auth-login-form")
    ?.addEventListener("submit", handleLoginSubmit);

  document
    .getElementById("logout-btn")
    ?.addEventListener("click", handleLogout);

  document
    .getElementById("check-update-btn")
    ?.addEventListener("click", () => checkForUpdates({ silent: false }));

  document
    .getElementById("apply-update-btn")
    ?.addEventListener("click", applyReleaseUpdate);

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

  checkAuthStatus();
}

document.addEventListener("DOMContentLoaded", initDashboard);
