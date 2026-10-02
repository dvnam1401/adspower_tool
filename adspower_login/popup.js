// Popup logic for AdsPower 2FA Bridge
document.addEventListener('DOMContentLoaded', () => {
  // Load saved URL configuration
  chrome.storage.local.get(['adspowerUrl'], (res) => {
    const urlInput = document.getElementById('adspowerUrl');
    if (urlInput) {
      urlInput.value = res.adspowerUrl || 'https://start.adspower.net/';
    }
  });

  // Handle saving the URL
  const saveUrlBtn = document.getElementById('saveUrlBtn');
  if (saveUrlBtn) {
    saveUrlBtn.addEventListener('click', () => {
      const urlInput = document.getElementById('adspowerUrl');
      const url = urlInput.value.trim();
      if (url) {
        chrome.storage.local.set({ adspowerUrl: url }, () => {
          // Provide simple visual feedback inside the button
          const originalText = saveUrlBtn.textContent;
          saveUrlBtn.textContent = "Đã lưu!";
          saveUrlBtn.style.backgroundColor = "#10b981"; // green
          setTimeout(() => {
            saveUrlBtn.textContent = originalText;
            saveUrlBtn.style.backgroundColor = "";
          }, 1500);
        });
      }
    });
  }

  updateStatus();
  // Refresh status every second
  setInterval(updateStatus, 1000);
});

function updateStatus() {
  chrome.runtime.sendMessage({ type: "GET_LATEST_CODE" }, (response) => {
    if (chrome.runtime.lastError) {
      console.log("[Bridge Popup] Context invalidated or background page not ready.");
      return;
    }

    const connStatus = document.getElementById('connStatus');
    const bridgeCode = document.getElementById('bridgeCode');

    if (response && response.code && !response.expired) {
      connStatus.textContent = "Đã nhận mã";
      connStatus.className = "status-val green";

      const rawCode = response.code;
      // Format to "123 456"
      const formatted = rawCode.substring(0, 3) + ' ' + rawCode.substring(3);
      bridgeCode.textContent = formatted;
    } else {
      connStatus.textContent = "Chưa nhận mã";
      connStatus.className = "status-val red";
      bridgeCode.textContent = "------";
    }
  });
}
