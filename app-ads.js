// ══════════════════════════════════════════════════════════
// app-ads.js — Daily Ads · Tasks · Channels · Init
// ══════════════════════════════════════════════════════════

import {
    APP_STATE, APP_CONFIG, _SERVER_CONFIG as _SC,
    WITHDRAW_HISTORY as _WH,
    fetchApi, _dbCall, createSession,
    initTelegramUser, _applyConfigToUI,
    REFERRAL_LINK, BOT_USERNAME,
    _updateReferralLinkUI,
} from './app-core.js';

import {
    showToast, pushNotif, animateBalance, updateBalanceUI,
    runCounters, showPage, _hideLoadingScreen,
    renderReferralList, renderWithdrawHistory, _timeAgo,
} from './app-ui.js';

const _AS = APP_STATE;
const _AC = APP_CONFIG;

// ══════════════════════════════════════════════════════════
// AD CONTROLLER (daily ads only)
// ══════════════════════════════════════════════════════════
const AD_BLOCK_ID    = '30161';
const AD_MAX_RETRIES = 2;
const AD_MIN_MS      = 7000;
const AD_PRELOAD     = 1;

let _adController    = null;
let _adStartedAt     = 0;
let _adRetryCount    = 0;
let _isClaimingAd    = false;   // ← guard ضد double-claim

// ══════════════════════════════════════════════════════════
// AD SESSION MANAGER — جودة ذكية + توقيتات تصاعدية طبيعية
// ══════════════════════════════════════════════════════════
const _AD_SESSION = {
    consecutiveCount:  0,
    lastAdCompletedAt: 0,

    // عتبات المكافأة (ms)
    BASIC_MS: 30000,   // 30–31s → مكافأة أساسية
    FULL_MS:  32000,   // 32s+   → مكافأة كاملة

    // cooldown تصاعدي: 1→60s · 2→90s · 3+→120s
    _steps: [60000, 90000, 120000],

    // Jitter طبيعي — يمنع التوقيتات المتطابقة دائماً (1200–4000ms)
    _jitter() { return 1200 + Math.floor(Math.random() * 2800); },

    getCooldown() {
        const idx = Math.min(this.consecutiveCount, this._steps.length - 1);
        return this._steps[idx] + this._jitter();
    },

    getQuality(ms) {
        if (ms >= this.FULL_MS)  return 'full';
        if (ms >= this.BASIC_MS) return 'basic';
        return 'incomplete';
    },

    // إعادة الإحصاء إذا أخذ المستخدم استراحة أكثر من 5 دقائق
    checkStreak() {
        if (this.lastAdCompletedAt && Date.now() - this.lastAdCompletedAt > 300000)
            this.consecutiveCount = 0;
    },

    markComplete() {
        this.lastAdCompletedAt = Date.now();
        if (this.consecutiveCount < this._steps.length - 1) this.consecutiveCount++;
    },
};

// ══════════════════════════════════════════════════════════
// PLAY REMINDER — تذكير وسط الشاشة · ≥ 4 ثوانٍ
// ══════════════════════════════════════════════════════════
let _playReminderInjected = false;

