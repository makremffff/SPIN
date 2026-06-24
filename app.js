/* ══════════════════════════════════════════════════════
   app.js — Entry point
   Depends on: config.js, api.js, security.js,
               notifications.js, pages.js
══════════════════════════════════════════════════════ */

/* 🛡️ Wire up onboarding FIRST, before anything else runs.
   initOnboarding() is pure static UI logic with no dependency
   on config.js/api.js/etc. Running it first guarantees the
   Next button always works even if something later in this
   file throws (e.g. a missing/broken APP_CONFIG, a failed
   network call). function declarations are hoisted, so
   initOnboarding is already defined here even though its
   body is written further down in this file. */

/* ── Initial load ───────────────────────────────────── */
async function initApp() {
  initTelegramApp();
  const startParam = getStartParam();
  const res = await fetchApi({ type: 'init', data: { startParam } });
  if (res && res.ok) {
    if (res.user?.banned) {
      const banScreen = document.getElementById('ban-screen');
      banScreen.style.display = 'flex';
      return;
    }
    // 🛡️ تحقق من سلامة الـ response قبل التطبيق
    if (!secValidate('init', res)) {
      console.error('[initApp] invalid response structure');
      return;
    }
    applyState(res);
    // ✅ شاشة التعليمات — تُعرض مرة وحدة فقط (الـ flag محفوظ في DB)
    try {
      initOnboarding(res.user?.onboarding_seen === true);
    } catch (err) {
      console.error('[initOnboarding] failed to initialize', err);
    }
  } else {
    console.error('[initApp] failed:', res?.error);
  }
}

/* ── Re-fetch + re-render after any state-changing action */
async function refreshState() {
  const res = await fetchApi({ type: 'init' });
  if (res && res.ok) applyState(res);
  return res;
}

/* ══════════════════════════════════════════════════════
   Countdown — target يأتي من السرفر (COMPETITION_END_MS)
   قبل وصول init response نستخدم القيمة من APP_CONFIG
══════════════════════════════════════════════════════ */
let competitionEnd = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.COMPETITION_END_MS) || (Date.now() + 20 * 24 * 60 * 60 * 1000);
const el     = document.getElementById('cd-days');
const word   = document.querySelector('.cd-word');

function tick() {
  if (!el || !word) return;
  const diff = competitionEnd - Date.now();
  const days = Math.max(0, Math.ceil(diff / 86400000));
  el.textContent   = String(days).padStart(2, '0');
  word.textContent = days === 1 ? 'day left' : 'days left';
}
try { tick(); } catch (err) { console.warn('[countdown] tick failed', err); }
setInterval(() => { try { tick(); } catch (err) {} }, 60000);

/* ══════════════════════════════════════════════════════
   Copy referral link
══════════════════════════════════════════════════════ */
async function handleCopyLink() {
  fetchApi({ type: 'logRefCopy', data: {} });

  try {
    await navigator.clipboard.writeText(REF_LINK);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = REF_LINK;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  const btn   = document.getElementById('ref-copy-btn');
  const label = document.getElementById('copy-label');
  btn.classList.add('copied');
  label.textContent = 'Copied!';
  setTimeout(() => {
    btn.classList.remove('copied');
    label.textContent = 'Copy Link';
  }, 2000);
}

/* ══════════════════════════════════════════════════════
   Share buttons
══════════════════════════════════════════════════════ */
function handleShareFacebook(e) {
  e.preventDefault();
  fetchApi({ type: 'logShare', data: { platform: 'facebook' } });
  window.open(
    'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(REF_LINK),
    '_blank'
  );
}

function handleShareWhatsApp(e) {
  e.preventDefault();
  fetchApi({ type: 'logShare', data: { platform: 'whatsapp' } });
  const msg = 'Join me and earn USDT rewards! ' + REF_LINK;
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

/* ══════════════════════════════════════════════════════
   Adsgram SDK — تهيئة مرة واحدة فقط
══════════════════════════════════════════════════════ */
let _adsgramController = null;
function getAdsgramController() {
  if (!_adsgramController && window.Adsgram) {
    _adsgramController = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_ID });
  }
  return _adsgramController;
}

