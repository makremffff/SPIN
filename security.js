/* security.js — minimal stub, no active checks */

function _reportSecEvent() {}

function initTelegramApp() {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.ready();
    tg.expand();
    if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
  } catch {}
}

function getStartParam() {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param
    || window.Telegram?.WebApp?.initDataUnsafe?.startapp
    || null;
}

function secValidate() { return true; }

const _domGuard = {
  register() {},
  startPolling() {}
};

function secRegisterState() {}

function secAllow() { return true; }

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
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h) ^ raw.charCodeAt(i);
    return (h >>> 0).toString(16);
  }
  const fp = build();
  return { get: () => fp };
})();

function secFingerprint() {
  return _fingerprint.get();
}
