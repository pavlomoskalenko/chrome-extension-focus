const FOCUS_KEY = "focusMode";
const SITES_KEY = "blockedSites";
const BLOCK_ORIGINS = ["<all_urls>"];
const SESSION_START_KEY = "focusSessionStartedAt";
const TOTAL_MS_KEY = "totalFocusMs";

const focusToggle = document.getElementById("focusToggle");
const toggleLabel = document.getElementById("toggleLabel");
const addForm = document.getElementById("addForm");
const siteInput = document.getElementById("siteInput");
const siteList = document.getElementById("siteList");
const timerCaption = document.getElementById("timerCaption");
const timerMain = document.getElementById("timerMain");
const permBanner = document.getElementById("permBanner");
const permGrantBtn = document.getElementById("permGrantBtn");

/** @type {{ focusMode: boolean, focusSessionStartedAt: number|null, totalFocusMs: number }} */
let timerState = {
  focusMode: false,
  focusSessionStartedAt: null,
  totalFocusMs: 0,
};

let tickId = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {number} ms */
function formatSessionClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
  return `${m}:${pad2(sec)}`;
}

/** @param {number} ms */
function formatTotalHuman(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "Under a minute";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function paintTimer() {
  const { focusMode, focusSessionStartedAt, totalFocusMs } = timerState;

  if (focusMode && typeof focusSessionStartedAt === "number") {
    timerCaption.textContent = "This session";
    timerMain.textContent = formatSessionClock(Date.now() - focusSessionStartedAt);
    return;
  }

  if (focusMode) {
    timerCaption.textContent = "This session";
    timerMain.textContent = "0:00";
    return;
  }

  timerCaption.textContent = "Total focus time";
  timerMain.textContent = formatTotalHuman(totalFocusMs);
}

function startTick() {
  stopTick();
  tickId = window.setInterval(paintTimer, 1000);
}

function stopTick() {
  if (tickId != null) {
    clearInterval(tickId);
    tickId = null;
  }
}

function syncTickTimer() {
  const on =
    timerState.focusMode && typeof timerState.focusSessionStartedAt === "number";
  if (on) startTick();
  else stopTick();
}

async function refreshTimerState() {
  const data = await chrome.storage.sync.get([
    FOCUS_KEY,
    SESSION_START_KEY,
    TOTAL_MS_KEY,
  ]);
  timerState = {
    focusMode: !!data[FOCUS_KEY],
    focusSessionStartedAt:
      typeof data[SESSION_START_KEY] === "number" ? data[SESSION_START_KEY] : null,
    totalFocusMs: typeof data[TOTAL_MS_KEY] === "number" ? data[TOTAL_MS_KEY] : 0,
  };
  paintTimer();
  syncTickTimer();
}

function splitEntries(text) {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function hasBlockHostPermission() {
  return chrome.permissions.contains({ origins: BLOCK_ORIGINS });
}

async function requestBlockHostPermission() {
  return chrome.permissions.request({ origins: BLOCK_ORIGINS });
}

async function updatePermissionBanner() {
  const { [FOCUS_KEY]: focus = false, [SITES_KEY]: sites = [] } =
    await chrome.storage.sync.get([FOCUS_KEY, SITES_KEY]);
  const need = focus && sites.length > 0;
  const has = !need || (await hasBlockHostPermission());
  permBanner.hidden = has;
}

async function loadState() {
  const { [FOCUS_KEY]: focus = false, [SITES_KEY]: sites = [] } =
    await chrome.storage.sync.get([FOCUS_KEY, SITES_KEY]);
  focusToggle.checked = focus;
  toggleLabel.textContent = focus ? "On" : "Off";
  renderList(sites);
  await refreshTimerState();
  await updatePermissionBanner();
}

function renderList(sites) {
  siteList.innerHTML = "";
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites yet. Add domains above.";
    siteList.appendChild(li);
    return;
  }
  sites.forEach((site, index) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = site;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => removeAt(index));
    li.appendChild(span);
    li.appendChild(btn);
    siteList.appendChild(li);
  });
}

async function saveSites(sites) {
  await chrome.storage.sync.set({ [SITES_KEY]: sites });
}

async function removeAt(index) {
  const { [SITES_KEY]: sites = [] } = await chrome.storage.sync.get(SITES_KEY);
  const next = sites.filter((_, i) => i !== index);
  await saveSites(next);
  renderList(next);
}

focusToggle.addEventListener("change", async () => {
  const on = focusToggle.checked;
  if (on) {
    const { [SITES_KEY]: sites = [] } = await chrome.storage.sync.get(SITES_KEY);
    if (sites.length > 0) {
      const allowed =
        (await hasBlockHostPermission()) || (await requestBlockHostPermission());
      if (!allowed) {
        focusToggle.checked = false;
        return;
      }
    }
  }
  await chrome.storage.sync.set({ [FOCUS_KEY]: on });
  toggleLabel.textContent = on ? "On" : "Off";
  await refreshTimerState();
  await updatePermissionBanner();
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = siteInput.value;
  const entries = splitEntries(raw);
  if (!entries.length) return;

  const { [SITES_KEY]: sites = [] } = await chrome.storage.sync.get(SITES_KEY);
  const merged = [...sites];
  for (const entry of entries) {
    if (!merged.includes(entry)) merged.push(entry);
  }
  siteInput.value = "";
  await saveSites(merged);
  renderList(merged);

  const { [FOCUS_KEY]: focus } = await chrome.storage.sync.get(FOCUS_KEY);
  if (focus && merged.length > 0) {
    if (!(await hasBlockHostPermission())) {
      await requestBlockHostPermission();
    }
    await chrome.runtime.sendMessage({ type: "syncBlockingRules" });
  }
  await updatePermissionBanner();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes[FOCUS_KEY]) {
    const v = changes[FOCUS_KEY].newValue;
    focusToggle.checked = !!v;
    toggleLabel.textContent = v ? "On" : "Off";
  }
  if (changes[SITES_KEY]) {
    renderList(changes[SITES_KEY].newValue ?? []);
  }
  if (
    changes[FOCUS_KEY] ||
    changes[SESSION_START_KEY] ||
    changes[TOTAL_MS_KEY]
  ) {
    refreshTimerState();
  }
  if (changes[FOCUS_KEY] || changes[SITES_KEY]) {
    updatePermissionBanner();
  }
});

permGrantBtn.addEventListener("click", async () => {
  const ok = await requestBlockHostPermission();
  if (ok) {
    await chrome.runtime.sendMessage({ type: "syncBlockingRules" });
  }
  await updatePermissionBanner();
});

loadState();
