// ══════════════════════════════════════════════════════════
// app-ads.js — Ads · Adsgram · Tasks · Channels · Init
// ══════════════════════════════════════════════════════════

import {
    APP_STATE, APP_CONFIG, _SERVER_CONFIG,
    USER_STATE, AD_STATE, TASKS_STATE, DAILY_GIFT_STATE,
    NOTIF_LIST_DATA, WITHDRAW_HISTORY,
    fetchApi, _dbCall, createSession,
    initTelegramUser, _applyConfigToUI, _fetchAppConfig,
    REFERRAL_LINK, BOT_USERNAME, CURRENT_USER_ID,
    _updateReferralLinkUI,
} from './app-core.js';

import {
    showToast, animateBalance, updateBalanceUI, runCounters,
    showPage, _hideLoadingScreen, _refreshWithdrawPageUI,
    addNotification, renderReferralList, renderWithdrawHistory,
    formatTimeAgo,
} from './app-ui.js';

// ══════════════════════════════════════════════════════════
// AD SYSTEM CONSTANTS
// ══════════════════════════════════════════════════════════
const AD_BLOCK_ID       = '30161';
const AD_TASK_BLOCK_ID  = APP_CONFIG.adsgram_task?.block_id || 'task-30166';
const AD_MAX_RETRIES    = 2;
const AD_MIN_DURATION   = 7000;
const AD_PRELOAD_REQUIRED = 1;

let _adController      = null;
let _adWatchStartedAt  = 0;
let _adRetryCount      = 0;

// Adsgram Task — separate timers/flags from daily ads
let _adsgramLocalTimer = null;
let _adsgramTaskNonce  = null;  // module-level (was window._adsgramTaskNonce)

// ══════════════════════════════════════════════════════════
// AD CONTROLLER
// ══════════════════════════════════════════════════════════
function _initAdController() {
    if (!window.Adsgram) return null;
    if (_adController) return _adController;
    try {
        _adController = window.Adsgram.init({ blockId: AD_BLOCK_ID, debug: false, debugBanners: false });
    } catch (e) {
        _adController = null;
    }
    return _adController;
}

function _getAdController() {
    if (!window.Adsgram) return null;
    return _initAdController();
}

// ══════════════════════════════════════════════════════════
// ADSGRAM TASK — Custom Card (hides raw widget)
// ══════════════════════════════════════════════════════════
function _clearAdsgramTimer() {
    if (_adsgramLocalTimer) { clearInterval(_adsgramLocalTimer); _adsgramLocalTimer = null; }
}

/**
 * Renders the Adsgram task card based on server state.
 * States: ready | watching | claim | cooldown | completed | none
 */
export function _syncAdsgramStateFromServer(adsgramState) {
    if (!adsgramState) return;
    const { status, remaining_seconds, reward } = adsgramState;

    const outer = document.getElementById('adsgram-task-outer');
    const card  = document.getElementById('adsgram-task-card');
    const done  = document.getElementById('adsgram-task-done');

    // Update title from config
    const titleEl = document.getElementById('adsgram-task-title');
    if (titleEl) {
        const lang = window.currentLang || 'ar';
        const cfgTitle = (lang === 'en' && APP_CONFIG?.adsgram_task?.title_en)
            ? APP_CONFIG.adsgram_task.title_en
            : (APP_CONFIG?.adsgram_task?.title_ar || '');
        if (cfgTitle) titleEl.textContent = cfgTitle;
    }

    switch (status) {
        case 'ready':
            _showAdsgramOuter(true);
            _showAdsgramCard(true);
            _showAdsgramDone(false);
            _renderAdsgramEmptyState(false);
            _clearAdsgramTimer();
            break;

        case 'watching':
            _showAdsgramOuter(true);
            _showAdsgramCard(false);
            _showAdsgramDone(true);
            _renderAdsgramCountdown(remaining_seconds, reward);
            break;

        case 'claim':
            _showAdsgramOuter(true);
            _showAdsgramCard(false);
            _showAdsgramDone(true);
            _renderAdsgramClaimReady(reward);
            _clearAdsgramTimer();
            break;

        case 'cooldown':
            _showAdsgramOuter(true);
            _showAdsgramCard(false);
            _showAdsgramDone(true);
            _renderAdsgramCooldown(remaining_seconds);
            break;

        case 'completed':
        default:
            _showAdsgramOuter(false);
            _clearAdsgramTimer();
            break;
    }
}

// Helper show/hide
function _showAdsgramOuter(show) {
    const el = document.getElementById('adsgram-task-outer');
    if (el) el.style.display = show ? 'block' : 'none';
}
function _showAdsgramCard(show) {
    const el = document.getElementById('adsgram-task-card');
    if (el) { el.style.display = show ? 'flex' : 'none'; el.style.opacity = '1'; }
}
function _showAdsgramDone(show) {
    const el = document.getElementById('adsgram-task-done');
    if (el) el.style.display = show ? 'block' : 'none';
}

function _renderAdsgramEmptyState(show) {
    const done = document.getElementById('adsgram-task-done');
    if (!done || !show) return;
    done.style.display = 'block';
    done.innerHTML = `
        <div style="display:flex;align-items:center;gap:11px;padding:4px 0;">
            <div style="width:36px;height:36px;border-radius:10px;flex-shrink:0;
                background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);
                display:flex;align-items:center;justify-content:center;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                </svg>
            </div>
            <div style="flex:1;">
                <div style="font-family:'Tajawal',sans-serif;font-size:13px;font-weight:700;
                    color:rgba(255,255,255,0.4);">لا توجد مهمة حالياً</div>
                <div style="font-family:'Readex Pro',sans-serif;font-size:11px;
                    color:rgba(255,255,255,0.2);margin-top:2px;">تحقق لاحقاً</div>
            </div>
        </div>`;
}

