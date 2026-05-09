// placeholder.js
// Lightweight script for placeholder.html. Responsibilities:
// - Read the snapshot id from the URL query param
// - Request metadata from the background service worker
// - Populate the UI (title + grayscaled favicon)
// - Minimal CPU usage; run once on load and then idle

(async function () {
  const params = new URL(location.href).searchParams;
  const id = params.get("id");
  const titleEl = document.getElementById("title");
  const favImg = document.getElementById("fav");
  const faviconLink = document.getElementById("page-favicon");

  if (!id) {
    titleEl.textContent = "Placeholder";
    return;
  }

  // ask background for snapshot data
  const snapshot = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getSnapshot", id }, (resp) => {
      resolve(resp && resp.snapshot ? resp.snapshot : null);
    });
  });

  if (!snapshot) {
    titleEl.textContent = "Original tab not available";
    return;
  }

  // populate title
  document.title = snapshot.title || snapshot.originalUrl || "Pinned";
  titleEl.textContent = snapshot.title || snapshot.originalUrl || "Pinned Tab";

  // set favicon — try grayscale conversion with caching
  const favUrl = snapshot.favUrl;
  let dataUrl = null;
  try {
    dataUrl = await window.faviconUtil.getGrayscale(favUrl);
  } catch (e) {
    console.warn("favicon conversion failed", e);
  }

  // fallback icon if no dataUrl
  if (!dataUrl) {
    // use the original favicon if available; otherwise use packaged icon
    dataUrl = favUrl || chrome.runtime.getURL("../images/icon_128.png");
  }

  // apply favicon and image
  try {
    if (faviconLink) faviconLink.href = dataUrl;
    if (favImg) favImg.src = dataUrl;
  } catch (e) {
    console.warn("apply favicon failed", e);
  }

  // Accessibility: set alt/title
  if (favImg) favImg.alt = snapshot.title || "";

  // Only restore when the user explicitly clicks the placeholder. This avoids
  // automatic restoration during browser startup/session restore.
  document.body.addEventListener(
    "click",
    async () => {
      titleEl.textContent = "Restoring...";
      try {
        chrome.runtime.sendMessage({ type: "restoreSnapshot", id }, (resp) => {
          // background will perform the in-place restore; if it fails, show message
          if (!resp || !resp.ok) titleEl.textContent = "Restore failed";
        });
      } catch (e) {
        titleEl.textContent = "Restore failed";
      }
    },
    { once: true },
  );
})();
