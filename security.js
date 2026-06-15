/* ══════════════════════════════════════════════════════
   security.js — Frontend Security Layer
   1. Telegram bootstrap helpers
   2. DevTools detection + Danger table
   3. Screenshot prevention
   4. API response integrity check
   5. Anti-DOM tampering
   6. Environment validation
   7. Frontend rate limiter
   8. Session fingerprint
══════════════════════════════════════════════════════ */

/* ── Shared: إرسال حدث أمني للسيرفر ────────────────── */
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

function _reportDanger(reason, meta) {
  try {
    fetch('/api', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:     'logDanger',
        data:     { reason, meta },
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

/* ── 2. DevTools Detection ──────────────────────────── */
(function devToolsGuard() {
  let devOpen = false;
  let freezeInterval = null;

  const screen$ = document.getElementById('devtools-screen');

  // Method A: فرق حجم النافذة (desktop)
  function checkSize() {
    return (window.outerWidth  - window.innerWidth)  > 160
        || (window.outerHeight - window.innerHeight) > 160;
  }

  // Method B: debugger timing (mobile + desktop)
  function checkDebugger() {
    const t = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    return performance.now() - t > 100;
  }

  function freeze() {
    // يجمّد الصفحة باستمرار طالما DevTools مفتوحة
    // eslint-disable-next-line no-debugger
    debugger;
  }

  function onOpen() {
    if (devOpen) return;
    devOpen = true;

    // أظهر الشاشة أولاً عبر visibility (أسرع من display)
    if (screen$) screen$.style.visibility = 'visible';

    _reportDanger('devtools', { ua: navigator.userAgent.slice(0, 80) });

    // انتظر frame كامل حتى يرسم الـ DOM الشاشة، ثم ابدأ التجميد
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        freezeInterval = setInterval(freeze, 100);
      });
    });
  }

  function onClose() {
    if (!devOpen) return;
    devOpen = false;

    if (screen$) screen$.style.visibility = 'hidden';

    // وقف التجميد
    if (freezeInterval) { clearInterval(freezeInterval); freezeInterval = null; }
  }

  setInterval(() => {
    const open = checkSize() || checkDebugger();
    if (open  && !devOpen) onOpen();
    if (!open &&  devOpen) onClose();
  }, 1000);
})();

/* ── 3. Screenshot Prevention ───────────────────────── */
(function screenshotGuard() {
  try {
    window.addEventListener('beforeprint', e => {
      e.preventDefault();
      _reportSecEvent('print_attempt', {});
    });

    const style = document.createElement('style');
    style.textContent = `@media print { body { display:none !important; } }`;
    document.head.appendChild(style);

    window.addEventListener('keyup', e => {
      if (e.key === 'PrintScreen') {
        _reportSecEvent('printscreen_key', {});
      }
    });
  } catch {}
})();

/* ── 4. API Response Integrity ──────────────────────── */
const RESPONSE_SCHEMA = {
  init:     { required: ['ok','user','leaderboard','referral','config'], user: ['id','telegram_id','pts','balance_usd','rank'] },
  watchAd:  { required: ['ok','reward'] },
  withdraw: { required: ['ok'] }
};

function secValidate(type, body) {
  if (!body || typeof body !== 'object') return false;
  const schema = RESPONSE_SCHEMA[type];
  if (!schema) return true;
  for (const f of schema.required) {
    if (!(f in body)) {
      _reportSecEvent('invalid_response', { type, missing: f });
      return false;
    }
  }
  if (schema.user && body.user) {
    for (const f of schema.user) {
      if (!(f in body.user)) {
        _reportSecEvent('invalid_response', { type, missing: `user.${f}` });
        return false;
      }
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
      console.warn(`[security] DOM tamper: #${elementId}`);
      _reportDanger('dom_tamper', { element: elementId, displayed, expected });
      if (parseAs === 'int') el.textContent = Math.floor(expected).toLocaleString();
      else                   el.textContent = expected.toFixed(2);
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

/* ── 6. Environment Validation ──────────────────────── */
(function envGuard() {
  const isHeadless = navigator.webdriver === true
    || /HeadlessChrome|PhantomJS|Puppeteer/i.test(navigator.userAgent);

  if (isHeadless) {
    _reportDanger('headless', { ua: navigator.userAgent.slice(0, 80) });
    document.addEventListener('DOMContentLoaded', () => {
      document.body.style.display = 'none';
    });
    return;
  }

  if (!window.Telegram?.WebApp?.initData?.length) {
    console.warn('[security] running outside Telegram');
    window.__outsideTelegram = true;
  }
})();

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
      if (_history[action].length >= cfg.max) {
        _reportSecEvent('rate_limit_hit', { action });
        return false;
      }
      _history[action].push(now);
      return true;
    }
  };
})();

function secAllow(action) { return _rateLimiter.allow(action); }

/* ── 8. Session Fingerprint ─────────────────────────── */
const _fingerprint = (function () {
  function build() {
    const raw = [
      navigator.language || '',
      navigator.languages?.join(',') || '',
      navigator.platform || '',
      navigator.hardwareConcurrency || 0,
      screen.width + 'x' + screen.height,
      screen.colorDepth || 0,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      new Date().getTimezoneOffset()
    ].join('|');
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i);
    return (h >>> 0).toString(16);
  }
  const fp = build();
  return { get: () => fp };
})();

function secFingerprint() { return _fingerprint.get(); }

/* ── Start DOM polling ──────────────────────────────── */
window.addEventListener('load', () => _domGuard.startPolling());
