// ═══════════════════════════════════════════════════════════════════
//  app-ui.js — toast | modals | animations | progress | rendering
// ═══════════════════════════════════════════════════════════════════

// ── Toast System ─────────────────────────────────────────────────
const TOAST_ICONS = {
    coin: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="#fbbf24" stroke-width="1.8"/>
        <path d="M12 7v10M9.5 9.5C9.5 8.67 10.67 8 12 8s2.5.67 2.5 1.5S13.33 11 12 11s-2.5.67-2.5 1.5S10.67 14 12 14s2.5-.67 2.5-1.5" stroke="#fbbf24" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`,
    fire: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M12 2C12 2 7 8 7 13a5 5 0 0010 0c0-2-.7-3.8-2-5.5.5 1.5.5 2.5.5 2.5S12 8 12 2z" fill="rgba(251,191,36,0.9)"/>
        <path d="M12 15c0 1.1-.9 2-2 2" stroke="rgba(251,191,36,0.5)" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`,
    trophy: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M6 2h12v8a6 6 0 01-12 0V2z" stroke="#34d399" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M6 5H3a2 2 0 000 4h3M18 5h3a2 2 0 010 4h-3" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M12 16v4M9 20h6" stroke="#34d399" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`
};

function showToast(iconKey, title, desc, color, badge) {
    // Vibrate on mobile for reward toasts
    if (color === 'green' && navigator.vibrate) {
        try { navigator.vibrate([40, 20, 60]); } catch (_) {}
    }

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
        ${badge ? `<div class="toast-badge ${color}">${badge}</div>` : ''}
    `;

    // Coin burst animation on reward
    if (color === 'green' && badge && String(badge).startsWith('+')) {
        toast.style.animation = 'none';
        requestAnimationFrame(() => {
            toast.style.animation = '';
        });
    }

    container.appendChild(toast);
    requestAnimationFrame(() => { requestAnimationFrame(() => toast.classList.add('show')); });

    setTimeout(() => {
        toast.classList.add('hide');
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3200);
}

// ── Balance Animation ─────────────────────────────────────────────
function animateBalance(fromPts, toPts, duration) {
    fromPts  = parseInt(fromPts) || 0;
    toPts    = parseInt(toPts)   || 0;
    duration = duration || 1400;
    if (fromPts === toPts) { updateBalanceUI(toPts); return; }

    const balEl   = document.getElementById('uc-balance-num');
    const heroNum = document.querySelector('.balance-hero-number');
    const start   = performance.now();

    // Flash effect on balance element
    if (balEl) { balEl.style.transition = 'color 0.2s ease'; balEl.style.color = toPts > fromPts ? '#34d399' : '#f87171'; }

    function tick(now) {
        const elapsed  = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const ease     = 1 - Math.pow(1 - progress, 3);
        const current  = Math.round(fromPts + (toPts - fromPts) * ease);
        const fmt      = current.toLocaleString('en-US');
        if (balEl)   balEl.textContent   = fmt;
        if (heroNum) heroNum.textContent = fmt;
        const usdtLive = document.getElementById('uc-usdt-val');
        if (usdtLive) usdtLive.textContent = (current / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(2);
        if (progress < 1) { requestAnimationFrame(tick); }
        else {
            updateBalanceUI(toPts);
            if (balEl) { setTimeout(() => { balEl.style.color = ''; }, 400); }
        }
    }
    requestAnimationFrame(tick);
}

function updateBalanceUI(pts) {
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
    if (tonSheet) tonSheet.textContent = pts.toLocaleString('en-US');
    if (tonEquiv) tonEquiv.textContent = '≈ ' + (pts / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(3) + ' TON';
    if (usdtEl)   usdtEl.textContent  = (pts / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(2);

    const lvl  = APP_STATE.level || 1;
    const THRESHOLDS = [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000];
    const curr = THRESHOLDS[lvl] || 0;
    const next = THRESHOLDS[lvl + 1] || curr + 10000;
    const pct  = next > curr ? Math.min(100, Math.floor((pts - curr) / (next - curr) * 100)) : 100;
    if (xpLevel) xpLevel.textContent = `المستوى ${lvl}`;
    if (xpPct)   xpPct.textContent   = pct + '%';
    if (xpFill)  xpFill.style.width  = pct + '%';
}

// ── Counters ──────────────────────────────────────────────────────
function runCounters(scope) {
    scope = scope || document;
    scope.querySelectorAll('.counter').forEach(counter => {
        const target = parseInt(counter.getAttribute('data-target'));
        if (!target) return;
        const duration = 1800;
        const startTime = performance.now();
        function update(now) {
            const elapsed  = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const ease     = 1 - Math.pow(1 - progress, 3);
            const current  = Math.floor(ease * target);
            counter.textContent = current.toLocaleString('en-US');
            if (progress < 1) requestAnimationFrame(update);
            else counter.textContent = target.toLocaleString('en-US');
        }
        requestAnimationFrame(update);
    });
}

// ── Page Navigation ───────────────────────────────────────────────
function showPage(pageName, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + pageName);
    if (target) target.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else { const navBtn = document.querySelector(`.nav-item[data-page="${pageName}"]`); if (navBtn) navBtn.classList.add('active'); }
    updateBalanceUI(APP_STATE.balance);
    if (pageName === 'withdraw') _refreshWithdrawPageUI();
}

function _refreshWithdrawPageUI() {
    const heroEl = document.getElementById('withdraw-balance-hero');
    if (heroEl) heroEl.textContent = APP_STATE.balance.toLocaleString();
    const minDisplay = document.getElementById('withdraw-ton-min-display');
    if (minDisplay) minDisplay.textContent = TON_CONFIG.minPts.toLocaleString();
}

// ── Ad Progress UI ────────────────────────────────────────────────
function updateAdUI() {
    const ads  = APP_STATE.ads;
    const r    = ads.remaining;
    const el   = (id) => document.getElementById(id);

    // Progress bar — watched / total (bar fills as more ads are watched)
    const watched = ads.total - r;
    const pct = ads.total > 0 ? (watched / ads.total) * 100 : 0;

    if (el('ads-remaining'))  el('ads-remaining').textContent  = r;
    if (el('ads-watched'))    el('ads-watched').textContent    = ads.watched;
    if (el('earned-today'))   el('earned-today').textContent   = ads.earned.toLocaleString('ar-EG');
    if (el('ads-progress'))   el('ads-progress').style.width   = pct + '%';
    const quotaTotal = document.querySelector('.ad-quota-total');
    if (quotaTotal) quotaTotal.textContent = '/ ' + ads.total;

    // Cooldown — independent from adsgram
    const coolLeft = ads.cooldownUntil - Date.now();
    const adBtn    = el('ad-watch-btn');
    const coolEl   = el('ad-cooldown-msg');

    if (coolLeft > 0 && r > 0) {
        if (adBtn) adBtn.classList.add('disabled');
        if (coolEl) {
            const sec = Math.ceil(coolLeft / 1000);
            coolEl.textContent = `⏳ انتظر ${sec}s`;
            coolEl.style.display = 'block';
        }
        if (!ads._cooldownTimer) {
            ads._cooldownTimer = setInterval(() => {
                const left = ads.cooldownUntil - Date.now();
                if (left <= 0) {
                    clearInterval(ads._cooldownTimer);
                    ads._cooldownTimer = null;
                    if (adBtn && r > 0) adBtn.classList.remove('disabled');
                    if (coolEl) coolEl.style.display = 'none';
                } else {
                    if (coolEl) coolEl.textContent = `⏳ انتظر ${Math.ceil(left / 1000)}s`;
                }
            }, 1000);
        }
    } else {
        if (r > 0 && adBtn) adBtn.classList.remove('disabled');
        if (coolEl) coolEl.style.display = 'none';
    }

    if (r === 0) {
        if (adBtn) adBtn.style.display = 'none';
        const doneEl = el('ad-done-state');
        if (doneEl) doneEl.style.display = 'flex';
    }

    syncDailyTasksFromAds();
}

function _updatePreloadBar(el, done, total) {
    if (!el) return;
    const pct = total > 0 ? (done / total) * 100 : 0;
    el.style.width      = pct + '%';
    el.style.background = done >= total
        ? 'linear-gradient(90deg, #34d399, #10b981)'
        : 'linear-gradient(90deg, #f59e0b, #fbbf24)';
    const label = document.getElementById('ad-preload-label');
    if (label) label.textContent = `${done} / ${total}`;
}

// ── Daily Tasks ───────────────────────────────────────────────────
function syncDailyTasksFromAds() {
    const watched = APP_STATE.ads.watched;

    const pct10 = Math.min(watched / 10, 1) * 100;
    const fill10 = document.getElementById('ads10-fill');
    const prog10 = document.getElementById('ads10-prog');
    if (fill10) fill10.style.width  = pct10 + '%';
    if (prog10) prog10.textContent  = Math.min(watched, 10) + ' / 10';
    if (watched >= 10 && !APP_STATE.tasks.ads10Done) {
        APP_STATE.tasks.ads10Done = true;
        markDailyTaskDone('dtask-ads10', false);
    }

    const pct25 = Math.min(watched / 25, 1) * 100;
    const fill25 = document.getElementById('ads25-fill');
    const prog25 = document.getElementById('ads25-prog');
    if (fill25) fill25.style.width  = pct25 + '%';
    if (prog25) prog25.textContent  = Math.min(watched, 25) + ' / 25';
    if (watched >= 25 && !APP_STATE.tasks.ads25Done) {
        APP_STATE.tasks.ads25Done = true;
        markDailyTaskDone('dtask-ads25', false);
    }

    updateDailyBadge();
}

const DTASK_CLAIM_MAP = {
    'dtask-ads10':   'ads_10',
    'dtask-ads25':   'ads_25',
    'dtask-invite3': 'daily_refs_3',
};

function markDailyTaskDone(cardId, rewardClaimed) {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.add('completed');
    const icon = card.querySelector('.dtask-icon');
    if (icon) {
        icon.style.background = 'rgba(52,211,153,0.12)';
        icon.style.border     = '1px solid rgba(52,211,153,0.22)';
        icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
    }
    const taskType  = DTASK_CLAIM_MAP[cardId];
    const claimBtn  = taskType ? document.getElementById('dtask-claim-' + taskType) : null;
    const claimedBadge = card.querySelector('.dtask-claimed-badge');
    if (!rewardClaimed) {
        if (claimBtn)     claimBtn.style.display     = 'inline-flex';
        if (claimedBadge) claimedBadge.style.display = 'none';
    } else {
        if (claimBtn)     claimBtn.style.display     = 'none';
        if (claimedBadge) claimedBadge.style.display = 'inline-flex';
    }
}

function updateDailyBadge() {
    const done = [APP_STATE.tasks.ads10Done, APP_STATE.tasks.ads25Done, APP_STATE.tasks.invite3Done].filter(Boolean).length;
    const badge = document.getElementById('daily-tasks-badge');
    if (badge) badge.textContent = done + ' / 3';
}

function handleDailyTask(type) {
    if (type === 'ads10' || type === 'ads25') {
        showPage('earn', null);
        const nav = document.querySelector('.nav-item[data-page="earn"]');
        if (nav) { document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active')); nav.classList.add('active'); }
    } else if (type === 'invite3') {
        showPage('invite', null);
        const nav = document.querySelector('.nav-item[data-page="invite"]');
        if (nav) { document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active')); nav.classList.add('active'); }
    }
}

async function claimDailyMission(taskType) {
    const btn = document.getElementById('dtask-claim-' + taskType);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

    const result = await fetchApi({ type: 'claim_daily_mission', data: { task_type: taskType } });

    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }

    if (!result.ok) {
        if (result.error === 'account_review')
            showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        else if (result.error === 'task_not_completed_or_already_claimed') {
            showToast('coin', 'تم الاستلام مسبقاً', '', 'gold', '✓');
            if (btn) btn.style.display = 'none';
        } else {
            showToast('coin', 'حدث خطأ', result.error || '', 'red', '!');
        }
        return;
    }

    if (result.points !== undefined) {
        animateBalance(APP_STATE.balance, result.points);
        APP_STATE.balance = result.points;
    }
    if (btn) btn.style.display = 'none';
    const cardId = 'dtask-' + taskType.replace(/_/g, '');
    const cb = document.getElementById(cardId)?.querySelector('.dtask-claimed-badge');
    if (cb) cb.style.display = 'inline-flex';

    showToast('trophy', 'تم استلام المكافأة! 🎁', `+${(result.reward || 0).toLocaleString()} نقطة`, 'green', `+${result.reward || 0}`);
    try { addNotification('gold', 'تم استلام مكافأة المهمة اليومية ✓', `+${(result.reward || 0).toLocaleString('ar-EG')} نقطة أُضيفت لرصيدك`, Date.now()); } catch (_) {}
}

// ── Notifications ─────────────────────────────────────────────────
function addNotification(type, title, sub, ts) {
    APP_STATE.notifList.unshift({ type, title, sub, ts: ts || Date.now(), read: false });
    APP_STATE.unreadNotifCount++;
    updateNotifBadge();
    renderNotifList();
}

function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (APP_STATE.unreadNotifCount > 0) {
        badge.classList.add('visible');
        badge.textContent = APP_STATE.unreadNotifCount > 9 ? '9+' : APP_STATE.unreadNotifCount;
    } else {
        badge.classList.remove('visible');
        badge.textContent = '';
    }
}

function renderNotifList() {
    const list     = document.getElementById('notif-list');
    const emptyMsg = document.getElementById('notif-empty-msg');
    if (!list) return;
    if (APP_STATE.notifList.length === 0) { if (emptyMsg) emptyMsg.style.display = ''; return; }
    if (emptyMsg) emptyMsg.style.display = 'none';

    const tonIcon  = `<img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:22px;height:22px;border-radius:7px;object-fit:cover;">`;
    const coinIcon = `<img src="asesst/coins.png" alt="" style="width:20px;height:20px;object-fit:contain;filter:drop-shadow(0 0 4px rgba(251,191,36,0.7));">`;

    list.innerHTML = APP_STATE.notifList.map((n, i) => `
        <div class="notif-item ${n.read ? '' : 'unread'}" onclick="markNotifRead(${i})">
            ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
            <div class="notif-item-icon ${n.type === 'ton' ? 'ton' : 'gold'}">${n.type === 'ton' ? tonIcon : coinIcon}</div>
            <div class="notif-item-body">
                <div class="notif-item-title">${n.title}</div>
                <div class="notif-item-sub">${n.sub}</div>
            </div>
            <div class="notif-item-time">${formatTimeAgo(n.ts)}</div>
        </div>`).join('');
}

