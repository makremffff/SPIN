// ══════════════════════════════════════════════════════════
// app-ui.js — Toast · Animations · Navigation · Rendering
// ══════════════════════════════════════════════════════════

import {
    APP_STATE, APP_CONFIG, _SERVER_CONFIG as _SC,
    fetchApi as _fetchApi,
    WITHDRAW_HISTORY as _WH,
    NOTIF_LIST_DATA as _NL,
    DAILY_GIFT_STATE as _DGS,
} from './app-core.js';

const _AS = APP_STATE;
const _AC = APP_CONFIG;

// ══════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════
export const TOAST_ICONS = {
    coin: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="#fbbf24" stroke-width="1.8"/>
        <path d="M12 7v10M9.5 9.5C9.5 8.67 10.67 8 12 8s2.5.67 2.5 1.5S13.33 11 12 11s-2.5.67-2.5 1.5S10.67 14 12 14s2.5-.67 2.5-1.5"
              stroke="#fbbf24" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`,
    fire: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 2C12 2 7 8 7 13a5 5 0 0010 0c0-2-.7-3.8-2-5.5.5 1.5.5 2.5.5 2.5S12 8 12 2z"
              fill="rgba(251,191,36,0.9)"/>
        <path d="M12 15c0 1.1-.9 2-2 2" stroke="rgba(251,191,36,0.5)" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
    trophy: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M6 2h12v8a6 6 0 01-12 0V2z" stroke="#34d399" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M6 5H3a2 2 0 000 4h3M18 5h3a2 2 0 010 4h-3" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M12 16v4M9 20h6" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`,
};