function _renderAdsgramCountdown(seconds, reward) {
    const done = document.getElementById('adsgram-task-done');
    if (!done) return;
    let s = Math.max(0, parseInt(seconds) || 60);

    const render = () => {
        const pct = Math.round(((60 - s) / 60) * 100);
        done.innerHTML = `
            <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px;">
                <div style="width:38px;height:38px;border-radius:11px;flex-shrink:0;
                    background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);
                    display:flex;align-items:center;justify-content:center;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(251,191,36,0.8)" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                    </svg>
                </div>
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
    _adsgramLocalTimer = setInterval(() => {
        s--;
        if (s <= 0) { _clearAdsgramTimer(); _renderAdsgramClaimReady(reward); }
        else render();
    }, 1000);
}

function _renderAdsgramClaimReady(reward) {
    const done = document.getElementById('adsgram-task-done');
    if (!done) return;
    _showAdsgramDone(true);
    const r = reward || APP_CONFIG.rewards.adsgram_task || 30;
    done.innerHTML = `
        <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px;">
            <div style="width:38px;height:38px;border-radius:11px;flex-shrink:0;
                background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);
                display:flex;align-items:center;justify-content:center;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2">
                    <path d="M6 2h12v8a6 6 0 01-12 0V2z" stroke-linejoin="round"/>
                    <path d="M12 16v4M9 20h6" stroke-linecap="round"/>
                </svg>
            </div>
            <div style="flex:1;">
                <div style="font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;
                    color:rgba(52,211,153,0.9);margin-bottom:2px;">المهمة مكتملة!</div>
                <div style="font-family:'Readex Pro',sans-serif;font-size:11px;
                    color:rgba(255,255,255,0.4);">اجمع مكافأتك الآن</div>
            </div>
        </div>
        <button onclick="window.claimAdsgramTaskReward()" style="
            width:100%;padding:12px;border-radius:12px;border:1px solid rgba(52,211,153,0.3);
            cursor:pointer;background:linear-gradient(135deg,rgba(52,211,153,0.2),rgba(52,211,153,0.1));
            font-family:'Tajawal',sans-serif;font-size:14px;font-weight:800;color:#34d399;
            display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.25s ease;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2">
                <path d="M6 2h12v8a6 6 0 01-12 0V2z" stroke-linejoin="round"/>
            </svg>
            جمع المكافأة
            <span style="background:rgba(52,211,153,0.15);padding:2px 10px;border-radius:8px;font-size:12px;">+${r}</span>
        </button>`;
}

function _renderAdsgramCooldown(seconds) {
    const done = document.getElementById('adsgram-task-done');
    if (!done) return;
    const totalCd = APP_CONFIG.adsgram_task?.cooldown_ms
        ? Math.ceil(APP_CONFIG.adsgram_task.cooldown_ms / 1000) : 60;
    let s = Math.max(0, parseInt(seconds) || totalCd);

    const render = () => {
        const pct = Math.round(((totalCd - s) / totalCd) * 100);
        done.innerHTML = `
            <div style="display:flex;align-items:center;gap:11px;margin-bottom:9px;">
                <div style="width:38px;height:38px;border-radius:11px;flex-shrink:0;
                    background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);
                    display:flex;align-items:center;justify-content:center;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
                    </svg>
                </div>
                <div style="flex:1;">
                    <div style="font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;
                        color:rgba(52,211,153,0.85);margin-bottom:2px;">مهمة مكتملة ✓</div>
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
    _adsgramLocalTimer = setInterval(() => {
        s--;
        if (s <= 0) {
            _clearAdsgramTimer();
            _showAdsgramCard(true);
            _showAdsgramDone(false);
        } else render();
    }, 1000);
}

// ── Claim Adsgram Reward ────────────────────────────────
export async function claimAdsgramTaskReward() {
    if (APP_STATE.adsgram.claimSucceeded) return;
    if (APP_STATE.adsgram.claimInProgress) return;
    APP_STATE.adsgram.claimInProgress = true;
    try { await _claimAdsgramInner(); }
    finally { APP_STATE.adsgram.claimInProgress = false; }
}

async function _claimAdsgramInner() {
    const nonce = _adsgramTaskNonce;
    if (!nonce) return;

    const result = await _dbCall('claim_adsgram_task', {}, nonce);

    if (result.ok) {
        APP_STATE.adsgram.claimSucceeded = true;
        _adsgramTaskNonce = null;
        animateBalance(APP_STATE.balance, result.points, 1000);
        APP_STATE.balance = result.points;
        const taskPts = result.reward || APP_CONFIG.rewards?.adsgram_task || 50;
        showToast('trophy', 'مبروك! 🎁', `تم إضافة +${taskPts.toLocaleString()} نقطة`, 'green', `+${taskPts}`);
        addNotification('gold', 'مكافأة المهمة الإعلانية ✓', `+${taskPts.toLocaleString('ar-EG')} نقطة أُضيفت لرصيدك`, Date.now());

        // Hide card, reset after cooldown
        _showAdsgramOuter(false);
        _clearAdsgramTimer();
        APP_STATE.adsgram.inProgress = false;

        const cooldownMs = APP_CONFIG.adsgram_task?.cooldown_ms || 230000;
        setTimeout(() => {
            APP_STATE.adsgram.claimSucceeded = false;
            if (result.adsgram_task) _syncAdsgramStateFromServer(result.adsgram_task);
            else { _showAdsgramOuter(true); _showAdsgramCard(true); _showAdsgramDone(false); }
        }, cooldownMs);

    } else {
        const e = result.error;
        if (e === 'already_claimed_today' || e === 'cooldown_active') {
            APP_STATE.adsgram.claimSucceeded = true;
            if (result.adsgram_task) _syncAdsgramStateFromServer(result.adsgram_task);
        } else if (e === 'nonce_used' || e === 'nonce_expired' || e === 'invalid' || e === 'nonce_missing') {
            APP_STATE.adsgram.claimSucceeded = true;
        } else if (e === 'account_review') {
            showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        }
        // task_too_fast / task_not_started — silent
        APP_STATE.adsgram.inProgress = false;
    }
}

