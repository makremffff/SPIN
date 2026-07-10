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
    const reward = res.reward ?? 0.001;

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

function showChannelGate(amount) {
  _pendingWithdrawAmount = amount;
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
      document.getElementById('wd-amount').value = _pendingWithdrawAmount;
      _pendingWithdrawAmount = null;
      handleWithdraw();
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
async function handleWithdraw() {
  // 🛡️ فحص rate limit على الفرونت
  if (!secAllow('withdraw')) {
    showToast({ type: 'withdraw', title: 'Too Many Attempts', msg: 'Please wait before trying again', duration: 3000 });
    return;
  }

  if (!connectedWalletAddress) {
    showToast({ type: 'withdraw', title: 'Connect Your Wallet', msg: 'Tap "Connect Wallet" to set your withdrawal address', duration: 3500 });
    return;
  }

  const amount = parseFloat(document.getElementById('wd-amount').value);

  const withdrawMin = (appState.config || (typeof APP_CONFIG !== 'undefined' ? APP_CONFIG : {})).WITHDRAW_MIN;
  if (isNaN(amount) || amount < withdrawMin) {
    showToast({ type: 'withdraw', title: 'Invalid Amount', msg: `Minimum withdrawal is $${withdrawMin.toFixed(2)}`, duration: 3500 });
    return;
  }

  const btn = document.querySelector('.wd-btn');
  btn.disabled = true;
  btn.style.opacity = '0.7';

  const res = await fetchApi({ type: 'withdraw', data: { address: connectedWalletAddress, amount } });

  btn.disabled = false;
  btn.style.opacity = '1';

  if (res && res.ok) {
    showToast({
      type:     'withdraw',
      title:    `Withdrawal Submitted`,
      msg:      `$${amount.toFixed(2)} · Processing within 24 hours`,
      duration: 5000
    });

    document.getElementById('wd-amount').value  = '';

    refreshState();
  } else if (res?.error === 'channel_required') {
    // 📢 اشتراك إجباري بالقناة — يظهر بوابة الاشتراك بدل رسالة خطأ عادية
    showChannelGate(amount);
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

/* ── Tab switcher ── */
function switchWdTab(tab) {
  const glider = document.getElementById('wd-tab-glider')?.parentElement;
  const wSec   = document.getElementById('wd-section-withdraw');
  const dSec   = document.getElementById('wd-section-deposit');
  const wBtn   = document.getElementById('tab-btn-withdraw');
  const dBtn   = document.getElementById('tab-btn-deposit');
  const title  = document.getElementById('wd-hero-title');

  const isDeposit = tab === 'deposit';
  glider?.classList.toggle('dp-active', isDeposit);
  wBtn?.classList.toggle('active', !isDeposit);
  dBtn?.classList.toggle('active', isDeposit);
  if (wSec) wSec.style.display = isDeposit ? 'none' : 'flex';
  if (dSec) dSec.style.display = isDeposit ? 'flex' : 'none';
  if (title) title.textContent = isDeposit ? 'Buy Competition Tickets' : 'Withdraw Your Earnings';

  if (isDeposit) renderDepositPackages();
}

/* ── Render ticket package cards from server-synced config ── */
function renderDepositPackages() {
  const wrap = document.getElementById('dp-packages');
  if (!wrap) return;

  const cfg  = appState.config || APP_CONFIG;
  const pkgs = (cfg.TICKET_PACKAGES || APP_CONFIG.TICKET_PACKAGES || []).slice();
  if (!pkgs.length) { wrap.innerHTML = ''; return; }

  // ترتيب تصاعدي حسب سعر TON، حتى لو ترتيب السيرفر مختلف
  pkgs.sort((a, b) => a.ton - b.ton);

  const ratio   = p => p.tickets / p.ton;
  const baseRate = ratio(pkgs[0]);
  const bestId  = pkgs.reduce((a, b) => (ratio(b) > ratio(a) ? b : a)).id;
  // سعر TON تقريبي بالدولار (لو متوفر من السيرفر)، وإلا نتجاهل عرض القيمة التقريبية
  const tonUsdRate = Number(cfg.TON_USD_RATE || APP_CONFIG.TON_USD_RATE) || null;

  const arrowSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>`;
  const tonIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;

  wrap.innerHTML = pkgs.map((p, i) => {
    const isBest = p.id === bestId;
    const bonusPct = Math.round((ratio(p) / baseRate - 1) * 100);

    let tierClass, tagLabel;
    if (isBest)      { tierClass = 'best';        tagLabel = '★ Best Value'; }
    else if (i === 0) { tierClass = '';            tagLabel = null; }
    else if (i === 1) { tierClass = 'tier-popular'; tagLabel = 'Popular'; }
    else              { tierClass = 'tier-deal';    tagLabel = 'Great Deal'; }

    const showBonus = bonusPct > 0 && (isBest || tierClass === 'tier-deal');
    const usdLine = tonUsdRate ? `<div class="dp-usd">≈ $${(p.ton * tonUsdRate).toFixed(2)}</div>` : '';

    return `
    <div class="dp-card ${isBest ? 'best' : tierClass}">
      <div class="dp-tag-row">
        ${tagLabel ? `<span class="dp-tag">${tagLabel}</span>` : '<span></span>'}
        ${showBonus ? `<span class="dp-bonus">+${bonusPct}%</span>` : ''}
      </div>
      <div class="dp-ticket-ic"><img src="${TICKET_IMG}" alt="ticket"></div>
      <div class="dp-card-info">
        <div class="dp-tickets">${p.tickets.toLocaleString()}</div>
        <div class="dp-tickets-label">TICKETS</div>
        <div class="dp-rate">${Math.round(ratio(p) / 1000)}K / TON</div>
        <div class="dp-price">${tonIconSvg}${p.ton} TON</div>
        ${usdLine}
      </div>
      <button class="dp-buy-btn" data-pkg="${p.id}" onclick="buyTicketPackage('${p.id}')">
        <span>Buy Now</span>${arrowSvg}
      </button>
    </div>`;
  }).join('');
}

/* ── Buy flow ── */
async function buyTicketPackage(pkgId) {
  if (!secAllow('withdraw')) {
    showToast({ type: 'withdraw', title: 'Too Many Attempts', msg: 'Please wait before trying again', duration: 3000 });
    return;
  }

  if (!tonConnectUI || !tonConnectUI.wallet) {
    showToast({ type: 'withdraw', title: 'Connect Your Wallet', msg: 'Tap "Connect Wallet" first to buy tickets', duration: 3500 });
    try { tonConnectUI?.openModal(); } catch {}
    return;
  }

  const cfg  = appState.config || APP_CONFIG;
  const pkgs = cfg.TICKET_PACKAGES || APP_CONFIG.TICKET_PACKAGES || [];
  const pkg  = pkgs.find(p => p.id === pkgId);
  if (!pkg) return;

  const statusEl = document.getElementById('dp-status');
  const btn = document.querySelector(`.dp-buy-btn[data-pkg="${pkgId}"]`);
  document.querySelectorAll('.dp-buy-btn').forEach(b => b.disabled = true);
  if (statusEl) statusEl.textContent = 'Waiting for wallet confirmation…';

  try {
    // 1) نحجز صف الايداع Pending بالسيرفر أولاً
    const initRes = await fetchApi({
      type: 'depositInit',
      data: { packageId: pkg.id, walletAddress: tonConnectUI.wallet.account.address }
    });

    if (!initRes || !initRes.ok) {
      showToast({ type: 'withdraw', title: 'Could Not Start Deposit', msg: initRes?.error || 'Please try again', duration: 3500 });
      if (statusEl) statusEl.textContent = '';
      return;
    }

    const nanotons = Math.round(pkg.ton * 1e9).toString();

    // 🧾 نرفق ايدي المستخدم (Telegram ID) كتعليق on-chain حقيقي على المعاملة
    let payload;
    try { payload = tonCommentPayload(String(appState.user.telegram_id || appState.user.id)); }
    catch (e) { console.warn('[buyTicketPackage] comment payload failed, sending without memo:', e); }

    // 2) المستخدم يوقّع ويرسل المعاملة من محفظته مباشرة للخزينة
    await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [{ address: TREASURY_WALLET_ADDRESS, amount: nanotons, ...(payload ? { payload } : {}) }]
    });

    if (statusEl) statusEl.textContent = 'Confirming on the TON blockchain…';

    // 3) بوّلينغ السرفر لحد ما يتأكد وصول المعاملة فعلياً على السلسلة
    await pollDepositStatus(initRes.depositId, pkg, statusEl);

  } catch (err) {
    console.error('[buyTicketPackage] failed:', err);
    if (statusEl) statusEl.textContent = '';
    showToast({ type: 'withdraw', title: 'Transaction Cancelled', msg: 'No TON was deducted', duration: 3000 });
  } finally {
    document.querySelectorAll('.dp-buy-btn').forEach(b => b.disabled = false);
  }
}

/* ── Poll backend, which itself verifies the tx on TonCenter ── */
async function pollDepositStatus(depositId, pkg, statusEl, attempt = 0) {
  const MAX_ATTEMPTS = 20; // ~80s
  const res = await fetchApi({ type: 'depositStatus', data: { depositId } });

  if (res?.ok && res.status === 'confirmed') {
    if (statusEl) statusEl.textContent = '';
    showToast({
      type: 'referral',
      title: 'Tickets Credited!',
      msg: `+${pkg.tickets.toLocaleString()} Tickets · ${pkg.ton} TON confirmed`,
      duration: 5000
    });
    refreshState();
    return;
  }

  if (res?.ok && res.status === 'failed') {
    if (statusEl) statusEl.textContent = '';
    showToast({ type: 'withdraw', title: 'Deposit Failed', msg: 'Transaction was not found on-chain', duration: 4000 });
    return;
  }

  if (attempt >= MAX_ATTEMPTS) {
    if (statusEl) statusEl.textContent = 'Still confirming — tickets will be credited automatically once verified.';
    return;
  }

  setTimeout(() => pollDepositStatus(depositId, pkg, statusEl, attempt + 1), 4000);
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
  const fullAmt  = Number(cfg.AD_USD_REWARD) || 0.001;

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
/* ══════════════════════════════════════════════════════
   Onboarding — first-launch swipeable intro (6 slides)
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
  const labels = ['Next', 'Next', 'Next', 'Next', 'Next', 'Start Playing'];
  let cur = 0, busy = false;

  // زر "Join Channel" داخل سلايد التعليمات
  const joinBtn = document.getElementById('ob-join-btn');
  if (joinBtn) {
    joinBtn.addEventListener('click', () => {
      if (window.Telegram?.WebApp?.openTelegramLink) {
        Telegram.WebApp.openTelegramLink(CHANNEL_LINK);
      } else {
        window.open(CHANNEL_LINK, '_blank');
      }
    });
  }

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

/* ── Leaderboard scroll hint ──────────────────────────
   نفس فكرة الشيفرون بصفحة التعليمات: يبين وقت في صفوف
   إضافية تحت (مستخدمين تانيين) والصفوف تختفي بتدرّج عبر
   mask-image بالـ CSS، بدون أي حساب لكل صف بالجافاسكربت. */
function checkLbScroll() {
  const card = document.querySelector('.leaderboard-card');
  const hint = document.getElementById('lb-scroll-hint');
  if (!card || !hint) return;
  const overflows = card.scrollHeight - card.scrollTop > card.clientHeight + 6;
  hint.classList.toggle('show', overflows);
}

(function initLbScrollHint() {
  const card = document.querySelector('.leaderboard-card');
  if (!card) return;
  card.addEventListener('scroll', checkLbScroll, { passive: true });
  window.addEventListener('resize', checkLbScroll);
  setTimeout(checkLbScroll, 600); // بعد ما تتحمل بيانات الليدربورد أول مرة
})();

/* ══════════════════════════════════════════════════════
   Startup
══════════════════════════════════════════════════════ */
try { renderConfig(); } catch (err) { console.error('[renderConfig] failed', err); }   // fill values from APP_CONFIG immediately (before server responds)
try { animatePage('contest'); } catch (err) { console.error('[animatePage] failed', err); }
try { initWalletConnect(); } catch (err) { console.error('[initWalletConnect] failed', err); }
initApp();
