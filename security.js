/* ══════════════════════════════════════════════════════
   security.js — TEST MODE (no protection)
   كل الحمايات معطلة — للاختبار فقط، لا ترفعه على production
══════════════════════════════════════════════════════ */

/* ── 1. Telegram Bootstrap ──────────────────────────── */
function initTelegramApp() {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
  } catch {}
}

function getStartParam() {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param
    || window.Telegram?.WebApp?.initDataUnsafe?.startapp
    || null;
}

/* ── 2. DevTools Detection — DISABLED ──────────────── */

/* ── 3. Screenshot Prevention — DISABLED ───────────── */

/* ── 4. API Response Integrity — DISABLED ──────────── */
function secValidate(type, body) {
  return true;
}

/* ── 5. Anti-DOM Tampering — DISABLED ──────────────── */
function secRegisterState(user) {}

/* ── 6. Environment Validation — DISABLED ──────────── */

/* ── 7. Frontend Rate Limiter — DISABLED (always allow) */
function secAllow(action) {
  return true;
}

/* ── 8. Session Fingerprint — stub ─────────────────── */
function secFingerprint() {
  return 'test';
}
