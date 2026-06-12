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

/* ── Render: "You" card on the contest page ────────────── */
function renderYouCard() {
  const card = document.querySelector('.you-card');
  if (!card) return;
  const rankEl = document.getElementById('you-rank');
  const ptsEl  = document.getElementById('you-pts');
  const nameEl = document.getElementById('you-name');
  if (rankEl) rankEl.textContent = appState.user.rank ? `#${appState.user.rank}` : '—';
  if (ptsEl)  ptsEl.textContent  = (appState.user.pts || 0).toLocaleString();
  if (nameEl) nameEl.textContent = appState.user.name || 'You';
  setAvatar(card.querySelector('.lb-avatar'), getMyPhotoUrl());
}

/* ── Render: podium (top 3) ─────────────────────────────── */
function renderPodium() {
  const slots = [
    { rank: 1, sel: '.pod-slot.first'  },
    { rank: 2, sel: '.pod-slot.second' },
    { rank: 3, sel: '.pod-slot.third'  }
  ];
  slots.forEach(({ rank, sel }) => {
    const slot = document.querySelector(sel);
    if (!slot) return;
    const entry    = appState.leaderboard.find(e => e.rank === rank);
    const avatar   = slot.querySelector('.pod-avatar');
    const ptsValue = slot.querySelector('.pod-pts-value');
    const ptsNum   = slot.querySelector('.pod-pts-num');
    const shimmer  = slot.querySelector('.pod-hidden-pts');
    if (entry) {
      const photo = entry.telegram_id === appState.user.telegram_id ? getMyPhotoUrl() : entry.photo_url;
      setAvatar(avatar, photo);
      if (ptsNum)   ptsNum.textContent        = (entry.pts || 0).toLocaleString();
      if (ptsValue) ptsValue.style.display    = 'flex';
      if (shimmer)  shimmer.style.display     = 'none';
    } else {
      setAvatar(avatar, null);
      if (ptsValue) ptsValue.style.display    = 'none';
      if (shimmer)  shimmer.style.display     = 'block';
    }
  });
}

/* ── Render: leaderboard rows 4–8 ──────────────────────── */
function renderLeaderboardRows() {
  const container = document.getElementById('lb-rows');
  if (!container) return;
  const rows = appState.leaderboard.filter(e => e.rank > 3).slice(0, 5);
  if (rows.length === 0) return; // keep skeleton until data arrives

  container.innerHTML = '';
  rows.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'lb-row';
    row.innerHTML = `
      <span class="lb-rank">${entry.rank}</span>
      <div class="lb-avatar">
        <img alt="">
        <div class="lb-avatar-placeholder">${LB_AVATAR_SVG}</div>
      </div>
      <div class="lb-info">
        <span class="lb-name">${escapeHtml(entry.name)}</span>
        <div class="lb-pts">
          <img src="asesst/coins.png" alt="coin">
          <span>${(entry.pts || 0).toLocaleString()}</span>
        </div>
      </div>
      <span class="lb-reward">—</span>
    `;
    container.appendChild(row);
    const photo = entry.telegram_id === appState.user.telegram_id ? getMyPhotoUrl() : entry.photo_url;
    setAvatar(row.querySelector('.lb-avatar'), photo);
  });
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
  if (balEl) balEl.textContent = '$' + (Number(appState.user.balance_usd) || 0).toFixed(2);
}

/* ── Master render: applies appState to every page ─────── */
function renderAll() {
  renderYouCard();
  renderPodium();
  renderLeaderboardRows();
  renderReferral();
  renderWithdraw();
}

/* ── Apply a fresh API response & re-render everything ──── */
function applyState(res) {
  if (!res || !res.ok) return;
  appState.user        = { ...appState.user, ...res.user };
  appState.leaderboard = res.leaderboard || [];
  appState.referral    = res.referral || appState.referral;
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
    document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    this.classList.add('active');
    document.getElementById('page-' + this.dataset.page).classList.add('active');
    animatePage(this.dataset.page);
  });
});