function markNotifRead(idx) {
    if (!APP_STATE.notifList[idx].read) {
        APP_STATE.notifList[idx].read = true;
        APP_STATE.unreadNotifCount = Math.max(0, APP_STATE.unreadNotifCount - 1);
        updateNotifBadge();
        renderNotifList();
    }
}

function openNotifPanel() {
    document.getElementById('notif-panel')?.classList.add('open');
    document.getElementById('notif-backdrop')?.classList.add('visible');
    APP_STATE.notifList.forEach(n => { n.read = true; });
    APP_STATE.unreadNotifCount = 0;
    updateNotifBadge();
    renderNotifList();
}

function closeNotifPanel() {
    document.getElementById('notif-panel')?.classList.remove('open');
    document.getElementById('notif-backdrop')?.classList.remove('visible');
}

// ── Withdraw Rendering ────────────────────────────────────────────
function renderWithdrawHistory() {
    const list  = document.getElementById('withdraw-history-list');
    const empty = document.getElementById('withdraw-empty');
    const badge = document.getElementById('withdraw-count-badge');
    if (WITHDRAW_HISTORY.length === 0) { if (empty) empty.style.display = ''; if (badge) badge.style.display = 'none'; return; }
    if (empty) empty.style.display = 'none';
    if (badge) { badge.style.display = ''; badge.textContent = WITHDRAW_HISTORY.length + ' طلب'; }
    if (!list) return;
    list.innerHTML = [...WITHDRAW_HISTORY].reverse().map(item => {
        const tonAmt    = (item.pts / 100000).toFixed(3);
        const addrShort = item.address.length > 14 ? item.address.substring(0, 6) + '...' + item.address.slice(-6) : item.address;
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

// ── Referral ──────────────────────────────────────────────────────
function renderReferralList(list, total) {
    const container = document.getElementById('referral-list-container');
    if (!container || !list.length) return;
    const colors = [
        { bg: 'linear-gradient(135deg,rgba(167,139,250,0.2),rgba(96,165,250,0.2))', border: 'rgba(167,139,250,0.2)', color: 'var(--purple)' },
        { bg: 'linear-gradient(135deg,rgba(96,165,250,0.2),rgba(52,211,153,0.2))',  border: 'rgba(96,165,250,0.2)',  color: 'var(--blue)'   },
        { bg: 'linear-gradient(135deg,rgba(251,191,36,0.15),rgba(251,191,36,0.05))',border: 'rgba(251,191,36,0.2)',  color: 'var(--gold)'   },
        { bg: 'linear-gradient(135deg,rgba(52,211,153,0.15),rgba(52,211,153,0.05))',border: 'rgba(52,211,153,0.2)',  color: 'var(--green)'  },
    ];
    const pts = APP_CONFIG.rewards.referral || 100;
    let html = '';
    list.forEach((r, i) => {
        const c = colors[i % colors.length];
        html += `<div class="referral-item">
            <div class="referral-avatar" style="background:${c.bg};border-color:${c.border};color:${c.color};">${(r.name || 'م')[0]}</div>
            <div class="referral-info">
                <div class="referral-name">${r.name || 'مستخدم'}</div>
                <div class="referral-date">${formatTimeAgo(r.ts || Date.now())}</div>
            </div>
            <div class="referral-reward">
                <img src="asesst/coins.png" alt="" style="width:14px;height:14px;object-fit:contain;filter:drop-shadow(0 0 3px rgba(251,191,36,0.6));">
                <span class="referral-reward-text">+${pts}</span>
            </div>
        </div><div class="shine-line-sm" style="margin:2px 10px;"></div>`;
    });
    const extra = total - list.length;
    if (extra > 0) html += `<div style="text-align:center;padding:12px 0 4px;"><span style="font-size:12px;font-weight:700;color:var(--purple);opacity:0.7;">+${extra} صديق آخر</span></div>`;
    container.innerHTML = html;
}

// ── Time helpers ──────────────────────────────────────────────────
function formatTimeAgo(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)    return 'الآن';
    if (diff < 3600)  return `منذ ${Math.floor(diff / 60)} دقيقة`;
    if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
    return `منذ ${Math.floor(diff / 86400)} يوم`;
}

// ── TON Withdraw ──────────────────────────────────────────────────
function openTonWithdraw() {
    const overlay   = document.getElementById('ton-withdraw-overlay');
    const ptsEl     = document.getElementById('ton-sheet-pts');
    const equivEl   = document.getElementById('ton-sheet-equiv');
    const levelWarn = document.getElementById('ton-level-warn');
    const ptsWarn   = document.getElementById('ton-pts-warn');
    const currLvlEl = document.getElementById('ton-current-level');
    const submitBtn = document.getElementById('ton-submit-btn');
    const input     = document.getElementById('ton-address-input');
    const errEl     = document.getElementById('ton-error-msg');

    if (!overlay) return;
    input.value = '';
    if (errEl) errEl.style.display = 'none';

    ptsEl.textContent   = APP_STATE.balance.toLocaleString();
    equivEl.textContent = '≈ ' + (APP_STATE.balance / TON_CONFIG.ptsPerTon).toFixed(3) + ' TON';

    const isFirst  = TON_CONFIG.isFirstWithdraw;
    const hasLevel = isFirst ? true : APP_STATE.level >= TON_CONFIG.minLevel;
    const hasPts   = APP_STATE.balance >= TON_CONFIG.minPts;

    if (levelWarn) levelWarn.style.display = 'none';
    if (ptsWarn)   ptsWarn.style.display   = 'none';

    const minChipVal = document.getElementById('ton-min-chip-val');
    if (minChipVal) { minChipVal.textContent = TON_CONFIG.minPts.toLocaleString() + ' نقطة'; minChipVal.style.color = isFirst ? 'var(--green)' : 'var(--gold)'; }

    const firstOfferEl = document.getElementById('first-withdraw-offer');
    if (firstOfferEl) firstOfferEl.style.display = isFirst ? 'flex' : 'none';

    const minPtsEl = document.getElementById('ton-min-pts');
    if (minPtsEl) minPtsEl.textContent = TON_CONFIG.minPts.toLocaleString();
    const ptsWarnMin = document.getElementById('ton-pts-warn-min');
    if (ptsWarnMin) ptsWarnMin.textContent = TON_CONFIG.minPts.toLocaleString();

    if (!hasLevel) {
        if (levelWarn) levelWarn.style.display = '';
        if (currLvlEl) currLvlEl.textContent = APP_STATE.level;
        if (submitBtn) submitBtn.disabled = true;
    } else if (!hasPts) {
        if (ptsWarn) ptsWarn.style.display = '';
        if (submitBtn) submitBtn.disabled = true;
    } else {
        if (submitBtn) submitBtn.disabled = false;
    }

    overlay.classList.add('visible');
}

function closeTonWithdraw() { document.getElementById('ton-withdraw-overlay')?.classList.remove('visible'); }

function handleTonOverlayClick(e) { if (e.target === document.getElementById('ton-withdraw-overlay')) closeTonWithdraw(); }

function clearTonError() {
    const errEl = document.getElementById('ton-error-msg');
    if (errEl) errEl.style.display = 'none';
    const input = document.getElementById('ton-address-input');
    if (input) input.style.borderColor = 'rgba(83,147,255,0.3)';
}

function isValidTonAddress(addr) {
    addr = addr.trim();
    return (addr.startsWith('EQ') || addr.startsWith('UQ') || addr.startsWith('0:')) && addr.length >= 48;
}

async function submitTonWithdraw() {
    const input     = document.getElementById('ton-address-input');
    const addr      = input.value.trim();
    const errEl     = document.getElementById('ton-error-msg');
    const submitBtn = document.getElementById('ton-submit-btn');

    if (!isValidTonAddress(addr)) {
        if (errEl)  errEl.style.display = 'block';
        if (input) input.style.borderColor = 'rgba(248,113,113,0.5)';
        return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ جاري الإرسال...'; }

    const result = await fetchApi({ type: 'submit_withdraw', data: { address: addr } });

    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'إرسال طلب السحب'; }

    if (!result.ok) {
        const msg = result.error === 'insufficient_balance' ? 'رصيدك غير كافٍ'
                  : result.error === 'level_too_low'        ? `يتطلب المستوى ${result.required_level || 5} للسحب`
                  : 'حدث خطأ، حاول مجدداً';
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        return;
    }

    if (result.new_balance !== undefined) {
        animateBalance(APP_STATE.balance, result.new_balance);
        APP_STATE.balance = result.new_balance;
        _refreshWithdrawPageUI();
    }

    if (result.first_withdraw === true) {
        APP_STATE.first_withdraw_done = true;
        const minChipVal = document.getElementById('ton-min-chip-val');
        if (minChipVal) { minChipVal.textContent = (APP_CONFIG.withdraw.normal_min || 20000).toLocaleString() + ' نقطة'; minChipVal.style.color = 'var(--gold)'; }
    }

    WITHDRAW_HISTORY.push({ pts: result.pts_deducted || APP_STATE.balance, address: addr, ts: Date.now(), status: result.status || 'pending' });
    addNotification('ton', 'تم استلام طلب السحب', `${WITHDRAW_HISTORY[WITHDRAW_HISTORY.length - 1].pts.toLocaleString()} نقطة ≈ ${(result.ton_amount || WITHDRAW_HISTORY[WITHDRAW_HISTORY.length - 1].pts / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(3)} TON`, Date.now());
    renderWithdrawHistory();
    closeTonWithdraw();
    showToast('trophy', 'تم إرسال طلب السحب! 🎉', 'سيتم معالجة طلبك قريباً', 'green', '✓');
}

// ── Daily Gift ────────────────────────────────────────────────────
const GIFT_DAYS_FALLBACK = [
    { day: 'اليوم الأول',   desc: 'مبروك! بداية رائعة معنا.\nاستمر يومياً لتضاعف مكافآتك!', pts: 100 },
    { day: 'اليوم الثاني',  desc: 'يومان متتاليان!\nالمثابرة هي مفتاح النجاح.', pts: 150 },
    { day: 'اليوم الثالث',  desc: 'ثلاثة أيام متتالية!\nمكافأة خاصة بانتظارك.', pts: 200 },
    { day: 'اليوم الرابع',  desc: 'أسبوعك يقترب!\nاستمر في التحدي.', pts: 250 },
    { day: 'اليوم الخامس',  desc: 'خمسة أيام!\nأنت من الملتزمين الحقيقيين.', pts: 300 },
    { day: 'اليوم السادس',  desc: 'يوم واحد ويكتمل أسبوعك!\nلا تتوقف.', pts: 400 },
    { day: 'اليوم السابع',  desc: 'أسبوع كامل!\nمكافأة ضخمة بانتظارك.', pts: 750 },
];

function _getGiftDayData(day) {
    const idx = Math.max(0, day - 1);
    const sv  = APP_CONFIG?.daily_gift || {};
    const pts   = (sv.rewards    && sv.rewards[idx]   != null) ? sv.rewards[idx]   : (GIFT_DAYS_FALLBACK[Math.min(idx, GIFT_DAYS_FALLBACK.length - 1)]?.pts  || 100);
    const dayT  = (sv.titles_ar  && sv.titles_ar[idx])          || GIFT_DAYS_FALLBACK[Math.min(idx, GIFT_DAYS_FALLBACK.length - 1)]?.day  || ('اليوم ' + day);
    const desc  = (sv.descs_ar   && sv.descs_ar[idx])           || GIFT_DAYS_FALLBACK[Math.min(idx, GIFT_DAYS_FALLBACK.length - 1)]?.desc || '';
    return { day: dayT, desc, amount: '+' + pts, pts };
}

function openDailyGiftOverlay() {
    if (APP_STATE.gift.isOpening) return;
    APP_STATE.gift.isOpening = true;

    const day   = APP_STATE.gift.dayNumber;
    const data  = _getGiftDayData(day);
    const overlay = document.getElementById('daily-gift-overlay');
    if (!overlay) { APP_STATE.gift.isOpening = false; return; }

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
        for (let i = 1; i <= 7; i++) {
            const dot = document.createElement('div');
            dot.style.cssText = `width:${i === day ? '22px' : '8px'};height:8px;border-radius:4px;background:${i < day ? 'rgba(251,191,36,0.75)' : i === day ? '#fbbf24' : 'rgba(255,255,255,0.1)'};box-shadow:${i <= day ? '0 0 6px rgba(251,191,36,0.4)' : 'none'};`;
            dotsEl.appendChild(dot);
        }
    }

    if (btn)   btn.style.display   = 'none';
    if (label) label.style.display = 'block';

    if (ringIcon) ringIcon.innerHTML = `<path d="M20 12v10H4V12" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 7H2v5h20V7z" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 22V7" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;

    overlay.style.opacity      = '1';
    overlay.style.pointerEvents = 'all';

    if (APP_STATE.gift.claimed) {
        const t2 = TRANSLATIONS[currentLang];
        if (label) { label.textContent = t2.gift_already_claimed || 'تم استلام هديتك اليوم ✓'; label.style.color = '#34d399'; label.style.fontSize = '14px'; label.style.fontWeight = '700'; }
        APP_STATE.gift.isOpening = false;
        setTimeout(() => closeDailyGiftOverlay(), 2200);
        return;
    }

    let sec = 3;
    const tg = TRANSLATIONS[currentLang];
    if (label) label.textContent = tg.gift_preparing || 'جاري تحضير هديتك...';

    const timer = setInterval(() => {
        sec--;
        if (sec > 0) {
            if (label) label.textContent = tg.gift_preparing || 'جاري تحضير هديتك...';
        } else {
            clearInterval(timer);
            if (label) label.style.display = 'none';
            if (btn) {
                btn.style.display   = 'block';
                btn.style.transform = 'scale(0.8)';
                btn.style.opacity   = '0';
                requestAnimationFrame(() => { requestAnimationFrame(() => {
                    btn.style.transition = 'all 0.4s cubic-bezier(0.34,1.56,0.64,1)';
                    btn.style.transform  = 'scale(1)';
                    btn.style.opacity    = '1';
                }); });
            }
            APP_STATE.gift.isOpening = false;
        }
    }, 1000);
}

function closeDailyGiftOverlay() {
    const overlay = document.getElementById('daily-gift-overlay');
    if (overlay) { overlay.style.opacity = '0'; overlay.style.pointerEvents = 'none'; }
    APP_STATE.gift.isOpening = false;
}

function openDailyGift()  { openDailyGiftOverlay(); }
function closeDailyGift() { closeDailyGiftOverlay(); }

async function claimGift() {
    if (APP_STATE.gift.claimed) return;
    APP_STATE.gift.claimed = true;

    const result = await fetchApi({ type: 'claim_gift', data: {} });
    if (!result.ok) { APP_STATE.gift.claimed = false; console.warn('[Gift] Backend rejected:', result.error); return; }

    if (result.streak_day)         APP_STATE.gift.dayNumber = result.streak_day;
    if (result.points !== undefined) {
        animateBalance(APP_STATE.balance, result.points);
        APP_STATE.balance = result.points;
    }

    const ringIcon = document.getElementById('gift-ring-icon');
    if (ringIcon) ringIcon.innerHTML = `<path d="M20 6L9 17l-5-5" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

    const btn = document.getElementById('gift-claim-btn');
    const tc  = TRANSLATIONS[currentLang];
    if (btn) { btn.textContent = tc.gift_claimed || 'تم الاستلام ✓'; btn.style.background = 'rgba(52,211,153,0.15)'; btn.style.color = '#34d399'; btn.style.border = '1px solid rgba(52,211,153,0.28)'; btn.style.cursor = 'default'; btn.onclick = null; }

    const reward = result.reward || 0;
    showToast('trophy', tc.toast_gift_title || 'تم استلام هديتك!', `+${reward} ${tc.pts || 'نقطة'}`, 'green', `+${reward}`);
    setTimeout(() => closeDailyGiftOverlay(), 1600);
}

// ── Channel tasks ─────────────────────────────────────────────────
const _channelJoined = {};

function renderChannels(channels) {
    const wrap = document.getElementById('channel-tasks-wrap');
    if (!wrap) return;
    if (!channels || !channels.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = channels.map(ch => {
        const isDone = !!ch.verified, id = ch.id;
        const membersText = ch.max_members > 0 ? `<span style="font-size:10px;color:rgba(37,178,248,0.5);font-weight:500;">أقصى ${ch.max_members.toLocaleString()} عضو</span>` : '';
        return `<div class="glass" style="border-radius:var(--radius-xl);overflow:hidden;${isDone ? 'border:1px solid rgba(52,211,153,0.2)!important;' : ''}">
            <div id="ch-card-${id}" style="display:flex;align-items:center;gap:14px;padding:16px 18px;position:relative;transition:background 0.2s ease;">
                ${isDone ? '<div style="position:absolute;inset:0;background:rgba(52,211,153,0.04);pointer-events:none;"></div>' : ''}
                <div style="width:46px;height:46px;border-radius:14px;background:rgba(37,178,248,0.1);border:1px solid rgba(37,178,248,0.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(37,178,248,0.12)" stroke="rgba(37,178,248,0.5)" stroke-width="1.2"/><path d="M17.5 7.5L15 16.5l-3-3-2 2-1-4-3-1 8.5-3.5z" fill="#29b6f6"/><path d="M12 13.5l-2 2-1-4 3 2z" fill="rgba(255,255,255,0.4)"/></svg>
                </div>
                <div style="flex:1;min-width:0;">
                    <div style="font-family:'Tajawal',sans-serif;font-size:14px;font-weight:800;color:rgba(255,255,255,0.92);margin-bottom:4px;">${ch.title}</div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <div style="display:flex;align-items:center;gap:5px;">
                            <img src="asesst/coins.png" alt="" style="width:11px;height:11px;object-fit:contain;filter:drop-shadow(0 0 3px rgba(251,191,36,0.7));">
                            <span style="font-family:'Readex Pro',sans-serif;font-size:11px;font-weight:600;color:rgba(251,191,36,0.75);">+${(ch.reward || 2500).toLocaleString()} نقطة</span>
                        </div>${membersText}
                    </div>
                </div>
                <div id="ch-action-${id}" style="flex-shrink:0;">
                    ${isDone
                        ? `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg><span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span></div>`
                        : `<button id="ch-join-btn-${id}" onclick="handleChannelJoin(${id}, '${ch.url}')" style="display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:12px;border:1px solid rgba(37,178,248,0.45);background:linear-gradient(135deg,rgba(37,178,248,0.22),rgba(37,178,248,0.08));color:#fff;font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(41,182,246,0.2)" stroke="rgba(41,182,246,0.8)" stroke-width="1.4"/><path d="M17.5 7.5L15 16.5l-3-3-2 2-1-4-3-1 8.5-3.5z" fill="#fff"/></svg>انضم</button>
                           <button id="ch-verify-btn-${id}" onclick="verifyChannelTask(${id})" style="display:none;align-items:center;gap:7px;padding:10px 16px;border-radius:12px;border:1px solid rgba(52,211,153,0.38);background:rgba(52,211,153,0.1);color:#34d399;font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>تحقق</button>`
                    }
                </div>
            </div>
            ${!isDone ? `<div id="ch-hint-${id}" style="display:none;margin:0 18px 14px;padding:9px 13px;border-radius:10px;background:rgba(37,178,248,0.05);border:1px solid rgba(37,178,248,0.13);"><div style="display:flex;align-items:center;gap:7px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(37,178,248,0.65)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><span style="font-size:11px;color:rgba(37,178,248,0.65);font-weight:600;font-family:'Readex Pro',sans-serif;">اضغط «تحقق» بعد الانضمام للقناة</span></div></div>` : ''}
        </div>`;
    }).join('');
}

function handleChannelJoin(channelId, url) {
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url, '_blank');
    _channelJoined[channelId] = true;
    const joinBtn   = document.getElementById('ch-join-btn-'    + channelId);
    const verifyBtn = document.getElementById('ch-verify-btn-'  + channelId);
    const hint      = document.getElementById('ch-hint-'        + channelId);
    if (joinBtn)   joinBtn.style.display   = 'none';
    if (verifyBtn) verifyBtn.style.display = 'inline-flex';
    if (hint)      hint.style.display      = 'block';
}

async function verifyChannelTask(channelId) {
    const verifyBtn = document.getElementById('ch-verify-btn-' + channelId);
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.style.opacity = '0.6'; }
    const result = await fetchApi({ type: 'verify_channel_task', data: { channel_id: channelId } });
    if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.style.opacity = '1'; }

    if (!result.ok) {
        if (result.error === 'not_in_channel') {
            showToast('coin', 'لم تنضم للقناة بعد ❌', 'اضغط «انضم» أولاً ثم حاول مجدداً', 'red', '!');
            const joinBtn = document.getElementById('ch-join-btn-' + channelId);
            if (joinBtn) joinBtn.style.display = 'inline-flex';
            if (verifyBtn) verifyBtn.style.display = 'none';
        } else if (result.error === 'already_verified') {
            showToast('coin', 'تم التحقق مسبقاً ✓', '', 'green', '✓');
            _markChannelDone(channelId);
        } else if (result.error === 'account_review') {
            showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        } else {
            showToast('coin', 'تأكد من انضمامك للقناة ثم أعد المحاولة', '', 'gold', '!');
        }
        return;
    }
    if (result.points !== undefined) { animateBalance(APP_STATE.balance, result.points); APP_STATE.balance = result.points; }
    const reward = result.reward || 2500;
    showToast('trophy', 'انضممت للقناة! 🎉', `+${reward.toLocaleString()} نقطة أضيفت لرصيدك`, 'gold', `+${reward}`);
    _markChannelDone(channelId);
}

function _markChannelDone(channelId) {
    const action = document.getElementById('ch-action-' + channelId);
    const hint   = document.getElementById('ch-hint-'   + channelId);
    const card   = document.getElementById('ch-card-'   + channelId);
    if (hint)   hint.style.display = 'none';
    if (action) action.innerHTML = `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg><span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span></div>`;
    if (card)   card.style.background = 'rgba(52,211,153,0.04)';
}

async function _loadChannels() {
    const result  = await fetchApi({ type: 'get_channels', data: {} });
    const loading = document.getElementById('channel-tasks-loading');
    if (loading) loading.remove();
    if (result.ok && Array.isArray(result.channels)) renderChannels(result.channels);
}

// ── TG Task ───────────────────────────────────────────────────────
function handleTelegramTask() {
    if (APP_STATE.tasks.tgVerified) return;
    const channelUrl = APP_CONFIG.telegram.channel_url || 'https://t.me/botbababab';
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(channelUrl);
    else window.open(channelUrl, '_blank');
    APP_STATE.tasks.tgJoined = true;
    const joinBtn    = document.getElementById('tg-join-btn');
    const verifyBtn  = document.getElementById('tg-verify-btn-compact');
    const verifyHint = document.getElementById('tg-verify-hint');
    if (joinBtn)    joinBtn.style.display    = 'none';
    if (verifyBtn)  { verifyBtn.style.display = 'inline-flex'; verifyBtn.style.animation = 'pageIn 0.3s ease both'; }
    if (verifyHint) verifyHint.style.display = 'block';
}

async function verifyTelegramTask() {
    if (APP_STATE.tasks.tgVerified) return;
    const verifyBtn = document.getElementById('tg-verify-btn-compact');
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.style.opacity = '0.6'; }
    const result = await fetchApi({ type: 'verify_tg_task', data: {} });
    if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.style.opacity = '1'; }

    if (!result.ok) {
        if (result.error === 'account_review')    showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        else if (result.error === 'not_in_channel') {
            showToast('coin', 'لم تنضم للقناة بعد ❌', 'اضغط «انضم» أولاً ثم حاول مجدداً', 'red', '!');
            const joinBtn = document.getElementById('tg-join-btn');
            if (joinBtn)   joinBtn.style.display   = 'inline-flex';
            if (verifyBtn) verifyBtn.style.display = 'none';
        } else if (result.error === 'already_verified') {
            showToast('coin', 'تم التحقق مسبقاً ✓', '', 'green', '✓');
        } else {
            showToast('coin', 'لم يتم التحقق بعد', 'تأكد من انضمامك للقناة ثم حاول مجدداً', 'gold', '!');
        }
        return;
    }

    if (result.points !== undefined) { animateBalance(APP_STATE.balance, result.points); APP_STATE.balance = result.points; }
    APP_STATE.tasks.tgVerified = true;

    ['tg-verify-btn-compact', 'tg-verify-hint'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    const actionWrap  = document.getElementById('tg-action-wrap');
    const doneState   = document.getElementById('tg-done-state');
    const doneOverlay = document.getElementById('tg-done-overlay');
    const card        = document.getElementById('tg-task-card');
    if (actionWrap) actionWrap.style.display = 'none';
    if (doneState)  { doneState.style.display = 'block'; doneState.style.animation = 'pageIn 0.4s cubic-bezier(0.22,1,0.36,1) both'; }
    if (doneOverlay) doneOverlay.style.display = 'block';
    if (card)        card.classList.add('completed');

    const reward = parseInt(result.reward) || APP_CONFIG.rewards.telegram_task || 200;
    showToast('trophy', 'انضممت للقناة! 🎉', `+${reward.toLocaleString('ar-EG')} نقطة أضيفت لرصيدك`, 'gold', `+${reward}`);
}

// ── Invite / Referral ─────────────────────────────────────────────
function copyReferralLink() {
    const btn = document.getElementById('copy-btn');
    navigator.clipboard.writeText(REFERRAL_LINK).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = REFERRAL_LINK; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    });
    btn.classList.add('copied');
    const t = TRANSLATIONS[currentLang];
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>${t.copy_btn_done || 'تم النسخ!'}`;
    showToast('trophy', t.toast_copy_title || 'تم نسخ الرابط ✓', t.toast_copy_desc || 'شارك رابطك مع أصدقائك', 'green', '🔗');
    setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/></svg>${t.copy_btn_default || t.copy_link}`;
    }, 2500);
}

function shareTelegram() {
    const text = encodeURIComponent('انضم معي في تطبيق الربح العربي واربح نقاط مجانية! 🎁\n' + REFERRAL_LINK);
    window.open('https://t.me/share/url?url=' + encodeURIComponent(REFERRAL_LINK) + '&text=' + text, '_blank');
}

function shareWhatsApp() {
    const text = encodeURIComponent('انضم معي في تطبيق الربح العربي واربح نقاط مجانية! 🎁\n' + REFERRAL_LINK);
    window.open('https://wa.me/?text=' + text, '_blank');
}
