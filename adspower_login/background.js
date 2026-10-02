// Background service worker for AdsPower 2FA Bridge
let latest2FACode = null;
let lastUpdatedTime = 0;

let tempWindowId = null;
let isOpeningWindow = false;

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ADSPOWER_CODE_UPDATED") {
    latest2FACode = message.code;
    lastUpdatedTime = Date.now();
    console.log("[Bridge Background] Received code from AdsPower:", message.code);

    // If this code came from our temporary background window, close it!
    if (sender.tab && sender.tab.windowId === tempWindowId) {
      chrome.windows.remove(sender.tab.windowId, () => {
        if (chrome.runtime.lastError) {
          console.log("[Bridge Background] Error closing window:", chrome.runtime.lastError.message);
        }
      });
      tempWindowId = null;
      isOpeningWindow = false;
      console.log("[Bridge Background] Closed temporary AdsPower window:", sender.tab.windowId);
    }

    sendResponse({ status: "success" });
  }

  else if (message.type === "GET_LATEST_CODE") {
    // Check if code is expired (e.g. older than 45 seconds to be safe)
    const isExpired = Date.now() - lastUpdatedTime > 45000;

    if (latest2FACode && !isExpired) {
      sendResponse({ code: latest2FACode, expired: false });
    } else {
      sendResponse({ code: null, expired: true });

      // Auto-open AdsPower page in minimized window to fetch the code
      triggerBackgroundWindowFetch();
    }
  }

  return true; // Keep message channel open
});

function triggerBackgroundWindowFetch() {
  if (isOpeningWindow) return; // Wait for active window fetch to finish or timeout
  isOpeningWindow = true;

  chrome.storage.local.get(['adspowerUrl'], (res) => {
    const targetUrl = res.adspowerUrl || 'https://start.adspower.net/';
    console.log("[Bridge Background] Triggering background window fetch from:", targetUrl);

    chrome.windows.create({
      url: targetUrl,
      type: "popup",
      state: "minimized",
      focused: false
    }, (window) => {
      tempWindowId = window.id;

      // Safety timeout: 15 seconds
      setTimeout(() => {
        if (tempWindowId === window.id) {
          chrome.windows.remove(window.id, () => {
            if (chrome.runtime.lastError) {}
          });
          tempWindowId = null;
          isOpeningWindow = false;
          console.log("[Bridge Background] Temporary window closed due to timeout");
        }
      }, 15000);
    });
  });
}
