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
    AdNotifQueue,
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
let _adSessionEndAt  = 0;
let _adPlayClicked   = false;
let _adRetryCount    = 0;
let _isClaimingAd    = false;

// تتبع الإعلانات المتتالية لـ Progressive Cooldown
let _adConsecutiveCount = 0;
let _adLastRewardTs     = 0;
const _AD_CONSECUTIVE_RESET_MS = 15 * 60 * 1000; // 15 دقيقة بدون إعلان = reset

// Cooldown steps: [0]=أول، [1]=ثاني، [2+=ثالث+]
const _COOLDOWN_STEPS = [60000, 90000, 120000];

function _getNextCooldownMs(count) {
    const idx = Math.min(count, _COOLDOWN_STEPS.length - 1);
    return _COOLDOWN_STEPS[idx];
}

function _initAdController() {
    if (!window.Adsgram||_adController) return _adController;
    try { _adController = window.Adsgram.init({ blockId:AD_BLOCK_ID, debug:false, debugBanners:false }); }
    catch(_) { _adController=null; }
    return _adController;
}

// ══════════════════════════════════════════════════════════
// updateAdUI
// ══════════════════════════════════════════════════════════
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

    const progBar = document.getElementById('ads-progress');
    if (progBar) progBar.style.width = (ads.total>0 ? Math.min(100,(ads.watched/ads.total)*100) : 0)+'%';
    const quotaTotal = document.querySelector('.ad-quota-total');
    if (quotaTotal) quotaTotal.textContent='/ '+ads.total;

    const coolLeft = ads.cooldownUntil - Date.now();
    const btn      = document.getElementById('ad-watch-btn');
    const coolEl   = document.getElementById('ad-cooldown-msg');
    if (coolEl) coolEl.style.display='none';

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

    const _earnRingFill = document.getElementById('earn-ring-fill');
    if (_earnRingFill) {
        const _EARN_CIRC = 263.89;
        const _total = ads.total || 10;
        const _pct   = _total > 0 ? r / _total : 0;
        _earnRingFill.style.strokeDashoffset = _EARN_CIRC * (1 - _pct);
    }
}