function _injectPlayReminder() {
    if (_playReminderInjected || document.getElementById('play-reminder-overlay')) return;
    _playReminderInjected = true;
    const el = document.createElement('div');
    el.id = 'play-reminder-overlay';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
        <div class="plr-card">
            <div class="plr-pulse"></div>
            <div class="plr-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10"
                        fill="rgba(251,191,36,.12)"
                        stroke="rgba(251,191,36,.55)" stroke-width="1.5"/>
                    <path d="M9.5 7.5l7 4.5-7 4.5V7.5z" fill="#fbbf24"/>
                </svg>
            </div>
            <div class="plr-title">للحصول على <span class="plr-gold">كامل الجائزة</span></div>
            <div class="plr-body">اضغط <strong>▶ تشغيل</strong> وتفاعل مع الإعلان</div>
        </div>`;
    document.body.appendChild(el);
}

function _showPlayReminder() {
    _injectPlayReminder();
    return new Promise(resolve => {
        const ov = document.getElementById('play-reminder-overlay');
        if (!ov) { resolve(); return; }
        ov.classList.add('plr-visible');
        // مدة عرض ≥ 4 ثوانٍ كما هو مطلوب، ثم يختفي تلقائياً
        setTimeout(() => {
            ov.classList.remove('plr-visible');
            setTimeout(resolve, 380); // انتظر نهاية الـ transition
        }, 4300);
    });
}

function _initAdController() {
    if (!window.Adsgram||_adController) return _adController;
    try { _adController = window.Adsgram.init({ blockId:AD_BLOCK_ID, debug:false, debugBanners:false }); }
    catch(_) { _adController=null; }
    return _adController;
}

// ══════════════════════════════════════════════════════════
// updateAdUI — يحدث واجهة الإعلانات اليومية فقط
// ══════════════════════════════════════════════════════════
// نسخة داخلية لا تتدخل بالزر إذا عنده عدّاد تنازلي
function _updateAdUINoBtn() {
    const ads = _AS.ads;
    const r   = ads.remaining;
    const setText = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    setText('ads-remaining', r);
    setText('ads-watched',   ads.watched);
    setText('earned-today',  ads.earned.toLocaleString('en-US'));
    setText('ads-daily-limit', ads.total);
    const progBar = document.getElementById('ads-progress');
    if (progBar) progBar.style.width = (ads.total>0 ? Math.min(100,(ads.watched/ads.total)*100) : 0)+'%';
    const quotaTotal = document.querySelector('.ad-quota-total');
    if (quotaTotal) quotaTotal.textContent='/ '+ads.total;
    const doneEl = document.getElementById('ad-done-state');
    const btn    = document.getElementById('ad-watch-btn');
    if (r===0) { if(btn) btn.style.display='none'; if(doneEl) doneEl.style.display='flex'; }
    else       { if(btn) btn.style.display='';     if(doneEl) doneEl.style.display='none'; }
    _syncDailyTaskProgress();
    const _earnRingFill = document.getElementById('earn-ring-fill');
    if (_earnRingFill) {
        const _EARN_CIRC = 263.89;
        const _total = ads.total || 10;
        const _pct   = _total > 0 ? r / _total : 0;
        _earnRingFill.style.strokeDashoffset = _EARN_CIRC * (1 - _pct);
    }
}

export function updateAdUI() {
    const ads = _AS.ads;
    const r   = ads.remaining;

    const setText = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    setText('ads-remaining', r);
    setText('ads-watched',   ads.watched);
    setText('earned-today',  ads.earned.toLocaleString('en-US'));
    setText('ads-daily-limit', ads.total);

    // progress — يعتمد على watched مش remaining (منع التناقص)
    const progBar = document.getElementById('ads-progress');
    if (progBar) progBar.style.width = (ads.total>0 ? Math.min(100,(ads.watched/ads.total)*100) : 0)+'%';

    const quotaTotal = document.querySelector('.ad-quota-total');
    if (quotaTotal) quotaTotal.textContent='/ '+ads.total;

    // cooldown مستقل
    const coolLeft = ads.cooldownUntil - Date.now();
    const btn      = document.getElementById('ad-watch-btn');
    const coolEl   = document.getElementById('ad-cooldown-msg');
    if (coolEl) coolEl.style.display='none';

    // إذا عنده عدّاد تنازلي داخلي — لا تتدخل بالزر
    if (!ads._btnCooldownActive) {
        if (coolLeft>0 && r>0) {
            if (btn) btn.classList.add('disabled');
        } else {
            if (r>0 && btn) btn.classList.remove('disabled');
        }
    }

    const doneEl = document.getElementById('ad-done-state');
    if (r===0) { if(btn) btn.style.display='none'; if(doneEl) doneEl.style.display='flex'; }
    else       { if(btn && !ads._btnCooldownActive) btn.style.display=''; if(doneEl) doneEl.style.display='none'; }

    _syncDailyTaskProgress();

    // ── Sync earn ring SVG ──
    const _earnRingFill = document.getElementById('earn-ring-fill');
    if (_earnRingFill) {
        const _EARN_CIRC = 263.89; // 2π×42
        const _total = ads.total || 10;
        const _pct   = _total > 0 ? r / _total : 0;
        _earnRingFill.style.strokeDashoffset = _EARN_CIRC * (1 - _pct);
    }
}

// ══════════════════════════════════════════════════════════
// SHOW AD (Adsgram SDK)
// ══════════════════════════════════════════════════════════
function _showAd() {
    return new Promise(async resolve => {
        const controller = _initAdController();
        if (!controller) { resolve(false); return; }

        await fetchApi({ type:'track_ad_event', data:{ event:'ad_requested', ad_type:'daily_ad', meta:{ block_id:AD_BLOCK_ID } } });
        _adStartedAt = Date.now();

        try {
            const result = await controller.show();
            if (result?.done===true) {
                const elapsed = Date.now()-_adStartedAt;
                if (elapsed<AD_MIN_MS) { resolve(false); return; }
                _adRetryCount=0;
                resolve(true);
            } else { resolve(false); }
        } catch(result) {
            if (result?.error===true && _adRetryCount<AD_MAX_RETRIES) {
                _adRetryCount++;
                _adController=null;
                setTimeout(()=>resolve(_showAd()), 1500);
                return;
            }
            _adRetryCount=0;
            resolve(false);
        }
    });
}

// ══════════════════════════════════════════════════════════
// watchAd — الزر الرئيسي للإعلانات اليومية
// ══════════════════════════════════════════════════════════
export async function watchAd() {
    const ads = _AS.ads;
    if (ads.remaining<=0||ads.isWatching||_isClaimingAd) return;
    if (ads.cooldownUntil&&Date.now()<ads.cooldownUntil) {
        showToast('coin','انتظر قليلاً',`${Math.ceil((ads.cooldownUntil-Date.now())/1000)} ثانية`,'red','');
        return;
    }

    ads.isWatching=true;
    const btn      = document.getElementById('ad-watch-btn');
    const overlay  = document.getElementById('ad-watch-overlay');
    const countEl  = document.getElementById('overlay-count');
    const labelEl  = document.getElementById('overlay-label');
    const preBar   = document.getElementById('ad-preload-bar');
    if (btn) btn.classList.add('disabled');

    // ── تذكير اضغط ▶ — وسط الشاشة ≥ 4 ثوانٍ قبل تحميل الإعلان ──
    _AD_SESSION.checkStreak();
    await _showPlayReminder();
    // ─────────────────────────────────────────────────────────────

    // SDK check
    if (!window.Adsgram||window._adsgramLoadStatus!=='loaded') {
        if (window._adsgramLoadStatus==='failed') {
            ads.isWatching=false; if(btn) btn.classList.remove('disabled');
            showToast('coin','تعذّر تحميل الإعلان','تحقق من اتصالك','red','');
            return;
        }
        if (overlay) { if(countEl) countEl.innerHTML='<img src="asesst/loading.gif" style="width:40px;height:40px;object-fit:contain;border-radius:8px;">'; overlay.classList.add('visible'); }
        const loaded = await new Promise(res=>{
            const t=setTimeout(()=>res(false),8000);
            const cb=s=>{ clearTimeout(t); res(s!=='failed'); };
            if (typeof window.onAdsgramLoaded==='function') window.onAdsgramLoaded(cb);
            else res(false);
        });
        if (overlay) overlay.classList.remove('visible');
        if (!loaded) {
            ads.isWatching=false; if(btn) btn.classList.remove('disabled');
            showToast('coin','تعذّر تحميل الإعلان','تحقق من اتصالك','red','');
            return;
        }
    }

    let successCount=0;
    for (let i=0;i<AD_PRELOAD;i++) {
        if (overlay) { if(countEl) countEl.textContent=`${i+1}/${AD_PRELOAD}`; if(labelEl) labelEl.textContent='جاري تحميل الإعلان...'; overlay.classList.add('visible'); }
        if (preBar) { preBar.style.width=(i/AD_PRELOAD*100)+'%'; preBar.style.background='linear-gradient(90deg,#f59e0b,#fbbf24)'; }
        await new Promise(r=>setTimeout(r,600));
        if (overlay) overlay.classList.remove('visible');

        const done = await _showAd();
        if (!done) {
            ads.isWatching=false; if(btn) btn.classList.remove('disabled');
            if (preBar) preBar.style.width='0%';
            showToast('coin','الإعلان لم يكتمل','شاهد الإعلان حتى النهاية','red','');
            return;
        }
        successCount++;

        if (i<AD_PRELOAD-1) {
            let rem=6;
            if (overlay) overlay.classList.add('visible');
            await new Promise(resolve=>{
                const tick=setInterval(()=>{
                    rem--;
                    if(countEl) countEl.textContent=`${rem}s`;
                    if(labelEl) labelEl.textContent=`إعلان ${successCount} ✓ — التالي بعد ${rem}s`;
                    if(rem<=0){ clearInterval(tick); if(overlay) overlay.classList.remove('visible'); resolve(); }
                },1000);
            });
        }
    }
    if (preBar) { preBar.style.width='100%'; preBar.style.background='linear-gradient(90deg,#34d399,#10b981)'; }

    // [1] start_ad → نحصل على nonce من السيرفر
    _isClaimingAd = true;
    const startRes = await _dbCall('start_ad', {});
    if (!startRes.ok) {
        ads.isWatching=false; if(btn) btn.classList.remove('disabled');
        _isClaimingAd = false;
        if (preBar) preBar.style.width='0%';
        if (startRes.error==='daily_limit_reached') { ads.remaining=0; updateAdUI(); }
        else if (startRes.error==='cooldown_active') { ads.cooldownUntil=Date.now()+(startRes.wait_ms||30000); updateAdUI(); }
        else showToast('coin','خطأ في المعالجة','حاول مرة أخرى','red','');
        return;
    }

    const adNonce = startRes.ad_nonce;
    if (!adNonce) {
        ads.isWatching=false; if(btn) btn.classList.remove('disabled');
        _isClaimingAd = false;
        if (preBar) preBar.style.width='0%';
        showToast('coin','خطأ في المعالجة','حاول مرة أخرى','red','');
        return;
    }

    // [2] reward_ad — نونس يُرسَل مرة وحدة كـ external nonce
    const result = await _dbCall('reward_ad',
        { ad_started_at: _adStartedAt, preload_count: successCount },
        adNonce  // ← external nonce من start_ad
    );

    ads.isWatching=false;
    _isClaimingAd = false;
    if (preBar) preBar.style.width='0%';

    if (result.ok) {
        ads.remaining    = result.remaining;
        ads.watched      = result.watchedToday;
        ads.earned       = result.earnedToday;
        if (result.points!==undefined) { animateBalance(_AS.balance,result.points,1200); _AS.balance=result.points; }

        const pts = _AC.rewards?.points_per_ad||50;

        // فيبريشن صريح
        try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch(e){}
        try { if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]); } catch(e){}

        // ── تحديد جودة الجلسة للإشعار ──
        const _sessionElapsed = Date.now() - _adStartedAt;
        const _sessionQuality = _AD_SESSION.getQuality(_sessionElapsed);
        const _qualityLabel   = _sessionQuality === 'full'
            ? `شاهدت ${result.watchedToday} إعلان · جائزة كاملة ✨`
            : `شاهدت ${result.watchedToday} إعلان اليوم`;

        showToast('trophy',`تم إضافة +${pts} نقطة 🎉`, _qualityLabel,'green',`+${pts}`);
        pushNotif('gold',`مكافأة إعلان #${result.watchedToday}`,`+${pts} نقطة أُضيفت لرصيدك`);

        // ── cooldown تصاعدي ذكي بدلاً من الثابت ──
        _AD_SESSION.markComplete();
        const cdMs = _AD_SESSION.getCooldown();
        ads.cooldownUntil= Date.now()+cdMs;
            // أوقف أي عدّاد قديم
            if (ads._cooldownTimer) { clearInterval(ads._cooldownTimer); ads._cooldownTimer = null; }
            btn.classList.add('disabled');
            let remSec = Math.ceil(cdMs / 1000);
            ads._btnCooldownActive = true;
            btn.innerHTML = `<div class="btn-shimmer"></div>`
                + `<div id="ad-btn-countdown" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;font-family:'DynaPuff',sans-serif;font-size:26px;font-weight:900;color:#fbbf24;letter-spacing:2px;text-shadow:0 0 14px rgba(251,191,36,0.6);"><img src="asesst/loading.gif" alt="" style="width:22px;height:22px;opacity:0.85;">${remSec}s</div>`;
            ads._cooldownTimer = setInterval(() => {
                remSec--;
                const lbl = document.getElementById('ad-btn-countdown');
                if (lbl) lbl.innerHTML = `<img src="asesst/loading.gif" alt="" style="width:22px;height:22px;opacity:0.85;">${remSec}s`;
                if (remSec <= 0) {
                    clearInterval(ads._cooldownTimer); ads._cooldownTimer = null;
                    ads._btnCooldownActive = false;
                    btn.innerHTML = `<div class="btn-shimmer"></div>`
                        + `<div class="earn-cta-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 4l14 8-14 8V4z" fill="#fbbf24" opacity=".9"/></svg></div>`
                        + `<div class="earn-cta-lbl" data-i18n="watch_ad">شاهد إعلاناً</div>`
                        + `<div class="earn-cta-reward"><div class="earn-cta-rnum">+${pts}</div><div class="earn-cta-rsub" data-i18n="pts">نقطة</div></div>`;
                    btn.classList.remove('disabled');
                }
            }, 1000);
        } else if (btn) {
            btn.classList.remove('disabled');
        }

        // updateAdUI بدون تدخّل بالزر إذا عنده عدّاد
        _updateAdUINoBtn();

    } else {
        if (btn) btn.classList.remove('disabled');
        if (result.error==='cooldown_active') { ads.cooldownUntil=Date.now()+(result.wait_ms||30000); updateAdUI(); }
        else if (result.error==='daily_limit_reached') { ads.remaining=0; updateAdUI(); showToast('trophy','انتهت إعلانات اليوم 🏆','عُد غداً لمزيد من النقاط','green',''); }
        else if (result.error==='ad_duration_invalid') showToast('coin','الإعلان لم يكتمل','شاهد الإعلان بالكامل','red','');
        else showToast('coin','خطأ في المعالجة','حاول مرة أخرى','red','');
        updateAdUI();
    }
}

