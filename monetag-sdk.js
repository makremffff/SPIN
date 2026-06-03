// ══════════════════════════════════════════════════════════
// monetag-sdk.js — Monetag SDK Loader (Rewarded Interstitial)
// ══════════════════════════════════════════════════════════
// نوع الإعلان: Rewarded Interstitial — أعلى CPM ومكافأة حقيقية
// يُحمَّل بشكل lazy وهو مستقل تماماً عن Adsgram
// ══════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ─── إعدادات Monetag ──────────────────────────────────
    // استبدل ZONE_ID بالرقم الحقيقي من لوحة تحكم Monetag
    const MONETAG_ZONE_ID = '10245709'; // ← عدّل هذا

    // اسم الدالة العالمية التي يولّدها الـ SDK: show_<ZONE_ID>
    // مثال: إذا كان الـ zone ID هو 12345، ستكون: show_12345
    const MONETAG_SHOW_FN  = `show_${MONETAG_ZONE_ID}`;
    const MONETAG_SDK_URL  = `https://partner.privatepush.com/sdk.js?zone=${MONETAG_ZONE_ID}&sdk=${MONETAG_SHOW_FN}`;

    window._monetagStatus  = 'idle';   // idle | loading | loaded | failed
    window._monetagQueue   = [];       // callbacks تنتظر تحميل الـ SDK

    // ─── تحميل الـ SDK ────────────────────────────────────
    function _loadSdk() {
        if (window._monetagStatus !== 'idle') return;
        window._monetagStatus = 'loading';

        const script    = document.createElement('script');
        script.src      = MONETAG_SDK_URL;
        script.async    = true;
        script.dataset.zone = MONETAG_ZONE_ID;
        script.dataset.sdk  = MONETAG_SHOW_FN;

        script.onload = () => {
            window._monetagStatus = 'loaded';
            // استدعاء كل الـ callbacks المنتظِرة
            window._monetagQueue.forEach(fn => fn());
            window._monetagQueue = [];
            console.log('[Monetag] SDK loaded ✓');
        };

        script.onerror = () => {
            window._monetagStatus = 'failed';
            window._monetagQueue.forEach(fn => fn(new Error('SDK load failed')));
            window._monetagQueue = [];
            console.warn('[Monetag] SDK failed to load');
        };

        document.head.appendChild(script);
    }

    // ─── انتظر حتى يكتمل تحميل الـ SDK ──────────────────
    function _whenReady(cb) {
        if (window._monetagStatus === 'loaded') { cb(); return; }
        if (window._monetagStatus === 'failed') { cb(new Error('SDK not loaded')); return; }
        window._monetagQueue.push(cb);
        if (window._monetagStatus === 'idle') _loadSdk();
    }

    // ─── Preload ──────────────────────────────────────────
    window._monetagPreload = function (userId) {
        return new Promise((resolve, reject) => {
            _whenReady((err) => {
                if (err) return reject(err);
                const showFn = window[MONETAG_SHOW_FN];
                if (typeof showFn !== 'function') return reject(new Error('show fn missing'));
                showFn({ type: 'preload', ymid: String(userId || '') })
                    .then(resolve)
                    .catch(reject);
            });
        });
    };

    // ─── عرض الإعلان (Rewarded Interstitial) ─────────────
    // يعيد Promise يُحَلّ بعد مشاهدة الإعلان → منح المكافأة
    window._monetagShowAd = function (userId) {
        return new Promise((resolve, reject) => {
            _whenReady((err) => {
                if (err) return reject(err);
                const showFn = window[MONETAG_SHOW_FN];
                if (typeof showFn !== 'function') return reject(new Error('show fn missing'));
                showFn({ ymid: String(userId || '') })
                    .then(resolve)
                    .catch(reject);
            });
        });
    };

    // ─── تحميل مبكر عند دخول صفحة الربح ────────────────
    // يُطلق التحميل عند أول استخدام (lazy)
    window._monetagInit = function () {
        if (window._monetagStatus === 'idle') _loadSdk();
    };

    console.log('[Monetag] monetag-sdk.js initialized (Rewarded Interstitial)');
})();
