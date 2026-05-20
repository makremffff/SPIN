// ═══════════════════════════════════════════════════════════════════
//  app-ads.js — daily ads | adsgram | rewards | tasks | ad flow
// ═══════════════════════════════════════════════════════════════════

// ── Adsgram Daily-Ads Controller ─────────────────────────────────
const AD_BLOCK_ID      = '30161';
const AD_MAX_RETRIES   = 2;
const AD_MIN_DURATION  = 7000;   // 7s client-side guard
const AD_PRELOAD_REQUIRED = 1;

let _adController     = null;
let _adWatchStartedAt = 0;
let _adRetryCount     = 0;

function _initAdController() {
    if (!window.Adsgram) return null;
    if (_adController)   return _adController;
    try {
        _adController = window.Adsgram.init({ blockId: AD_BLOCK_ID, debug: false, debugBanners: false });
    } catch (e) { _adController = null; }
    return _adController;
}

function _getAdController() {
    if (!window.Adsgram) return null;
    return _initAdController();
}

// ── trackAdEvent ──────────────────────────────────────────────────
// ad_type: 'daily_ad' | 'adsgram_task' — بدون تداخل
async function trackAdEvent(event, meta, ad_type) {
    try { await fetchApi({ type: 'track_ad_event', data: { event, ad_type: ad_type || 'daily_ad', meta: meta || {} } }); } catch (_) {}
}

