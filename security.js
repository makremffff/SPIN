/* ══════════════════════════════════════════════════════
   security.js — DEV MODE (بدون DevTools detection)
   ✅ يحتفظ بكل الوظائف الأخرى
   ❌ يحذف: DevTools check، Screenshot prevention،
            Environment block، DOM polling
   استبدله بـ security.js الأصلي قبل الإنتاج
══════════════════════════════════════════════════════ */

/* ── Shared ─────────────────────────────────────────── */
function _reportSecEvent(event, detail) {
  try {
    fetch('/api', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:     'logSecEvent',
        data:     { event, detail },
        initData: window.Telegram?.WebApp?.initData || '',
        fp:       typeof secFingerprint === 'function' ? secFingerprint() : null
      })
    }).catch(() => {});
  } catch {}
}

/* ── 1. Telegram Bootstrap ──────────────────────────── */
function initTelegramApp() {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
    if (typeof tg.disableVerticalSwipes === 'function') {
      tg.disableVerticalSwipes();
    }
  } catch {}
}

function getStartParam() {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param
    || window.Telegram?.WebApp?.initDataUnsafe?.startapp
    || null;
}

/* ── 2. DevTools Detection — معطّل في DEV ───────────── */
// (محذوف — أعد تفعيله في ملف الإنتاج)

/* ── 3. Screenshot Prevention — معطّل في DEV ────────── */
// (محذوف — أعد تفعيله في ملف الإنتاج)

/* ── 4. API Response Integrity ──────────────────────── */
const RESPONSE_SCHEMA = {
  init:     { required: ['ok', 'user', 'leaderboard', 'referral', 'config'],
               user:    ['id', 'telegram_id', 'pts', 'balance_usd', 'rank'] },
  watchAd:  { required: ['ok', 'reward'] },
  withdraw: { required: ['ok'] }
};

function secValidate(type, body) {
  if (!body || typeof body !== 'object') return false;
  const schema = RESPONSE_SCHEMA[type];
  if (!schema) return true;
  for (const field of schema.required) {
    if (!(field in body)) return false;
  }
  if (schema.user && body.user) {
    for (const field of schema.user) {
      if (!(field in body.user)) return false;
    }
  }
  return true;
}

/* ── 5. Anti-DOM Tampering ──────────────────────────── */
const _domGuard = {
  _values: {},
  register(key, value) { this._values[key] = value; },
  check(key, elementId, parseAs) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text      = el.textContent.replace(/[^0-9.]/g, '');
    const displayed = parseAs === 'int' ? parseInt(text, 10) : parseFloat(text);
    const expected  = this._values[key];
    if (expected === undefined || isNaN(displayed)) return;
    if (Math.abs(displayed - expected) > 0.01) {
      el.textContent = parseAs === 'int'
        ? Math.floor(expected).toLocaleString()
        : expected.toFixed(2);
    }
  },
  startPolling() {
    setInterval(() => {
      this.check('pts',         'you-pts',    'int');
      this.check('balance_usd', 'wd-balance', 'float');
      this.check('rank',        'you-rank',   'int');
    }, 3000);
  }
};

function secRegisterState(user) {
  if (!user) return;
  _domGuard.register('pts',         user.pts);
  _domGuard.register('balance_usd', user.balance_usd);
  _domGuard.register('rank',        user.rank);
}

/* ── 6. Environment — معطّل في DEV ─────────────────── */
// (محذوف — no headless check, no Telegram-only block)
window.__outsideTelegram = !window.Telegram?.WebApp?.initData?.length;

/* ── 7. Frontend Rate Limiter ───────────────────────── */
const _rateLimiter = (function () {
  const _limits = {
    watchAd:  { max: 1,  windowMs: 70000 },
    withdraw: { max: 2,  windowMs: 60000 },
    startAd:  { max: 2,  windowMs: 70000 },
    default:  { max: 30, windowMs: 60000 }
  };
  const _history = {};
  return {
    allow(action) {
      const now = Date.now();
      const cfg = _limits[action] || _limits.default;
      if (!_history[action]) _history[action] = [];
      _history[action] = _history[action].filter(t => now - t < cfg.windowMs);
      if (_history[action].length >= cfg.max) return false;
      _history[action].push(now);
      return true;
    }
  };
})();

function secAllow(action) {
  return _rateLimiter.allow(action);
}

/* ── 8. Session Fingerprint ─────────────────────────── */
const _fingerprint = (function () {
  function build() {
    const raw = [
      navigator.language    || '',
      navigator.languages?.join(',') || '',
      navigator.platform    || '',
      navigator.hardwareConcurrency || 0,
      screen.width + 'x' + screen.height,
      screen.colorDepth     || 0,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      new Date().getTimezoneOffset()
    ].join('|');
    let h = 5381;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) + h) ^ raw.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }
  const fp = build();
  return { get: () => fp };
})();

function secFingerprint() {
  return _fingerprint.get();
}

/* ── DOM polling ────────────────────────────────────── */
window.addEventListener('load', () => _domGuard.startPolling());