// ══════════════════════════════════════════════════════════
// SHOW AD (Adsgram SDK) — مع تتبع جودة الجلسة
// ══════════════════════════════════════════════════════════
function _showAd() {
    return new Promise(async resolve => {
        const controller = _initAdController();
        if (!controller) { resolve(false); return; }

        await fetchApi({ type:'track_ad_event', data:{ event:'ad_requested', ad_type:'daily_ad', meta:{ block_id:AD_BLOCK_ID } } });

        // [SESSION QUALITY] — reset play flag وسجّل وقت البداية الحقيقي
        _adPlayClicked  = false;
        _adStartedAt    = Date.now();
        _adSessionEndAt = 0;

        // تسجيل نقر Play عبر اعتراض نقر المستخدم
        const _playDetector = (e) => {
            // أي نقرة أثناء عرض الإعلان تُعدّ play interaction
            _adPlayClicked = true;
        };
        document.addEventListener('click', _playDetector, { once: true, capture: true });

        try {
            const result = await controller.show();
            document.removeEventListener('click', _playDetector, { capture: true });
            _adSessionEndAt = Date.now();

            if (result?.done===true) {
                const elapsed = _adSessionEndAt - _adStartedAt;
                if (elapsed < AD_MIN_MS) { resolve(false); return; }
                _adRetryCount=0;
                resolve(true);
            } else { resolve(false); }
        } catch(result) {
            document.removeEventListener('click', _playDetector, { capture: true });
            _adSessionEndAt = Date.now();

            if (result?.error===true && _adRetryCount<AD_MAX_RETRIES) {
                _adRetryCount++;
                _adController=null;
                // تأخر طبيعي متغير بدلاً من ثابت
                const jitter = 1200 + Math.floor(Math.random() * 600);
                setTimeout(()=>resolve(_showAd()), jitter);
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
        const remSec = Math.ceil((ads.cooldownUntil-Date.now())/1000);
        AdNotifQueue.push({
            type: 'cooldown',
            title: 'انتظر قليلاً',
            body: `متاح بعد ${remSec} ثانية`,
        });
        showToast('coin','انتظر قليلاً',`${remSec} ثانية`,'red','');
        return;
    }

    // إعادة تعيين العدّاد المتتالي إذا مضت فترة طويلة
    if (_adLastRewardTs > 0 && (Date.now() - _adLastRewardTs) > _AD_CONSECUTIVE_RESET_MS) {
        _adConsecutiveCount = 0;
    }

    ads.isWatching=true;
    const btn      = document.getElementById('ad-watch-btn');
    const overlay  = document.getElementById('ad-watch-overlay');
    const countEl  = document.getElementById('overlay-count');
    const labelEl  = document.getElementById('overlay-label');
    const preBar   = document.getElementById('ad-preload-bar');
    if (btn) btn.classList.add('disabled');

    // SDK check
    if (!window.Adsgram||window._adsgramLoadStatus!=='loaded') {
        if (window._adsgramLoadStatus==='failed') {
            ads.isWatching=false; if(btn) btn.classList.remove('disabled');
            AdNotifQueue.push({ type:'load_failed', title:'تعذّر تحميل الإعلان', body:'تحقق من اتصالك بالإنترنت' });
            showToast('coin','تعذّر تحميل الإعلان','تحقق من اتصالك','red','');
            return;
        }
        if (overlay) {
            if(countEl) countEl.innerHTML='<img src="asesst/loading.gif" style="width:40px;height:40px;object-fit:contain;border-radius:8px;">';
            overlay.classList.add('visible');
        }
        const loaded = await new Promise(res=>{
            const t=setTimeout(()=>res(false),8000);
            const cb=s=>{ clearTimeout(t); res(s!=='failed'); };
            if (typeof window.onAdsgramLoaded==='function') window.onAdsgramLoaded(cb);
            else res(false);
        });
        if (overlay) overlay.classList.remove('visible');
        if (!loaded) {
            ads.isWatching=false; if(btn) btn.classList.remove('disabled');
            AdNotifQueue.push({ type:'load_failed', title:'تعذّر تحميل الإعلان', body:'تحقق من اتصالك بالإنترنت' });
            showToast('coin','تعذّر تحميل الإعلان','تحقق من اتصالك','red','');
            return;
        }
    }

    let successCount=0;
    for (let i=0;i<AD_PRELOAD;i++) {
        if (overlay) {
            if(countEl) countEl.textContent=`${i+1}/${AD_PRELOAD}`;
            if(labelEl) labelEl.textContent='جاري تحميل الإعلان...';
            overlay.classList.add('visible');
        }
        if (preBar) { preBar.style.width=(i/AD_PRELOAD*100)+'%'; preBar.style.background='linear-gradient(90deg,#f59e0b,#fbbf24)'; }
        await new Promise(r=>setTimeout(r,600));
        if (overlay) overlay.classList.remove('visible');

        const done = await _showAd();
        if (!done) {
            ads.isWatching=false; if(btn) btn.classList.remove('disabled');
            if (preBar) preBar.style.width='0%';

            const sessionMs = _adSessionEndAt > _adStartedAt ? _adSessionEndAt - _adStartedAt : 0;
            if (sessionMs > 0 && sessionMs < 5000) {
                AdNotifQueue.push({ type:'closed_early', title:'أُغلق الإعلان مبكراً', body:'شاهده حتى النهاية للحصول على المكافأة' });
                showToast('coin','الإعلان لم يكتمل','شاهد الإعلان حتى النهاية','red','');
            } else {
                AdNotifQueue.push({ type:'incomplete', title:'الإعلان لم يكتمل', body:'حاول مرة أخرى' });
                showToast('coin','الإعلان لم يكتمل','شاهد الإعلان بالكامل','red','');
            }
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

    // حساب مدة الجلسة الفعلية
    const sessionDurationMs = (_adSessionEndAt > _adStartedAt)
        ? (_adSessionEndAt - _adStartedAt)
        : (Date.now() - _adStartedAt);

    // [1] start_ad → نحصل على nonce من السيرفر
    _isClaimingAd = true;
    const startRes = await _dbCall('start_ad', {});
    if (!startRes.ok) {
        ads.isWatching=false; if(btn) btn.classList.remove('disabled');
        _isClaimingAd = false;
        if (preBar) preBar.style.width='0%';
        if (startRes.error==='daily_limit_reached') { ads.remaining=0; updateAdUI(); }
        else if (startRes.error==='cooldown_active') {
            const waitMs = startRes.wait_ms||60000;
            ads.cooldownUntil=Date.now()+waitMs;
            updateAdUI();
            AdNotifQueue.push({ type:'cooldown', title:'في فترة الانتظار', body:`متاح بعد ${Math.ceil(waitMs/1000)} ثانية` });
        }
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

    // [2] reward_ad — مع بيانات جودة الجلسة
    const result = await _dbCall('reward_ad',
        {
            ad_started_at:      _adStartedAt,
            session_duration_ms: sessionDurationMs,
            play_clicked:       _adPlayClicked,
            consecutive_count:  _adConsecutiveCount,
            preload_count:      successCount,
        },
        adNonce
    );

    ads.isWatching=false;
    _isClaimingAd = false;
    if (preBar) preBar.style.width='0%';

    if (result.ok) {
        ads.remaining    = result.remaining;
        ads.watched      = result.watchedToday;
        ads.earned       = result.earnedToday;

        // استخدام cooldown_ms من السيرفر (متغير حسب Progressive Cooldown)
        const cdMs = result.cooldown_ms || _getNextCooldownMs(_adConsecutiveCount);
        ads.cooldownUntil = Date.now() + cdMs;

        // تحديث عداد المتتاليات
        _adLastRewardTs = Date.now();
        _adConsecutiveCount++;

        if (result.points!==undefined) { animateBalance(_AS.balance,result.points,1200); _AS.balance=result.points; }

        const pts          = result.earned || _AC.rewards?.points_per_ad || 50;
        const isPartial    = result.is_partial === true;
        const sessionGrade = result.session_grade || 'full';
        const needsPlay    = result.needs_play === true;

        // فيبريشن
        try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch(e){}
        try { if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]); } catch(e){}

        // إشعار وتوست حسب جودة الجلسة
        if (isPartial) {
            const reason = needsPlay ? 'اضغط ▶ داخل الإعلان للمكافأة الكاملة' : 'شاهد لفترة أطول للمكافأة الكاملة';
            showToast('coin',`+${pts} نقطة (جزئية)`,reason,'gold',`+${pts}`);
            AdNotifQueue.push({ type:'partial', title:`مكافأة جزئية +${pts}`, body: reason, ts: Date.now() });
            pushNotif('gold',`مكافأة جزئية #${result.watchedToday}`,`+${pts} نقطة — ${reason}`);
        } else {
            showToast('trophy',`تم إضافة +${pts} نقطة 🎉`,`شاهدت ${result.watchedToday} إعلان اليوم`,'green',`+${pts}`);
            AdNotifQueue.push({ type:'success', title:`مكافأة كاملة +${pts} 🎉`, body:`شاهدت ${result.watchedToday} إعلان اليوم`, ts: Date.now() });
            pushNotif('gold',`مكافأة إعلان #${result.watchedToday}`,`+${pts} نقطة أُضيفت لرصيدك`);
        }

        // عدّاد تنازلي داخل الزر (Progressive Cooldown)
        if (ads.remaining > 0 && btn) {
            if (ads._cooldownTimer) { clearInterval(ads._cooldownTimer); ads._cooldownTimer = null; }
            btn.classList.add('disabled');
            let remSec = Math.ceil(cdMs / 1000);
            ads._btnCooldownActive = true;
            const _renderBtnCountdown = (sec) => {
                btn.innerHTML = `<div class="btn-shimmer"></div>`
                    + `<div id="ad-btn-countdown" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;font-family:'Nunito',sans-serif;font-size:26px;font-weight:900;color:#fbbf24;letter-spacing:2px;text-shadow:0 0 14px rgba(251,191,36,0.6);">`
                    + `<img src="asesst/loading.gif" alt="" style="width:22px;height:22px;opacity:0.85;">${sec}s</div>`;
            };
            _renderBtnCountdown(remSec);
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
                        + `<div class="earn-cta-reward"><div class="earn-cta-rnum">+${_AC.rewards?.points_per_ad||50}</div><div class="earn-cta-rsub" data-i18n="pts">نقطة</div></div>`;
                    btn.classList.remove('disabled');
                }
            }, 1000);
        } else if (btn) {
            btn.classList.remove('disabled');
        }

        _updateAdUINoBtn();

    } else {
        if (btn) btn.classList.remove('disabled');
        if (result.error==='cooldown_active') {
            const waitMs = result.wait_ms||60000;
            ads.cooldownUntil=Date.now()+waitMs;
            updateAdUI();
            AdNotifQueue.push({ type:'cooldown', title:'في فترة الانتظار', body:`متاح بعد ${Math.ceil(waitMs/1000)} ثانية` });
        }
        else if (result.error==='daily_limit_reached') {
            ads.remaining=0; updateAdUI();
            showToast('trophy','انتهت إعلانات اليوم 🏆','عُد غداً لمزيد من النقاط','green','');
            AdNotifQueue.push({ type:'limit', title:'انتهت إعلانات اليوم 🏆', body:'عُد غداً لمزيد من النقاط' });
        }
        else if (result.error==='ad_duration_invalid') {
            showToast('coin','الإعلان لم يكتمل','شاهد الإعلان بالكامل','red','');
            AdNotifQueue.push({ type:'incomplete', title:'الإعلان لم يكتمل', body:'شاهد الإعلان بالكامل للحصول على المكافأة' });
        }
        else {
            showToast('coin','خطأ في المعالجة','حاول مرة أخرى','red','');
            AdNotifQueue.push({ type:'error', title:'خطأ في المعالجة', body:'يُرجى المحاولة مرة أخرى' });
        }
        updateAdUI();
    }
}

// ══════════════════════════════════════════════════════════
// DAILY TASKS
// ══════════════════════════════════════════════════════════
function _syncDailyTaskProgress() {
    const watched = _AS.ads.watched;
    const fill10=document.getElementById('ads10-fill');
    const prog10=document.getElementById('ads10-prog');
    if (fill10) fill10.style.width=Math.min(watched/10,1)*100+'%';
    if (prog10) prog10.textContent=Math.min(watched,10)+' / 10';
    if (window.updateCircle) window.updateCircle('ads10', Math.min(watched,10), 10);
    if (watched>=10&&!_AS.tasks.ads10Done) { _AS.tasks.ads10Done=true; _markDailyDone('dtask-ads10',false); }

    const fill25=document.getElementById('ads25-fill');
    const prog25=document.getElementById('ads25-prog');
    if (fill25) fill25.style.width=Math.min(watched/25,1)*100+'%';
    if (prog25) prog25.textContent=Math.min(watched,25)+' / 25';
    if (window.updateCircle) window.updateCircle('ads25', Math.min(watched,25), 25);
    if (watched>=25&&!_AS.tasks.ads25Done) { _AS.tasks.ads25Done=true; _markDailyDone('dtask-ads25',false); }

    _updateDailyBadge();
}

function _markDailyDone(cardId, rewardClaimed) {
    const card=document.getElementById(cardId);
    if (!card) return;
    card.classList.add('completed');
    const tasksIco=card.querySelector('.tasks-ico');
    if (tasksIco) {
        tasksIco.style.background='rgba(61,220,132,0.12)';
        tasksIco.style.border='1px solid rgba(61,220,132,0.22)';
        tasksIco.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
    }
    const icon=card.querySelector('.dtask-icon');
    if (icon) {
        icon.style.background='rgba(52,211,153,0.12)'; icon.style.border='1px solid rgba(52,211,153,0.22)';
        icon.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
    }
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
    _chMarkDone(channelId);

    const reward=result.reward||0;
    showToast('trophy','تم التحقق ✓',`+${reward.toLocaleString('en-US')} نقطة`,'green',`+${reward}`);
    pushNotif('gold','مهمة قناة ✓',`+${reward.toLocaleString('en-US')} نقطة`);
}

function _chMarkDone(channelId) {
    const card=document.getElementById('ch-card-'+channelId);
    if (card) card.classList.add('completed');
    document.getElementById('ch-join-btn-'+channelId)?.style.setProperty('display','none');
    document.getElementById('ch-verify-btn-'+channelId)?.style.setProperty('display','none');
    document.getElementById('ch-hint-'+channelId)?.style.setProperty('display','none');
    const done=document.getElementById('ch-done-'+channelId);
    if (done) done.style.display='inline-flex';
}

async function _loadChannels() {
    try {
        const r=await fetchApi({ type:'get_channels', data:{} });
        if (!r.ok||!r.channels?.length) return;
        const cont=document.getElementById('channel-tasks-list');
        if (!cont) return;
        cont.innerHTML='';
        r.channels.forEach(ch=>{
            const done=!!ch.verified;
            cont.insertAdjacentHTML('beforeend',`
            <div class="tasks-card${done?' completed':''}" id="ch-card-${ch.id}">
              <div class="tasks-ico" style="background:rgba(14,165,233,0.1);border:1px solid rgba(14,165,233,0.22);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.86 9.81 19.79 19.79 0 01.77 1.18 2 2 0 012.76 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 7.91a16 16 0 006.16 6.16l1.08-1.08a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" stroke="#0ea5e9" stroke-width="1.8"/></svg>
              </div>
              <div class="tasks-info">
                <div class="tasks-title">${ch.title_ar||ch.title||'قناة'}</div>
                <div class="tasks-sub">${(ch.reward||0).toLocaleString('en-US')} نقطة</div>
              </div>
              <div class="tasks-action" id="ch-action-${ch.id}">
                ${done
                  ? `<div class="tasks-done-badge" id="ch-done-${ch.id}" style="display:inline-flex;">مكتملة ✓</div>`
                  : `<button class="tasks-btn" id="ch-join-btn-${ch.id}" onclick="handleChannelJoin('${ch.id}','${ch.url}')">انضم</button>
                     <button class="tasks-btn tasks-btn-verify" id="ch-verify-btn-${ch.id}" style="display:none;" onclick="verifyChannelTask('${ch.id}')">تحقق</button>
                     <div class="tasks-verify-hint" id="ch-hint-${ch.id}" style="display:none;">بعد الانضمام اضغط «تحقق»</div>`
                }
              </div>
            </div>`);
        });
        const section=document.getElementById('channel-tasks-section');
        if (section) section.style.display='block';
    } catch(_){}
}

// ══════════════════════════════════════════════════════════
// DOMContentLoaded — init
// ══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await createSession();
        const load = await fetchApi({ type:'load', data:{} });
        if (!load.ok) { _hideLoadingScreen(); return; }

        initTelegramUser(load.user);
        _applyConfigToUI(load.config);

        const ads = _AS.ads;
        ads.remaining = load.ads_remaining    ?? 0;
        ads.watched   = load.ads_watched_today ?? 0;
        ads.earned    = load.earned_today      ?? 0;
        ads.total     = load.config?.ads?.daily_limit ?? 10;

        if (load.ad_cooldown_ms > 0) ads.cooldownUntil = Date.now() + load.ad_cooldown_ms;

        if (load.tasks) {
            _AS.tasks.ads10Done   = !!load.tasks.ads_10?.claimed;
            _AS.tasks.ads25Done   = !!load.tasks.ads_25?.claimed;
            _AS.tasks.invite3Done = !!load.tasks.daily_refs_3?.claimed;
            if (load.tasks.ads_10?.completed  && !load.tasks.ads_10?.claimed)  _markDailyDone('dtask-ads10',false);
            else if (load.tasks.ads_10?.claimed) _markDailyDone('dtask-ads10',true);
            if (load.tasks.ads_25?.completed  && !load.tasks.ads_25?.claimed)  _markDailyDone('dtask-ads25',false);
            else if (load.tasks.ads_25?.claimed) _markDailyDone('dtask-ads25',true);
            if (load.tasks.daily_refs_3?.completed && !load.tasks.daily_refs_3?.claimed) _markDailyDone('dtask-invite3',false);
            else if (load.tasks.daily_refs_3?.claimed) _markDailyDone('dtask-invite3',true);
        }

        if (load.tg_task_verified) {
            _AS.tasks.tgVerified=true;
            document.getElementById('tg-action-wrap')?.style.setProperty('display','none');
            const ds=document.getElementById('tg-done-state');
            if (ds) ds.style.display='block';
            document.getElementById('tg-done-overlay')?.style.setProperty('display','block');
            document.getElementById('tg-task-card')?.classList.add('completed');
        }

        updateAdUI();
        _updateReferralLinkUI();

        if (load.referrals?.length) renderReferralList(load.referrals);
        if (load.withdraw_history?.length) renderWithdrawHistory(load.withdraw_history);

        _AS.balance      = parseInt(load.user?.points) || 0;
        _AS.usdt_balance = parseFloat(load.user?.usdt_balance) || 0;
        _AS.level        = parseInt(load.user?.level) || 1;

        if (load.adsgram_task) initAdsgramTaskUI(load.adsgram_task);

        if (load.gift) {
            _AS.gift = load.gift;
            if (typeof window._initGiftUI === 'function') window._initGiftUI(load.gift);
        }

        if (load.tasks?.tg_channel?.verified) {
            _AS.tasks.tgVerified=true;
            document.getElementById('tg-action-wrap')?.style.setProperty('display','none');
            const ds=document.getElementById('tg-done-state');
            if (ds) ds.style.display='block';
            document.getElementById('tg-done-overlay')?.style.setProperty('display','block');
            document.getElementById('tg-task-card')?.classList.add('completed');
        }

        const pts = _AS.balance;
        setTimeout(()=>{ animateBalance(0,pts,1600); runCounters(document); },120);

    } catch(e) {
        console.error('[INIT]',e.message);
    } finally {
        _hideLoadingScreen();
    }

    _loadChannels();
    _atBindWidget();

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
        AdNotifQueue.push({ type:'offline', title:'انقطع الاتصال', body:'تحقق من اتصالك بالإنترنت' });
    });
    window.addEventListener('online',async()=>{
        if (offBanner) { offBanner.style.transform='translateY(-100%)'; setTimeout(()=>{ offBanner.style.display='none'; },300); }
        AdNotifQueue.flush(); // إعادة إرسال الإشعارات المعلّقة
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
// ADSGRAM SPONSORED TASK (task-30166)
// ══════════════════════════════════════════════════════════
const _AT = {
    blockId:       'task-30166',
    controller:    null,
    isRunning:     false,
    cooldownTimer: null,
    reward:        50,
    dailyLimit:    3,
    doneCount:     0,
    cooldownMs:    60000,
};

function _atShow(id) {
    ['atask-loading-state','atask-cooldown-state','atask-maxed-state'].forEach(x => {
        const el = document.getElementById(x);
        if (el) el.style.display = (x === id) ? 'inline-flex' : 'none';
    });
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
    _atShow(null);
    _atPrestart();
}

export async function startAdsgramTask() {}

let _atPendingNonce = null;

async function _atPrestart() {
    if (_AT.doneCount >= _AT.dailyLimit) return;
    if (_atPendingNonce) return;
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

    setTimeout(_atPrestart, 500);

    widget.addEventListener('reward', async () => {
        if (_AT.doneCount >= _AT.dailyLimit) {
            _atShow('atask-maxed-state');
            return;
        }

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
        _atPendingNonce = null;

        const claimRes = await _dbCall('claim_adsgram_task', {}, taskNonce);

        if (claimRes.ok) {
            const pts = claimRes.points;
            if (pts !== undefined) { animateBalance(_AS.balance, pts, 1200); _AS.balance = pts; }

            const earned = claimRes.earned || claimRes.reward || _AT.reward;
            _AT.doneCount = claimRes.adsgram_task_today_count || (_AT.doneCount + 1);
            _atUpdateCounter();

            showToast('trophy', 'مهمة إعلانية مكتملة 🎉', `+${earned.toLocaleString('en-US')} نقطة أُضيفت`, 'green', `+${earned}`);
            pushNotif('gold', 'مهمة إعلانية ✓', `+${earned.toLocaleString('en-US')} نقطة`);
            AdNotifQueue.push({ type:'success', title:'مهمة إعلانية ✓ 🎉', body:`+${earned.toLocaleString('en-US')} نقطة أُضيفت` });

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
        const wrap = document.getElementById('atask-widget-wrap');
        if (wrap) wrap.style.display = 'none';
        ['atask-loading-state','atask-cooldown-state','atask-maxed-state'].forEach(x => {
            const el = document.getElementById(x);
            if (el) el.style.display = 'none';
        });
        const action = document.getElementById('atask-action');
        if (action) {
            action.innerHTML = `<div style="display:inline-flex;align-items:center;gap:6px;padding:10px 14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.35);font-family:'Tajawal',sans-serif;font-size:12px;font-weight:700;">انتظر</div>`;
        }
    });

    widget.addEventListener('onTooLongSession', () => {
        showToast('coin', 'أعد تشغيل التطبيق', 'الجلسة طويلة جداً', 'red', '!');
        AdNotifQueue.push({ type:'timeout', title:'انتهت مهلة الجلسة', body:'يُرجى إعادة تشغيل التطبيق' });
    });

    widget.addEventListener('onError', () => {
        showToast('coin', 'خطأ في تحميل المهمة', 'حاول لاحقاً', 'red', '!');
        AdNotifQueue.push({ type:'error', title:'خطأ في تحميل الإعلان', body:'حاول مرة أخرى لاحقاً' });
    });
}

export function initAdsgramTaskUI(adsgramTaskData) {
    if (!adsgramTaskData) return;
    if (adsgramTaskData.reward)         _AT.reward      = adsgramTaskData.reward;
    if (adsgramTaskData.cooldown_ms)    _AT.cooldownMs  = adsgramTaskData.cooldown_ms;
    _atUpdateCounter();

    const { status, remaining_seconds } = adsgramTaskData;
    if (status === 'cooldown' && remaining_seconds > 0) {
        _atStartCooldown(remaining_seconds * 1000);
    } else if (status === 'ready') {
        _atShow(null);
    }
}

window.startAdsgramTask    = startAdsgramTask;
window.initAdsgramTaskUI   = initAdsgramTaskUI;
