/* ══════════════════════════════════════════════════════
   app.js — Entry point
   Depends on: config.js, api.js, security.js,
               notifications.js, pages.js
══════════════════════════════════════════════════════ */

/* ── Bot Notification via Telegram ─────────────────────
   Fires fetchApi({ type: 'sendBotMsg', ... })
   Backend uses BOT_TOKEN from env, never exposed here. */
async function sendBotNotification({ chatId, text }) {
  return fetchApi({ type: 'sendBotMsg', data: { chatId, text } });
}

/* ── Initial load ───────────────────────────────────── */
async function initApp() {
  initTelegramApp();
  const startParam = getStartParam();
  const res = await fetchApi({ type: 'init', data: { startParam } });
  if (res && res.ok) {
    applyState(res);
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
   Countdown
══════════════════════════════════════════════════════ */
const target = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const el     = document.getElementById('cd-days');
const word   = document.querySelector('.cd-word');

function tick() {
  const diff = target - Date.now();
  const days = Math.max(0, Math.ceil(diff / 86400000));
  el.textContent   = String(days).padStart(2, '0');
  word.textContent = days === 1 ? 'day left' : 'days left';
}
tick();
setInterval(tick, 60000);

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
  // ✅ adType: السيرفر يحدد المدة المطلوبة فعلياً حسب الشبكة (adsgram/monetag/telega)
  const AD_PROVIDER = 'adsgram'; // ← غيّرها حسب الشبكة المستخدمة فعلاً هنا
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
    await adController.show(); // يُرفض إذا تخطى المستخدم الإعلان أو لم يكتمل
  } catch (err) {
    btn.disabled = false;
    showToast({ type: 'error', title: 'Ad Skipped', msg: 'You must watch the full ad to get the reward', duration: 3000 });
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

    showToast({
      type:     'ad',
      title:    `+${reward.toLocaleString()} Tickets Earned!`,
      msg:      'Ad watched successfully · Keep going',
      duration: 4500
    });

    if (res.rankUp) {
      setTimeout(() => {
        showToast({
          type:     'rank',
          title:    `Rank Up! You're Now #${res.newRank}`,
          msg:      `You climbed ${res.rankDelta} place${res.rankDelta > 1 ? 's' : ''} · Stay on top!`,
          duration: 5000
        });
      }, 700);

      if (res.chatId) {
        sendBotNotification({
          chatId: res.chatId,
          text:   `🏆 *Rank Up!*\nYou reached *#${res.newRank}* on the leaderboard!\nKeep watching ads to stay on top 🔥`
        });
      }
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
window.onReferralJoin = function({ friendName = 'A friend', reward = 5000, chatId } = {}) {
  showToast({
    type:     'referral',
    title:    `${friendName} Joined!`,
    msg:      `+${reward.toLocaleString()} Tickets added to your balance`,
    duration: 5500
  });

  if (chatId) {
    sendBotNotification({
      chatId,
      text: `🎉 *New Referral!*\n*${friendName}* just joined via your link!\nYou earned *+${reward.toLocaleString()} Tickets* 🚀`
    });
  }
};

/* ══════════════════════════════════════════════════════
   Withdraw → toast on success
══════════════════════════════════════════════════════ */
async function handleWithdraw() {
  const address = document.getElementById('wd-address').value.trim();
  const memo    = document.getElementById('wd-memo').value.trim();
  const amount  = parseFloat(document.getElementById('wd-amount').value);

  if (!address) {
    showToast({ type: 'withdraw', title: 'Wallet Address Required', msg: 'Please enter your wallet address', duration: 3500 });
    return;
  }
  if (isNaN(amount) || amount < 1) {
    showToast({ type: 'withdraw', title: 'Invalid Amount', msg: 'Minimum withdrawal is $1.00', duration: 3500 });
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

    if (res.chatId) {
      sendBotNotification({
        chatId: res.chatId,
        text:   `💸 *Withdrawal Request Received*\nAmount: *$${amount.toFixed(2)}*\nAddress: \`${address}\`\nStatus: *Under Review* ⏳`
      });
    }

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
   Startup
══════════════════════════════════════════════════════ */
animatePage('contest');
initApp();