export function showToast(iconKey, title, desc, color, badge) {
    if (color === 'green' && navigator.vibrate) navigator.vibrate([80, 40, 80]);
    const container = document.getElementById('ad-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'ad-toast';
    toast.innerHTML = `
        <div class="toast-icon-wrap ${color}">${TOAST_ICONS[iconKey] || TOAST_ICONS.coin}</div>
        <div class="toast-body">
            <div class="toast-title">${title}</div>
            <div class="toast-desc">${desc}</div>
        </div>
        <div class="toast-badge ${color}">${badge}</div>`;
    container.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
    setTimeout(() => {
        toast.classList.add('hide'); toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3200);
}

// ══════════════════════════════════════════════════════════
// BALANCE
// ══════════════════════════════════════════════════════════
export function animateBalance(fromPts, toPts, duration) {
    fromPts  = parseInt(fromPts) || 0;
    toPts    = parseInt(toPts)   || 0;
    duration = duration || 1400;
    if (fromPts === toPts) { updateBalanceUI(toPts); return; }
    const balEl   = document.getElementById('uc-balance-num');
    const heroNum = document.querySelector('.balance-hero-number');
    const start   = performance.now();
    function tick(now) {
        const elapsed  = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const ease     = 1 - Math.pow(1 - progress, 3);
        const current  = Math.round(fromPts + (toPts - fromPts) * ease);
        const fmt      = current.toLocaleString('en-US');
        if (balEl)   balEl.textContent  = fmt;
        if (heroNum) heroNum.textContent = fmt;
        const usdtLive = document.getElementById('uc-usdt-val');
        if (usdtLive) usdtLive.textContent = (current / (_SC.pts_per_ton || 100000)).toFixed(2);
        if (progress < 1) requestAnimationFrame(tick);
        else updateBalanceUI(toPts);
    }
    requestAnimationFrame(tick);
}

export function updateBalanceUI(pts) {
    pts = parseInt(pts) || 0;
    const balEl    = document.getElementById('uc-balance-num');
    const tonSheet = document.getElementById('ton-sheet-pts');
    const tonEquiv = document.getElementById('ton-sheet-equiv');
    const heroNum  = document.querySelector('.balance-hero-number');
    const usdtEl   = document.getElementById('uc-usdt-val');
    const xpLevel  = document.querySelector('.uc-xp-level');
    const xpPct    = document.querySelector('.uc-xp-pct');
    const xpFill   = document.querySelector('.uc-xp-fill');
    const formatted = pts.toLocaleString('en-US');
    if (balEl)   { balEl.textContent  = formatted; balEl.dataset.target  = pts; }
    if (heroNum) { heroNum.textContent = formatted; heroNum.dataset.target = pts; }
    if (tonSheet)  tonSheet.textContent = pts.toLocaleString('en-US');
    if (tonEquiv)  tonEquiv.textContent = '≈ ' + (pts / (_SC.pts_per_ton || 100000)).toFixed(3) + ' TON';
    if (usdtEl)    usdtEl.textContent  = (pts / (_SC.pts_per_ton || 100000)).toFixed(2);
    const lvl  = _AS.level || 1;
    const TH = [0,0,500,1500,3500,8000,16000,30000,55000,90000,150000];
    const curr = TH[lvl] || 0; const next = TH[lvl+1] || curr+10000;
    const pct = next > curr ? Math.min(100, Math.floor((pts-curr)/(next-curr)*100)) : 100;
    if (xpLevel) xpLevel.textContent = `المستوى ${lvl}`;
    if (xpPct)   xpPct.textContent   = pct + '%';
    if (xpFill)  xpFill.style.width  = pct + '%';
}

export function runCounters(scope) {
    scope = scope || document;
    scope.querySelectorAll('.counter').forEach(counter => {
        const target = parseInt(counter.getAttribute('data-target'));
        if (!target) return;
        const dur = 1800; const startTime = performance.now();
        function update(now) {
            const p = Math.min((now-startTime)/dur, 1);
            const e = 1-Math.pow(1-p,3);
            counter.textContent = Math.floor(e*target).toLocaleString('en-US');
            if (p < 1) requestAnimationFrame(update);
            else counter.textContent = target.toLocaleString('en-US');
        }
        requestAnimationFrame(update);
    });
}

// ══════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════
export function showPage(pageName, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + pageName)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else document.querySelector(`.nav-item[data-page="${pageName}"]`)?.classList.add('active');
    updateBalanceUI(_AS.balance);
    if (pageName === 'withdraw') _refreshWithdrawPageUI();
}

export function _refreshWithdrawPageUI() {
    const heroEl = document.getElementById('withdraw-balance-hero');
    if (heroEl) heroEl.textContent = _AS.balance.toLocaleString();
    const fw  = _AS.first_withdraw_done;
    const min = fw ? (_AC.withdraw.normal_min||20000) : (_AC.withdraw.first_min||3000);
    const el  = document.getElementById('withdraw-ton-min-display');
    if (el) el.textContent = min.toLocaleString();
}

export function _hideLoadingScreen() {
    const screen = document.getElementById('app-loading-screen');
    if (!screen) return;
    screen.style.opacity = '0'; screen.style.visibility = 'hidden';
    setTimeout(() => screen.remove(), 600);
}

// ══════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════
export function addNotification(type, title, sub, ts) {
    _NL.unshift({ type, title, sub, ts: ts||Date.now(), read: false });
    _AS.unreadNotifCount++;
    updateNotifBadge(); renderNotifList();
}

export function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (_AS.unreadNotifCount > 0) {
        badge.classList.add('visible');
        badge.textContent = _AS.unreadNotifCount > 9 ? '9+' : _AS.unreadNotifCount;
    } else { badge.classList.remove('visible'); badge.textContent = ''; }
}

