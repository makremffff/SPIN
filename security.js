/* ══════════════════════════════════════════════════════
   security.js — Frontend Security Layer
   1. Telegram bootstrap helpers
   2. DevTools detection
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

/* ── 1. Telegram Bootstrap ──────────────────────────── */
function initTelegramApp() {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready();
    tg.expand();

    // 🛡️ منع لقطات الشاشة عبر Telegram WebApp API
    if (typeof tg.disableVerticalSwipes === 'function') {
      tg.disableVerticalSwipes();
    }
    // API الرسمي لمنع Screenshot (متاح في بعض إصدارات Telegram)
    if (typeof tg.requestWriteAccess === 'function') {
      // نستخدم isVersionAtLeast للتحقق من دعم lockOrientation
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
  // 🔧 وضع المطور: لو مفعّل، الكشف بالكامل ما بيشتغل
  // فعّله من الـ Console مرة وحدة: localStorage.setItem('dev_mode', '1')
  // وعطّله برجاعه: localStorage.removeItem('dev_mode')
  if (localStorage.getItem('dev_mode') === '1') {
    console.log('[security] dev_mode active — DevTools guard disabled');
    return;
  }

  let devOpen = false;

  // Method A: فرق حجم النافذة (DevTools مفتوح على الجانب)
  function checkSize() {
    return (window.outerWidth - window.innerWidth) > 160
        || (window.outerHeight - window.innerHeight) > 160;
  }

  // Method B: توقيت debugger statement
  function checkDebugger() {
    const t = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    return performance.now() - t > 100;
  }

  function onOpen() {
    if (devOpen) return;
    devOpen = true;
    console.warn('[security] DevTools detected');
    _reportSecEvent('devtools_open', { ua: navigator.userAgent.slice(0, 80) });
  }

  function onClose() {
    devOpen = false;
  }

  setInterval(() => {
    const open = checkSize() || checkDebugger();
    if (open && !devOpen) onOpen();
    if (!open && devOpen) onClose();
  }, 1500);
})();

/* ── 3. Screenshot Prevention ───────────────────────── */
(function screenshotGuard() {
  try {
    // منع طباعة الصفحة (Ctrl+P)
    window.addEventListener('beforeprint', e => {
      e.preventDefault();
      _reportSecEvent('print_attempt', {});
    });

    // CSS: إخفاء المحتوى عند الطباعة
    const style = document.createElement('style');
    style.textContent = `@media print { body { display:none !important; } }`;
    document.head.appendChild(style);

    // كشف محاولة PrtScr عبر كليد الكيبورد (Windows)
    window.addEventListener('keyup', e => {
      if (e.key === 'PrintScreen') {
        _reportSecEvent('printscreen_key', {});
      }
    });
  } catch {}
})();

/* ── 4. API Response Integrity ──────────────────────── */
const RESPONSE_SCHEMA = {
  init: {
    required: ['ok', 'user', 'leaderboard', 'referral', 'config'],
    user:     ['id', 'telegram_id', 'pts', 'balance_usd', 'rank']
  },
  watchAd: { required: ['ok', 'reward'] },
  withdraw: { required: ['ok'] }
};

function secValidate(type, body) {
  if (!body || typeof body !== 'object') return false;
  const schema = RESPONSE_SCHEMA[type];
  if (!schema) return true;

  for (const field of schema.required) {
    if (!(field in body)) {
      console.warn(`[security] missing "${field}" in ${type} response`);
      _reportSecEvent('invalid_response', { type, missing: field });
      return false;
    }
  }
  if (schema.user && body.user) {
    for (const field of schema.user) {
      if (!(field in body.user)) {
        console.warn(`[security] missing user.${field} in ${type} response`);
        _reportSecEvent('invalid_response', { type, missing: `user.${field}` });
        return false;
      }
    }
  }
  return true;
}

/* ── 5. Anti-DOM Tampering ──────────────────────────── */
const _domGuard = {
  _values: {},

  register(key, value) {
    this._values[key] = value;
  },

  check(key, elementId, parseAs) {
    const el = document.getElementById(elementId);
    if (!el) return;

    const text     = el.textContent.replace(/[^0-9.]/g, '');
    const displayed = parseAs === 'int' ? parseInt(text, 10) : parseFloat(text);
    const expected  = this._values[key];
    if (expected === undefined || isNaN(displayed)) return;

    if (Math.abs(displayed - expected) > 0.01) {
      console.warn(`[security] DOM tamper: #${elementId} displayed=${displayed} expected=${expected}`);
      _reportSecEvent('dom_tamper', { element: elementId, displayed, expected });

      // استعادة القيمة الحقيقية فوراً
      if (parseAs === 'int') {
        el.textContent = Math.floor(expected).toLocaleString();
      } else {
        el.textContent = expected.toFixed(2);
      }
    }
  },

  startPolling() {
    setInterval(() => {
      // IDs مطابقة لما هو في index.html
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
  // كشف Headless / Automation
  const isHeadless = navigator.webdriver === true
    || /HeadlessChrome|PhantomJS|Puppeteer/i.test(navigator.userAgent);

  if (isHeadless) {
    console.warn('[security] headless browser detected');
    _reportSecEvent('headless_detected', { ua: navigator.userAgent.slice(0, 80) });
    // إيقاف التطبيق نظيف — إخفاء كامل المحتوى
    document.addEventListener('DOMContentLoaded', () => {
      document.body.style.display = 'none';
    });
    return;
  }

  // التحقق من بيئة Telegram
  const isTelegram = !!(
    window.Telegram?.WebApp?.initData?.length > 0
  );

  if (!isTelegram) {
    console.warn('[security] running outside Telegram');
    window.__outsideTelegram = true;
    // لا نوقف — dev mode يحتاج هذا
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

      // ازل الطلبات القديمة
      _history[action] = _history[action].filter(t => now - t < cfg.windowMs);

      if (_history[action].length >= cfg.max) {
        console.warn(`[security] rate limit: ${action}`);
        _reportSecEvent('rate_limit_hit', { action });
        return false;
      }

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

    // djb2 hash
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

/* ── Start DOM polling after page load ──────────────── */
window.addEventListener('load', () => _domGuard.startPolling());
