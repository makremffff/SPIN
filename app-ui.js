// ══════════════════════════════════════════════════════════
// app-ui.js — Toast · Balance · Nav · Gift · Withdraw
// ══════════════════════════════════════════════════════════

import {
    APP_STATE, APP_CONFIG,
    _SERVER_CONFIG as _SC,
    DAILY_GIFT_STATE as _DGS,
    WITHDRAW_HISTORY as _WH,
    fetchApi as _fetchApi,
    _updateReferralLinkUI,
} from './app-core.js';

const _AS = APP_STATE;
const _AC = APP_CONFIG;

// ══════════════════════════════════════════════════════════
// NOTIFICATIONS — نظام جديد من الصفر
// ══════════════════════════════════════════════════════════

// المخزن: array بسيط في الذاكرة
const _NOTIFS = [];
let   _unread = 0;

/**
 * pushNotif(type, title, body)
 * type: 'gold' | 'ton' | 'error'
 * يضيف للقائمة + يحدث الـ badge
 */
export function pushNotif(type, title, body) {
    _NOTIFS.unshift({ type, title, body, ts: Date.now(), read: false });
    _unread++;
    _updateNotifBadge();
}

function _updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (_unread > 0) {
        badge.textContent = _unread > 9 ? '9+' : String(_unread);
        badge.classList.add('visible');
    } else {
        badge.textContent = '';
        badge.classList.remove('visible');
    }
}

