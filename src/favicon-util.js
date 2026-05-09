// favicon-util.js
// Lightweight helper to fetch an image, convert to grayscale and return a data URL.
// Exposes: window.faviconUtil.getGrayscale(favUrl) -> Promise<dataUrl>

(function () {
  const STORAGE_FAV_CACHE = "faviconCache";

  // promisified storage
  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  async function getCached(favUrl) {
    if (!favUrl) return null;
    const s = await storageGet(STORAGE_FAV_CACHE);
    const map = s[STORAGE_FAV_CACHE] || {};
    return map[favUrl] || null;
  }

  async function setCached(favUrl, dataUrl) {
    const s = await storageGet(STORAGE_FAV_CACHE);
    const map = s[STORAGE_FAV_CACHE] || {};
    map[favUrl] = dataUrl;
    await storageSet({ [STORAGE_FAV_CACHE]: map });
  }

  // Attempt to fetch favicon and convert to grayscale. Best-effort: CORS may
  // prevent canvas readback; if so, this will reject and callers should fallback.
  async function generateGrayscaleDataUrl(favUrl) {
    if (!favUrl) throw new Error("no-fav-url");
    try {
      const resp = await fetch(favUrl, { mode: "cors" });
      if (!resp.ok) throw new Error("fetch-failed");
      const blob = await resp.blob();
      const imgBitmap = await createImageBitmap(blob);
      const w = Math.min(64, imgBitmap.width || 64);
      const h = Math.min(64, imgBitmap.height || 64);
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext("2d");
      ctx.drawImage(imgBitmap, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      // convert to grayscale
      for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i],
          g = imageData.data[i + 1],
          b = imageData.data[i + 2];
        const v = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = v;
      }
      ctx.putImageData(imageData, 0, 0);
      return c.convertToBlob().then((b) => {
        return new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.readAsDataURL(b);
        });
      });
    } catch (err) {
      // try fallback: draw via Image element (may allow crossOrigin in some cases)
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const w = Math.min(64, img.naturalWidth || 64);
            const h = Math.min(64, img.naturalHeight || 64);
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            const imageData = ctx.getImageData(0, 0, w, h);
            for (let i = 0; i < imageData.data.length; i += 4) {
              const r = imageData.data[i],
                g = imageData.data[i + 1],
                b = imageData.data[i + 2];
              const v = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
              imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = v;
            }
            ctx.putImageData(imageData, 0, 0);
            resolve(canvas.toDataURL("image/png"));
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => reject(new Error("img-load-failed"));
        img.src = favUrl;
        // if image is cached and already complete
        if (img.complete && img.naturalWidth) {
          img.onload();
        }
      });
    }
  }

  async function getGrayscale(favUrl) {
    if (!favUrl) return null;
    const cached = await getCached(favUrl);
    if (cached) return cached;
    try {
      const dataUrl = await generateGrayscaleDataUrl(favUrl);
      if (dataUrl) {
        try {
          await setCached(favUrl, dataUrl);
        } catch (e) {
          /* non-fatal */
        }
        return dataUrl;
      }
    } catch (e) {
      // fail silently — caller will fallback
      console.warn("Failed to generate grayscale favicon", e);
    }
    return null;
  }

  window.faviconUtil = { getGrayscale };
})();