// ══════════════════════════════════════════════════════════
// DAILY TASKS
// ══════════════════════════════════════════════════════════
function _syncDailyTaskProgress() {
    const watched = _AS.ads.watched;

    // Legacy mini-bar (hidden but kept for compatibility)
    const fill10=document.getElementById('ads10-fill');
    const prog10=document.getElementById('ads10-prog');
    if (fill10) fill10.style.width=Math.min(watched/10,1)*100+'%';
    if (prog10) prog10.textContent=Math.min(watched,10)+' / 10';
    // Circular progress
    if (window.updateCircle) window.updateCircle('ads10', Math.min(watched,10), 10);

    if (watched>=10&&!_AS.tasks.ads10Done) { _AS.tasks.ads10Done=true; _markDailyDone('dtask-ads10',false); }

    const fill25=document.getElementById('ads25-fill');
    const prog25=document.getElementById('ads25-prog');
    if (fill25) fill25.style.width=Math.min(watched/25,1)*100+'%';
    if (prog25) prog25.textContent=Math.min(watched,25)+' / 25';
    // Circular progress
    if (window.updateCircle) window.updateCircle('ads25', Math.min(watched,25), 25);

    if (watched>=25&&!_AS.tasks.ads25Done) { _AS.tasks.ads25Done=true; _markDailyDone('dtask-ads25',false); }

    _updateDailyBadge();
}

