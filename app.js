/* ══════════════════════════════════════════════════════
   app.js — Entry point
   Depends on: config.js, api.js, security.js,
               notifications.js, pages.js
══════════════════════════════════════════════════════ */

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
  label.textContent = 'Copied';
  setTimeout(() => {
    btn.classList.remove('copied');
    label.textContent = 'Copy';
  }, 2000);
}

/* ══════════════════════════════════════════════════════
   Share buttons
══════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════
   Share buttons — one promo message, reused everywhere
══════════════════════════════════════════════════════ */
function getPromoText() {
  return "🏆 I'm competing on BigLeague — watch ads, climb the leaderboard, and win real USDT every season. No bots, no shortcuts. Join me and start earning:";
}

function handleShareTelegram(e) {
  e.preventDefault();
  fetchApi({ type: 'logShare', data: { platform: 'telegram' } });
  const url = 'https://t.me/share/url?url=' + encodeURIComponent(REF_LINK) +
              '&text=' + encodeURIComponent(getPromoText());
  if (window.Telegram?.WebApp?.openTelegramLink) {
    window.Telegram.WebApp.openTelegramLink(url);
  } else {
    window.open(url, '_blank');
  }
}

function handleShareWhatsApp(e) {
  e.preventDefault();
  fetchApi({ type: 'logShare', data: { platform: 'whatsapp' } });
  const msg = getPromoText() + ' ' + REF_LINK;
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function handleShareX(e) {
  e.preventDefault();
  fetchApi({ type: 'logShare', data: { platform: 'x' } });
  const url = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(getPromoText()) +
              '&url=' + encodeURIComponent(REF_LINK);
  window.open(url, '_blank');
}

function handleShareFacebook(e) {
  e.preventDefault();
  fetchApi({ type: 'logShare', data: { platform: 'facebook' } });
  const url = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(REF_LINK) +
              '&quote=' + encodeURIComponent(getPromoText());
  window.open(url, '_blank');
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
    const reward = res.reward ?? 0.03;

    if (res.partial) {
      // 50% reward — show center modal instead of normal toast
      showPartialRewardModal(reward);
    } else {
      showToast({
        type:     'ad',
        title:    `+$${reward.toFixed(4)} Earned!`,
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
   📢 Channel Gate — يظهر لما السحب يرجع channel_required
   زر "Join Channel" يفتح القناة، زر "Verify" يتحقق فوراً
   ويعيد محاولة السحب تلقائياً لو العضوية تأكدت.
══════════════════════════════════════════════════════ */
let _pendingWithdrawAmount = null;
let _pendingWithdrawFee    = null;

function showChannelGate(amount, fee) {
  _pendingWithdrawAmount = amount;
  _pendingWithdrawFee    = fee;
  document.getElementById('channel-gate-overlay')?.classList.add('active');
}

function hideChannelGate() {
  document.getElementById('channel-gate-overlay')?.classList.remove('active');
}

function openChannelFromGate() {
  const link = typeof CHANNEL_LINK !== 'undefined' ? CHANNEL_LINK : null;
  if (!link) return;
  if (window.Telegram?.WebApp?.openTelegramLink) {
    Telegram.WebApp.openTelegramLink(link);
  } else {
    window.open(link, '_blank');
  }
}

async function verifyChannelAndRetry() {
  const btn = document.getElementById('cg-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = ' Checking...'; }

  const res = await fetchApi({ type: 'checkChannel' });

  if (res?.ok) {
    hideChannelGate();
    if (btn) { btn.disabled = false; btn.textContent = '✓ I Joined — Verify'; }
    if (_pendingWithdrawAmount != null) {
      const retryAmount = _pendingWithdrawAmount;
      const retryFee    = _pendingWithdrawFee;
      _pendingWithdrawAmount = null;
      _pendingWithdrawFee    = null;
      handleWithdraw(retryAmount, retryFee);
    }
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '✓ I Joined — Verify'; }
    showToast({ type: 'withdraw', title: 'Not Joined Yet', msg: 'Join the channel first, then tap Verify', duration: 3500 });
  }
}
window.openChannelFromGate  = openChannelFromGate;
window.verifyChannelAndRetry = verifyChannelAndRetry;

/* ══════════════════════════════════════════════════════
   Withdraw → toast on success
══════════════════════════════════════════════════════ */
async function handleWithdraw(amount, fee) {
  // 🛡️ فحص rate limit على الفرونت
  if (!secAllow('withdraw')) {
    showToast({ type: 'withdraw', title: 'Too Many Attempts', msg: 'Please wait before trying again', duration: 3000 });
    return;
  }

  if (!connectedWalletAddress) {
    showToast({ type: 'withdraw', title: 'Connect Your Wallet', msg: 'Tap "Connect Wallet" to set your withdrawal address', duration: 3500 });
    return;
  }

  amount = parseFloat(amount);
  fee    = parseFloat(fee) || 0;

  const withdrawMin = (appState.config || (typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {})).WITHDRAW_MIN;
  if (isNaN(amount) || amount < withdrawMin) {
    showToast({ type: 'withdraw', title: 'Invalid Amount', msg: `Minimum withdrawal is $${withdrawMin.toFixed(2)}`, duration: 3500 });
    return;
  }

  // الصافي بعد خصم الرسوم — نعرضه للمستخدم بالتوست، لكن السيرفر هو اللي بيحسب
  // الخصم من الرصيد (بالإجمالي) والمبلغ المستحق فعلياً (بالصافي) عشان الحد الأدنى يضل يتحقق صح
  const netAmount = Math.round((amount - fee) * 1000) / 1000;

  const btn = document.querySelector(`.wc-buy-btn[data-amt="${amount}"]`);
  document.querySelectorAll('.wc-buy-btn').forEach(b => b.disabled = true);
  if (btn) btn.style.opacity = '0.7';

  const res = await fetchApi({ type: 'withdraw', data: { address: connectedWalletAddress, amount, fee } });

  document.querySelectorAll('.wc-buy-btn').forEach(b => { b.disabled = false; b.style.opacity = '1'; });

  if (res && res.ok) {
    showToast({
      type:     'withdraw',
      title:    `Withdrawal Submitted`,
      msg:      `$${netAmount.toFixed(3).replace(/0$/, '')} · Processing within 24 hours`,
      duration: 5000
    });

    refreshState();
  } else if (res?.error === 'channel_required') {
    // 📢 اشتراك إجباري بالقناة — يظهر بوابة الاشتراك بدل رسالة خطأ عادية
    showChannelGate(amount, fee);
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
   TonConnect — Wallet Connection (Withdraw Page)
   #conect button opens the TonConnect modal (Telegram Wallet,
   Tonkeeper, MyTonWallet...). Connected address is masked and
   shown under the button, and used as the withdraw destination.
══════════════════════════════════════════════════════ */
let tonConnectUI          = null;
let connectedWalletAddress = '';

function maskWalletAddress(addr) {
  if (!addr || addr.length < 10) return addr || '';
  return addr.slice(0, 5) + '****' + addr.slice(-4);
}

function initWalletConnect() {
  if (typeof TON_CONNECT_UI === 'undefined') {
    console.error('[wallet] TonConnect SDK failed to load');
    return;
  }

  // SDK يرسم زراره الرسمي داخل #ton-connect-button تلقائياً
  tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
    manifestUrl:  TONCONNECT_MANIFEST_URL,
    buttonRootId: 'ton-connect-button'
  });

  const addrEl = document.getElementById('ad-wallet');

  function renderWalletState(wallet) {
    if (wallet && addrEl) {
      connectedWalletAddress = TON_CONNECT_UI.toUserFriendlyAddress(wallet.account.address);
      addrEl.textContent = maskWalletAddress(connectedWalletAddress);
    } else if (addrEl) {
      connectedWalletAddress = '';
      addrEl.textContent = '';
    }
  }

  tonConnectUI.onStatusChange(renderWalletState);
  renderWalletState(tonConnectUI.wallet); // يرجع الحالة المحفوظة من جلسة سابقة
}

/* ══════════════════════════════════════════════════════
   Deposit — Buy competition tickets with TON via TonConnect
   الفلو: depositInit (يحجز صف pending بالسيرفر) → tonConnectUI
   .sendTransaction (المستخدم يوقّع من محفظته) → depositStatus
   بوّلينغ يتحقق من السرفر على TonCenter لحد ما تتأكد المعاملة
   على السلسلة فعلياً، وقتها فقط تُضاف التذاكر للرصيد.
══════════════════════════════════════════════════════ */
const TICKET_IMG = 'https://files.catbox.moe/b3yq30.png';

/* ── TON text-comment payload — بدون أي مكتبة خارجية ──
   يبني BOC صحيح لخلية تعليق بسيطة (opcode صفري + UTF-8 نص) ليُرفق
   بمعاملة TonConnect، بحيث يظهر تعليق "ايدي المستخدم" على السلسلة
   نفسها كما يظهر بأي محفظة/مستكشف. تم التحقق من تطابقه byte-for-byte
   مع مخرجات مكتبة @ton/core الرسمية. */
const _CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function _crc32c(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _CRC32C_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _b64FromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function tonCommentPayload(text) {
  const textBytes = new TextEncoder().encode(String(text));
  if (textBytes.length > 123) throw new Error('Comment too long for a single-cell payload');

  const n = 4 + textBytes.length; // 32-bit zero opcode + UTF-8 text
  const cellPayload = new Uint8Array(n);
  cellPayload.set([0, 0, 0, 0], 0);
  cellPayload.set(textBytes, 4);

  const cellData = new Uint8Array(2 + n);
  cellData[0] = 0;         // d1: refs=0, not exotic, level=0
  cellData[1] = n * 2;     // d2: byte-aligned data → 2n
  cellData.set(cellPayload, 2);

  const header = new Uint8Array([
    0xb5, 0xee, 0x9c, 0x72,   // BOC magic
    0x41,                     // has_crc32c=1, size=1
    0x01,                     // off_bytes = 1
    0x01,                     // cells = 1
    0x01,                     // roots = 1
    0x00,                     // absent = 0
    cellData.length,          // tot_cells_size
    0x00                      // root_list[0] = 0
  ]);

  const withoutCrc = new Uint8Array(header.length + cellData.length);
  withoutCrc.set(header, 0);
  withoutCrc.set(cellData, header.length);

  const crc = _crc32c(withoutCrc);
  const full = new Uint8Array(withoutCrc.length + 4);
  full.set(withoutCrc, 0);
  full[withoutCrc.length]     = crc & 0xFF;
  full[withoutCrc.length + 1] = (crc >>> 8) & 0xFF;
  full[withoutCrc.length + 2] = (crc >>> 16) & 0xFF;
  full[withoutCrc.length + 3] = (crc >>> 24) & 0xFF;

  return _b64FromBytes(full);
}

/* ── Render withdraw tier cards from server-synced config ── */
function renderWithdrawTiers() {
  const wrap = document.getElementById('wc-packages');
  if (!wrap) return;

  const cfg   = appState.config || APP_CONFIG;
  const tiers = (cfg.WITHDRAW_TIERS || APP_CONFIG.WITHDRAW_TIERS || []).slice();
  if (!tiers.length) { wrap.innerHTML = ''; return; }

  tiers.sort((a, b) => a.amount - b.amount);

  const feePct  = t => t.fee / t.amount;
  const bestTier = tiers.reduce((a, b) => (feePct(b) < feePct(a) ? b : a));

  const arrowSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`;
  const walletSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/></svg>`;
  const dollarSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;

  wrap.innerHTML = tiers.map((t, i) => {
    const isBest = t.best || t.id === bestTier.id;
    const net = t.amount - t.fee;
    const pct = Math.round(feePct(t) * 100);

    let tierClass, tagLabel;
    if (isBest)       { tierClass = 'best';        tagLabel = '★ Best Offer'; }
    else if (i === 0)  { tierClass = '';             tagLabel = null; }
    else if (i === 1)  { tierClass = 'tier-popular'; tagLabel = 'Popular'; }
    else               { tierClass = 'tier-deal';    tagLabel = 'Great Deal'; }

    return `
    <div class="wc-card ${isBest ? 'best' : tierClass}">
      <div class="wc-tag-row">
        ${tagLabel ? `<span class="wc-tag">${tagLabel}</span>` : '<span></span>'}
        <span class="wc-bonus">${pct}% fee</span>
      </div>
      <div class="wc-icon">${walletSvg}</div>
      <div class="wc-card-info">
        <div class="wc-amount">$${t.amount.toFixed(2)}</div>
        <div class="wc-amount-label">WITHDRAW</div>
        <div class="wc-fee">Fee $${t.fee.toFixed(3).replace(/0$/, '')}</div>
        <div class="wc-net">${dollarSvg}$${net.toFixed(3).replace(/0$/, '')} net</div>
      </div>
      <button class="wc-buy-btn" data-amt="${t.amount}" onclick="handleWithdraw(${t.amount}, ${t.fee})">
        <span>Withdraw</span>${arrowSvg}
      </button>
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════
   Partial Reward Modal — shown when ad session < AD_FULL_REWARD_MIN_SEC
   Displayed centered on screen with play.jpg image
══════════════════════════════════════════════════════ */
function showPartialRewardModal(reward) {
  // Remove any existing modal
  const old = document.getElementById('partial-reward-modal');
  if (old) old.remove();

  const cfg      = appState.config || APP_CONFIG;
  const fullAmt  = Number(cfg.AD_USD_REWARD) || 0.03;

  const modal = document.createElement('div');
  modal.id = 'partial-reward-modal';
  modal.innerHTML = `
    <div id="partial-reward-card">
      <div id="partial-reward-media">
        <img src="asesst/play.jpg" alt="" id="partial-reward-img">
      </div>
      <div id="partial-reward-body">
        <p id="partial-reward-eyebrow">AD RESULT</p>
        <p id="partial-reward-title">You got half</p>

        <div id="partial-reward-amount-wrap">
          <p id="partial-reward-amount">+$${reward.toFixed(4)}</p>
          <svg viewBox="0 0 200 10" preserveAspectRatio="none">
            <path d="M2,6 C50,2 150,9 198,4" fill="none" stroke="#f5c840" stroke-width="3" stroke-linecap="round" opacity="0.55"/>
          </svg>
        </div>

        <p id="partial-reward-full">Full reward is <b>$${fullAmt.toFixed(3)}</b></p>

        <div id="partial-reward-hint">
          <p>Reward not granted. Please tap the action button in the ad (Play, Go, Install, or Subscribe) to receive<b>full reward</b>.</p>
        </div>

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
   Startup
══════════════════════════════════════════════════════ */
try { renderConfig(); } catch (err) { console.error('[renderConfig] failed', err); }   // fill values from APP_CONFIG immediately (before server responds)
try { animatePage('contest'); } catch (err) { console.error('[animatePage] failed', err); }
try { initWalletConnect(); } catch (err) { console.error('[initWalletConnect] failed', err); }
initApp();