// ── Watch Adsgram Task (custom button handler) ──────────
export async function watchAdsgramTask() {
    if (APP_STATE.adsgram.inProgress) return;
    APP_STATE.adsgram.inProgress = true;

    // Disable custom button
    const customBtn = document.getElementById('adsgram-custom-btn');
    if (customBtn) { customBtn.disabled = true; customBtn.style.opacity = '0.6'; }

    let startRes;
    try {
        startRes = await _dbCall('start_adsgram_task', {});
    } catch (_) {
        startRes = { ok: false, error: 'network_error' };
    }

    if (!startRes.ok) {
        APP_STATE.adsgram.inProgress = false;
        if (customBtn) { customBtn.disabled = false; customBtn.style.opacity = '1'; }
        if (startRes.error === 'cooldown_active') {
            const sec = Math.ceil((startRes.wait_ms || 60000) / 1000);
            showToast('coin', 'انتظر قليلاً ⏳', `${sec} ثانية`, 'red', '');
        } else {
            showToast('coin', 'حدث خطأ', 'حاول مرة أخرى', 'red', '');
        }
        return;
    }

    _adsgramTaskNonce = startRes.task_nonce || null;
    if (customBtn) { customBtn.disabled = false; customBtn.style.opacity = '1'; }

    // Trigger the hidden widget
    const widget = document.getElementById('adsgram-task-widget');
    try {
        if (widget && typeof widget.show === 'function') {
            widget.show();
        } else if (widget) {
            const inner = widget.querySelector('button');
            if (inner) inner.click();
        }
    } catch (e) {
        console.warn('[AdsgramTask] show() error:', e.message);
        APP_STATE.adsgram.inProgress = false;
    }
}

// ── Init Adsgram Task Widget Events ────────────────────
let _taskStartedAt = 0;

function _initAdsgramTask() {
    const widget = document.getElementById('adsgram-task-widget');
    if (!widget) return;

    widget.addEventListener('start', async () => {
        _taskStartedAt = Date.now();
        APP_STATE.adsgram.claimSucceeded = false;
        try {
            const startRes = await _dbCall('start_adsgram_task', {});
            if (startRes.ok || startRes.already_watching) {
                _adsgramTaskNonce = startRes.task_nonce || null;
            } else if (startRes.error === 'cooldown_active') {
                const sec = Math.ceil((startRes.wait_ms || 60000) / 1000);
                showToast('coin', 'انتظر قليلاً', `${sec} ثانية`, 'red', '');
            }
        } catch (e) { console.warn('[AdsgramTask] start failed:', e.message); }
    });

    widget.addEventListener('reward', async () => {
        if (!_taskStartedAt) _taskStartedAt = Date.now();
        const elapsed = Date.now() - _taskStartedAt;
        if (elapsed < 1800) await new Promise(r => setTimeout(r, 1800 - elapsed));
        await claimAdsgramTaskReward();
        trackAdEvent('ad_completed', { elapsed_ms: Date.now() - _taskStartedAt }, 'adsgram_task').catch(() => {});
    });

    widget.addEventListener('error', () => {
        APP_STATE.adsgram.inProgress = false;
    });
}

