const RULE_ID_BASE = 1;

/**
 * @param {string} raw
 * @returns {string|null} hostname for urlFilter, or null if invalid
 */
function parseHostname(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  let host = trimmed;
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split("/")[0].split(":")[0];
  }

  if (!host || host.includes(" ") || !host.includes(".")) {
    if (host === "localhost") return "localhost";
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    if (!host.includes(".") && host !== "localhost") return null;
  }

  return host || null;
}

/**
 * Adblock-style domain filter understood by declarativeNetRequest.
 * @param {string} hostname
 */
function domainUrlFilter(hostname) {
  return `||${hostname}^`;
}

const BLOCK_ORIGINS = ["<all_urls>"];

async function hasBlockHostPermission() {
  return chrome.permissions.contains({ origins: BLOCK_ORIGINS });
}

async function syncBlockingRules() {
  const { focusMode = false, blockedSites = [] } =
    await chrome.storage.sync.get(["focusMode", "blockedSites"]);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const hostnames = [];
  for (const entry of blockedSites) {
    const h = parseHostname(typeof entry === "string" ? entry : entry?.url ?? "");
    if (h && !hostnames.includes(h)) hostnames.push(h);
  }

  if (!focusMode || hostnames.length === 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    return;
  }

  if (!(await hasBlockHostPermission())) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    return;
  }

  const resourceTypes = [
    chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
    chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
  ];

  const addRules = hostnames.map((hostname, index) => ({
    id: RULE_ID_BASE + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: domainUrlFilter(hostname),
      resourceTypes,
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

/**
 * @param {boolean|undefined} oldVal
 * @param {boolean|undefined} newVal
 * @param {chrome.storage.StorageChange} [focusSessionChange]
 */
async function handleFocusModeTimer(oldVal, newVal, focusSessionChange) {
  if (newVal === true && oldVal !== true) {
    if (typeof focusSessionChange?.newValue === "number") return;
    const cur = await chrome.storage.sync.get("focusSessionStartedAt");
    if (typeof cur.focusSessionStartedAt === "number") return;
    await chrome.storage.sync.set({ focusSessionStartedAt: Date.now() });
    return;
  }
  if (newVal === false && oldVal === true) {
    const { focusSessionStartedAt, totalFocusMs = 0 } = await chrome.storage.sync.get([
      "focusSessionStartedAt",
      "totalFocusMs",
    ]);
    if (typeof focusSessionStartedAt === "number") {
      const nextTotal = totalFocusMs + (Date.now() - focusSessionStartedAt);
      await chrome.storage.sync.set({ totalFocusMs: nextTotal });
    }
    await chrome.storage.sync.remove("focusSessionStartedAt");
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;

  if (changes.focusMode) {
    const { oldValue: oldVal, newValue: newVal } = changes.focusMode;
    void handleFocusModeTimer(oldVal, newVal, changes.focusSessionStartedAt).catch(
      () => {}
    );
    syncBlockingRules();
  } else if (changes.blockedSites) {
    syncBlockingRules();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  syncBlockingRules();
});

chrome.runtime.onStartup.addListener(() => {
  syncBlockingRules();
});

syncBlockingRules();

chrome.permissions.onRemoved.addListener(() => {
  void syncBlockingRules();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "syncBlockingRules") {
    void syncBlockingRules().then(() => sendResponse({ ok: true }));
    return true;
  }
});
