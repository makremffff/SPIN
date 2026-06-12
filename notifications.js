/* ══════════════════════════════════════════════════════
   notifications.js — Toast Notification System
   showToast({ type, title, msg, duration })
   type: 'ad' | 'rank' | 'referral' | 'withdraw'
══════════════════════════════════════════════════════ */

const BELL_SVG = `
  <svg viewBox="0 0 24 24">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
`;

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

  toast.innerHTML = `
    <span class="toast-icon">${BELL_SVG}</span>
    <div class="toast-body">
      <span class="toast-title">${title}</span>
      ${msg ? `<span class="toast-msg">${msg}</span>` : ''}
    </div>
    <span class="toast-close">✕</span>
    <div class="toast-progress" style="animation-duration: ${duration}ms;"></div>
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