function _markDailyDone(cardId, rewardClaimed) {
    const card=document.getElementById(cardId);
    if (!card) return;
    card.classList.add('completed');
    // Update new tasks-ico (new design icon)
    const tasksIco=card.querySelector('.tasks-ico');
    if (tasksIco) {
        tasksIco.style.background='rgba(61,220,132,0.12)';
        tasksIco.style.border='1px solid rgba(61,220,132,0.22)';
        tasksIco.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
    }
    // Legacy dtask-icon (kept for safety)
    const icon=card.querySelector('.dtask-icon');
    if (icon) {
        icon.style.background='rgba(52,211,153,0.12)'; icon.style.border='1px solid rgba(52,211,153,0.22)';
        icon.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
    }
    // Fill circular progress to 100% for invite3
    if (cardId==='dtask-invite3' && window.updateCircle) window.updateCircle('invite3', 3, 3);
    const typeMap={'dtask-ads10':'ads_10','dtask-ads25':'ads_25','dtask-invite3':'daily_refs_3'};
    const type    =typeMap[cardId];
    const claimBtn=type?document.getElementById('dtask-claim-'+type):null;
    const claimed =card.querySelector('.dtask-claimed-badge');
    if (!rewardClaimed) {
        if (claimBtn) claimBtn.style.display='inline-flex';
        if (claimed)  claimed.style.display ='none';
    } else {
        if (claimBtn) claimBtn.style.display='none';
        if (claimed)  claimed.style.display ='inline-flex';
    }
}

function _updateDailyBadge() {
    const done=[_AS.tasks.ads10Done,_AS.tasks.ads25Done,_AS.tasks.invite3Done].filter(Boolean).length;
    const badge=document.getElementById('daily-tasks-badge');
    if (badge) badge.textContent=done+' / 3';
}

export async function claimDailyMission(taskType) {
    const btn=document.getElementById('dtask-claim-'+taskType);
    if (btn) { btn.disabled=true; btn.style.opacity='0.6'; }
    const result=await fetchApi({ type:'claim_daily_mission', data:{ task_type:taskType } });
    if (btn) { btn.disabled=false; btn.style.opacity='1'; }

    if (!result.ok) {
        if (result.error==='task_not_completed_or_already_claimed') showToast('coin','تم الاستلام مسبقاً','','gold','✓');
        else showToast('coin','حدث خطأ',result.error||'','error','!');
        return;
    }

    if (result.points!==undefined) { animateBalance(_AS.balance,result.points); _AS.balance=result.points; }
    if (btn) btn.style.display='none';
    const parentCard=btn?.closest('.dtask-card');
    const claimedBadge=parentCard?.querySelector('.dtask-claimed-badge');
    if (claimedBadge) claimedBadge.style.display='inline-flex';

    const reward=result.reward||0;
    showToast('trophy',`مكافأة المهمة ✓`,`+${reward.toLocaleString('en-US')} نقطة`,'green',`+${reward}`);
    pushNotif('gold','مكافأة مهمة يومية ✓',`+${reward.toLocaleString('en-US')} نقطة`);
}

export function handleDailyTask(type) {
    if (type==='ads10'||type==='ads25') {
        showPage('earn',null);
        document.querySelector('.nav-item[data-page="earn"]')?.classList.add('active');
    } else if (type==='invite3') {
        showPage('invite',null);
        document.querySelector('.nav-item[data-page="invite"]')?.classList.add('active');
    }
}

// ══════════════════════════════════════════════════════════
// TELEGRAM CHANNEL TASK
// ══════════════════════════════════════════════════════════
export function handleTelegramTask() {
    if (_AS.tasks.tgVerified) return;
    const url=_AC.telegram.channel_url||'https://t.me/botbababab';
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url,'_blank');
    _AS.tasks.tgJoined=true;
    document.getElementById('tg-join-btn')?.style.setProperty('display','none');
    const vbtn=document.getElementById('tg-verify-btn-compact');
    if (vbtn) { vbtn.style.display='inline-flex'; vbtn.style.animation='pageIn 0.3s ease both'; }
    const hint=document.getElementById('tg-verify-hint');
    if (hint) hint.style.display='block';
}

export async function verifyTelegramTask() {
    if (_AS.tasks.tgVerified) return;
    const vbtn=document.getElementById('tg-verify-btn-compact');
    if (vbtn) { vbtn.disabled=true; vbtn.style.opacity='0.6'; }

    const result=await fetchApi({ type:'verify_tg_task', data:{} });

    if (vbtn) { vbtn.disabled=false; vbtn.style.opacity='1'; }

    if (!result.ok) {
        if (result.error==='not_in_channel') {
            showToast('coin','لم تنضم للقناة بعد ❌','اضغط «انضم» أولاً','red','!');
            document.getElementById('tg-join-btn')?.style.setProperty('display','inline-flex');
            if (vbtn) vbtn.style.display='none';
        } else if (result.error==='already_verified') {
            showToast('coin','تم التحقق مسبقاً ✓','','green','✓');
        } else {
            showToast('coin','تأكد من انضمامك للقناة','ثم أعد المحاولة','gold','!');
        }
        return;
    }

    if (result.points!==undefined) { animateBalance(_AS.balance,result.points); _AS.balance=result.points; }
    _AS.tasks.tgVerified=true;

    document.getElementById('tg-verify-btn-compact')?.style.setProperty('display','none');
    document.getElementById('tg-verify-hint')?.style.setProperty('display','none');
    document.getElementById('tg-action-wrap')?.style.setProperty('display','none');
    const ds=document.getElementById('tg-done-state');
    if (ds) { ds.style.display='block'; ds.style.animation='pageIn 0.4s cubic-bezier(0.22,1,0.36,1) both'; }
    document.getElementById('tg-done-overlay')?.style.setProperty('display','block');
    document.getElementById('tg-task-card')?.classList.add('completed');

    const reward=parseInt(result.reward)||_AC.rewards.telegram_task||200;
    showToast('trophy','انضممت للقناة! 🎉',`+${reward.toLocaleString('en-US')} نقطة`,'gold',`+${reward}`);
    pushNotif('gold','مهمة قناة تيليغرام ✓',`+${reward.toLocaleString('en-US')} نقطة`);
}

