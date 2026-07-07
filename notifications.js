/* ══════════════════════════════════════════════════════
   notifications.js — Toast Notification System (v2 · Premium)
   showToast({ type, title, msg, duration })
   type: 'ad' | 'rank' | 'referral' | 'success' | 'withdraw' | 'error'
══════════════════════════════════════════════════════ */

const TOAST_ICONS = {
  ad: `
    <svg viewBox="0 0 24 24">
      <path d="M12 2v20M17 5.5c0-1.9-2.2-3.5-5-3.5S7 3.6 7 5.5 9.2 9 12 9s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5"/>
    </svg>`,
  rank: `
    <svg viewBox="0 0 24 24">
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/>
      <path d="M7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3"/>
    </svg>`,
  referral: `
    <svg viewBox="0 0 24 24">
      <circle cx="9" cy="8" r="3.2"/>
      <path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5"/>
      <path d="M17 8.5c1.3.3 2.2 1.4 2.2 2.8s-.9 2.5-2.2 2.8M19 20c0-2.6-1.6-4.5-3.7-5.2"/>
    </svg>`,
  success: `
    <svg viewBox="0 0 24 24">
      <path d="M20 6 9 17l-5-5"/>
    </svg>`,
  withdraw: `
    <svg viewBox="0 0 24 24">
      <rect x="3" y="6" width="18" height="13" rx="2.5"/>
      <path d="M3 10h18"/>
      <circle cx="16.5" cy="14.2" r="1.3" fill="#0a0710" stroke="none"/>
    </svg>`,
  error: `
    <svg viewBox="0 0 24 24">
      <path d="M12 3 2 20h20L12 3Z"/>
      <path d="M12 10v4"/>
      <circle cx="12" cy="17" r=".6" fill="#0a0710" stroke="none"/>
    </svg>`
};

const _toastContainer = document.getElementById('toast-container');
const _toastQueue     = [];
let   _toastBusy      = false;

function showToast({ type = 'ad', title, msg, duration = 4000 }) {
  _toastQueue.push({ type, title, msg, duration });
  _drainToastQueue();
}

function _drainToastQueue() {
  if (_toastBusy || _toastQueue.length === 0) return;
  _toastBusy = true;
  const { type, title, msg, duration } = _toastQueue.shift();
  _renderToast({ type, title, msg, duration });
}

function _renderToast({ type, title, msg, duration }) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = TOAST_ICONS[type] || TOAST_ICONS.ad;

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-body">
      <span class="toast-title">${title}</span>
      ${msg ? `<span class="toast-msg">${msg}</span>` : ''}
    </div>
    <span class="toast-close">
      <svg class="toast-close-ring" viewBox="0 0 26 26">
        <circle class="ring-track" cx="13" cy="13" r="11"/>
        <circle class="ring-fill" cx="13" cy="13" r="11" style="animation-duration: ${duration}ms;"/>
      </svg>
      <span class="toast-close-btn">✕</span>
    </span>
  `;

  _toastContainer.appendChild(toast);

  // dismiss on tap
  toast.addEventListener('click', () => _dismissToast(toast));

  // auto-dismiss
  const timer = setTimeout(() => _dismissToast(toast), duration);
  toast._dismissTimer = timer;
}

function _dismissToast(toast) {
  if (toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._dismissTimer);
  toast.classList.add('leaving');
  toast.addEventListener('animationend', () => {
    toast.remove();
    _toastBusy = false;
    // small delay before next toast so they don't stack visually
    setTimeout(_drainToastQueue, 120);
  }, { once: true });
}
