/* ══════════════════════════════════════════════════════
   pages.js — Render functions, navigation & animations
   Depends on: config.js
══════════════════════════════════════════════════════ */

/* ── Avatar helper ──────────────────────────────────────
   Works on any wrapper that contains:
     <img alt="">
     <div class="...-placeholder">…svg…</div>
   Shows photo if it loads, falls back to placeholder icon. */
function setAvatar(wrapper, url) {
  if (!wrapper) return;
  const img         = wrapper.querySelector('img');
  const placeholder = wrapper.querySelector('[class*="placeholder"]');
  if (!img) return;
  if (url) {
    img.onload  = () => { img.style.display = 'block'; if (placeholder) placeholder.style.display = 'none'; };
    img.onerror = () => { img.style.display = 'none';  if (placeholder) placeholder.style.display = 'flex'; };
    img.src = url;
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    if (placeholder) placeholder.style.display = 'flex';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* Prefer DB photo_url, fall back to live Telegram profile photo */
function getMyPhotoUrl() {
  return appState.user.photo_url
    || window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url
    || null;
}

/* ── Render: referral page ──────────────────────────────── */
function renderReferral() {
  const countEl  = document.getElementById('ref-count');
  const earnedEl = document.getElementById('ref-earned');
  const linkEl   = document.getElementById('ref-link-display');
  if (countEl)  countEl.textContent  = (appState.referral.count  || 0).toLocaleString();
  if (earnedEl) earnedEl.textContent = (appState.referral.earned || 0).toLocaleString();
  if (appState.user.telegram_id) {
    const param = `ref_${appState.user.telegram_id}`;
    REF_LINK = `https://t.me/${BOT_USERNAME}/play?startapp=${param}`;
    if (linkEl) linkEl.textContent = `t.me/${BOT_USERNAME}/play?startapp=${param}`;
  }
}

/* ── Render: withdraw page ──────────────────────────────── */
function renderWithdraw() {
  const balEl = document.getElementById('wd-balance');
  // 🎮 4 خانات عشرية — يعرض رصيد USDT كاملاً بدون تقريب (يشمل مبالغ اللعبة 0.0001)
  if (balEl) balEl.textContent = '$' + (Number(appState.user.balance_usd) || 0).toFixed(4);
}

/* ── Render: fill dynamic config values into the UI ────── */
function renderConfig() {
  const cfg = appState.config || APP_CONFIG;

  // Referral reward pill
  const refUsdt = document.getElementById('ref-usdt-reward');
  if (refUsdt) refUsdt.textContent = `+$${cfg.REF_USDT_REWARD.toFixed(2)}`;

  // Ad reward card
  const adReward = document.getElementById('ad-ticket-reward');
  if (adReward) adReward.textContent = `$${cfg.AD_USD_REWARD.toFixed(2)}`;

  // Withdraw minimum badge
  const wdMin = document.getElementById('wd-min-label');
  if (wdMin) wdMin.textContent = `Min $${cfg.WITHDRAW_MIN.toFixed(2)}`;

  // Update withdraw input min attribute
  const wdInput = document.getElementById('wd-amount');
  if (wdInput) wdInput.min = cfg.WITHDRAW_MIN;
}

/* ── Master render: applies appState to every page ─────── */
function renderAll() {
  renderConfig();
  renderReferral();
  renderWithdraw();
}

/* ── Apply a fresh API response & re-render everything ──── */
function applyState(res) {
  if (!res || !res.ok) return;
  appState.user        = { ...appState.user, ...res.user };
  appState.leaderboard = res.leaderboard || [];
  appState.referral    = res.referral || appState.referral;
  if (res.config) {
    appState.config = res.config;  // server is source of truth
    // مزامنة توقيت المسابقة من السرفر
    if (res.config.COMPETITION_END_MS) {
      competitionEnd = res.config.COMPETITION_END_MS;
      tick();
    }
  }
  // 🛡️ سجّل القيم الحقيقية لحماية DOM من التلاعب
  secRegisterState(res.user);
  renderAll();
}

/* ══════════════════════════════════════════════════════
   Page Entrance Animations
   Staggers .reveal children of a page in, one by one,
   each time that page becomes active.
══════════════════════════════════════════════════════ */
function animatePage(pageId) {
  const page = document.getElementById('page-' + pageId);
  if (!page) return;
  const items = page.querySelectorAll('.reveal');

  // reset instantly (no transition) so it can replay
  items.forEach(item => {
    item.style.transitionDelay = '0s';
    item.classList.remove('revealed');
  });

  // force reflow so the reset is applied before re-animating
  void page.offsetHeight;

  // stagger each element in
  items.forEach((item, i) => {
    item.style.transitionDelay = (i * REVEAL_STEP) + 'ms';
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      items.forEach(item => item.classList.add('revealed'));
    });
  });

}

/* ── Navigation ─────────────────────────────────────────── */
document.querySelectorAll('.nb').forEach(btn => {
  btn.addEventListener('click', function () {
    const target = this.dataset.page;

    document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    this.classList.add('active');
    document.getElementById('page-' + target).classList.add('active');
    animatePage(target);

    if (target === 'withdraw' && typeof renderWithdrawTiers === 'function') renderWithdrawTiers();
  });
});