// ══════════════════════════════════════════════════════════
// CHANNEL TASKS (dynamic)
// ══════════════════════════════════════════════════════════
const _chJoined={};

export function handleChannelJoin(channelId, url) {
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url,'_blank');
    _chJoined[channelId]=true;
    document.getElementById('ch-join-btn-'+channelId)?.style.setProperty('display','none');
    const vbtn=document.getElementById('ch-verify-btn-'+channelId);
    if (vbtn) vbtn.style.display='inline-flex';
    const hint=document.getElementById('ch-hint-'+channelId);
    if (hint) hint.style.display='block';
}

export async function verifyChannelTask(channelId) {
    const vbtn=document.getElementById('ch-verify-btn-'+channelId);
    if (vbtn) { vbtn.disabled=true; vbtn.style.opacity='0.6'; }
    const result=await fetchApi({ type:'verify_channel_task', data:{ channel_id:channelId } });
    if (vbtn) { vbtn.disabled=false; vbtn.style.opacity='1'; }

    if (!result.ok) {
        if (result.error==='not_in_channel') {
            showToast('coin','لم تنضم للقناة بعد ❌','اضغط «انضم» أولاً','red','!');
            document.getElementById('ch-join-btn-'+channelId)?.style.setProperty('display','inline-flex');
            if (vbtn) vbtn.style.display='none';
        } else if (result.error==='already_verified') {
            showToast('coin','تم التحقق مسبقاً ✓','','green','✓');
            _chMarkDone(channelId);
        } else {
            showToast('coin','تأكد من انضمامك للقناة','','gold','!');
        }
        return;
    }

    if (result.points!==undefined) { animateBalance(_AS.balance,result.points); _AS.balance=result.points; }
    const reward=result.reward||2500;
    showToast('trophy','انضممت للقناة! 🎉',`+${reward.toLocaleString('en-US')} نقطة`,'gold',`+${reward}`);
    pushNotif('gold','مهمة قناة ✓',`+${reward.toLocaleString('en-US')} نقطة`);
    _chMarkDone(channelId);
}

function _chMarkDone(id) {
    const action=document.getElementById('ch-action-'+id);
    const hint  =document.getElementById('ch-hint-'+id);
    const card  =document.getElementById('ch-card-'+id);
    if (hint)   hint.style.display='none';
    if (action) action.innerHTML=`
        <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);
            border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
            </svg>
            <span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span>
        </div>`;
    if (card) card.style.background='rgba(52,211,153,0.04)';
}

function _renderChannels(channels) {
    const wrap=document.getElementById('channel-tasks-wrap');
    if (!wrap||!channels.length) return;
    wrap.innerHTML=channels.map(ch=>{
        const id=ch.id; const done=!!ch.verified;
        return `
        <div class="tasks-row" id="ch-card-${id}" style="cursor:default;${done?'opacity:.7;':''}" >
            <div class="tasks-ico tasks-ico-blue">
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
                    <path d="M21.44 3.29a1.5 1.5 0 00-1.6-.22L2.87 10.6a1.5 1.5 0 00.07 2.76l3.71 1.37 1.41 4.5a1 1 0 001.73.34l2.04-2.13 3.99 2.93a1.5 1.5 0 002.31-1.01L22 4.75a1.5 1.5 0 00-.56-1.46zM10.1 14.5l-.7 2.56-.97-3.1 7.18-6.07-5.51 6.61z" fill="rgba(94,206,255,.85)"/>
                </svg>
            </div>
            <div class="tasks-rbody">
                <div class="tasks-rname">${ch.title}</div>
                <div class="tasks-rsub">+${(ch.reward||2500).toLocaleString('en-US')} نقطة${ch.max_members>0?` · أقصى ${ch.max_members.toLocaleString('en-US')} عضو`:''}</div>
            </div>
            <div id="ch-action-${id}" style="flex-shrink:0;">
                ${done
                    ? `<div style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:10px;background:rgba(61,220,132,.05);border:1px solid rgba(61,220,132,.14);">
                           <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                           <span style="font-size:11px;font-weight:800;color:#3ddc84;font-family:'Tajawal',sans-serif;">مكتمل</span>
                       </div>`
                    : `<button id="ch-join-btn-${id}" onclick="window.handleChannelJoin(${id},'${ch.url}')"
                           class="tasks-rbtn tasks-btn-blue">
                           <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21.44 3.29a1.5 1.5 0 00-1.6-.22L2.87 10.6a1.5 1.5 0 00.07 2.76l3.71 1.37 1.41 4.5a1 1 0 001.73.34l2.04-2.13 3.99 2.93a1.5 1.5 0 002.31-1.01L22 4.75a1.5 1.5 0 00-.56-1.46z" fill="rgba(94,206,255,.9)"/></svg>
                           اشترك
                       </button>
                       <button id="ch-verify-btn-${id}" onclick="window.verifyChannelTask(${id})"
                           style="display:none;" class="tasks-rbtn" style="background:rgba(61,220,132,.08);border:1px solid rgba(61,220,132,.22);color:#3ddc84;">
                           تحقق
                       </button>`
                }
            </div>
        </div>
        ${!done?`<div id="ch-hint-${id}" style="display:none;margin:0 12px 8px;padding:8px 12px;border-radius:10px;background:rgba(94,206,255,.05);border:1px solid rgba(94,206,255,.1);">
            <span style="font-size:11px;color:rgba(94,206,255,.6);font-weight:600;font-family:'Tajawal',sans-serif;">اضغط «تحقق» بعد الاشتراك في القناة</span>
        </div>`:''}`;
    }).join('');
}
async function _loadChannels() {
    const result=await fetchApi({ type:'get_channels', data:{} });
    document.getElementById('channel-tasks-loading')?.remove();
    if (result.ok&&Array.isArray(result.channels)) _renderChannels(result.channels);
}