/* ══════════════════════════════════════════════════════
   Friendly messages for ad-related backend errors
   (يطابق نصوص الخطأ المُرجعة من api/index.js)
══════════════════════════════════════════════════════ */
function getAdErrorMessage(res) {
  switch (res?.error) {
    case 'Daily ad limit reached':
      return { title: 'Daily Limit Reached', msg: 'Come back tomorrow for more ads' };

    case 'Please wait':
    case 'Please wait between ads':
      return res?.waitSec
        ? { title: 'Please Wait', msg: `Next ad available in ${res.waitSec}s` }
        : { title: 'Please Wait', msg: 'Wait a bit before watching another ad' };

    case 'Too many ads from this network':
      return { title: 'Slow Down', msg: 'Too many requests — try again later' };

    case 'Ad not fully watched':
      return { title: 'Ad Not Counted', msg: 'Please watch the full ad to get your reward' };

    case 'Session expired':
    case 'Duplicate request':
    case 'Invalid session':
    case 'Session mismatch':
      return { title: 'Something Went Wrong', msg: 'Please try watching the ad again' };

    case 'Request expired':
      return { title: 'Check Your Clock', msg: 'Your device time looks off — fix it and try again' };

    default:
      return { title: 'Ad Not Available', msg: 'Try again in a moment' };
  }
}

/* ══════════════════════════════════════════════════════
   Watch Ad → two-step: startAd token → show ad → watchAd
══════════════════════════════════════════════════════ */
async function handleWatchAd() {
  const btn = document.getElementById('watch-btn');

  btn.disabled = true;

  // الخطوة 1: احجز token من السيرفر قبل ما تشغّل الإعلان
  // الـ cooldown الحقيقي محمي server-side — لا نستهلك secAllow هنا حتى لا نعاقب المستخدم
  // لو الإعلان فشل لأسباب خارجة عن إرادته (no fill, SDK error…)
  const AD_PROVIDER = 'adsgram';
  const startRes = await fetchApi({ type: 'startAd', data: { ts: Math.floor(Date.now() / 1000), adType: AD_PROVIDER } });

  if (!startRes || !startRes.ok) {
    btn.disabled = false;
    const { title, msg } = getAdErrorMessage(startRes);
    showToast({ type: 'error', title, msg, duration: 3500 });
    return;
  }

  const adToken = startRes.token;

  // الخطوة 2: شغّل الإعلان الحقيقي عبر Adsgram SDK
  const adController = getAdsgramController();
  if (!adController) {
    btn.disabled = false;
    showToast({ type: 'error', title: 'Error', msg: 'Ad SDK not loaded', duration: 3000 });
    return;
  }

  try {
    await adController.show();
  } catch (err) {
    btn.disabled = false;

    // 🛡️ كشف "no fill" (مافي إعلانات متاحة الآن) بناءً على شكل الـ error من Adsgram SDK
    // Adsgram يرجع: { error: true, done: false } أو description تحتوي NO_FILL / no_fill / no fill
    const desc = (err?.description || err?.message || err?.code || '').toString().toLowerCase();
    const isNoFill = (
      (err?.error === true && err?.done === false) ||
      desc.includes('no_fill') ||
      desc.includes('no fill') ||
      desc.includes('nofill') ||
      desc.includes('no ad') ||
      desc.includes('noads')
    );

    if (isNoFill) {
      // لا يوجد inventory — مش ذنب المستخدم، ما نعاقبه بـ cooldown
      showToast({ type: 'error', title: 'No Ads Available', msg: 'No ads right now — try again in a moment', duration: 3000 });
    } else {
      // المستخدم أغلق الإعلان قبل ما يكتمل — هنا نستهلك الـ rate limit كعقوبة خفيفة
      secAllow('watchAd');
      showToast({ type: 'error', title: 'Ad Skipped', msg: 'You must watch the full ad to get the reward', duration: 3000 });
    }
    return;
  }

  // ✅ الإعلان اكتمل — الآن نستهلك الـ frontend rate limit slot
  // (السيرفر هو الحكم الحقيقي، هذا فقط حماية إضافية طبيعية المسار)
  if (!secAllow('watchAd')) {
    // نادر جداً — يعني المستخدم ضغط مرتين في نفس اللحظة
    showToast({ type: 'error', title: 'Slow Down', msg: 'Please wait before watching another ad', duration: 3000 });
    setTimeout(() => { btn.disabled = false; }, 3000);
    return;
  }

  // الخطوة 3: طالب المكافأة مع الـ token
  // 🛡️ قد يحتاج السيرفر بضع ثوان لاستقبال تأكيد Adsgram (server-to-server) — أعد المحاولة بهدوء
  let res = await fetchApi({ type: 'watchAd', data: { token: adToken, ts: Math.floor(Date.now() / 1000) } });

  let retries = 0;

  // 🛡️ السيرفر بيحتاج وقت لاستقبال تأكيد Adsgram — رجّعنا للمستخدم إشارة
  // بدل ما يضل الزر مقفول 7.5 ثانية بدون أي تفسير
  if (res && res.error === 'pending_confirmation') {
    showToast({ type: 'ad', title: 'Confirming...', msg: 'Almost there, hold on', duration: 4000 });
  }

  while (res && res.error === 'pending_confirmation' && retries < 5) {
    await new Promise(r => setTimeout(r, res.retryAfterMs || 1500));
    res = await fetchApi({ type: 'watchAd', data: { token: adToken, ts: Math.floor(Date.now() / 1000) } });
    retries++;
  }

  if (res && res.ok) {
    const reward = res.reward ?? 750;

    if (res.partial) {
      // 60% reward — show center modal instead of normal toast
      showPartialRewardModal(reward);
    } else {
      showToast({
        type:     'ad',
        title:    `+${reward.toLocaleString()} Tickets Earned!`,
        msg:      'Ad watched successfully · Keep going',
        duration: 4500
      });
    }

    if (res.rankUp) {
      setTimeout(() => {
        showToast({
          type:     'rank',
          title:    `Rank Up! You're Now #${res.newRank}`,
          msg:      `You climbed ${res.rankDelta} place${res.rankDelta > 1 ? 's' : ''} · Stay on top!`,
          duration: 5000
        });
      }, 700);

    }

    refreshState();
  } else {
    const { title, msg } = getAdErrorMessage(res);
    showToast({ type: 'ad', title, msg, duration: 3500 });
  }

  setTimeout(() => { btn.disabled = false; }, 3000);
}

