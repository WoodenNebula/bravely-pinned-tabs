// Storage keys
const STORAGE_SNAP_KEY = "pinnedTabSnapshots";
const STORAGE_FAV_CACHE = "faviconCache";

let HAS_INITIALIZED = false;
let allowActivationRestore = true;

const pinnedInfoByTabId = new Map();
const placeholderTabToSnapshot = new Map();
const pendingUnpinChecks = new Map();

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function saveSnapshot(snapshotId, snapshot) {
  const store = await storageGet(STORAGE_SNAP_KEY);
  const map = store[STORAGE_SNAP_KEY] || {};
  map[snapshotId] = snapshot;
  await storageSet({ [STORAGE_SNAP_KEY]: map });
}

async function removeSnapshot(snapshotId) {
  const store = await storageGet(STORAGE_SNAP_KEY);
  const map = store[STORAGE_SNAP_KEY] || {};
  delete map[snapshotId];
  await storageSet({ [STORAGE_SNAP_KEY]: map });
}

function makeSnapshotID() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cancelPendingUnpinCheck(tabId) {
  const timeoutId = pendingUnpinChecks.get(tabId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    pendingUnpinChecks.delete(tabId);
  }
}

// Initialize: scan tabs and build maps
async function init() {
  if (HAS_INITIALIZED) return;
  HAS_INITIALIZED = true;
  console.log("===Initializing background script for Persistent Pinned Tabs===");
  // ensure storage keys exist
  const initObj = {};
  initObj[STORAGE_SNAP_KEY] = (await storageGet(STORAGE_SNAP_KEY))[STORAGE_SNAP_KEY] || {};
  initObj[STORAGE_FAV_CACHE] = (await storageGet(STORAGE_FAV_CACHE))[STORAGE_FAV_CACHE] || {};
  await storageSet(initObj);

  console.log("Initialized: ", initObj);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    // track pinned tabs metadata
    if (t.pinned) {
      pinnedInfoByTabId.set(t.id, {
        originalUrl: t.url,
        title: t.title,
        favUrl: t.favIconUrl,
        index: t.index,
        windowId: t.windowId,
      });
    }
    // detect placeholder tabs (by URL pointing to our placeholder.html?id=...)
    const placeholderBase = chrome.runtime.getURL("src/placeholder.html");
    if (t.url && t.url.includes(placeholderBase)) {
      const snapshotId = new URL(t.url).searchParams.get("id");
      if (!snapshotId) {
        continue;
      }

      placeholderTabToSnapshot.set(t.id, snapshotId);
      const snapshot = initObj[STORAGE_SNAP_KEY][snapshotId];

      if (!snapshot) {
        console.warn("Found placeholder tab with no snapshot data", t);
        continue;
      }

      console.log("Found placeholder tab during startup; reloading it to restore the placeholder content", t);
      chrome.tabs.reload(t.id, { bypassCache: true }, () => {
        void chrome.runtime.lastError;
      });
    }
  }
}