// ══════════════════════════════════════════════════════════
// MAIN INIT
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
    initTelegramUser();
    window._REFERRAL_LINK = REFERRAL_LINK;

    // ── Safety net: إذا ما اتخفّت شاشة التحميل خلال 8 ثوانٍ → أخفها قسراً
    // (يحدث عند تعليق الـ fetch بسبب ضعف الشبكة أو غيابها)
    const _loadingFallbackTimer = setTimeout(() => {
        _hideLoadingScreen();
    }, 8000);

    try {
        await createSession();
        const load=await fetchApi({ type:'load', data:{} });

        if (load.ok) {
            const pts=parseInt(load.points)||0;
            _AS.balance             = pts;
            _AS.level               = parseInt(load.level)||1;
            _AS.first_withdraw_done = !!load.first_withdraw_done;
            _AS.tasks.tgVerified    = !!load.tg_verified;
            if (load.usdt_balance !== undefined) _AS.usdt_balance = parseFloat(load.usdt_balance)||0;

            // config
            if (load.config) {
                const cfg=load.config;
                if (cfg.withdraw)  Object.assign(_AC.withdraw,  cfg.withdraw);
                if (cfg.rewards)   Object.assign(_AC.rewards,   cfg.rewards);
                if (cfg.telegram)  Object.assign(_AC.telegram,  cfg.telegram);
                if (cfg.ads)       Object.assign(_AC.ads,       cfg.ads);
                if (cfg.ads?.daily_limit) _AS.serverConfig.ads_daily_limit=cfg.ads.daily_limit;
                // ── adsgram task dynamic config ──
                if (cfg.adsgram_task) {
                    if (cfg.adsgram_task.reward)      _AT.reward     = cfg.adsgram_task.reward;
                    if (cfg.adsgram_task.cooldown_ms) _AT.cooldownMs = cfg.adsgram_task.cooldown_ms;
                    if (cfg.adsgram_task.block_id)    _AT.blockId    = cfg.adsgram_task.block_id;
                }
                if (cfg.adsgram_task?.daily_limit)    _AT.dailyLimit = cfg.adsgram_task.daily_limit;
                if (cfg.ads?.adsgram_daily_limit)     _AT.dailyLimit = cfg.ads.adsgram_daily_limit;
                _applyConfigToUI();
            }

            // ads
            const ads=_AS.ads;
            ads.total     = parseInt(load.ads_total)||_AC.ads.daily_limit||10;
            ads.remaining = parseInt(load.ads_remaining)??ads.total;
            ads.watched   = parseInt(load.ads_watched_today)||0;
            ads.earned    = parseInt(load.earned_today)||0;
            updateAdUI();

            // daily gift
            if (load.streak_day!==undefined) _AS.dailyGift.dayNumber=Math.max(1,(parseInt(load.streak_day)||0)+1);
            if (String(load.last_gift_date||'').slice(0,10)===new Date().toISOString().slice(0,10))
                _AS.dailyGift.claimed=true;

            // withdraw history
            if (Array.isArray(load.withdrawals)) {
                _AS.withdrawHistory.length=0;
                load.withdrawals.forEach(w=>{
                    _AS.withdrawHistory.push({ pts:parseInt(w.pts)||0, address:w.address||'', ts:parseInt(w.ts)||Date.now(), status:w.status||'pending' });
                });
                renderWithdrawHistory();
            }

            // completed tasks
            if (Array.isArray(load.completed_tasks)) {
                const has = t=>load.completed_tasks.some(x=>(typeof x==='string'?x:x.task_type)===t);
                const claimed=t=>load.completed_tasks.some(x=>typeof x==='object'&&x.task_type===t&&x.reward_claimed);
                if (has('ads_10'))       { _AS.tasks.ads10Done=true;   _markDailyDone('dtask-ads10',  claimed('ads_10')); }
                if (has('ads_25'))       { _AS.tasks.ads25Done=true;   _markDailyDone('dtask-ads25',  claimed('ads_25')); }
                if (has('tg_join'))      _AS.tasks.tgVerified=true;
                if (has('daily_refs_3')) { _AS.tasks.invite3Done=true; _markDailyDone('dtask-invite3',claimed('daily_refs_3')); }
            }
            _updateDailyBadge();

            // referral stats
            const totalRefs =parseInt(load.total_referrals)||0;
            const earnedRefs=parseInt(load.earned_from_refs)||0;
            document.querySelectorAll('.uc-stat-val.green').forEach(el=>{ el.textContent=totalRefs; });
            document.querySelectorAll('.uc-stat-val.gold').forEach(el=>{ el.textContent=earnedRefs.toLocaleString('en-US'); });
            document.querySelectorAll('.uc-stat-val.blue').forEach(el=>{ el.textContent=load.completed_tasks?.length||0; });
            const refBadge=document.getElementById('referral-friends-badge');
            if (refBadge) refBadge.textContent=totalRefs+' صديق';
            // تحديث دائرة التقدم لمهمة الدعوة 3
            if (window.updateCircle) window.updateCircle('invite3', Math.min(totalRefs,3), 3);
            const inv3fill=document.getElementById('invite3-fill');
            const inv3prog=document.getElementById('invite3-prog');
            if (inv3fill) inv3fill.style.width=Math.min(totalRefs/3,1)*100+'%';
            if (inv3prog) inv3prog.textContent=Math.min(totalRefs,3)+' / 3';
            if (Array.isArray(load.referral_list)&&load.referral_list.length)
                renderReferralList(load.referral_list,totalRefs);

            if (load.tg_id) {
                window._REFERRAL_LINK='https://t.me/'+BOT_USERNAME+'/earn?startapp=ref_'+load.tg_id;
                _updateReferralLinkUI();
            }

            // ── adsgram task state from server ──
            if (load.config?.adsgram_task?.daily_limit !== undefined) {
                _AT.dailyLimit = load.config.adsgram_task.daily_limit;
            }
            if (load.adsgram_task) {
                if (load.adsgram_task.reward)       _AT.reward     = load.adsgram_task.reward;
                if (load.adsgram_task.cooldown_ms)  _AT.cooldownMs = load.adsgram_task.cooldown_ms;
                if (load.adsgram_task_today_count !== undefined) _AT.doneCount = load.adsgram_task_today_count;
                if (load.adsgram_task_daily_limit !== undefined) _AT.dailyLimit = load.adsgram_task_daily_limit;
                _atUpdateCounter();
                const atStatus = load.adsgram_task.status;
                const atRemSec = load.adsgram_task.remaining_seconds || 0;
                if (atStatus === 'cooldown' && atRemSec > 0) {
                    _atStartCooldown(atRemSec * 1000);
                } else if (atStatus === 'maxed' || _AT.doneCount >= _AT.dailyLimit) {
                    _atShow('atask-maxed-state');
                    document.getElementById('atask-card')?.style.setProperty('opacity','0.75');
                } else {
                    _atShow('atask-start-btn');
                }
            } else {
                _atShow('atask-start-btn');
            }
            // tgVerified UI
            if (_AS.tasks.tgVerified) {
                document.getElementById('tg-join-btn')?.style.setProperty('display','none');
                document.getElementById('tg-verify-btn-compact')?.style.setProperty('display','none');
                document.getElementById('tg-action-wrap')?.style.setProperty('display','none');
                const ds=document.getElementById('tg-done-state');
                if (ds) ds.style.display='block';
                document.getElementById('tg-done-overlay')?.style.setProperty('display','block');
                document.getElementById('tg-task-card')?.classList.add('completed');
            }

            setTimeout(()=>{ animateBalance(0,pts,1600); runCounters(document); },120);

        } else {
            setTimeout(()=>runCounters(document),350);
        }
    } catch(e) {
        console.error('[INIT]',e.message);
    } finally {
        clearTimeout(_loadingFallbackTimer); // ألغِ الـ safety timer — التحميل انتهى طبيعياً
        _hideLoadingScreen();
    }

    _loadChannels();
    _injectPlayReminder(); // حقن overlay التذكير
    _atBindWidget();
    // Run entrance animation if tasks page is active on load
    if (document.getElementById('page-tasks')?.classList.contains('active')) {
        setTimeout(() => { if (window.runTasksEntranceAnimation) window.runTasksEntranceAnimation(); }, 200);
    }

    // polling
    let _lastPts=_AS.balance; let _pollFails=0;
    async function _poll() {
        try {
            const s=await fetchApi({ type:'get_state', data:{} });
            if (!s.ok) { _pollFails++; return; }
            _pollFails=0;
            const ads=_AS.ads;
            if (s.ads_remaining!==undefined&&!ads.isWatching) {
                ads.remaining=s.ads_remaining;
                ads.watched  =s.ads_watched_today||0;
                ads.earned   =s.earned_today||0;
                if (s.ad_cooldown_ms>0) ads.cooldownUntil=Date.now()+s.ad_cooldown_ms;
                updateAdUI();
            }
            if (s.points!==undefined&&s.points!==_lastPts) {
                animateBalance(_lastPts,s.points,800);
                _lastPts=s.points; _AS.balance=s.points;
            }
            if (s.usdt_balance!==undefined) _AS.usdt_balance=parseFloat(s.usdt_balance)||0;
            if (s.level!==undefined) _AS.level=s.level;
        } catch(_) { _pollFails++; }
    }

    let _pollInterval=setInterval(_poll,5000);

    const offBanner=document.getElementById('offline-banner');
    window.addEventListener('offline',()=>{
        clearInterval(_pollInterval);
        if (offBanner) { offBanner.style.display='block'; requestAnimationFrame(()=>{ offBanner.style.transform='translateY(0)'; }); }
    });
    window.addEventListener('online',async()=>{
        if (offBanner) { offBanner.style.transform='translateY(-100%)'; setTimeout(()=>{ offBanner.style.display='none'; },300); }
        await _poll();
        _pollInterval=setInterval(_poll,5000);
    });
});