export function renderNotifList() {
    const list = document.getElementById('notif-list');
    const emptyMsg = document.getElementById('notif-empty-msg');
    if (!list) return;
    if (_NL.length === 0) { if (emptyMsg) emptyMsg.style.display = ''; return; }
    if (emptyMsg) emptyMsg.style.display = 'none';
    const tonIcon  = `<img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:22px;height:22px;border-radius:7px;object-fit:cover;">`;
    const coinIcon = `<img src="asesst/coins.png" alt="" style="width:20px;height:20px;object-fit:contain;filter:drop-shadow(0 0 4px rgba(251,191,36,0.7));">`;
    list.innerHTML = _NL.map((n,i) => `
        <div class="notif-item ${n.read?'':'unread'}" onclick="window._markNotifRead(${i})">
            ${!n.read?'<div class="notif-unread-dot"></div>':''}
            <div class="notif-item-icon ${n.type==='ton'?'ton':'gold'}">${n.type==='ton'?tonIcon:coinIcon}</div>
            <div class="notif-item-body">
                <div class="notif-item-title">${n.title}</div>
                <div class="notif-item-sub">${n.sub}</div>
            </div>
            <div class="notif-item-time">${formatTimeAgo(n.ts)}</div>
        </div>`).join('');
}

export function markNotifRead(idx) {
    if (_NL[idx] && !_NL[idx].read) {
        _NL[idx].read = true;
        _AS.unreadNotifCount = Math.max(0, _AS.unreadNotifCount-1);
        updateNotifBadge(); renderNotifList();
    }
}

export function openNotifPanel() {
    document.getElementById('notif-panel')?.classList.add('open');
    document.getElementById('notif-backdrop')?.classList.add('visible');
    _NL.forEach(n => { n.read = true; }); _AS.unreadNotifCount = 0;
    updateNotifBadge(); renderNotifList();
}

export function closeNotifPanel() {
    document.getElementById('notif-panel')?.classList.remove('open');
    document.getElementById('notif-backdrop')?.classList.remove('visible');
}

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
export function formatTimeAgo(ts) {
    const diff = Math.floor((Date.now()-ts)/1000);
    if (diff < 60)    return 'الآن';
    if (diff < 3600)  return `منذ ${Math.floor(diff/60)} دقيقة`;
    if (diff < 86400) return `منذ ${Math.floor(diff/3600)} ساعة`;
    return `منذ ${Math.floor(diff/86400)} يوم`;
}

export function renderReferralList(list, total) {
    const container = document.getElementById('referral-list-container');
    if (!container || !list.length) return;
    const colors = [
        {bg:'linear-gradient(135deg,rgba(167,139,250,0.2),rgba(96,165,250,0.2))',border:'rgba(167,139,250,0.2)',color:'var(--purple)'},
        {bg:'linear-gradient(135deg,rgba(96,165,250,0.2),rgba(52,211,153,0.2))', border:'rgba(96,165,250,0.2)', color:'var(--blue)'},
        {bg:'linear-gradient(135deg,rgba(251,191,36,0.15),rgba(251,191,36,0.05))',border:'rgba(251,191,36,0.2)', color:'var(--gold)'},
        {bg:'linear-gradient(135deg,rgba(52,211,153,0.15),rgba(52,211,153,0.05))',border:'rgba(52,211,153,0.2)', color:'var(--green)'},
    ];
    const pts = _AC.rewards.referral || _SC.pts_per_referral || 100;
    let html = list.map((r,i) => {
        const c = colors[i%colors.length];
        return `<div class="referral-item">
            <div class="referral-avatar" style="background:${c.bg};border-color:${c.border};color:${c.color};">${(r.name||'م')[0]}</div>
            <div class="referral-info">
                <div class="referral-name">${r.name||'مستخدم'}</div>
                <div class="referral-date">${formatTimeAgo(r.ts||Date.now())}</div>
            </div>
            <div class="referral-reward">
                <img src="asesst/coins.png" alt="" style="width:14px;height:14px;object-fit:contain;filter:drop-shadow(0 0 3px rgba(251,191,36,0.6));">
                <span class="referral-reward-text">+${pts}</span>
            </div>
        </div><div class="shine-line-sm" style="margin:2px 10px;"></div>`;
    }).join('');
    const extra = total - list.length;
    if (extra > 0) html += `<div style="text-align:center;padding:12px 0 4px;"><span style="font-size:12px;font-weight:700;color:var(--purple);opacity:0.7;">+${extra} صديق آخر</span></div>`;
    container.innerHTML = html;
}