/* ══════════════════════════════════════════════════════
   Referral join — called from backend webhook / bot
   Exposed on window so backend-injected scripts can call it
══════════════════════════════════════════════════════ */
window.onReferralJoin = function({ friendName = 'A friend', reward = 5000 } = {}) {
  showToast({
    type:     'referral',
    title:    `${friendName} Joined!`,
    msg:      `+${reward.toLocaleString()} Tickets added to your balance`,
    duration: 5500
  });
};

/* ══════════════════════════════════════════════════════
   Withdraw → toast on success
══════════════════════════════════════════════════════ */
async function handleWithdraw() {
  // 🛡️ فحص rate limit على الفرونت
  if (!secAllow('withdraw')) {
    showToast({ type: 'withdraw', title: 'Too Many Attempts', msg: 'Please wait before trying again', duration: 3000 });
    return;
  }

  const address = document.getElementById('wd-address').value.trim();
  const memo    = document.getElementById('wd-memo').value.trim();
  const amount  = parseFloat(document.getElementById('wd-amount').value);

  if (!address) {
    showToast({ type: 'withdraw', title: 'Wallet Address Required', msg: 'Please enter your wallet address', duration: 3500 });
    return;
  }
  const withdrawMin = (appState.config || (typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {})).WITHDRAW_MIN;
  if (isNaN(amount) || amount < withdrawMin) {
    showToast({ type: 'withdraw', title: 'Invalid Amount', msg: `Minimum withdrawal is $${withdrawMin.toFixed(2)}`, duration: 3500 });
    return;
  }

  const btn = document.querySelector('.wd-btn');
  btn.disabled = true;
  btn.style.opacity = '0.7';

  const res = await fetchApi({ type: 'withdraw', data: { address, memo, amount } });

  btn.disabled = false;
  btn.style.opacity = '1';

  if (res && res.ok) {
    showToast({
      type:     'withdraw',
      title:    `Withdrawal Submitted`,
      msg:      `$${amount.toFixed(2)} · Processing within 24 hours`,
      duration: 5000
    });

    document.getElementById('wd-address').value = '';
    document.getElementById('wd-memo').value    = '';
    document.getElementById('wd-amount').value  = '';

    refreshState();
  } else {
    showToast({
      type:     'withdraw',
      title:    'Withdrawal Failed',
      msg:      res?.error || 'Please try again later',
      duration: 4000
    });
  }
}