// ══════════════════════════════════════════════════════════
// TRACK AD EVENT
// ══════════════════════════════════════════════════════════
async function trackAdEvent(event, meta, ad_type) {
    try {
        await fetchApi({ type: 'track_ad_event', data: { event, ad_type: ad_type || 'daily_ad', meta: meta || {} } });
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════
// DAILY ADS — Completely separate from Adsgram task
// ══════════════════════════════════════════════════════════
export function updateAdUI() {
    const ads = APP_STATE.ads;
    const r   = ads.remaining;

    const elRem      = document.getElementById('ads-remaining');
    const elWatched  = document.getElementById('ads-watched');
    const elEarned   = document.getElementById('earned-today');
    const elProgress = document.getElementById('ads-progress');
    const elBtn      = document.getElementById('ad-watch-btn');
    const elDone     = document.getElementById('ad-done-state');
    const elCooldown = document.getElementById('ad-cooldown-msg');

    if (elRem)     elRem.textContent    = r;
    if (elWatched) elWatched.textContent = ads.watched;
    if (elEarned)  elEarned.textContent  = ads.earned.toLocaleString('ar-EG');

    // Progress = watched / total (not remaining-based, prevents going down)
    if (elProgress) {
        const pct = ads.total > 0 ? Math.min(100, (ads.watched / ads.total) * 100) : 0;
        elProgress.style.width = pct + '%';
    }

    const quotaTotal = document.querySelector('.ad-quota-total');
    if (quotaTotal) quotaTotal.textContent = '/ ' + ads.total;

    // ── Cooldown state (independent of adsgram) ────────
    const coolLeft = ads.cooldownUntil - Date.now();
    if (coolLeft > 0 && r > 0) {
        if (elBtn) elBtn.classList.add('disabled');
        if (elCooldown) {
            elCooldown.textContent = `⏳ انتظر ${Math.ceil(coolLeft / 1000)}s`;
            elCooldown.style.display = 'block';
        }
        if (!ads._cooldownTimer) {
            ads._cooldownTimer = setInterval(() => {
                const left = ads.cooldownUntil - Date.now();
                if (left <= 0) {
                    clearInterval(ads._cooldownTimer);
                    ads._cooldownTimer = null;
                    if (elBtn) elBtn.classList.remove('disabled');
                    if (elCooldown) elCooldown.style.display = 'none';
                } else {
                    if (elCooldown) elCooldown.textContent = `⏳ انتظر ${Math.ceil(left / 1000)}s`;
                }
            }, 1000);
        }
    } else {
        if (r > 0 && elBtn) elBtn.classList.remove('disabled');
        if (elCooldown) elCooldown.style.display = 'none';
    }

    if (r === 0) {
        if (elBtn)  elBtn.style.display  = 'none';
        if (elDone) elDone.style.display = 'flex';
    } else {
        if (elBtn)  elBtn.style.display  = '';
        if (elDone) elDone.style.display = 'none';
    }

    syncDailyTasksFromAds();
}

function _adReset(adBtn) {
    APP_STATE.ads.isWatching = false;
    if (adBtn) adBtn.classList.remove('disabled');
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

// ── Official Adsgram SDK show() ─────────────────────────
function _showAdsgramAd() {
    return new Promise(async (resolve) => {
        const controller = _getAdController();
        if (!controller) {
            await trackAdEvent('ad_failed', { reason: 'sdk_not_ready' }, 'daily_ad');
            resolve(false);
            return;
        }
        await trackAdEvent('ad_requested', { block_id: AD_BLOCK_ID }, 'daily_ad');
        _adWatchStartedAt = Date.now();

        try {
            const result = await controller.show();
            if (result && result.done === true) {
                const elapsed = Date.now() - _adWatchStartedAt;
                if (elapsed < AD_MIN_DURATION) {
                    await trackAdEvent('suspicious_activity', { reason: 'ad_too_short', elapsed_ms: elapsed }, 'daily_ad');
                    resolve(false);
                    return;
                }
                await trackAdEvent('ad_completed', { elapsed_ms: elapsed }, 'daily_ad');
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

// ── watchAd — main daily ad button ─────────────────────
export async function watchAd() {
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

    // SDK check
    if (!window.Adsgram || window._adsgramLoadStatus !== 'loaded') {
        if (window._adsgramLoadStatus === 'failed') {
            _adReset(adBtn);
            await trackAdEvent('ad_failed', { reason: 'sdk_failed_to_load' }, 'daily_ad');
            showToast('coin', 'تعذّر تحميل الإعلان', 'تحقق من اتصالك', 'red', '');
            return;
        }
        if (overlay) { if (countEl) countEl.textContent = '⏳'; overlay.classList.add('visible'); }
        const sdkLoaded = await new Promise(res => {
            const t = setTimeout(() => res(false), 8000);
            window.onAdsgramLoaded(s => { clearTimeout(t); res(s !== 'failed'); });
        });
        if (overlay) overlay.classList.remove('visible');
        if (!sdkLoaded) {
            _adReset(adBtn);
            showToast('coin', 'تعذّر تحميل الإعلان', 'تحقق من اتصالك', 'red', '');
            return;
        }
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
            const elapsed   = Date.now() - _adWatchStartedAt;
            const failTitle = elapsed < 1000 ? '❌ لم تبدأ مشاهدة الإعلان'
                            : elapsed < 6000 ? `⚠️ الإعلان ${i+1} لم يكتمل`
                            : '⚠️ تعذّر تشغيل الإعلان';
            showToast('coin', failTitle, `شاهده حتى النهاية (${successCount}/${AD_PRELOAD_REQUIRED} مكتمل)`, 'red', '');
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
                if (labelEl) labelEl.textContent = `إعلان ${successCount} ✓ — التالي بعد ${rem}s`;
                const tick = setInterval(() => {
                    rem--;
                    if (countEl) countEl.textContent = `${rem}s`;
                    if (labelEl) labelEl.textContent = `إعلان ${successCount} ✓ — التالي بعد ${rem}s`;
                    if (rem <= 0) { clearInterval(tick); if (overlay) overlay.classList.remove('visible'); resolve(); }
                }, 1000);
            });
            showToast('coin', `إعلان ${successCount} مكتمل ✓`,
                `${left} ${left===1?'إعلان متبقي':'إعلانات متبقية'} للمكافأة`, 'gold', '');
        }
    }

    _updatePreloadBar(preloadBar, AD_PRELOAD_REQUIRED, AD_PRELOAD_REQUIRED);

    // [4] start_ad → get nonce
    const startRes = await _dbCall('start_ad', {});
    if (!startRes.ok) {
        _adReset(adBtn);
        _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);
        if (startRes.error === 'daily_limit_reached') { ads.remaining = 0; updateAdUI(); }
        else if (startRes.error === 'cooldown_active') {
            const waitMs = startRes.wait_ms || 30000;
            ads.cooldownUntil = Date.now() + waitMs;
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

    // [5] reward_ad
    const result = await fetchApi({
        type: 'reward_ad',
        data: { ad_started_at: _adWatchStartedAt, preload_count: successCount },
        _nonce: _adNonce,
    });

    _adReset(adBtn);
    _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);

    if (result.ok) {
        // Update state FIRST
        ads.remaining    = result.remaining;
        ads.watched      = result.watchedToday;
        ads.earned       = result.earnedToday;
        const cdMs       = result.cooldown_ms || APP_CONFIG.ads?.cooldown_ms || 30000;
        ads.cooldownUntil = Date.now() + cdMs;

        if (result.points !== undefined) {
            animateBalance(APP_STATE.balance, result.points, 1200);
            APP_STATE.balance = result.points;
        }

        // Toast + notification
        const adPts = APP_CONFIG.rewards?.points_per_ad || 50;
        showToast('trophy', 'مبروك! 🎉', `تم إضافة +${adPts.toLocaleString()} نقطة`, 'green', `+${adPts}`);
        addNotification('gold', 'مكافأة إعلان يومي ✓',
            `+${adPts.toLocaleString('ar-EG')} نقطة — شاهدت ${result.watchedToday} إعلان اليوم`, Date.now());

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
        } else if (['nonce_missing','nonce_not_issued','nonce_expired','invalid'].includes(result.error)) {
            showToast('coin', 'انتهت الجلسة', 'اضغط مرة أخرى', 'red', '');
        } else {
            showToast('coin', 'خطأ في المعالجة', 'حاول مرة أخرى', 'red', '');
        }
        updateAdUI();
    }
}

// ══════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════
export function syncDailyTasksFromAds() {
    const watched = APP_STATE.ads.watched;

    const fill10 = document.getElementById('ads10-fill');
    const prog10 = document.getElementById('ads10-prog');
    const pct10  = Math.min(watched / 10, 1) * 100;
    if (fill10) fill10.style.width = pct10 + '%';
    if (prog10) prog10.textContent = Math.min(watched, 10) + ' / 10';
    if (watched >= 10 && !APP_STATE.tasks.ads10Done) {
        APP_STATE.tasks.ads10Done = true;
        markDailyTaskDone('dtask-ads10', false);
    }

    const fill25 = document.getElementById('ads25-fill');
    const prog25 = document.getElementById('ads25-prog');
    const pct25  = Math.min(watched / 25, 1) * 100;
    if (fill25) fill25.style.width = pct25 + '%';
    if (prog25) prog25.textContent = Math.min(watched, 25) + ' / 25';
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

export function markDailyTaskDone(cardId, rewardClaimed) {
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.add('completed');
    const icon = card.querySelector('.dtask-icon');
    if (icon) {
        icon.style.background = 'rgba(52,211,153,0.12)';
        icon.style.border     = '1px solid rgba(52,211,153,0.22)';
        icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
    }
    const taskType   = DTASK_CLAIM_MAP[cardId];
    const claimBtn   = taskType ? document.getElementById('dtask-claim-' + taskType) : null;
    const claimedBadge = card.querySelector('.dtask-claimed-badge');
    if (!rewardClaimed) {
        if (claimBtn)     claimBtn.style.display     = 'inline-flex';
        if (claimedBadge) claimedBadge.style.display = 'none';
    } else {
        if (claimBtn)     claimBtn.style.display     = 'none';
        if (claimedBadge) claimedBadge.style.display = 'inline-flex';
    }
}

export async function claimDailyMission(taskType) {
    const btn = document.getElementById('dtask-claim-' + taskType);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

    const result = await fetchApi({ type: 'claim_daily_mission', data: { task_type: taskType } });

    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }

    if (!result.ok) {
        if (result.error === 'account_review') {
            showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        } else if (result.error === 'task_not_completed_or_already_claimed') {
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
    const cardId = 'dtask-' + taskType.replace(/_/g, '').replace('ads','ads').replace('dailyrefs3','invite3');
    // safer lookup:
    const claimBtnId = 'dtask-claim-' + taskType;
    const parentCard = document.getElementById(claimBtnId)?.closest('.dtask-card');
    const claimedBadge = parentCard?.querySelector('.dtask-claimed-badge');
    if (claimedBadge) claimedBadge.style.display = 'inline-flex';

    showToast('trophy', 'تم استلام المكافأة! 🎁', `تم إضافة +${(result.reward||0).toLocaleString()} نقطة`, 'green', `+${result.reward||0}`);
    try {
        addNotification('gold', 'تم استلام مكافأة المهمة اليومية ✓',
            `+${(result.reward||0).toLocaleString('ar-EG')} نقطة أُضيفت لرصيدك`, Date.now());
    } catch (_) {}
}

export function updateDailyBadge() {
    const done = [APP_STATE.tasks.ads10Done, APP_STATE.tasks.ads25Done, APP_STATE.tasks.invite3Done].filter(Boolean).length;
    const badge = document.getElementById('daily-tasks-badge');
    if (badge) badge.textContent = done + ' / 3';
}

export function handleDailyTask(type, el) {
    if (type === 'ads10' || type === 'ads25') {
        showPage('earn', null);
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        document.querySelector('.nav-item[data-page="earn"]')?.classList.add('active');
    } else if (type === 'invite3') {
        showPage('invite', null);
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        document.querySelector('.nav-item[data-page="invite"]')?.classList.add('active');
    }
}

// ── Telegram Channel Task ──────────────────────────────
export function handleTelegramTask() {
    if (APP_STATE.tasks.tgVerified) return;
    const channelUrl = APP_CONFIG.telegram.channel_url || 'https://t.me/botbababab';
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(channelUrl);
    else window.open(channelUrl, '_blank');
    APP_STATE.tasks.tgJoined = true;

    const joinBtn    = document.getElementById('tg-join-btn');
    const verifyBtn  = document.getElementById('tg-verify-btn-compact');
    const verifyHint = document.getElementById('tg-verify-hint');
    if (joinBtn)    joinBtn.style.display   = 'none';
    if (verifyBtn)  { verifyBtn.style.display = 'inline-flex'; verifyBtn.style.animation = 'pageIn 0.3s ease both'; }
    if (verifyHint) verifyHint.style.display = 'block';
}

export async function verifyTelegramTask() {
    if (APP_STATE.tasks.tgVerified) return;
    const verifyBtn = document.getElementById('tg-verify-btn-compact');
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.style.opacity = '0.6'; }

    const result = await fetchApi({ type: 'verify_tg_task', data: {} });

    if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.style.opacity = '1'; }

    if (!result.ok) {
        if (result.error === 'not_in_channel') {
            showToast('coin', 'لم تنضم للقناة بعد ❌', 'اضغط «انضم» أولاً ثم حاول مجدداً', 'red', '!');
            document.getElementById('tg-join-btn')?.style?.setProperty('display','inline-flex');
            if (verifyBtn) verifyBtn.style.display = 'none';
        } else if (result.error === 'already_verified') {
            showToast('coin', 'تم التحقق مسبقاً ✓', '', 'green', '✓');
        } else if (result.error === 'account_review') {
            showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
        } else {
            showToast('coin', 'لم يتم التحقق بعد', 'تأكد من انضمامك للقناة ثم حاول مجدداً', 'gold', '!');
        }
        return;
    }

    if (result.points !== undefined) {
        animateBalance(APP_STATE.balance, result.points);
        APP_STATE.balance = result.points;
    }

    APP_STATE.tasks.tgVerified = true;
    const verifyHint = document.getElementById('tg-verify-hint');
    const actionWrap = document.getElementById('tg-action-wrap');
    const doneState  = document.getElementById('tg-done-state');
    const doneOverlay= document.getElementById('tg-done-overlay');
    const card       = document.getElementById('tg-task-card');

    if (verifyBtn)  verifyBtn.style.display  = 'none';
    if (verifyHint) verifyHint.style.display = 'none';
    if (actionWrap) actionWrap.style.display = 'none';
    if (doneState)  { doneState.style.display = 'block'; doneState.style.animation = 'pageIn 0.4s cubic-bezier(0.22,1,0.36,1) both'; }
    if (doneOverlay) doneOverlay.style.display = 'block';
    if (card) card.classList.add('completed');

    const reward = parseInt(result.reward) || APP_CONFIG.rewards.telegram_task || 200;
    showToast('trophy', 'انضممت للقناة! 🎉', `تم إضافة +${reward.toLocaleString('ar-EG')} نقطة`, 'gold', `+${reward}`);
}

// ── Channel Tasks ──────────────────────────────────────
const _channelJoined = {};

export function handleChannelJoin(channelId, url) {
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url, '_blank');
    _channelJoined[channelId] = true;
    const joinBtn   = document.getElementById('ch-join-btn-' + channelId);
    const verifyBtn = document.getElementById('ch-verify-btn-' + channelId);
    const hint      = document.getElementById('ch-hint-' + channelId);
    if (joinBtn)   joinBtn.style.display   = 'none';
    if (verifyBtn) verifyBtn.style.display = 'inline-flex';
    if (hint)      hint.style.display      = 'block';
}

export async function verifyChannelTask(channelId) {
    const verifyBtn = document.getElementById('ch-verify-btn-' + channelId);
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.style.opacity = '0.6'; }

    const result = await fetchApi({ type: 'verify_channel_task', data: { channel_id: channelId } });

    if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.style.opacity = '1'; }

    if (!result.ok) {
        if (result.error === 'not_in_channel') {
            showToast('coin', 'لم تنضم للقناة بعد ❌', 'اضغط «انضم» أولاً ثم حاول مجدداً', 'red', '!');
            const joinBtn = document.getElementById('ch-join-btn-' + channelId);
            if (joinBtn)   joinBtn.style.display   = 'inline-flex';
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

    if (result.points !== undefined) {
        animateBalance(APP_STATE.balance, result.points);
        APP_STATE.balance = result.points;
    }

    const reward = result.reward || 2500;
    showToast('trophy', 'انضممت للقناة! 🎉', `تم إضافة +${reward.toLocaleString()} نقطة`, 'gold', `+${reward}`);
    _markChannelDone(channelId);
}

function _markChannelDone(channelId) {
    const action = document.getElementById('ch-action-' + channelId);
    const hint   = document.getElementById('ch-hint-' + channelId);
    const card   = document.getElementById('ch-card-' + channelId);
    if (hint)   hint.style.display = 'none';
    if (action) action.innerHTML = `
        <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);
            border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
            </svg>
            <span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span>
        </div>`;
    if (card) card.style.background = 'rgba(52,211,153,0.04)';
}

function renderChannels(channels) {
    const wrap = document.getElementById('channel-tasks-wrap');
    if (!wrap) return;
    if (!channels.length) return;

    wrap.innerHTML = channels.map(ch => {
        const isDone = !!ch.verified;
        const id = ch.id;
        const membersText = ch.max_members > 0
            ? `<span style="font-size:10px;color:rgba(37,178,248,0.5);font-weight:500;">أقصى ${ch.max_members.toLocaleString()} عضو</span>`
            : '';
        return `
        <div class="glass" style="border-radius:var(--radius-xl);overflow:hidden;${isDone?'border:1px solid rgba(52,211,153,0.2)!important;':''}">
            <div id="ch-card-${id}" style="display:flex;align-items:center;gap:14px;padding:16px 18px;position:relative;transition:background 0.2s ease;">
                ${isDone?'<div style="position:absolute;inset:0;background:rgba(52,211,153,0.04);pointer-events:none;"></div>':''}
                <div style="width:46px;height:46px;border-radius:14px;background:rgba(37,178,248,0.1);border:1px solid rgba(37,178,248,0.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(37,178,248,0.12)" stroke="rgba(37,178,248,0.5)" stroke-width="1.2"/>
                        <path d="M17.5 7.5L15 16.5l-3-3-2 2-1-4-3-1 8.5-3.5z" fill="#29b6f6"/>
                    </svg>
                </div>
                <div style="flex:1;min-width:0;">
                    <div style="font-family:'Tajawal',sans-serif;font-size:14px;font-weight:800;color:rgba(255,255,255,0.92);margin-bottom:4px;">${ch.title}</div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <div style="display:flex;align-items:center;gap:5px;">
                            <img src="asesst/coins.png" alt="" style="width:11px;height:11px;object-fit:contain;filter:drop-shadow(0 0 3px rgba(251,191,36,0.7));">
                            <span style="font-family:'Readex Pro',sans-serif;font-size:11px;font-weight:600;color:rgba(251,191,36,0.75);">+${(ch.reward||2500).toLocaleString()} نقطة</span>
                        </div>
                        ${membersText}
                    </div>
                </div>
                <div id="ch-action-${id}" style="flex-shrink:0;">
                    ${isDone
                        ? `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;">
                               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                               <span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span>
                           </div>`
                        : `<button id="ch-join-btn-${id}" onclick="window.handleChannelJoin(${id},'${ch.url}')"
                               style="display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:12px;border:1px solid rgba(37,178,248,0.45);background:linear-gradient(135deg,rgba(37,178,248,0.22),rgba(37,178,248,0.08));color:#fff;font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;cursor:pointer;transition:all 0.22s;white-space:nowrap;">
                               <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(41,182,246,0.2)" stroke="rgba(41,182,246,0.8)" stroke-width="1.4"/><path d="M17.5 7.5L15 16.5l-3-3-2 2-1-4-3-1 8.5-3.5z" fill="#fff"/></svg>
                               انضم
                           </button>
                           <button id="ch-verify-btn-${id}" onclick="window.verifyChannelTask(${id})"
                               style="display:none;align-items:center;gap:7px;padding:10px 16px;border-radius:12px;border:1px solid rgba(52,211,153,0.38);background:rgba(52,211,153,0.1);color:#34d399;font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;cursor:pointer;transition:all 0.22s;white-space:nowrap;">
                               <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                               تحقق
                           </button>`
                    }
                </div>
            </div>
            ${!isDone?`
            <div id="ch-hint-${id}" style="display:none;margin:0 18px 14px;padding:9px 13px;border-radius:10px;background:rgba(37,178,248,0.05);border:1px solid rgba(37,178,248,0.13);">
                <div style="display:flex;align-items:center;gap:7px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(37,178,248,0.65)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                    <span style="font-size:11px;color:rgba(37,178,248,0.65);font-weight:600;font-family:'Readex Pro',sans-serif;">اضغط «تحقق» بعد الانضمام للقناة</span>
                </div>
            </div>`:''}
        </div>`;
    }).join('');
}

async function _loadChannels() {
    const result = await fetchApi({ type: 'get_channels', data: {} });
    const loading = document.getElementById('channel-tasks-loading');
    if (loading) loading.remove();
    if (result.ok && Array.isArray(result.channels)) renderChannels(result.channels);
}

// ══════════════════════════════════════════════════════════
// MAIN INIT — DOMContentLoaded
// ══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
    // Make REFERRAL_LINK accessible for share functions
    window._REFERRAL_LINK = REFERRAL_LINK;

    initTelegramUser();
    // Sync REFERRAL_LINK after TG init
    window._REFERRAL_LINK = REFERRAL_LINK;

    try {
        await createSession();
        const loadResult = await fetchApi({ type: 'load', data: {} });

        if (loadResult.ok) {
            const pts = parseInt(loadResult.points) || 0;
            const lvl = parseInt(loadResult.level)  || 1;

            APP_STATE.balance              = pts;
            APP_STATE.level                = lvl;
            APP_STATE.first_withdraw_done  = !!loadResult.first_withdraw_done;
            APP_STATE.tasks.tgVerified     = !!loadResult.tg_verified;

            // Config from server
            if (loadResult.config) {
                const cfg = loadResult.config;
                if (cfg.withdraw)  APP_CONFIG.withdraw  = cfg.withdraw;
                if (cfg.rewards)   APP_CONFIG.rewards   = cfg.rewards;
                if (cfg.telegram)  APP_CONFIG.telegram  = cfg.telegram;
                if (cfg.ads)       APP_CONFIG.ads       = cfg.ads;
                if (cfg.ads?.daily_limit) APP_STATE.serverConfig.ads_daily_limit = cfg.ads.daily_limit;
                _applyConfigToUI();
            }

            // Ads state
            const ads = APP_STATE.ads;
            ads.total   = parseInt(loadResult.ads_total)        || APP_CONFIG.ads.daily_limit || 10;
            ads.remaining = parseInt(loadResult.ads_remaining)  || ads.total;
            ads.watched   = parseInt(loadResult.ads_watched_today) || 0;
            ads.earned    = parseInt(loadResult.earned_today)   || 0;
            updateAdUI();

            // Adsgram task state
            if (loadResult.adsgram_task) {
                _syncAdsgramStateFromServer(loadResult.adsgram_task);
            }

            // Daily gift
            if (loadResult.streak_day !== undefined)
                APP_STATE.dailyGift.dayNumber = Math.max(1, (parseInt(loadResult.streak_day) || 0) + 1);
            const today    = new Date().toISOString().slice(0, 10);
            const lastGift = String(loadResult.last_gift_date || '').slice(0, 10);
            if (lastGift === today) APP_STATE.dailyGift.claimed = true;

            // Withdraw history
            if (Array.isArray(loadResult.withdrawals)) {
                APP_STATE.withdrawHistory.length = 0;
                loadResult.withdrawals.forEach(w => {
                    APP_STATE.withdrawHistory.push({
                        pts: parseInt(w.pts) || 0, address: w.address || '',
                        ts: parseInt(w.ts) || Date.now(), status: w.status || 'pending',
                    });
                });
                renderWithdrawHistory();
            }

            // Completed tasks
            if (Array.isArray(loadResult.completed_tasks)) {
                const taskArr  = loadResult.completed_tasks;
                const hasType  = t => taskArr.some(x => (typeof x === 'string' ? x : x.task_type) === t);
                const isClaimed = t => taskArr.some(x => typeof x === 'object' && x.task_type === t && x.reward_claimed);

                if (hasType('ads_10'))   { APP_STATE.tasks.ads10Done = true;  markDailyTaskDone('dtask-ads10',   isClaimed('ads_10')); }
                if (hasType('ads_25'))   { APP_STATE.tasks.ads25Done = true;  markDailyTaskDone('dtask-ads25',   isClaimed('ads_25')); }
                if (hasType('tg_join'))    APP_STATE.tasks.tgVerified = true;
                if (hasType('daily_refs_3')) { APP_STATE.tasks.invite3Done = true; markDailyTaskDone('dtask-invite3', isClaimed('daily_refs_3')); }
            }

            // Referral stats
            const totalRefs  = parseInt(loadResult.total_referrals)  || 0;
            const earnedRefs = parseInt(loadResult.earned_from_refs) || 0;
            document.querySelectorAll('.uc-stat-val').forEach(el => {
                if (el.classList.contains('green')) el.textContent = totalRefs;
                if (el.classList.contains('gold'))  el.textContent = earnedRefs.toLocaleString('en-US');
                if (el.classList.contains('blue'))  el.textContent = loadResult.completed_tasks?.length || 0;
            });
            const inviteStatVals = document.querySelectorAll('.invite-stat-val');
            if (inviteStatVals[0]) {
                const sp = inviteStatVals[0].querySelector('span');
                if (sp) sp.textContent = totalRefs; else inviteStatVals[0].textContent = totalRefs;
            }
            if (inviteStatVals[1]) {
                const sp = inviteStatVals[1].querySelector('span[style*="color:var(--gold)"]');
                if (sp) sp.textContent = earnedRefs.toLocaleString('en-US');
            }
            const refBadge = document.getElementById('referral-friends-badge');
            if (refBadge) refBadge.textContent = totalRefs + ' صديق';

            if (Array.isArray(loadResult.referral_list) && loadResult.referral_list.length > 0)
                renderReferralList(loadResult.referral_list, totalRefs);

            if (loadResult.tg_id) {
                window._REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '?start=ref_' + loadResult.tg_id;
                _updateReferralLinkUI();
            }

            // tgVerified UI
            if (APP_STATE.tasks.tgVerified) {
                document.getElementById('tg-join-btn')?.style?.setProperty('display','none');
                document.getElementById('tg-verify-btn-compact')?.style?.setProperty('display','none');
                const aw = document.getElementById('tg-action-wrap');
                const ds = document.getElementById('tg-done-state');
                const do_ = document.getElementById('tg-done-overlay');
                const card = document.getElementById('tg-task-card');
                if (aw)  aw.style.display   = 'flex';
                if (ds)  ds.style.display   = 'block';
                if (do_) do_.style.display  = 'block';
                if (card) card.classList.add('completed');
            }

            // Animate balance on first load
            setTimeout(() => { animateBalance(0, pts, 1600); runCounters(document); }, 120);

        } else {
            setTimeout(() => runCounters(document), 350);
        }

    } catch (e) {
        console.error('[INIT] Error:', e.message);
    } finally {
        _hideLoadingScreen();
    }

    setTimeout(_initAdsgramTask, 1000);
    _loadChannels();

    // ── Auto-refresh polling (5s) ─────────────────────
    let _lastPolledPts = APP_STATE.balance;
    let _pollFailCount = 0;

    async function _doPoll() {
        try {
            const state = await fetchApi({ type: 'get_state', data: {} });
            if (!state.ok) { _pollFailCount++; return; }
            _pollFailCount = 0;

            const ads = APP_STATE.ads;
            // Only sync ads state if NOT currently watching (prevent interruption)
            if (state.ads_remaining !== undefined && !ads.isWatching
                && !APP_STATE.adsgram.inProgress && !APP_STATE.adsgram.claimInProgress) {
                ads.remaining = state.ads_remaining;
                ads.watched   = state.ads_watched_today || 0;
                ads.earned    = state.earned_today || 0;
                if (state.ad_cooldown_ms > 0) ads.cooldownUntil = Date.now() + state.ad_cooldown_ms;
                updateAdUI();
            }

            // Balance — animate if changed
            if (state.points !== undefined && state.points !== _lastPolledPts) {
                animateBalance(_lastPolledPts, state.points, 800);
                _lastPolledPts    = state.points;
                APP_STATE.balance = state.points;
            }
            if (state.level !== undefined) APP_STATE.level = state.level;

            // Adsgram state — only sync if not in progress
            if (state.adsgram_task && !APP_STATE.adsgram.inProgress && !APP_STATE.adsgram.claimInProgress) {
                _syncAdsgramStateFromServer(state.adsgram_task);
            }

            // Referral stats
            if (state.total_referrals !== undefined) {
                document.querySelectorAll('.uc-stat-val.green').forEach(el => {
                    el.textContent = state.total_referrals;
                });
            }
            if (state.earned_from_refs !== undefined) {
                document.querySelectorAll('.uc-stat-val.gold').forEach(el => {
                    el.textContent = state.earned_from_refs.toLocaleString('en-US');
                });
            }
        } catch (_) { _pollFailCount++; }
    }

    let _pollInterval = setInterval(_doPoll, 5000);

    // Offline detection
    const offlineBanner = document.getElementById('offline-banner');
    window.addEventListener('offline', () => {
        clearInterval(_pollInterval);
        if (offlineBanner) {
            offlineBanner.style.display = 'block';
            requestAnimationFrame(() => { offlineBanner.style.transform = 'translateY(0)'; });
        }
    });
    window.addEventListener('online', async () => {
        if (offlineBanner) {
            offlineBanner.style.transform = 'translateY(-100%)';
            setTimeout(() => { offlineBanner.style.display = 'none'; }, 300);
        }
        await _doPoll();
        _pollInterval = setInterval(_doPoll, 5000);
    });

    try { Object.freeze(APP_STATE.serverConfig); } catch (_) {}
});

// ── Expose all to window ─────────────────────────────────
window.watchAd                   = watchAd;
window.watchAdsgramTask          = watchAdsgramTask;
window.claimAdsgramTaskReward    = claimAdsgramTaskReward;
window.claimDailyMission         = claimDailyMission;
window.handleDailyTask           = handleDailyTask;
window.handleTelegramTask        = handleTelegramTask;
window.verifyTelegramTask        = verifyTelegramTask;
window.handleChannelJoin         = handleChannelJoin;
window.verifyChannelTask         = verifyChannelTask;
window.updateAdUI                = updateAdUI;
window.syncDailyTasksFromAds     = syncDailyTasksFromAds;
window._syncAdsgramStateFromServer = _syncAdsgramStateFromServer;