export function renderWithdrawHistory() {
    const list  = document.getElementById('withdraw-history-list');
    const empty = document.getElementById('withdraw-empty');
    const badge = document.getElementById('withdraw-count-badge');
    if (_WH.length === 0) { if (empty) empty.style.display=''; if (badge) badge.style.display='none'; return; }
    if (empty) empty.style.display = 'none';
    if (badge) { badge.style.display=''; badge.textContent=_WH.length+' طلب'; }
    if (list) list.innerHTML = _WH.slice().reverse().map(item => {
        const tonAmt = (item.pts/100000).toFixed(3);
        const addrShort = item.address.length>14 ? item.address.substring(0,6)+'...'+item.address.slice(-6) : item.address;
        return `<div class="withdraw-hist-item">
            <div class="withdraw-hist-icon"><img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:26px;height:26px;border-radius:7px;object-fit:cover;"></div>
            <div class="withdraw-hist-info">
                <div class="withdraw-hist-name">سحب TON</div>
                <div class="withdraw-hist-addr">${addrShort}</div>
                <div class="withdraw-hist-time">${formatTimeAgo(item.ts)}</div>
            </div>
            <div class="withdraw-hist-right">
                <div class="withdraw-hist-pts">${item.pts.toLocaleString()}</div>
                <div class="withdraw-hist-ton">${tonAmt} TON</div>
                <div class="withdraw-hist-badge pending">قيد المعالجة</div>
            </div>
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// DAILY GIFT
// ══════════════════════════════════════════════════════════
const GIFT_FB = [
    {day:'اليوم الأول',  desc:'مبروك! بداية رائعة.\nاستمر يومياً لتضاعف مكافآتك!',pts:100},
    {day:'اليوم الثاني', desc:'يومان متتاليان!\nالمثابرة مفتاح النجاح.',pts:150},
    {day:'اليوم الثالث', desc:'ثلاثة أيام متتالية!',pts:200},
    {day:'اليوم الرابع', desc:'أسبوعك يقترب!',pts:250},
    {day:'اليوم الخامس',desc:'خمسة أيام!',pts:300},
    {day:'اليوم السادس',desc:'يوم واحد ويكتمل أسبوعك!',pts:400},
    {day:'اليوم السابع', desc:'أسبوع كامل! مكافأة ضخمة.',pts:750},
];

function _getGiftDayData(day) {
    const idx = Math.max(0, day-1);
    const sv  = _AC?.daily_gift || {};
    const pts  = sv.rewards?.[idx]  ?? GIFT_FB[Math.min(idx,6)]?.pts ?? 100;
    const dayT = sv.titles_ar?.[idx] || GIFT_FB[Math.min(idx,6)]?.day || ('اليوم '+day);
    const desc = sv.descs_ar?.[idx]  || GIFT_FB[Math.min(idx,6)]?.desc || '';
    return { day: dayT, desc, amount: '+'+pts, pts };
}

export function openDailyGiftOverlay() {
    if (_DGS.isOpening) return;
    _DGS.isOpening = true;
    const day  = _DGS.dayNumber;
    const data = _getGiftDayData(day);
    const overlay = document.getElementById('daily-gift-overlay');
    if (!overlay) { _DGS.isOpening = false; return; }

    const dayTextEl  = document.getElementById('gift-day-text');
    const descTextEl = document.getElementById('gift-desc-text');
    const amountEl   = document.getElementById('gift-amount');
    const dotsEl     = document.getElementById('gift-streak-dots');
    const btn        = document.getElementById('gift-claim-btn');
    const label      = document.getElementById('gift-loading-label');
    const ringIcon   = document.getElementById('gift-ring-icon');

    if (dayTextEl)  dayTextEl.textContent  = data.day;
    if (descTextEl) descTextEl.textContent = data.desc;
    if (amountEl)   amountEl.textContent   = data.amount;

    if (dotsEl) {
        dotsEl.innerHTML = '';
        for (let i=1;i<=7;i++) {
            const dot = document.createElement('div');
            dot.style.cssText = `width:${i===day?'22px':'8px'};height:8px;border-radius:4px;
                background:${i<day?'rgba(251,191,36,0.75)':i===day?'#fbbf24':'rgba(255,255,255,0.1)'};
                box-shadow:${i<=day?'0 0 6px rgba(251,191,36,0.4)':'none'};`;
            dotsEl.appendChild(dot);
        }
    }
    if (btn)   btn.style.display   = 'none';
    if (label) label.style.display = 'block';
    if (ringIcon) ringIcon.innerHTML = `
        <path d="M20 12v10H4V12" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M22 7H2v5h20V7z" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 22V7" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

    overlay.style.opacity = '1'; overlay.style.pointerEvents = 'all';
    const tc = (window.TRANSLATIONS||{})[window.currentLang||'ar'] || {};

    if (_DGS.claimed) {
        if (label) { label.textContent='تم استلام هديتك اليوم ✓'; label.style.color='#34d399'; label.style.fontSize='14px'; label.style.fontWeight='700'; }
        _DGS.isOpening = false;
        setTimeout(() => closeDailyGiftOverlay(), 2200);
        return;
    }

    let sec = 3;
    if (label) label.textContent = tc.gift_preparing || 'جاري تحضير هديتك...';
    const timer = setInterval(() => {
        sec--;
        if (sec > 0) { if (label) label.textContent = tc.gift_preparing||'جاري تحضير هديتك...'; }
        else {
            clearInterval(timer);
            if (label) label.style.display = 'none';
            if (btn) {
                btn.style.display='block'; btn.style.transform='scale(0.8)'; btn.style.opacity='0';
                requestAnimationFrame(()=>requestAnimationFrame(()=>{
                    btn.style.transition='all 0.4s cubic-bezier(0.34,1.56,0.64,1)';
                    btn.style.transform='scale(1)'; btn.style.opacity='1';
                }));
            }
            _DGS.isOpening = false;
        }
    }, 1000);
}

export function closeDailyGiftOverlay() {
    const overlay = document.getElementById('daily-gift-overlay');
    if (overlay) { overlay.style.opacity='0'; overlay.style.pointerEvents='none'; }
    _DGS.isOpening = false;
}

export async function claimGift() {
    if (_DGS.claimed) return;
    _DGS.claimed = true;
    const result = await _fetchApi({ type: 'claim_gift', data: {} });
    if (!result.ok) { _DGS.claimed = false; return; }
    if (result.streak_day)          _DGS.dayNumber = result.streak_day;
    if (result.points !== undefined) { animateBalance(_AS.balance, result.points); _AS.balance = result.points; }
    const ringIcon = document.getElementById('gift-ring-icon');
    if (ringIcon) ringIcon.innerHTML = `<path d="M20 6L9 17l-5-5" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    const btn = document.getElementById('gift-claim-btn');
    const tc  = (window.TRANSLATIONS||{})[window.currentLang||'ar'] || {};
    if (btn) {
        btn.textContent = tc.gift_claimed||'تم الاستلام ✓';
        btn.style.background='rgba(52,211,153,0.15)'; btn.style.color='#34d399';
        btn.style.border='1px solid rgba(52,211,153,0.28)'; btn.style.cursor='default'; btn.onclick=null;
    }
    showToast('trophy', tc.toast_gift_title||'تم استلام هديتك!', `+${result.reward||0} ${tc.pts||'نقطة'}`, 'green', `+${result.reward||0}`);
    setTimeout(() => closeDailyGiftOverlay(), 1600);
}

// ══════════════════════════════════════════════════════════
// TON WITHDRAW
// ══════════════════════════════════════════════════════════
export const TON_CONFIG = new Proxy({}, {
    get(_,k) {
        const fw = _AS.first_withdraw_done;
        if (k==='minPts')          return fw?(_AC.withdraw.normal_min||20000):(_AC.withdraw.first_min||3000);
        if (k==='minLevel')        return fw?(_AC.withdraw.normal_level||5):0;
        if (k==='ptsPerTon')       return _SC.pts_per_ton||100000;
        if (k==='isFirstWithdraw') return !fw;
    }
});

export function openTonWithdraw() {
    const overlay    = document.getElementById('ton-withdraw-overlay');
    const ptsEl      = document.getElementById('ton-sheet-pts');
    const equivEl    = document.getElementById('ton-sheet-equiv');
    const levelWarn  = document.getElementById('ton-level-warn');
    const ptsWarn    = document.getElementById('ton-pts-warn');
    const curLvlEl   = document.getElementById('ton-current-level');
    const submitBtn  = document.getElementById('ton-submit-btn');
    const input      = document.getElementById('ton-address-input');

    input.value = ''; document.getElementById('ton-error-msg').style.display = 'none';
    ptsEl.textContent  = _AS.balance.toLocaleString();
    equivEl.textContent = '≈ '+(_AS.balance/TON_CONFIG.ptsPerTon).toFixed(3)+' TON';

    const isFirst  = TON_CONFIG.isFirstWithdraw;
    const hasLevel = isFirst ? true : _AS.level >= TON_CONFIG.minLevel;
    const hasPts   = _AS.balance >= TON_CONFIG.minPts;

    levelWarn.style.display = 'none'; ptsWarn.style.display = 'none';
    const minChipVal = document.getElementById('ton-min-chip-val');
    if (minChipVal) { minChipVal.textContent=TON_CONFIG.minPts.toLocaleString()+' نقطة'; minChipVal.style.color=isFirst?'var(--green)':'var(--gold)'; }
    const firstOfferEl = document.getElementById('first-withdraw-offer');
    if (firstOfferEl) firstOfferEl.style.display = isFirst?'flex':'none';
    const minPtsEl = document.getElementById('ton-min-pts');
    if (minPtsEl) minPtsEl.textContent = TON_CONFIG.minPts.toLocaleString();
    const ptsWarnMin = document.getElementById('ton-pts-warn-min');
    if (ptsWarnMin) ptsWarnMin.textContent = TON_CONFIG.minPts.toLocaleString();

    if (!hasLevel) { levelWarn.style.display=''; if (curLvlEl) curLvlEl.textContent=_AS.level; submitBtn.disabled=true; }
    else if (!hasPts) { ptsWarn.style.display=''; submitBtn.disabled=true; }
    else { submitBtn.disabled=false; }
    overlay.classList.add('visible');
}

export function closeTonWithdraw() {
    document.getElementById('ton-withdraw-overlay')?.classList.remove('visible');
}

export function handleTonOverlayClick(e) {
    if (e.target===document.getElementById('ton-withdraw-overlay')) closeTonWithdraw();
}

export function clearTonError() {
    document.getElementById('ton-error-msg').style.display='none';
    document.getElementById('ton-address-input').style.borderColor='rgba(83,147,255,0.3)';
}

export function isValidTonAddress(addr) {
    addr = addr.trim();
    return (addr.startsWith('EQ')||addr.startsWith('UQ')||addr.startsWith('0:')) && addr.length>=48;
}

export async function submitTonWithdraw() {
    const input     = document.getElementById('ton-address-input');
    const addr      = input.value.trim();
    const errEl     = document.getElementById('ton-error-msg');
    const submitBtn = document.getElementById('ton-submit-btn');
    if (!isValidTonAddress(addr)) { errEl.style.display='block'; input.style.borderColor='rgba(248,113,113,0.5)'; return; }
    submitBtn.disabled=true; submitBtn.textContent='⏳ جاري الإرسال...';
    const result = await _fetchApi({ type:'submit_withdraw', data:{address:addr} });
    submitBtn.disabled=false; submitBtn.textContent='إرسال طلب السحب';
    if (!result.ok) {
        errEl.textContent = result.error==='insufficient_balance'?'رصيدك غير كافٍ'
            :result.error==='level_too_low'?`يتطلب المستوى ${result.required_level||5} للسحب`
            :'حدث خطأ، حاول مجدداً';
        errEl.style.display='block'; return;
    }
    if (result.new_balance!==undefined) { animateBalance(_AS.balance,result.new_balance); _AS.balance=result.new_balance; _refreshWithdrawPageUI(); }
    if (result.first_withdraw===true) {
        _AS.first_withdraw_done=true;
        const mcv=document.getElementById('ton-min-chip-val');
        if (mcv) { mcv.textContent=(_AC.withdraw.normal_min||20000).toLocaleString()+' نقطة'; mcv.style.color='var(--gold)'; }
    }
    const item={pts:result.pts_deducted||_AS.balance,address:addr,ts:Date.now(),status:result.status||'pending'};
    _WH.push(item);
    addNotification('ton','تم استلام طلب السحب',
        `${item.pts.toLocaleString()} نقطة ≈ ${(result.ton_amount||item.pts/(_SC.pts_per_ton||100000)).toFixed(3)} TON`,item.ts);
    renderWithdrawHistory(); closeTonWithdraw();
    showToast('trophy','تم إرسال طلب السحب! 🎉','سيتم معالجة طلبك قريباً','green','✓');
}

export function openDepositSupport() {
    const url='https://t.me/YourSupportUsername?text='+encodeURIComponent('مرحبا أريد إيداع داخل البوت');
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url,'_blank');
}

export function copyReferralLink() {
    const btn=document.getElementById('copy-btn');
    const link=window._REFERRAL_LINK||'';
    navigator.clipboard.writeText(link).catch(()=>{
        const ta=document.createElement('textarea'); ta.value=link;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    });
    btn.classList.add('copied');
    const t=(window.TRANSLATIONS||{})[window.currentLang||'ar']||{};
    btn.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>${t.copy_btn_done||'تم النسخ!'}`;
    showToast('trophy',t.toast_copy_title||'تم نسخ الرابط ✓',t.toast_copy_desc||'شارك رابطك مع أصدقائك','green','🔗');
    setTimeout(()=>{
        btn.classList.remove('copied');
        btn.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/></svg>${t.copy_btn_default||t.copy_link||'نسخ'}`;
    },2500);
}

export function shareTelegram() {
    const link=window._REFERRAL_LINK||'';
    window.open('https://t.me/share/url?url='+encodeURIComponent(link)+'&text='+encodeURIComponent('انضم معي في تطبيق الربح العربي واربح نقاط مجانية! 🎁\n'+link),'_blank');
}

export function shareWhatsApp() {
    const link=window._REFERRAL_LINK||'';
    window.open('https://wa.me/?text='+encodeURIComponent('انضم معي في تطبيق الربح العربي واربح نقاط مجانية! 🎁\n'+link),'_blank');
}

// ── Expose to window ─────────────────────────────────────
window.showPage             = showPage;
window.openNotifPanel       = openNotifPanel;
window.closeNotifPanel      = closeNotifPanel;
window._markNotifRead       = markNotifRead;
window.openDailyGiftOverlay = openDailyGiftOverlay;
window.openDailyGift        = openDailyGiftOverlay;
window.closeDailyGift       = closeDailyGiftOverlay;
window.closeDailyGiftOverlay= closeDailyGiftOverlay;
window.claimGift            = claimGift;
window.openTonWithdraw      = openTonWithdraw;
window.closeTonWithdraw     = closeTonWithdraw;
window.handleTonOverlayClick= handleTonOverlayClick;
window.clearTonError        = clearTonError;
window.submitTonWithdraw    = submitTonWithdraw;
window.openDepositSupport   = openDepositSupport;
window.copyReferralLink     = copyReferralLink;
window.shareTelegram        = shareTelegram;
window.shareWhatsApp        = shareWhatsApp;
window.animateBalance       = animateBalance;
window.updateBalanceUI      = updateBalanceUI;
window.showToast            = showToast;
window.addNotification      = addNotification;
window.renderWithdrawHistory= renderWithdrawHistory;