function _renderNotifPanel() {
    const list     = document.getElementById('notif-list');
    const emptyEl  = document.getElementById('notif-empty-msg');
    if (!list) return;

    if (!_NOTIFS.length) {
        if (emptyEl) emptyEl.style.display = '';
        list.innerHTML = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    list.innerHTML = _NOTIFS.map((n, i) => {
        const icon = n.type === 'ton'
            ? `<img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:22px;height:22px;border-radius:7px;object-fit:cover;">`
            : n.type === 'error'
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01" stroke-linecap="round"/></svg>`
            : `<img src="asesst/coins.png" alt="" style="width:20px;height:20px;object-fit:contain;filter:drop-shadow(0 0 4px rgba(251,191,36,0.7));">`;

        const iconClass = n.type === 'ton' ? 'ton' : n.type === 'error' ? 'red' : 'gold';

        return `<div class="notif-item${n.read?'':' unread'}" onclick="window._notifRead(${i})" style="cursor:pointer;">
            ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
            <div class="notif-item-icon ${iconClass}">${icon}</div>
            <div class="notif-item-body">
                <div class="notif-item-title">${n.title}</div>
                <div class="notif-item-sub">${n.body}</div>
            </div>
            <div class="notif-item-time">${_timeAgo(n.ts)}</div>
        </div>`;
    }).join('');
}

export function openNotifPanel() {
    // mark all read
    _NOTIFS.forEach(n => { n.read = true; });
    _unread = 0;
    _updateNotifBadge();
    _renderNotifPanel();
    document.getElementById('notif-panel')?.classList.add('open');
    document.getElementById('notif-backdrop')?.classList.add('visible');
}

export function closeNotifPanel() {
    document.getElementById('notif-panel')?.classList.remove('open');
    document.getElementById('notif-backdrop')?.classList.remove('visible');
}

window._notifRead = function(idx) {
    if (_NOTIFS[idx] && !_NOTIFS[idx].read) {
        _NOTIFS[idx].read = true;
        _unread = Math.max(0, _unread - 1);
        _updateNotifBadge();
        _renderNotifPanel();
    }
};

// ══════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════
const _ICONS = {
    coin:   `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#fbbf24" stroke-width="1.8"/><path d="M12 7v10M9.5 9.5C9.5 8.67 10.67 8 12 8s2.5.67 2.5 1.5S13.33 11 12 11s-2.5.67-2.5 1.5S10.67 14 12 14s2.5-.67 2.5-1.5" stroke="#fbbf24" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    trophy: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 2h12v8a6 6 0 01-12 0V2z" stroke="#34d399" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 5H3a2 2 0 000 4h3M18 5h3a2 2 0 010 4h-3" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"/><path d="M12 16v4M9 20h6" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    error:  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#f87171" stroke-width="1.8"/><path d="M12 8v4M12 16h.01" stroke="#f87171" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

export function showToast(icon, title, desc, color, badge) {
    if (color === 'green' && navigator.vibrate) navigator.vibrate([80,40,80]);
    const container = document.getElementById('ad-toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'ad-toast';
    el.innerHTML = `
        <div class="toast-icon-wrap ${color}">${_ICONS[icon] || _ICONS.coin}</div>
        <div class="toast-body">
            <div class="toast-title">${title}</div>
            <div class="toast-desc">${desc}</div>
        </div>
        <div class="toast-badge ${color}">${badge}</div>`;
    container.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => {
        el.classList.add('hide'); el.classList.remove('show');
        setTimeout(() => el.remove(), 400);
    }, 3200);
}

// ══════════════════════════════════════════════════════════
// BALANCE ANIMATION
// ══════════════════════════════════════════════════════════
export function animateBalance(from, to, dur) {
    from = parseInt(from)||0; to = parseInt(to)||0; dur = dur||1400;
    if (from === to) { updateBalanceUI(to); return; }
    const balEl  = document.getElementById('uc-balance-num');
    const heroEl = document.querySelector('.balance-hero-number');
    const start  = performance.now();
    function tick(now) {
        const p = Math.min((now-start)/dur, 1);
        const e = 1-Math.pow(1-p, 3);
        const v = Math.round(from+(to-from)*e);
        const f = v.toLocaleString('en-US');
        if (balEl)  balEl.textContent  = f;
        if (heroEl) heroEl.textContent = f;
        const uEl = document.getElementById('uc-usdt-val');
        if (uEl) uEl.textContent = (v/(_SC.pts_per_ton||100000)).toFixed(2);
        if (p < 1) requestAnimationFrame(tick);
        else updateBalanceUI(to);
    }
    requestAnimationFrame(tick);
}

export function updateBalanceUI(pts) {
    pts = parseInt(pts)||0;
    const f    = pts.toLocaleString('en-US');
    const balEl  = document.getElementById('uc-balance-num');
    const heroEl = document.querySelector('.balance-hero-number');
    const tonSh  = document.getElementById('ton-sheet-pts');
    const tonEq  = document.getElementById('ton-sheet-equiv');
    const usdtEl = document.getElementById('uc-usdt-val');
    const xpLvl  = document.querySelector('.uc-xp-level');
    const xpPct  = document.querySelector('.uc-xp-pct');
    const xpFill = document.querySelector('.uc-xp-fill');
    if (balEl)  { balEl.textContent  = f; balEl.dataset.target  = pts; }
    if (heroEl) { heroEl.textContent = f; heroEl.dataset.target = pts; }
    if (tonSh)  tonSh.textContent = f;
    if (tonEq)  tonEq.textContent = '≈ '+(pts/(_SC.pts_per_ton||100000)).toFixed(3)+' TON';
    if (usdtEl) usdtEl.textContent = (pts/(_SC.pts_per_ton||100000)).toFixed(2);
    const lvl = _AS.level||1;
    const TH  = [0,0,500,1500,3500,8000,16000,30000,55000,90000,150000];
    const cur = TH[lvl]||0; const nxt = TH[lvl+1]||cur+10000;
    const pct = nxt>cur ? Math.min(100,Math.floor((pts-cur)/(nxt-cur)*100)) : 100;
    if (xpLvl)  xpLvl.textContent = `المستوى ${lvl}`;
    if (xpPct)  xpPct.textContent = pct+'%';
    if (xpFill) xpFill.style.width = pct+'%';
    // ── Home ring + tier update ──
    _updateHomeRing(lvl);
    // ── Slide-in balance icons (once) ──
    _triggerBalIcons();
    // ── Ticker ──
    _updateHomeTicker(pts, lvl);
}

let _balIconsTriggered = false;
function _triggerBalIcons() {
    if (_balIconsTriggered) return;
    _balIconsTriggered = true;
    setTimeout(() => {
        document.querySelectorAll('.hm-bal-icon').forEach(el => el.classList.add('hm-in'));
    }, 200);
}

function _updateHomeRing(lvl) {
    const cont      = document.getElementById('hm-ring-container');
    const ringNum   = document.getElementById('ring-level-num');
    const tierLabel = document.getElementById('hm-tier-label');
    if (!cont) return;
    if (ringNum) ringNum.textContent = lvl;
    const tier = lvl >= 7 ? 'gold' : lvl >= 4 ? 'silver' : 'green';
    const labels = { gold: 'مستوى ذهبي', silver: 'مستوى فضي', green: 'مستوى أخضر' };
    cont.classList.remove('tier-gold', 'tier-silver', 'tier-green');
    cont.classList.add('tier-' + tier);
    if (tierLabel) tierLabel.textContent = labels[tier];
}

function _updateHomeTicker(pts, lvl) {
    const el = document.getElementById('hm-ticker-inner');
    if (!el) return;
    const bal     = pts.toLocaleString('en-US');
    const usdt    = (pts / (_SC.pts_per_ton || 100000)).toFixed(2);
    const friends = (document.querySelector('.uc-stat-val.green') || {}).textContent || '0';
    const tasks   = (document.querySelector('.uc-stat-val.blue')  || {}).textContent || '0';
    const items = [
        { cls: 'hm-y', label: 'رصيدك',   val: bal + ' نقطة' },
        { cls: 'hm-g', label: 'USDT',     val: usdt           },
        { cls: 'hm-y', label: 'المستوى',  val: String(lvl)   },
        { cls: 'hm-g', label: 'أصدقاء',  val: friends        },
        { cls: 'hm-y', label: 'مهام',     val: tasks          },
    ];
    // duplicate for seamless infinite scroll
    const html = [...items, ...items]
        .map(i => `<div class="hm-tick ${i.cls}">${i.label} <strong>${i.val}</strong></div>`)
        .join('');
    el.innerHTML = html;
}

export function runCounters(scope) {
    (scope||document).querySelectorAll('.counter').forEach(el => {
        const target = parseInt(el.getAttribute('data-target')); if (!target) return;
        const dur = 1800; const t0 = performance.now();
        function u(now) {
            const p = Math.min((now-t0)/dur,1); const e = 1-Math.pow(1-p,3);
            el.textContent = Math.floor(e*target).toLocaleString('en-US');
            if (p<1) requestAnimationFrame(u); else el.textContent=target.toLocaleString('en-US');
        }
        requestAnimationFrame(u);
    });
}

// ══════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════
export function showPage(pageName, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-'+pageName)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    (btn || document.querySelector(`.nav-item[data-page="${pageName}"]`))?.classList.add('active');
    updateBalanceUI(_AS.balance);
    if (pageName === 'withdraw') _refreshWithdrawUI();
}

function _refreshWithdrawUI() {
    const heroEl = document.getElementById('withdraw-balance-hero');
    if (heroEl) heroEl.textContent = _AS.balance.toLocaleString('en-US');
    const fw  = _AS.first_withdraw_done;
    const min = fw ? (_AC.withdraw.normal_min||20000) : (_AC.withdraw.first_min||3000);
    const el  = document.getElementById('withdraw-ton-min-display');
    if (el) el.textContent = min.toLocaleString('en-US');
}

export function _hideLoadingScreen() {
    const sc = document.getElementById('app-loading-screen');
    if (!sc) return;
    sc.style.opacity='0'; sc.style.visibility='hidden';
    setTimeout(()=>sc.remove(), 600);
}

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
export function _timeAgo(ts) {
    const d = Math.floor((Date.now()-ts)/1000);
    if (d<60)    return 'الآن';
    if (d<3600)  return `منذ ${Math.floor(d/60)} دقيقة`;
    if (d<86400) return `منذ ${Math.floor(d/3600)} ساعة`;
    return `منذ ${Math.floor(d/86400)} يوم`;
}

export function renderReferralList(list, total) {
    const container = document.getElementById('referral-list-container');
    if (!container||!list.length) return;
    const colors = [
        {bg:'linear-gradient(135deg,rgba(167,139,250,0.2),rgba(96,165,250,0.2))', border:'rgba(167,139,250,0.2)',color:'var(--purple)'},
        {bg:'linear-gradient(135deg,rgba(96,165,250,0.2),rgba(52,211,153,0.2))',  border:'rgba(96,165,250,0.2)', color:'var(--blue)'},
        {bg:'linear-gradient(135deg,rgba(251,191,36,0.15),rgba(251,191,36,0.05))',border:'rgba(251,191,36,0.2)', color:'var(--gold)'},
        {bg:'linear-gradient(135deg,rgba(52,211,153,0.15),rgba(52,211,153,0.05))',border:'rgba(52,211,153,0.2)', color:'var(--green)'},
    ];
    const pts = _AC.rewards.referral||100;
    let html = list.map((r,i) => {
        const c = colors[i%colors.length];
        return `<div class="referral-item">
            <div class="referral-avatar" style="background:${c.bg};border-color:${c.border};color:${c.color};">${(r.name||'م')[0]}</div>
            <div class="referral-info">
                <div class="referral-name">${r.name||'مستخدم'}</div>
                <div class="referral-date">${_timeAgo(r.ts||Date.now())}</div>
            </div>
            <div class="referral-reward">
                <img src="asesst/coins.png" alt="" style="width:14px;height:14px;object-fit:contain;">
                <span class="referral-reward-text">+${pts}</span>
            </div>
        </div><div class="shine-line-sm" style="margin:2px 10px;"></div>`;
    }).join('');
    const extra = total-list.length;
    if (extra>0) html += `<div style="text-align:center;padding:12px 0 4px;"><span style="font-size:12px;font-weight:700;color:var(--purple);opacity:0.7;">+${extra} صديق آخر</span></div>`;
    container.innerHTML = html;
}

export function renderWithdrawHistory() {
    const listEl = document.getElementById('withdraw-history-list');
    const emptyEl= document.getElementById('withdraw-empty');
    const badge  = document.getElementById('withdraw-count-badge');
    if (!_WH.length) { if(emptyEl) emptyEl.style.display=''; if(badge) badge.style.display='none'; return; }
    if (emptyEl) emptyEl.style.display='none';
    if (badge)   { badge.style.display=''; badge.textContent=_WH.length+' طلب'; }
    if (!listEl) return;
    listEl.innerHTML = _WH.slice().reverse().map(item => {
        const ton   = (item.pts/100000).toFixed(3);
        const addr  = item.address.length>14 ? item.address.slice(0,6)+'...'+item.address.slice(-6) : item.address;
        return `<div class="withdraw-hist-item">
            <div class="withdraw-hist-icon"><img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:26px;height:26px;border-radius:7px;object-fit:cover;"></div>
            <div class="withdraw-hist-info">
                <div class="withdraw-hist-name">سحب TON</div>
                <div class="withdraw-hist-addr">${addr}</div>
                <div class="withdraw-hist-time">${_timeAgo(item.ts)}</div>
            </div>
            <div class="withdraw-hist-right">
                <div class="withdraw-hist-pts">${item.pts.toLocaleString('en-US')}</div>
                <div class="withdraw-hist-ton">${ton} TON</div>
                <div class="withdraw-hist-badge pending">قيد المعالجة</div>
            </div>
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
// DAILY GIFT
// ══════════════════════════════════════════════════════════
const GIFT_FB = [
    {day:'اليوم الأول',  desc:'مبروك! استمر يومياً لتضاعف مكافآتك!', pts:100},
    {day:'اليوم الثاني', desc:'يومان متتاليان! المثابرة مفتاح النجاح.', pts:150},
    {day:'اليوم الثالث', desc:'ثلاثة أيام متتالية!', pts:200},
    {day:'اليوم الرابع', desc:'أسبوعك يقترب!', pts:250},
    {day:'اليوم الخامس',desc:'خمسة أيام!', pts:300},
    {day:'اليوم السادس',desc:'يوم واحد ويكتمل أسبوعك!', pts:400},
    {day:'اليوم السابع', desc:'أسبوع كامل! مكافأة ضخمة.', pts:750},
];

function _giftData(day) {
    const idx = Math.max(0,day-1);
    const sv  = _AC.daily_gift||{};
    return {
        day:    sv.titles_ar?.[idx]||GIFT_FB[Math.min(idx,6)]?.day||('اليوم '+day),
        desc:   sv.descs_ar?.[idx] ||GIFT_FB[Math.min(idx,6)]?.desc||'',
        pts:    sv.rewards?.[idx]  ??GIFT_FB[Math.min(idx,6)]?.pts??100,
    };
}

export function openDailyGiftOverlay() {
    if (_DGS.isOpening) return;
    _DGS.isOpening = true;
    const overlay = document.getElementById('daily-gift-overlay');
    if (!overlay) { _DGS.isOpening=false; return; }

    const g = _giftData(_DGS.dayNumber);
    const setText = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    setText('gift-day-text',  g.day);
    setText('gift-desc-text', g.desc);
    setText('gift-amount',    '+'+g.pts);

    const dotsEl = document.getElementById('gift-streak-dots');
    if (dotsEl) {
        dotsEl.innerHTML='';
        for (let i=1;i<=7;i++) {
            const d=document.createElement('div');
            d.style.cssText=`width:${i===_DGS.dayNumber?'22px':'8px'};height:8px;border-radius:4px;
                background:${i<_DGS.dayNumber?'rgba(251,191,36,0.75)':i===_DGS.dayNumber?'#fbbf24':'rgba(255,255,255,0.1)'};
                box-shadow:${i<=_DGS.dayNumber?'0 0 6px rgba(251,191,36,0.4)':'none'};`;
            dotsEl.appendChild(d);
        }
    }

    const btn   = document.getElementById('gift-claim-btn');
    const label = document.getElementById('gift-loading-label');
    const ring  = document.getElementById('gift-ring-icon');
    if (btn)   btn.style.display   = 'none';
    if (label) label.style.display = 'block';
    if (ring)  ring.innerHTML = `
        <path d="M20 12v10H4V12" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M22 7H2v5h20V7z" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 22V7" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

    overlay.style.opacity='1'; overlay.style.pointerEvents='all';

    if (_DGS.claimed) {
        if (label) { label.textContent='تم استلام هديتك اليوم ✓'; label.style.color='#34d399'; label.style.fontWeight='700'; }
        _DGS.isOpening=false;
        setTimeout(()=>closeDailyGiftOverlay(), 2200);
        return;
    }

    let sec=3;
    if (label) label.textContent='جاري تحضير هديتك...';
    const timer = setInterval(()=>{
        sec--;
        if (sec>0) { if(label) label.textContent='جاري تحضير هديتك...'; }
        else {
            clearInterval(timer);
            if (label) label.style.display='none';
            if (btn) {
                btn.style.display='block'; btn.style.transform='scale(0.8)'; btn.style.opacity='0';
                requestAnimationFrame(()=>requestAnimationFrame(()=>{
                    btn.style.transition='all 0.4s cubic-bezier(0.34,1.56,0.64,1)';
                    btn.style.transform='scale(1)'; btn.style.opacity='1';
                }));
            }
            _DGS.isOpening=false;
        }
    }, 1000);
}

export function closeDailyGiftOverlay() {
    const overlay=document.getElementById('daily-gift-overlay');
    if (overlay) { overlay.style.opacity='0'; overlay.style.pointerEvents='none'; }
    _DGS.isOpening=false;
}

export async function claimGift() {
    if (_DGS.claimed) return;
    _DGS.claimed=true;
    const result = await _fetchApi({ type:'claim_gift', data:{} });
    if (!result.ok) { _DGS.claimed=false; return; }
    if (result.streak_day)          _DGS.dayNumber = result.streak_day;
    if (result.points!==undefined)  { animateBalance(_AS.balance,result.points); _AS.balance=result.points; }
    const ring=document.getElementById('gift-ring-icon');
    if (ring) ring.innerHTML=`<path d="M20 6L9 17l-5-5" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    const btn=document.getElementById('gift-claim-btn');
    if (btn) {
        btn.textContent='تم الاستلام ✓';
        btn.style.background='rgba(52,211,153,0.15)'; btn.style.color='#34d399';
        btn.style.border='1px solid rgba(52,211,153,0.28)'; btn.style.cursor='default'; btn.onclick=null;
    }
    const reward=result.reward||0;
    showToast('trophy','تم استلام هديتك!',`+${reward} نقطة`,'green',`+${reward}`);
    pushNotif('gold','هدية يومية ✓',`+${reward} نقطة أُضيفت لرصيدك`);
    setTimeout(()=>closeDailyGiftOverlay(), 1600);
}

// ══════════════════════════════════════════════════════════
// TON WITHDRAW
// ══════════════════════════════════════════════════════════
export function openTonWithdraw() {
    const overlay   = document.getElementById('ton-withdraw-overlay');
    const ptsEl     = document.getElementById('ton-sheet-pts');
    const equivEl   = document.getElementById('ton-sheet-equiv');
    const levelWarn = document.getElementById('ton-level-warn');
    const ptsWarn   = document.getElementById('ton-pts-warn');
    const curLvlEl  = document.getElementById('ton-current-level');
    const submitBtn = document.getElementById('ton-submit-btn');
    const input     = document.getElementById('ton-address-input');
    const errEl     = document.getElementById('ton-error-msg');

    input.value=''; errEl.style.display='none';
    const ptsPerTon = _SC.pts_per_ton||100000;
    ptsEl.textContent  = _AS.balance.toLocaleString('en-US');
    equivEl.textContent= '≈ '+(_AS.balance/ptsPerTon).toFixed(3)+' TON';

    const fw      = _AS.first_withdraw_done;
    const minPts  = fw ? (_AC.withdraw.normal_min||20000) : (_AC.withdraw.first_min||3000);
    const minLvl  = fw ? (_AC.withdraw.normal_level||5)  : 0;
    const hasLvl  = fw ? _AS.level>=minLvl : true;
    const hasPts  = _AS.balance>=minPts;

    levelWarn.style.display='none'; ptsWarn.style.display='none';
    const chip=document.getElementById('ton-min-chip-val');
    if (chip) { chip.textContent=minPts.toLocaleString('en-US')+' نقطة'; chip.style.color=fw?'var(--gold)':'var(--green)'; }
    const firstOffer=document.getElementById('first-withdraw-offer');
    if (firstOffer) firstOffer.style.display=fw?'none':'flex';
    const minPtsEl=document.getElementById('ton-min-pts');
    if (minPtsEl) minPtsEl.textContent=minPts.toLocaleString('en-US');
    const warnMin=document.getElementById('ton-pts-warn-min');
    if (warnMin) warnMin.textContent=minPts.toLocaleString('en-US');

    if (!hasLvl) { levelWarn.style.display=''; if(curLvlEl) curLvlEl.textContent=_AS.level; submitBtn.disabled=true; }
    else if (!hasPts) { ptsWarn.style.display=''; submitBtn.disabled=true; }
    else submitBtn.disabled=false;

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

function _isValidTonAddr(addr) {
    return (addr.startsWith('EQ')||addr.startsWith('UQ')||addr.startsWith('0:')) && addr.length>=48;
}

export async function submitTonWithdraw() {
    const input    = document.getElementById('ton-address-input');
    const addr     = input.value.trim();
    const errEl    = document.getElementById('ton-error-msg');
    const submitBtn= document.getElementById('ton-submit-btn');

    if (!_isValidTonAddr(addr)) { errEl.style.display='block'; input.style.borderColor='rgba(248,113,113,0.5)'; return; }

    submitBtn.disabled=true; submitBtn.innerHTML='<img src="asesst/loading.gif" style="width:14px;height:14px;object-fit:contain;vertical-align:middle;border-radius:2px;margin-left:4px;"> جاري الإرسال...';
    const result = await _fetchApi({ type:'submit_withdraw', data:{address:addr} });
    submitBtn.disabled=false; submitBtn.textContent='إرسال طلب السحب';

    if (!result.ok) {
        errEl.textContent = result.error==='insufficient_balance'?'رصيدك غير كافٍ'
            : result.error==='level_too_low'?`يتطلب المستوى ${result.required_level||5} للسحب`
            : 'حدث خطأ، حاول مجدداً';
        errEl.style.display='block'; return;
    }

    if (result.new_balance!==undefined) { animateBalance(_AS.balance,result.new_balance); _AS.balance=result.new_balance; }
    if (result.first_withdraw===true) _AS.first_withdraw_done=true;

    const item={pts:result.pts_deducted||0,address:addr,ts:Date.now(),status:'pending'};
    _WH.push(item);
    renderWithdrawHistory();
    closeTonWithdraw();
    showToast('trophy','تم إرسال طلب السحب! 🎉','سيتم معالجة طلبك قريباً','green','✓');
    pushNotif('ton','طلب سحب TON مُرسَل',`${item.pts.toLocaleString('en-US')} نقطة قيد المعالجة`);
}

export function copyReferralLink() {
    const btn  = document.getElementById('copy-btn');
    const link = window._REFERRAL_LINK||'';
    navigator.clipboard.writeText(link).catch(()=>{
        const ta=document.createElement('textarea'); ta.value=link;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    });
    btn.classList.add('copied');
    btn.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>تم النسخ!`;
    showToast('trophy','تم نسخ الرابط ✓','شارك رابطك مع أصدقائك','green','🔗');
    setTimeout(()=>{
        btn.classList.remove('copied');
        btn.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/></svg>نسخ`;
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

// ── expose ────────────────────────────────────────────────
window.showPage              = showPage;
window.openNotifPanel        = openNotifPanel;
window.closeNotifPanel       = closeNotifPanel;
window.openDailyGiftOverlay  = openDailyGiftOverlay;
window.openDailyGift         = openDailyGiftOverlay;
window.closeDailyGift        = closeDailyGiftOverlay;
window.closeDailyGiftOverlay = closeDailyGiftOverlay;
window.claimGift             = claimGift;
window.openTonWithdraw       = openTonWithdraw;
window.closeTonWithdraw      = closeTonWithdraw;
window.handleTonOverlayClick = handleTonOverlayClick;
window.clearTonError         = clearTonError;
window.submitTonWithdraw     = submitTonWithdraw;
window.copyReferralLink      = copyReferralLink;
window.shareTelegram         = shareTelegram;
window.shareWhatsApp         = shareWhatsApp;
window.animateBalance        = animateBalance;
window.updateBalanceUI       = updateBalanceUI;
window.showToast             = showToast;
window.pushNotif             = pushNotif;
window.renderWithdrawHistory = renderWithdrawHistory;