/* ══════════════════════════════════════════════════════
   Partial Reward Modal — shown when ad session < 33s
   Displayed centered on screen with play.jpg image
══════════════════════════════════════════════════════ */
function showPartialRewardModal(reward) {
  // Remove any existing modal
  const old = document.getElementById('partial-reward-modal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'partial-reward-modal';
  modal.innerHTML = `
    <div id="partial-reward-card">
      <img src="asesst/play.jpg" alt="" id="partial-reward-img">
      <div id="partial-reward-body">
        <p id="partial-reward-pct">You got <strong>60%</strong> of the reward</p>
        <p id="partial-reward-amount">+${reward.toLocaleString()} Tickets</p>
        <p id="partial-reward-hint">Engage with the ad fully to unlock<br>your <strong>100% reward</strong> next time</p>
        <button id="partial-reward-close">Got it</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Animate in
  requestAnimationFrame(() => modal.classList.add('visible'));

  function close() {
    modal.classList.remove('visible');
    modal.addEventListener('transitionend', () => modal.remove(), { once: true });
  }

  document.getElementById('partial-reward-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

/* ══════════════════════════════════════════════════════
/* ══════════════════════════════════════════════════════
   Onboarding — first-launch swipeable intro (5 slides)
   Shown once; suppressed afterwards via DB flag (onboarding_seen).
   Called from initApp() after the init response arrives.
══════════════════════════════════════════════════════ */

function initOnboarding(alreadySeen = false) {
  const ob = document.getElementById('ob');
  if (!ob) return;

  if (alreadySeen) {
    // ob already hidden via CSS default (display:none)
    return;
  }

  // First visit — reveal the overlay
  ob.style.display = 'flex';

  const slides = ob.querySelectorAll('.slide');
  const track  = document.getElementById('track');
  const dots   = ob.querySelectorAll('.dot');
  const btn    = document.getElementById('btn');
  const flash  = document.getElementById('flash');
  const hint   = document.getElementById('scroll-hint');
  const labels = ['Next', 'Next', 'Next', 'Next', 'Start Playing'];
  let cur = 0, busy = false;

  function checkScroll() {
    const sl = slides[cur];
    const overflows = sl.scrollHeight - sl.scrollTop > sl.clientHeight + 10;
    hint.classList.toggle('show', overflows);
  }
  slides.forEach(s => s.addEventListener('scroll', checkScroll, { passive: true }));

  function goTo(n) {
    if (busy || n === cur) return;
    busy = true;
    flash.classList.remove('pop');
    void flash.offsetWidth;
    flash.classList.add('pop');
    slides[cur].classList.remove('visible');
    cur = n;
    track.style.transform = `translateX(-${cur * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle('on', i === cur));
    btn.textContent = labels[cur];
    btn.classList.toggle('go', cur === slides.length - 1);
    setTimeout(() => {
      slides[cur].classList.add('visible');
      slides[cur].scrollTop = 0;
      setTimeout(checkScroll, 300);
      busy = false;
    }, 120);
  }

  function finishOnboarding() {
    // ✅ سجّل في DB — يضمن ما تظهر مرة ثانية حتى لو تمسح الكاش أو غيّر جهاز
    fetchApi({ type: 'markOnboardingSeen' }).catch(err =>
      console.warn('[onboarding] could not persist seen-state to server', err)
    );
    ob.style.transition = 'opacity 0.4s ease';
    ob.style.opacity = '0';
    setTimeout(() => { ob.style.display = 'none'; }, 400);
  }

  btn.addEventListener('click', () => {
    if (cur < slides.length - 1) goTo(cur + 1);
    else finishOnboarding();
  });

  // swipe between slides
  let sx = 0;
  track.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 48) {
      if (dx < 0 && cur < slides.length - 1) goTo(cur + 1);
      if (dx > 0 && cur > 0)                 goTo(cur - 1);
    }
  });

  setTimeout(checkScroll, 600);
}

/* ══════════════════════════════════════════════════════
   Startup
══════════════════════════════════════════════════════ */
try { renderConfig(); } catch (err) { console.error('[renderConfig] failed', err); }   // fill values from APP_CONFIG immediately (before server responds)
try { animatePage('contest'); } catch (err) { console.error('[animatePage] failed', err); }
initApp();
    } catch (_) {}
  }, 8000);                                        // كل 8 ثواني
}