chrome.windows.onCreated.addListener((window) => {
  console.log("Window created");
  HAS_INITIALIZED = false;
  init().catch((err) => console.error("Initialization failed", err));
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const placeholderBase = chrome.runtime.getURL("src/placeholder.html");
  // ignore if entire window is closing
  if (removeInfo.isWindowClosing) {
    console.log("Tab Closed: Window closing, doing nothing", tabId, removeInfo);
    return;
  }
  cancelPendingUnpinCheck(tabId);
  const info = pinnedInfoByTabId.get(tabId);
  if (!info) {
    console.log("Tab Closed: id not found in map", tabId, pinnedInfoByTabId);
    return;
  } else if (info.originalUrl.includes(placeholderBase)) {
    console.log("Tab Closed: Placeholder tab closed, not creating new placeholder", tabId, removeInfo, info);
    return;
  }
  // Create a snapshot and placeholder
  const snapshotId = makeSnapshotID();
  const snapshot = {
    originalUrl: info.originalUrl,
    title: info.title,
    favUrl: info.favUrl,
    index: info.index,
    windowId: info.windowId,
    createdAt: Date.now(),
  };
  await saveSnapshot(snapshotId, snapshot);

  // create placeholder tab in same window/index and pinned (do not activate)
  const placeholderUrl = placeholderBase + "?id=" + snapshotId;
  try {
    // remember which tab is currently active in this window so we can restore focus
    let activeTabId = null;
    try {
      const activeTabs = await chrome.tabs.query({ windowId: info.windowId, active: true });
      console.log("Active tabs in window before creating placeholder", activeTabs);
      if (activeTabs && activeTabs[0]) activeTabId = activeTabs[0].id;
    } catch (e) {}

    const created = await chrome.tabs.create({
      windowId: info.windowId,
      index: info.index,
      pinned: true,
      active: false,
      url: placeholderUrl,
    });

    placeholderTabToSnapshot.set(created.id, snapshotId);
    // restore previously active tab if create stole focus
    if (activeTabId && activeTabId !== created.id) {
      try {
        await chrome.tabs.update(activeTabId, { active: true });
      } catch (e) {}
    } else {
      chrome.tabs.create({ windowId: info.windowId, active: true });
    }
  } catch (err) {
    console.warn("Failed to create placeholder tab", err);
    await removeSnapshot(snapshotId);
  }

  // remove the removed tab from runtime map
  pinnedInfoByTabId.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // keep pinned metadata up-to-date
  if (tab.pinned) {
    cancelPendingUnpinCheck(tabId);
    pinnedInfoByTabId.set(tabId, {
      originalUrl: tab.url,
      title: tab.title,
      favUrl: tab.favIconUrl,
      index: tab.index,
      windowId: tab.windowId,
    });
  } else {
    // Do not delete immediately. A pinned tab close often emits pinned=false
    // first and onRemoved slightly later. Defer the decision so close events
    // keep their metadata until onRemoved runs, while user unpins are
    // cleaned up after the tab remains alive and unpinned.
    if (pinnedInfoByTabId.has(tabId) && !pendingUnpinChecks.has(tabId)) {
      const timeoutId = setTimeout(async () => {
        pendingUnpinChecks.delete(tabId);
        try {
          const liveTab = await chrome.tabs.get(tabId);
          if (!liveTab || liveTab.pinned) return;
          console.log("Tab unpinned by user, removing from tracking map", tabId, changeInfo, pinnedInfoByTabId);
          pinnedInfoByTabId.delete(tabId);
        } catch {
          // Tab disappeared before confirmation; onRemoved should handle cleanup.
        }
      }, 250);
      pendingUnpinChecks.set(tabId, timeoutId);
    }
  }

  // If the URL changed and now it's a placeholder, update placeholder map
  const placeholderBase = chrome.runtime.getURL("src/placeholder.html");
  if (changeInfo.url && changeInfo.url.includes(placeholderBase)) {
    const snapshotId = new URL(changeInfo.url).searchParams.get("id");
    if (snapshotId) placeholderTabToSnapshot.set(tabId, snapshotId);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!allowActivationRestore) return;

  const snapshotId = placeholderTabToSnapshot.get(activeInfo.tabId);
  if (!snapshotId) return;

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const placeholderBase = chrome.runtime.getURL("src/placeholder.html");
    if (!tab.url || !tab.url.includes(placeholderBase)) return;

    await restoreSnapshotById(snapshotId);
  } catch (err) {
    console.error("Error restoring placeholder tab on activation", err);
  }
});

// Restore flow: placeholder pages ask the background to restore a snapshot
// only when the user explicitly requests it (click). This avoids automatic
// restoration during browser startup/session restore.
async function restoreSnapshotById(snapshotId) {
  const store = await storageGet(STORAGE_SNAP_KEY);
  const map = store[STORAGE_SNAP_KEY] || {};
  const snapshot = map[snapshotId];
  if (!snapshot) return { ok: false };

  const placeholderUrl = chrome.runtime.getURL("src/placeholder.html") + "?id=" + snapshotId;
  // find the tab(s) currently showing this placeholder and update them in-place
  const tabs = await chrome.tabs.query({ url: placeholderUrl });
  if (!tabs || tabs.length === 0) return { ok: false };

  for (const t of tabs) {
    try {
      await chrome.tabs.update(t.id, { url: snapshot.originalUrl });
      placeholderTabToSnapshot.delete(t.id);
    } catch (e) {
      console.warn("Failed to restore tab", t.id, e);
    }
  }

  await removeSnapshot(snapshotId);
  return { ok: true };
}

// When a tab is removed that was a placeholder, cleanup its snapshot
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // cleanup placeholder mapping if present
  const snapshotId = placeholderTabToSnapshot.get(tabId);
  if (!snapshotId) return;

  // If the tab is being removed because its window is closing, do not
  // delete the persistent snapshot. Window-close should not consume the
  // snapshot (that would cause other placeholders to lose their original
  // metadata during session restore). Remove only the in-memory mapping.
  if (removeInfo && removeInfo.isWindowClosing) {
    console.log("Placeholder Tab removed due to window closing; keeping snapshot", tabId, snapshotId);
    placeholderTabToSnapshot.delete(tabId);
    return;
  }

  console.log("Placeholder Tab removed", tabId, removeInfo);
  await removeSnapshot(snapshotId);
  placeholderTabToSnapshot.delete(tabId);
});

// On extension install/startup, initialize
chrome.runtime.onInstalled.addListener(() => {
  init().catch((err) => console.error("Initialization failed", err));
});

chrome.runtime.onStartup.addListener(() => {
  allowActivationRestore = false;
  setTimeout(() => {
    allowActivationRestore = true;
  }, 2000);
  init().catch((err) => console.error("Initialization failed", err));
});

// Quick message handler for the placeholder page to request snapshot data
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getSnapshot") {
    (async () => {
      const store = await storageGet(STORAGE_SNAP_KEY);
      const map = store[STORAGE_SNAP_KEY] || {};
      sendResponse({ snapshot: map[msg.id] });
    })();
    // indicates we'll call sendResponse asynchronously
    return true;
  }
  if (msg && msg.type === "restoreSnapshot") {
    (async () => {
      try {
        const result = await restoreSnapshotById(msg.id);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
});

// Ensure initialization runs whenever the service worker script is (re)loaded.
init().catch((err) => console.error("Initialization failed", err));
