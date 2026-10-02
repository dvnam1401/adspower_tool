// Content script for AdsPower Start Page
console.log("[AdsPower 2FA Bridge] content_adspower.js loaded");

function getAdsPower2FACode() {
  // Method 1: Find by matching label "2FA Code"
  const divs = Array.from(document.querySelectorAll('div'));
  for (const div of divs) {
    const className = div.className || '';
    if (className.includes('_cell__label') && div.innerText && div.innerText.includes('2FA Code')) {
      // Find the closest common cell parent container
      const cell = div.closest('div[class*="_cell_"]');
      if (cell) {
        const codeEl = cell.querySelector('[class*="_totp__code"]');
        if (codeEl) {
          const rawText = codeEl.textContent || '';
          // Extract the 6 digit code from the beginning
          const match = rawText.trim().match(/^\d{6}/);
          if (match) {
            return match[0];
          }
        }
      }
    }
  }

  // Method 2: Direct class fallback
  const directCodeEl = document.querySelector('[class*="_totp__code"]');
  if (directCodeEl) {
    const rawText = directCodeEl.textContent || '';
    const match = rawText.trim().match(/^\d{6}/);
    if (match) {
      return match[0];
    }
  }

  return null;
}

let lastCode = '';

// Check and update code every second
const checkInterval = setInterval(() => {
  // Safe check for extension context
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    clearInterval(checkInterval);
    return;
  }

  const code = getAdsPower2FACode();
  if (code && code !== lastCode) {
    lastCode = code;
    chrome.runtime.sendMessage({ type: "ADSPOWER_CODE_UPDATED", code: code }, (response) => {
      if (chrome.runtime.lastError) {
        console.log("[AdsPower 2FA Bridge] Error sending message:", chrome.runtime.lastError.message);
      } else {
        console.log("[AdsPower 2FA Bridge] Sent latest code to background:", code);
      }
    });
  }
}, 1000);