// ── Show Adsgram Ad ───────────────────────────────────────────────
function _showAdsgramAd() {
    return new Promise(async (resolve) => {
        const controller = _getAdController();
        if (!controller) {
            await trackAdEvent('ad_failed', { reason: 'sdk_not_ready' }, 'daily_ad');
            resolve(false); return;
        }
        await trackAdEvent('ad_requested', { block_id: AD_BLOCK_ID }, 'daily_ad');
        _adWatchStartedAt = Date.now();

        try {
            const result = await controller.show();
            if (result && result.done === true) {
                const elapsed = Date.now() - _adWatchStartedAt;
                if (elapsed < AD_MIN_DURATION) {
                    await trackAdEvent('suspicious_activity', { reason: 'ad_too_short', elapsed_ms: elapsed }, 'daily_ad');
                    resolve(false); return;
                }
                _adRetryCount = 0;
                resolve(true);
            } else {
                await trackAdEvent('ad_failed', { reason: 'user_skipped', result_done: result?.done }, 'daily_ad');
                resolve(false);
            }
        } catch (result) {
            const errReason = result?.description || result?.state || 'unknown';
            if (result?.error === true) {
                await trackAdEvent('ad_failed', { reason: 'technical_error', message: errReason }, 'daily_ad');
                if (_adRetryCount < AD_MAX_RETRIES) {
                    _adRetryCount++;
                    _adController = null;
                    setTimeout(() => resolve(_showAdsgramAd()), 1500);
                    return;
                }
                _adRetryCount = 0;
            } else {
                await trackAdEvent('ad_failed', { reason: 'user_closed' }, 'daily_ad');
            }
            resolve(false);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════
//  watchAd — Daily Ads Flow (INDEPENDENT from Adsgram task)
// ═══════════════════════════════════════════════════════════════════
async function watchAd() {
    const ads = APP_STATE.ads;
    if (ads.remaining <= 0 || ads.isWatching) return;
    if (ads.cooldownUntil && Date.now() < ads.cooldownUntil) {
        const waitSec = Math.ceil((ads.cooldownUntil - Date.now()) / 1000);
        showToast('coin', 'انتظر قليلاً ⏳', `${waitSec} ثانية`, 'red', '');
        return;
    }

    ads.isWatching = true;
    const overlay    = document.getElementById('ad-watch-overlay');
    const countEl    = document.getElementById('overlay-count');
    const adBtn      = document.getElementById('ad-watch-btn');
    const preloadBar = document.getElementById('ad-preload-bar');
    if (adBtn) adBtn.classList.add('disabled');

    // Wait for SDK
    if (!window.Adsgram || window._adsgramLoadStatus !== 'loaded') {
        if (window._adsgramLoadStatus === 'failed') {
            _adReset(adBtn);
            showToast('coin', 'تعذّر تحميل الإعلان', 'تحقق من اتصالك', 'red', '');
            return;
        }
        if (overlay) { if (countEl) countEl.textContent = '⏳'; overlay.classList.add('visible'); }
        const sdkLoaded = await new Promise(res => {
            const t = setTimeout(() => res(false), 8000);
            window.onAdsgramLoaded(s => { clearTimeout(t); res(s !== 'failed'); });
        });
        if (overlay) overlay.classList.remove('visible');
        if (!sdkLoaded) { _adReset(adBtn); showToast('coin', 'تعذّر تحميل الإعلان', 'تحقق من اتصالك', 'red', ''); return; }
    }

    let successCount = 0;

    for (let i = 0; i < AD_PRELOAD_REQUIRED; i++) {
        if (overlay) {
            if (countEl) countEl.textContent = `${i + 1} / ${AD_PRELOAD_REQUIRED}`;
            const labelEl = document.getElementById('overlay-label');
            if (labelEl) labelEl.textContent = 'جاري تحميل الإعلان...';
            overlay.classList.add('visible');
        }
        _updatePreloadBar(preloadBar, i, AD_PRELOAD_REQUIRED);
        await new Promise(r => setTimeout(r, 600));
        if (overlay) overlay.classList.remove('visible');

        await trackAdEvent('ad_started', { block_id: AD_BLOCK_ID, attempt: i + 1 }, 'daily_ad');
        const adShown = await _showAdsgramAd();

        if (!adShown) {
            const elapsed = Date.now() - _adWatchStartedAt;
            const failTitle = elapsed < 1000 ? '❌ لم تبدأ مشاهدة الإعلان' : elapsed < 6000 ? `⚠️ الإعلان ${i + 1} لم يكتمل` : '⚠️ تعذّر تشغيل الإعلان';
            const failSub   = elapsed < 6000 ? `شاهده حتى النهاية (${successCount}/${AD_PRELOAD_REQUIRED} مكتمل)` : 'حاول مرة أخرى';
            showToast('coin', failTitle, failSub, 'red', '');
            _adReset(adBtn);
            _updatePreloadBar(preloadBar, successCount, AD_PRELOAD_REQUIRED);
            return;
        }

        await trackAdEvent('ad_completed', { elapsed_ms: Date.now() - _adWatchStartedAt }, 'daily_ad');
        successCount++;

        if (i < AD_PRELOAD_REQUIRED - 1) {
            const left = AD_PRELOAD_REQUIRED - successCount;
            const WAIT_SEC = 6;
            if (overlay) overlay.classList.add('visible');
            const labelEl = document.getElementById('overlay-label');
            await new Promise(resolve => {
                let rem = WAIT_SEC;
                if (countEl) countEl.textContent = `${rem}s`;
                if (labelEl) labelEl.textContent  = `إعلان ${successCount} ✓ — التالي بعد ${rem}s`;
                const tick = setInterval(() => {
                    rem--;
                    if (countEl) countEl.textContent = `${rem}s`;
                    if (labelEl) labelEl.textContent  = `إعلان ${successCount} ✓ — التالي بعد ${rem}s`;
                    if (rem <= 0) { clearInterval(tick); if (overlay) overlay.classList.remove('visible'); resolve(); }
                }, 1000);
            });
            showToast('coin', `إعلان ${successCount} مكتمل ✓`, `${left} ${left === 1 ? 'إعلان متبقي' : 'إعلانات متبقية'} للمكافأة`, 'gold', '');
        }
    }

    _updatePreloadBar(preloadBar, AD_PRELOAD_REQUIRED, AD_PRELOAD_REQUIRED);

    // start_ad → ad_nonce
    const startRes = await _dbCall('start_ad', {});
    if (!startRes.ok) {
        _adReset(adBtn);
        _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);
        if (startRes.error === 'daily_limit_reached') { ads.remaining = 0; updateAdUI(); }
        else if (startRes.error === 'cooldown_active') {
            ads.cooldownUntil = Date.now() + (startRes.wait_ms || 30000);
            updateAdUI();
        } else { showToast('coin', 'خطأ في المعالجة', 'حاول مرة أخرى', 'red', ''); }
        return;
    }

    const _adNonce = startRes.ad_nonce;
    if (!_adNonce) {
        _adReset(adBtn);
        _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);
        showToast('coin', 'خطأ في المعالجة', 'حاول مرة أخرى', 'red', '');
        return;
    }

    // reward_ad
    const result = await fetchApi({
        type: 'reward_ad',
        data: { ad_started_at: _adWatchStartedAt, preload_count: successCount },
        _nonce: _adNonce,
    });

    _adReset(adBtn);
    _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);

    if (result.ok) {
        // Update state from server
        ads.remaining    = result.remaining;
        ads.watched      = result.watchedToday;
        ads.earned       = result.earnedToday;
        ads.cooldownUntil = Date.now() + (result.cooldown_ms || APP_CONFIG.ads?.cooldown_ms || 30000);
        if (result.points !== undefined) {
            animateBalance(APP_STATE.balance, result.points, 1200);
            APP_STATE.balance = result.points;
        }

        // Toast + vibrate
        const _adPts = APP_CONFIG.rewards?.points_per_ad || 50;
        showToast('trophy', 'مبروك! 🎉', `تم إضافة +${_adPts.toLocaleString()} نقطة`, 'green', `+${_adPts}`);
        addNotification('gold', 'مكافأة إعلان يومي ✓', `+${_adPts.toLocaleString('ar-EG')} نقطة — شاهدت ${result.watchedToday} إعلان اليوم`, Date.now());
        updateAdUI();
        await trackAdEvent('reward_granted', { watched_today: result.watchedToday }, 'daily_ad');
    } else {
        if (result.error === 'cooldown_active') {
            ads.cooldownUntil = Date.now() + (result.wait_ms || 30000);
            updateAdUI();
        } else if (result.error === 'ad_duration_invalid') {
            showToast('coin', 'الإعلان لم يكتمل', 'شاهد الإعلان بالكامل', 'red', '');
        } else if (result.error === 'daily_limit_reached') {
            ads.remaining = 0;
            showToast('trophy', 'انتهت إعلانات اليوم 🏆', 'عُد غداً لمزيد من النقاط', 'green', '');
        } else if (['nonce_missing', 'nonce_not_issued', 'nonce_expired', 'invalid'].includes(result.error)) {
            showToast('coin', 'انتهت الجلسة', 'اضغط مرة أخرى', 'red', '');
        } else {
            showToast('coin', 'خطأ في المعالجة', 'حاول مرة أخرى', 'red', '');
        }
        updateAdUI();
    }
}

function _adReset(adBtn) {
    APP_STATE.ads.isWatching = false;
    if (adBtn) adBtn.classList.remove('disabled');
}

// ═══════════════════════════════════════════════════════════════════
//  ADSGRAM TASK — Custom Card (NO raw widget rendering)
//  State machine: empty → ready → watching → claim → cooldown → empty
// ═══════════════════════════════════════════════════════════════════

function _clearAdsgramTimer() {
    if (APP_STATE.adsgram.localTimer) { clearInterval(APP_STATE.adsgram.localTimer); APP_STATE.adsgram.localTimer = null; }
}

// ── Build task card content from server state ─────────────────────
// IMPORTANT: We render the card ourselves — never show raw Adsgram widget HTML
function syncAdsgramStateFromServer(adsgramState) {
    if (!adsgramState) return;
    const { status, remaining_seconds, reward, claimed } = adsgramState;

    const outer = document.getElementById('adsgram-task-outer');
    const card  = document.getElementById('adsgram-task-card');
    const done  = document.getElementById('adsgram-task-done');

    // Always update title from config
    const titleEl = document.getElementById('adsgram-task-title');
    if (titleEl) {
        const lang     = (typeof currentLang !== 'undefined') ? currentLang : 'ar';
        const cfgTitle = (lang === 'en' && APP_CONFIG?.adsgram_task?.title_en)
            ? APP_CONFIG.adsgram_task.title_en
            : (APP_CONFIG?.adsgram_task?.title_ar || '');
        titleEl.textContent = cfgTitle || titleEl.textContent || 'مهمة إعلانية';
    }

    if (status === 'ready') {
        // Show clean custom card — hide raw widget output
        if (outer) outer.style.display = 'block';
        if (card)  { card.style.display = 'flex'; card.style.opacity = '1'; _renderAdsgramReadyCard(card); }
        if (done)  done.style.display   = 'none';
        _clearAdsgramTimer();
        APP_STATE.adsgram.hasTask = true;
    } else if (status === 'watching') {
        if (outer) outer.style.display = 'block';
        if (card)  card.style.display  = 'none';
        if (done)  { done.style.display = 'block'; }
        _startAdsgramCountdown(remaining_seconds, reward);
        APP_STATE.adsgram.hasTask = true;
    } else if (status === 'claim') {
        if (outer) outer.style.display = 'block';
        if (card)  card.style.display  = 'none';
        if (done)  { done.style.display = 'block'; }
        _showAdsgramClaimReady(reward);
        _clearAdsgramTimer();
        APP_STATE.adsgram.hasTask = true;
    } else if (status === 'cooldown') {
        if (outer) outer.style.display = 'block';
        if (card)  card.style.display  = 'none';
        if (done)  { done.style.display = 'block'; }
        _showAdsgramCooldown(remaining_seconds);
        APP_STATE.adsgram.hasTask = false;
    } else if (status === 'completed' || status === 'none') {
        // Hide everything — clean empty state
        if (outer) outer.style.display = 'none';
        if (card)  card.style.display  = 'none';
        if (done)  done.style.display  = 'none';
        _clearAdsgramTimer();
        APP_STATE.adsgram.hasTask = false;
    } else {
        // Unknown status — hide card to prevent blank white card
        if (outer) outer.style.display = 'none';
        APP_STATE.adsgram.hasTask = false;
    }
}

// ── Render our custom "ready" card — NO raw widget text ────────────
function _renderAdsgramReadyCard(card) {
    // Suppress any text injected by Adsgram SDK by hiding the widget element
    const widget = document.getElementById('adsgram-task-widget');
    if (widget) widget.style.display = 'none';

    const r = APP_CONFIG.rewards?.adsgram_task || 50;

    // Build our own action button
    let actionWrap = card.querySelector('.adsgram-custom-action');
    if (!actionWrap) {
        actionWrap = document.createElement('div');
        actionWrap.className = 'adsgram-custom-action';
        actionWrap.style.cssText = 'flex-shrink:0;';
        card.appendChild(actionWrap);
    }

    actionWrap.innerHTML = `
        <button onclick="watchAdsgramTask()" style="
            display:inline-flex;align-items:center;gap:7px;
            padding:10px 18px;border-radius:12px;
            border:1px solid rgba(251,191,36,0.45);
            background:linear-gradient(135deg,rgba(251,191,36,0.22),rgba(251,191,36,0.08));
            color:#fbbf24;font-family:'Tajawal',sans-serif;font-size:13px;
            font-weight:800;cursor:pointer;white-space:nowrap;
            box-shadow:0 4px 14px rgba(251,191,36,0.1);
            transition:all 0.22s cubic-bezier(0.34,1.56,0.64,1);"
            onmouseenter="this.style.transform='scale(1.04)'"
            onmouseleave="this.style.transform=''"
            id="adsgram-watch-btn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="rgba(251,191,36,0.15)" stroke="rgba(251,191,36,0.5)" stroke-width="1.4"/>
                <path d="M10 8.5l6 3.5-6 3.5V8.5z" fill="#fbbf24"/>
            </svg>
            ابدأ المهمة
            <span style="background:rgba(251,191,36,0.15);padding:2px 8px;border-radius:8px;font-size:11px;">+${r}</span>
        </button>`;
}

function _startAdsgramCountdown(seconds, reward) {
    const done = document.getElementById('adsgram-task-done');
    if (!done) return;
    let s = Math.max(0, parseInt(seconds) || 60);

    const render = () => {
        const pct = Math.round(((60 - s) / 60) * 100);
        done.innerHTML = `
            <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px;">
                <div style="width:38px;height:38px;border-radius:11px;flex-shrink:0;
                    background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);
                    display:flex;align-items:center;justify-content:center;font-size:17px;">⏳</div>
                <div style="flex:1;">
                    <div style="font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;
                        color:rgba(251,191,36,0.85);margin-bottom:2px;">جاري المشاهدة...</div>
                    <div style="font-family:'Readex Pro',sans-serif;font-size:11px;
                        color:rgba(255,255,255,0.4);">المكافأة خلال ${s} ثانية</div>
                </div>
                <span style="font-family:'DynaPuff',sans-serif;font-size:12px;
                    font-weight:700;color:rgba(251,191,36,0.7);">${s}s</span>
            </div>
            <div style="height:3px;background:rgba(251,191,36,0.07);border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#f59e0b,#fbbf24);
                    border-radius:3px;transition:width 1s linear;"></div>
            </div>`;
    };
    render();
    _clearAdsgramTimer();
    APP_STATE.adsgram.localTimer = setInterval(() => {
        s--;
        if (s <= 0) { _clearAdsgramTimer(); _showAdsgramClaimReady(reward); }
        else render();
    }, 1000);
}

function _showAdsgramClaimReady(reward) {
    const done = document.getElementById('adsgram-task-done');
    if (!done) return;
    const r = reward || APP_CONFIG.rewards?.adsgram_task || 50;
    done.innerHTML = `
        <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px;">
            <div style="width:38px;height:38px;border-radius:11px;flex-shrink:0;
                background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);
                display:flex;align-items:center;justify-content:center;font-size:17px;">🎁</div>
            <div style="flex:1;">
                <div style="font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;
                    color:rgba(52,211,153,0.9);margin-bottom:2px;">المهمة مكتملة!</div>
                <div style="font-family:'Readex Pro',sans-serif;font-size:11px;
                    color:rgba(255,255,255,0.4);">اجمع مكافأتك الآن</div>
            </div>
        </div>
        <button onclick="claimAdsgramTaskReward()" style="
            width:100%;padding:12px;border-radius:12px;border:1px solid rgba(52,211,153,0.3);
            cursor:pointer;background:linear-gradient(135deg,rgba(52,211,153,0.2),rgba(52,211,153,0.1));
            font-family:'Tajawal',sans-serif;font-size:14px;font-weight:800;
            color:#34d399;display:flex;align-items:center;justify-content:center;gap:8px;
            transition:all 0.25s ease;" id="adsgram-claim-btn">
            🎁 جمع المكافأة
            <span style="background:rgba(52,211,153,0.15);padding:2px 10px;border-radius:8px;font-size:12px;">+${r}</span>
        </button>`;
}

function _showAdsgramCooldown(seconds) {
    const done = document.getElementById('adsgram-task-done');
    if (!done) return;
    let s = Math.max(0, parseInt(seconds) || 60);

    const render = () => {
        const pct = Math.round(((60 - s) / 60) * 100);
        done.innerHTML = `
            <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px;">
                <div style="width:38px;height:38px;border-radius:11px;flex-shrink:0;
                    background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);
                    display:flex;align-items:center;justify-content:center;font-size:17px;">✓</div>
                <div style="flex:1;">
                    <div style="font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;
                        color:rgba(52,211,153,0.85);margin-bottom:2px;">مهمة مكتملة</div>
                    <div style="font-family:'Readex Pro',sans-serif;font-size:11px;
                        color:rgba(255,255,255,0.4);">المهمة التالية خلال ${s} ثانية</div>
                </div>
                <span style="font-family:'DynaPuff',sans-serif;font-size:12px;
                    font-weight:700;color:rgba(255,255,255,0.3);">${s}s</span>
            </div>
            <div style="height:2px;background:rgba(52,211,153,0.07);border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:rgba(52,211,153,0.35);
                    border-radius:3px;transition:width 1s linear;"></div>
            </div>`;
    };
    render();
    _clearAdsgramTimer();
    APP_STATE.adsgram.localTimer = setInterval(() => {
        s--;
        if (s <= 0) {
            _clearAdsgramTimer();
            // Reset to ready — show custom card again
            const outer = document.getElementById('adsgram-task-outer');
            const card  = document.getElementById('adsgram-task-card');
            if (done) done.style.display = 'none';
            if (card) { card.style.display = 'flex'; card.style.opacity = '1'; _renderAdsgramReadyCard(card); }
            if (outer) outer.style.display = 'block';
        } else render();
    }, 1000);
}

// ── Claim Adsgram Task Reward ─────────────────────────────────────
async function claimAdsgramTaskReward() {
    if (APP_STATE.adsgram.claimSucceeded)  { console.warn('[AdsgramTask] already succeeded'); return; }
    if (APP_STATE.adsgram.claimInProgress) { console.warn('[AdsgramTask] claim in progress'); return; }
    APP_STATE.adsgram.claimInProgress = true;

    // Disable claim button to prevent spam
    const claimBtn = document.getElementById('adsgram-claim-btn');
    if (claimBtn) { claimBtn.disabled = true; claimBtn.style.opacity = '0.6'; }

    try {
        await _claimAdsgramTaskRewardInner();
    } finally {
        APP_STATE.adsgram.claimInProgress = false;
        if (claimBtn && !APP_STATE.adsgram.claimSucceeded) { claimBtn.disabled = false; claimBtn.style.opacity = '1'; }
    }
}

async function _claimAdsgramTaskRewardInner() {
    const nonce = APP_STATE.adsgram.taskNonce || null;
    if (!nonce) { console.warn('[AdsgramTask] no task_nonce — aborting'); return; }

    const result = await _dbCall('claim_adsgram_task', {}, nonce);

    if (result.ok) {
        APP_STATE.adsgram.claimSucceeded = true;
        APP_STATE.adsgram.taskNonce      = null;

        animateBalance(APP_STATE.balance, result.points, 1000);
        APP_STATE.balance = result.points;

        const taskPts = result.reward || APP_CONFIG.rewards?.adsgram_task || 50;
        showToast('trophy', 'مبروك! 🎁', `تم إضافة +${taskPts.toLocaleString()} نقطة من المهمة`, 'green', `+${taskPts}`);
        addNotification('gold', 'مكافأة المهمة الإعلانية ✓', `+${taskPts.toLocaleString('ar-EG')} نقطة أُضيفت لرصيدك`, Date.now());

        // Hide card immediately
        ['adsgram-task-outer', 'adsgram-task-card', 'adsgram-task-done'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        _clearAdsgramTimer();
        APP_STATE.adsgram.taskInProgress = false;

        // Cooldown period — show card again after server cooldown
        const cdMs = APP_CONFIG.adsgram_task?.cooldown_ms || 230000;
        setTimeout(() => {
            APP_STATE.adsgram.claimSucceeded = false;
            if (result.adsgram_task) syncAdsgramStateFromServer(result.adsgram_task);
            else {
                // Default: show cooldown
                const outer = document.getElementById('adsgram-task-outer');
                if (outer) outer.style.display = 'block';
            }
        }, cdMs);

    } else {
        const e = result.error;
        if (e === 'already_claimed_today' || e === 'cooldown_active') {
            APP_STATE.adsgram.claimSucceeded = true;
            if (result.adsgram_task) syncAdsgramStateFromServer(result.adsgram_task);
        } else if (e === 'task_too_fast' || e === 'task_not_started') {
            console.warn('[AdsgramTask]', e);
        } else if (e === 'account_review') {
            showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        } else if (e === 'nonce_used' || e === 'nonce_expired' || e === 'invalid' || e === 'nonce_missing') {
            APP_STATE.adsgram.claimSucceeded = true;
        } else {
            console.warn('[AdsgramTask] claim failed silently:', e);
        }
        APP_STATE.adsgram.taskInProgress = false;
    }
}

// ── watchAdsgramTask — triggered by our custom button ─────────────
async function watchAdsgramTask() {
    if (APP_STATE.adsgram.taskInProgress) return;
    APP_STATE.adsgram.taskInProgress = true;

    // Disable button immediately
    const watchBtn = document.getElementById('adsgram-watch-btn');
    if (watchBtn) { watchBtn.disabled = true; watchBtn.style.opacity = '0.6'; }

    // [1] start_adsgram_task — get task_nonce from server
    let startRes;
    try {
        startRes = await _dbCall('start_adsgram_task', {});
    } catch (_) {
        startRes = { ok: false, error: 'network_error' };
    }

    if (!startRes.ok) {
        APP_STATE.adsgram.taskInProgress = false;
        if (watchBtn) { watchBtn.disabled = false; watchBtn.style.opacity = '1'; }
        if (startRes.error === 'cooldown_active') {
            const sec = Math.ceil((startRes.wait_ms || 60000) / 1000);
            const min = Math.floor(sec / 60);
            const label = min > 0 ? `${min} دقيقة` : `${sec} ثانية`;
            showToast('coin', 'انتظر قليلاً ⏳', label, 'red', '');
        } else {
            showToast('coin', 'حدث خطأ', 'حاول مرة أخرى', 'red', '');
        }
        return;
    }

    APP_STATE.adsgram.taskNonce = startRes.task_nonce || null;
    await trackAdEvent('ad_started', { block_id: APP_CONFIG.adsgram_task?.block_id || 'task-30166', type: 'adsgram_task' }, 'adsgram_task');

    // [2] Show Adsgram Task via SDK (using task block_id, not daily block_id)
    const taskBlockId = APP_CONFIG.adsgram_task?.block_id || 'task-30166';
    let taskController = null;
    try {
        if (window.Adsgram) {
            taskController = window.Adsgram.init({ blockId: taskBlockId, debug: false });
        }
    } catch (e) { console.warn('[AdsgramTask] init error:', e.message); }

    if (!taskController) {
        APP_STATE.adsgram.taskInProgress = false;
        if (watchBtn) { watchBtn.disabled = false; watchBtn.style.opacity = '1'; }
        showToast('coin', 'تعذّر تشغيل المهمة', 'تحقق من اتصالك', 'red', '');
        return;
    }

    // Show countdown in done area while task is pending
    const done = document.getElementById('adsgram-task-done');
    const card = document.getElementById('adsgram-task-card');
    if (done && card) { card.style.display = 'none'; done.style.display = 'block'; }
    _startAdsgramCountdown(60, startRes.reward || APP_CONFIG.rewards?.adsgram_task || 50);

    try {
        const result = await taskController.show();
        const elapsed = Date.now() - (startRes._started_at || Date.now());
        if (result && result.done === true) {
            // Widget says done — try to claim immediately
            _clearAdsgramTimer();
            await claimAdsgramTaskReward();
            await trackAdEvent('ad_completed', { elapsed_ms: elapsed }, 'adsgram_task');
        } else {
            // User closed / skipped
            _clearAdsgramTimer();
            APP_STATE.adsgram.taskInProgress = false;
            if (card) { card.style.display = 'flex'; if (done) done.style.display = 'none'; _renderAdsgramReadyCard(card); }
        }
    } catch (result) {
        _clearAdsgramTimer();
        APP_STATE.adsgram.taskInProgress = false;
        if (result?.done === false) {
            // User skipped — reset to ready
            if (card) { card.style.display = 'flex'; if (done) done.style.display = 'none'; _renderAdsgramReadyCard(card); }
        }
        // Technical error — show claim button if nonce exists
        else if (APP_STATE.adsgram.taskNonce) {
            _showAdsgramClaimReady(APP_CONFIG.rewards?.adsgram_task || 50);
            if (done) done.style.display = 'block';
        }
    }
}

// ── initAdsgramTask — listen to widget events as backup ───────────
function initAdsgramTask() {
    const widget = document.getElementById('adsgram-task-widget');
    if (!widget) return;

    // Suppress all raw output from the widget — we render our own UI
    widget.style.display  = 'none';
    widget.style.position = 'absolute';
    widget.style.opacity  = '0';
    widget.style.pointerEvents = 'none';

    // Backup event listeners in case SDK fires them
    widget.addEventListener('reward', async () => {
        if (APP_STATE.adsgram.claimSucceeded) return;
        const elapsed = Date.now() - (APP_STATE.adsgram._taskStartedAt || Date.now());
        if (elapsed < 1800) await new Promise(r => setTimeout(r, 1800 - elapsed));
        await claimAdsgramTaskReward();
    });
    widget.addEventListener('error', () => { APP_STATE.adsgram.taskInProgress = false; });
}
