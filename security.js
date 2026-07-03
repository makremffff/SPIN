/* ══════════════════════════════════════════════════════
   security.js — DEV / EMPTY BUILD
   ⚠️ نسخة فاضية بالكامل — بدون DevTools detection، بدون
   rate limiting، بدون fingerprint حقيقي، بدون أي حجب.
   الهدف الوحيد: تفتح Developer Tools بحرية وتشوف كل
   طلبات الـ API (Network tab) وهي بترسل/بترجع من السيرفر
   من غير ما حاجة توقفك أو تقفل الكونسول.

   🚫 ممنوع ترفع النسخة دي على الإنتاج (Vercel) — دي بتلغي
   كل الحماية الحالية (DevTools block, screenshot prevention,
   response integrity check, rate limiting, fingerprinting).
   ارجع لنسخة security.prod.backup.js قبل أي deploy حقيقي.
══════════════════════════════════════════════════════ */

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

/* 🔓 يقبل أي شيء — بدون فحص بنية الرد */
function secValidate(_type, _body) {
  return true;
}

/* 🔓 بدون تسجيل حالة أمنية */
function secRegisterState(_user) {}

/* 🔓 بدون أي rate limit — كل الأزرار تشتغل بلا حدود */
function secAllow(_action) {
  return true;
}

/* 🔓 fingerprint وهمي ثابت — بدون تجميع بيانات جهاز حقيقية */
function secFingerprint() {
  return 'dev-mode-no-fingerprint';
}