// ── expose ────────────────────────────────────────────────
window.watchAd             = watchAd;
window.claimDailyMission   = claimDailyMission;
window.handleDailyTask     = handleDailyTask;
window.handleTelegramTask  = handleTelegramTask;
window.verifyTelegramTask  = verifyTelegramTask;
window.handleChannelJoin   = handleChannelJoin;
window.verifyChannelTask   = verifyChannelTask;
window.updateAdUI          = updateAdUI;

// ══════════════════════════════════════════════════════════
// ADSGRAM SPONSORED TASK (task-30166) — Custom UI
// AdsGram SDK runs silently in the background only.
// All visual state is driven by our own UI elements.
// ══════════════════════════════════════════════════════════

// ── state ─────────────────────────────────────────────────
const _AT = {
    blockId:       'task-30166',
    controller:    null,
    isRunning:     false,
    cooldownTimer: null,
    // values loaded from server (defaults match config)
    reward:        50,
    dailyLimit:    3,
    doneCount:     0,
    cooldownMs:    60000,
};

// ── helpers ───────────────────────────────────────────────
function _atShow(id) {
    // states داخل atask-action
    ['atask-loading-state','atask-cooldown-state','atask-maxed-state'].forEach(x => {
        const el = document.getElementById(x);
        if (el) el.style.display = (x === id) ? 'inline-flex' : 'none';
    });
    // widget-wrap: يُخبى فقط عند cooldown أو maxed — لا أثناء loading
    const wrap = document.getElementById('atask-widget-wrap');
    if (wrap) {
        const hideWrap = ['atask-cooldown-state','atask-maxed-state'].includes(id);
        wrap.style.display = hideWrap ? 'none' : 'block';
    }
}

function _atUpdateCounter() {
    const dc = document.getElementById('atask-done-count');
    const dl = document.getElementById('atask-daily-limit');
    const rl = document.getElementById('atask-reward-label');
    const rb = document.getElementById('adsgram-reward-badge');
    if (dc) dc.textContent = _AT.doneCount;
    if (dl) dl.textContent = _AT.dailyLimit;
    if (rl) rl.textContent = _AT.reward;
    if (rb) rb.textContent = _AT.reward;
}

function _atStartCooldown(ms) {
    if (_AT.cooldownTimer) clearInterval(_AT.cooldownTimer);
    _atShow('atask-cooldown-state');
    const timerEl = document.getElementById('atask-cooldown-timer');
    let remaining = Math.ceil(ms / 1000);
    if (timerEl) timerEl.textContent = remaining + 's';
    _AT.cooldownTimer = setInterval(() => {
        remaining--;
        if (timerEl) timerEl.textContent = remaining + 's';
        if (remaining <= 0) {
            clearInterval(_AT.cooldownTimer);
            _AT.cooldownTimer = null;
            _atRefreshState();
        }
    }, 1000);
}

function _atRefreshState() {
    // بعد انتهاء cooldown — أظهر الـ widget وأصدر nonce مسبقاً
    _atShow(null);
    _atPrestart();
}


// ── main entry — الـ <adsgram-task> widget يدير الـ UI مباشرةً ─────
// عند reward event نبدأ claim مع السيرفر
export async function startAdsgramTask() {
    // هذه الدالة لم تعد تُستدعى من زر — الـ widget يشتغل وحده
    // نبقيها فقط للتوافق مع أي استدعاء قديم
}

// ── ربط الـ widget بالسيرفر ────────────────────────────────
// start_adsgram_task يُستدعى لحظة ظهور الـ widget للمستخدم
// هكذا adsgram_started_at يُسجل مبكراً وlapsed يتجاوز min_watch_ms
let _atPendingNonce = null;

