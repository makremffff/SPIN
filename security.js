/* ══════════════════════════════════════════════════════
   security.js — Telegram WebApp bootstrap helpers
══════════════════════════════════════════════════════ */

/**
 * Signals Telegram the app is ready and expands to full height.
 * Safe to call even outside Telegram (no-op).
 */
function initTelegramApp() {
  try {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
  } catch {}
}

/**
 * Extracts the startapp/start_param value from Telegram initData.
 * Used to detect referral codes on first open.
 * @returns {string|null}
 */
function getStartParam() {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param
    || window.Telegram?.WebApp?.initDataUnsafe?.startapp
    || null;
}
