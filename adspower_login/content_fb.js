// Content script for Facebook 2FA Page (AdsPower Bridge version)
console.log("[AdsPower 2FA Bridge] content_fb.js loaded");

// Check if element is visible
function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Find the 2FA input field on the page
function findOTPInput() {
  // 1. Try standard autocomplete property
  let input = document.querySelector('input[autocomplete="one-time-code"]');
  if (input && isElementVisible(input)) return input;

  // 2. Facebook legacy attribute
  input = document.querySelector('input[name="approvals_code"]');
  if (input && isElementVisible(input)) return input;

  // 3. Search all input elements
  const inputs = Array.from(document.querySelectorAll('input'));
  const otpKeywords = [
    // English
    'approvals_code', 'code', 'otp', '2fa', 'twofactor', 'two-factor',
    'verification', 'security_code', 'authcode', 'passcode',
    'verification_code', 'one-time', 'security', 'login_code',
    // Vietnamese
    'mã', 'xác thực', 'xác minh', 'bảo mật', 'mã xác nhận', 'mã xác minh', 'thiết bị',
    // Spanish / Portuguese
    'código', 'codigo', 'verificación', 'verificação', 'seguridad', 'segurança', 'clave',
    // Danish / Norwegian / German / Swedish
    'kode', 'to-faktor', 'to-trins', 'bekræftelse', 'godkendelse', 'fortsæt',
    // Russian
    'код', 'подтвержд', 'проверк', 'безопасн',
    // Chinese
    '验证码', '安全码', '验证', '校验码',
    // Japanese
    'コード', '認証', 'ワンタイム', 'セキュリティ',
    // Korean
    '코드', '인증', '보안', '인증번호'
  ];

  const visibleInputs = [];

  for (const inp of inputs) {
    const type = (inp.getAttribute('type') || 'text').toLowerCase();
    if (!['text', 'number', 'tel', 'password'].includes(type)) continue;

    const visible = isElementVisible(inp);
    if (!visible) continue;

    visibleInputs.push(inp);

    const name = (inp.name || '').toLowerCase();
    const id = (inp.id || '').toLowerCase();
    const placeholder = (inp.placeholder || '').toLowerCase();
    const className = (inp.className || '').toLowerCase();
    const label = (inp.getAttribute('aria-label') || '').toLowerCase();

    // Check direct attributes
    let isMatch = otpKeywords.some(keyword =>
      name.includes(keyword) ||
      id.includes(keyword) ||
      placeholder.includes(keyword) ||
      className.includes(keyword) ||
      label.includes(keyword)
    );

    // Check parent text (up to 3 levels)
    if (!isMatch) {
      let parent = inp.parentElement;
      let level = 0;
      while (parent && level < 3) {
        const parentText = (parent.innerText || '').toLowerCase();
        isMatch = otpKeywords.some(keyword => parentText.includes(keyword));
        if (isMatch) break;
        parent = parent.parentElement;
        level++;
      }
    }

    if (isMatch) {
      return inp;
    }
  }

  // Fallback: If exactly ONE visible text input on a verification-related page
  const isVerificationPage = [window.location.href, document.title, document.body.innerText].some(text => {
    const lower = (text || '').toLowerCase();
    return [
      // English / URL structures (Universal)
      'two_factor', 'two-factor', 'two_step', 'two-step', 'verification', 'otp', 'auth', 'security', 'checkpoint', 'verify', 'challenge',
      // Vietnamese
      'xác thực', 'xác minh', 'mã xác nhận', 'mã bảo mật', 'mã bảo vệ',
      // Spanish / Portuguese
      'verificación', 'verificação', 'seguridad', 'segurança', 'código de inicio',
      // Danish / Norwegian / Swedish / German
      'to-trins', 'to-faktor', 'bekræftelse', 'godkendelse', 'kode',
      // Russian
      'подтвержд', 'проверк', 'двухфакторн',
      // Chinese
      '双重验证', '验证码', '安全码',
      // Japanese
      '2段階認証', 'コード', '認証',
      // Korean
      '2단계 인증', '인증 번호', '코드'
    ].some(kw => lower.includes(kw));
  });

  if (visibleInputs.length === 1 && isVerificationPage) {
    console.log("[AdsPower 2FA Bridge] Fallback: Exactly one visible input found on verification page:", visibleInputs[0]);
    return visibleInputs[0];
  }

  return null;
}

let autofillTimer = null;
let lastAutofilledCode = '';

function showAutofillFeedback(input) {
  const originalBorder = input.style.borderColor;
  const originalTransition = input.style.transition;
  const originalShadow = input.style.boxShadow;

  input.style.transition = 'all 0.3s ease';
  input.style.borderColor = '#10b981'; // Green accent
  input.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.4)';

  setTimeout(() => {
    input.style.borderColor = originalBorder;
    input.style.boxShadow = originalShadow;
    setTimeout(() => {
      input.style.transition = originalTransition;
    }, 300);
  }, 1200);
}

// Attempt to fetch code from background and autofill
function tryAutofillFromBridge() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    if (autofillTimer) {
      clearInterval(autofillTimer);
      autofillTimer = null;
    }
    return;
  }

  // Check if we are on a 2FA page
  const currentUrl = window.location.href;

  // Exclude setup/authentication configuration pages
  if (currentUrl.includes('/two_step_verification/authentication')) {
    return; // Silent exit on settings page
  }

  const is2FAPage = currentUrl.includes('/two_step_verification/') || currentUrl.includes('/two_factor/') || currentUrl.includes('two-factor') || currentUrl.includes('two_step');

  if (!is2FAPage) {
    return; // Silent exit on non-2FA pages
  }

  chrome.runtime.sendMessage({ type: "GET_LATEST_CODE" }, (response) => {
    if (chrome.runtime.lastError) {
      console.log("[AdsPower 2FA Bridge] Context invalidated.");
      return;
    }

    if (response && response.code) {
      const otpInput = findOTPInput();
      if (!otpInput) return;

      const code = response.code;
      const currentValue = otpInput.value;
      const isEmpty = currentValue.trim() === '';
      const isOurPreviousCode = currentValue.trim().replace(/\s+/g, '') === lastAutofilledCode;

      if (isEmpty || isOurPreviousCode) {
        otpInput.value = code;
        lastAutofilledCode = code;

        // Dispatch React events
        otpInput.dispatchEvent(new Event('input', { bubbles: true }));
        otpInput.dispatchEvent(new Event('change', { bubbles: true }));

        if (isEmpty) {
          showAutofillFeedback(otpInput);
          console.log("[AdsPower 2FA Bridge] Successfully autofilled 2FA code from AdsPower:", code);
        }
      }
    }
  });
}

function initBridgeAutofill() {
  tryAutofillFromBridge();

  // Observe DOM additions
  const observer = new MutationObserver((mutations) => {
    tryAutofillFromBridge();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Poll every 2 seconds to keep codes fresh
  if (autofillTimer) clearInterval(autofillTimer);
  autofillTimer = setInterval(tryAutofillFromBridge, 2000);
}

// Run init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBridgeAutofill);
} else {
  initBridgeAutofill();
}