async function _atPrestart() {
    if (_AT.doneCount >= _AT.dailyLimit) return;
    if (_atPendingNonce) return; // نonce موجود مسبقاً
    const startRes = await fetchApi({ type: 'start_adsgram_task', data: {} });
    if (!startRes.ok) {
        if (startRes.error === 'daily_limit_reached') {
            _AT.doneCount = _AT.dailyLimit; _atUpdateCounter(); _atShow('atask-maxed-state');
        } else if (startRes.error === 'cooldown_active') {
            _atStartCooldown(startRes.wait_ms || _AT.cooldownMs);
        }
        return;
    }
    _atPendingNonce = startRes.task_nonce;
}

function _atBindWidget() {
    const widget = document.getElementById('atask-widget');
    if (!widget) return;

    // Pre-issue nonce بعد تحميل الـ widget مباشرةً
    setTimeout(_atPrestart, 500);

    widget.addEventListener('reward', async () => {
        // Guard: daily limit
        if (_AT.doneCount >= _AT.dailyLimit) {
            _atShow('atask-maxed-state');
            return;
        }

        // إذا ما عندنا nonce بعد → اطلبه الحين
        if (!_atPendingNonce) {
            const startRes = await fetchApi({ type: 'start_adsgram_task', data: {} });
            if (!startRes.ok) {
                if (startRes.error === 'daily_limit_reached') {
                    _AT.doneCount = _AT.dailyLimit; _atUpdateCounter(); _atShow('atask-maxed-state');
                    document.getElementById('atask-card')?.style.setProperty('opacity', '0.7');
                } else if (startRes.error === 'cooldown_active') {
                    _atStartCooldown(startRes.wait_ms || _AT.cooldownMs);
                } else {
                    _atShow(null);
                    showToast('coin', 'خطأ في التحقق', startRes.error || '', 'red', '!');
                }
                return;
            }
            _atPendingNonce = startRes.task_nonce;
        }

        const taskNonce = _atPendingNonce;
        _atPendingNonce = null; // استهلك الـ nonce

        // Claim المكافأة
        const claimRes = await _dbCall('claim_adsgram_task', {}, taskNonce);

        if (claimRes.ok) {
            const pts = claimRes.points;
            if (pts !== undefined) { animateBalance(_AS.balance, pts, 1200); _AS.balance = pts; }

            const earned = claimRes.earned || claimRes.reward || _AT.reward;
            _AT.doneCount = claimRes.adsgram_task_today_count || (_AT.doneCount + 1);
            _atUpdateCounter();

            showToast('trophy', 'مهمة إعلانية مكتملة 🎉', `+${earned.toLocaleString('en-US')} نقطة أُضيفت`, 'green', `+${earned}`);
            pushNotif('gold', 'مهمة إعلانية ✓', `+${earned.toLocaleString('en-US')} نقطة`);

            const icon = document.getElementById('atask-icon');
            if (icon) {
                icon.style.background = 'rgba(52,211,153,0.12)';
                icon.style.border = '1px solid rgba(52,211,153,0.28)';
                icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
                setTimeout(() => {
                    icon.style.background = 'rgba(251,191,36,0.1)';
                    icon.style.border = '1px solid rgba(251,191,36,0.22)';
                    icon.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="rgba(251,191,36,0.8)" stroke-width="1.6" fill="rgba(251,191,36,0.08)"/><path d="M8 12l3 3 5-5" stroke="rgba(251,191,36,0.9)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
                }, 1800);
            }

            if (_AT.doneCount >= _AT.dailyLimit) {
                setTimeout(() => {
                    _atShow('atask-maxed-state');
                    document.getElementById('atask-card')?.style.setProperty('opacity', '0.75');
                }, 1500);
            } else {
                setTimeout(() => {
                    _atStartCooldown(claimRes.cooldown_ms || _AT.cooldownMs);
                    // pre-issue nonce للمرة القادمة بعد انتهاء cooldown
                    setTimeout(_atPrestart, (claimRes.cooldown_ms || _AT.cooldownMs) + 200);
                }, 600);
            }
        } else {
            if (claimRes.error === 'cooldown_active') {
                _atStartCooldown(claimRes.wait_ms || _AT.cooldownMs);
            } else if (claimRes.error === 'daily_limit_reached') {
                _AT.doneCount = _AT.dailyLimit; _atUpdateCounter(); _atShow('atask-maxed-state');
            } else {
                _atShow(null);
                showToast('coin', 'خطأ في المعالجة', claimRes.error || '', 'red', '!');
            }
        }
    });

    widget.addEventListener('onBannerNotFound', () => {
        // الكارد تبقى مرئية لكن فارغة — نخفي الـ widget wrap ونظهر حالة "انتظر"
        const wrap = document.getElementById('atask-widget-wrap');
        if (wrap) wrap.style.display = 'none';
        ['atask-loading-state','atask-cooldown-state','atask-maxed-state'].forEach(x => {
            const el = document.getElementById(x);
            if (el) el.style.display = 'none';
        });
        // نعرض حالة انتظر مخصصة
        const action = document.getElementById('atask-action');
        if (action) {
            action.innerHTML = `<div style="display:inline-flex;align-items:center;gap:6px;padding:10px 14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.35);font-family:'Tajawal',sans-serif;font-size:12px;font-weight:700;">انتظر</div>`;
        }
    });

    widget.addEventListener('onTooLongSession', () => {
        showToast('coin', 'أعد تشغيل التطبيق', 'الجلسة طويلة جداً', 'red', '!');
    });

    widget.addEventListener('onError', () => {
        showToast('coin', 'خطأ في تحميل المهمة', 'حاول لاحقاً', 'red', '!');
    });
}


// ── Init adsgram task UI from server data ─────────────────
export function initAdsgramTaskUI(adsgramTaskData) {
    // adsgramTaskData = load.adsgram_task from server
    if (!adsgramTaskData) return;
    if (adsgramTaskData.reward)         _AT.reward      = adsgramTaskData.reward;
    if (adsgramTaskData.cooldown_ms)    _AT.cooldownMs  = adsgramTaskData.cooldown_ms;
    // daily limit comes from config
    _atUpdateCounter();

    const { status, remaining_seconds } = adsgramTaskData;
    if (status === 'cooldown' && remaining_seconds > 0) {
        _atStartCooldown(remaining_seconds * 1000);
    } else if (status === 'ready') {
        _atShow(null); // أظهر الـ widget
    }
    // Show section (always visible)
}

// ── expose ────────────────────────────────────────────────
window.startAdsgramTask    = startAdsgramTask;
window.initAdsgramTaskUI   = initAdsgramTaskUI;
