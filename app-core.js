// ═══════════════════════════════════════════════════════════════════
//  app-core.js — startup | session | config | state | auth | api
// ═══════════════════════════════════════════════════════════════════

const API_BASE = '/api';

// ── Central APP_STATE ────────────────────────────────────────────
const APP_STATE = {
    balance: 0,
    level: 1,
    first_withdraw_done: false,
    ads: {
        total: 10,
        watched: 0,
        remaining: 10,
        earned: 0,
        cooldown: false,
        cooldownUntil: 0,
        isWatching: false,
        _cooldownTimer: null,
    },
    adsgram: {
        loading: false,
        ready: false,
        hasTask: false,
        cooldown: false,
        taskInProgress: false,
        claimInProgress: false,
        claimSucceeded: false,
        taskNonce: null,
        localTimer: null,
    },
    tasks: {
        tgJoined: false,
        tgVerified: false,
        ads10Done: false,
        ads25Done: false,
        invite3Done: false,
    },
    gift: {
        dayNumber: 1,
        claimed: false,
        isOpening: false,
    },
    withdrawHistory: [],
    notifList: [],
    unreadNotifCount: 0,
};

// ── Legacy aliases (backward compat) ────────────────────────────
const USER_STATE   = { get points() { return APP_STATE.balance; }, set points(v) { APP_STATE.balance = v; },
                        get level()  { return APP_STATE.level;   }, set level(v)  { APP_STATE.level = v;   },
                        get first_withdraw_done() { return APP_STATE.first_withdraw_done; },
                        set first_withdraw_done(v) { APP_STATE.first_withdraw_done = v; } };
const AD_STATE     = APP_STATE.ads;
const TASKS_STATE  = APP_STATE.tasks;
const DAILY_GIFT_STATE = APP_STATE.gift;
const WITHDRAW_HISTORY = APP_STATE.withdrawHistory;
const NOTIF_LIST_DATA  = APP_STATE.notifList;

// ── APP_CONFIG ────────────────────────────────────────────────────
let APP_CONFIG = {
    withdraw:     { first_min: 3000, normal_min: 20000, normal_level: 5 },
    rewards:      { referral: 100, telegram_task: 200, adsgram_task: 50,
                    daily_ads_10: 200, daily_ads_25: 300, daily_referrals_3: 1000,
                    points_per_ad: 50 },
    telegram:     { channel_url: 'https://t.me/botbababab' },
    ads:          { daily_limit: 10, cooldown_ms: 30000, min_duration_ms: 14000 },
    adsgram_task: { title_ar: '', title_en: '', block_id: 'task-30166', reward: 50, cooldown_ms: 60000 },
    daily_gift:   { rewards: [], titles_ar: [], descs_ar: [] },
};

let _SERVER_CONFIG = {
    withdraw_min_pts: 20000, withdraw_min_level: 5,
    pts_per_ton: 100000, pts_per_referral: 100, ads_daily_limit: 10,
};

const TON_CONFIG = new Proxy({}, {
    get(_, k) {
        const fw = APP_STATE.first_withdraw_done;
        if (k === 'minPts')    return fw ? (APP_CONFIG.withdraw.normal_min  || 20000) : (APP_CONFIG.withdraw.first_min || 3000);
        if (k === 'minLevel')  return fw ? (APP_CONFIG.withdraw.normal_level || 5) : 0;
        if (k === 'ptsPerTon') return _SERVER_CONFIG.pts_per_ton || 100000;
        if (k === 'isFirstWithdraw') return !fw;
    }
});

async function _fetchAppConfig() {
    try {
        const res = await fetch(API_BASE + '/config', { method: 'GET' });
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok !== false) {
            if (data.withdraw)      APP_CONFIG.withdraw      = data.withdraw;
            if (data.rewards)       APP_CONFIG.rewards       = data.rewards;
            if (data.telegram)      APP_CONFIG.telegram      = data.telegram;
            if (data.ads)           APP_CONFIG.ads           = data.ads;
            if (data.adsgram_task)  APP_CONFIG.adsgram_task  = data.adsgram_task;
            if (data.daily_gift)    APP_CONFIG.daily_gift    = data.daily_gift;
            _applyConfigToUI();
        }
    } catch (e) { console.warn('[Config] Failed:', e.message); }
}

function _applyConfigToUI() {
    document.querySelectorAll('[data-tg-channel]').forEach(el => { el.href = APP_CONFIG.telegram.channel_url; });
    try {
        const lang = (typeof currentLang !== 'undefined') ? currentLang : 'ar';
        const dynTitle = (lang === 'en' && APP_CONFIG.adsgram_task?.title_en)
            ? APP_CONFIG.adsgram_task.title_en
            : (APP_CONFIG.adsgram_task?.title_ar || '');
        const titleEl = document.getElementById('adsgram-task-title');
        if (titleEl && dynTitle) titleEl.textContent = dynTitle;
        const widget = document.getElementById('adsgram-task-widget');
        if (widget && APP_CONFIG.adsgram_task?.block_id) {
            const cur = widget.getAttribute('data-block-id');
            if (cur !== APP_CONFIG.adsgram_task.block_id)
                widget.setAttribute('data-block-id', APP_CONFIG.adsgram_task.block_id);
        }
    } catch (_) {}
    document.querySelectorAll('.adsgram-reward-badge, #adsgram-reward-badge').forEach(el => { el.textContent = APP_CONFIG.rewards.adsgram_task; });
    document.querySelectorAll('.referral-reward-badge').forEach(el => { el.textContent = APP_CONFIG.rewards.referral; });
    document.querySelectorAll('.tg-task-reward-badge').forEach(el => { el.textContent = APP_CONFIG.rewards.telegram_task; });
    document.querySelectorAll('.daily-ads10-reward-badge').forEach(el => { el.textContent = APP_CONFIG.rewards.daily_ads_10; });
    document.querySelectorAll('.daily-ads25-reward-badge').forEach(el => { el.textContent = APP_CONFIG.rewards.daily_ads_25; });
    document.querySelectorAll('.daily-refs3-reward-badge').forEach(el => { el.textContent = APP_CONFIG.rewards.daily_referrals_3; });
}
_fetchAppConfig();

// ═══════════════════════════════════════════════════════════════════
//  ZERO TRUST CLIENT
// ═══════════════════════════════════════════════════════════════════
let _sessionId      = null;
let _fpCache        = null;
let _pendingSession = null;

function _genNonce() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('') + '_' + Date.now();
}

function _genIncidentId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = 'INC-';
    for (let i = 0; i < 12; i++) {
        if (i === 4 || i === 8) id += '-';
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

function showSecurityWall() {
    const lp = document.getElementById('loading-page');
    if (lp) lp.remove();
    document.body.style.pointerEvents = 'none';
    document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;
            height:100vh;min-height:100dvh;
            background:radial-gradient(ellipse at 50% 30%, rgba(239,68,68,0.08) 0%, #0a0a1a 65%);
            flex-direction:column;gap:0;padding:32px 24px;text-align:center;
            font-family:'Tajawal',sans-serif;">
            <div style="margin-bottom:28px;">
                <img src="asesst/baned.gif" alt="banned"
                     style="width:140px;height:140px;object-fit:contain;
                            filter:drop-shadow(0 0 32px rgba(239,68,68,0.4));" />
            </div>
            <div style="color:#f87171;font-size:22px;font-weight:800;letter-spacing:0.3px;
                margin-bottom:10px;text-shadow:0 0 24px rgba(248,113,113,0.4);">تم حظر هذا الحساب</div>
            <div style="color:rgba(255,255,255,0.38);font-size:13px;line-height:1.6;
                max-width:260px;margin-bottom:28px;">تم رصد نشاط مخالف لسياسة الاستخدام.<br>لا يمكن المتابعة من هذا الحساب.</div>
            <div style="width:180px;height:1px;background:rgba(255,255,255,0.07);margin-bottom:20px;"></div>
            <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
                border-radius:10px;padding:10px 20px;display:inline-flex;flex-direction:column;gap:4px;">
                <span style="color:rgba(255,255,255,0.25);font-size:10px;letter-spacing:1px;text-transform:uppercase;">Incident ID</span>
                <span style="color:rgba(255,255,255,0.45);font-size:12px;font-family:monospace;letter-spacing:1px;">${_genIncidentId()}</span>
            </div>
            <div style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:14px;">
                ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
            </div>
        </div>`;
}

async function _buildFingerprint() {
    if (_fpCache) return _fpCache;
    let canvasHash = '';
    try {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top'; ctx.font = '14px Arial';
        ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069'; ctx.fillText('Cwm fjordbank glyphs vext quiz', 2, 15);
        ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('Cwm fjordbank glyphs vext quiz', 4, 17);
        canvasHash = c.toDataURL().slice(-40);
    } catch (_) { canvasHash = 'canvas_blocked'; }

    let webglInfo = '';
    try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            webglInfo = ext
                ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) + '|' + gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
                : gl.getParameter(gl.RENDERER);
        }
    } catch (_) { webglInfo = 'webgl_blocked'; }

    let audioHash = '';
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
        const osc = ac.createOscillator(); const an = ac.createAnalyser();
        const gain = ac.createGain(); gain.gain.value = 0;
        osc.connect(an); an.connect(gain); gain.connect(ac.destination);
        osc.start(0);
        const buf = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(buf); osc.stop(); await ac.close();
        audioHash = buf.slice(0, 8).reduce((s, v) => s + Math.abs(v).toFixed(2), '');
    } catch (_) { audioHash = 'audio_blocked'; }

    const hw       = [navigator.hardwareConcurrency || 0, navigator.deviceMemory || 0].join('x');
    const touch    = [navigator.maxTouchPoints || 0, 'ontouchstart' in window ? 1 : 0].join('');
    const platform = [navigator.userAgent || '', navigator.language || '',
                      (navigator.languages || []).join(','),
                      `${screen.width}x${screen.height}x${screen.colorDepth}`,
                      new Date().getTimezoneOffset(),
                      (Intl.DateTimeFormat().resolvedOptions().timeZone || '')].join('|');
    const plugins  = navigator.plugins?.length || 0;
    const media    = [window.matchMedia('(prefers-color-scheme:dark)').matches ? 'D' : 'L',
                      (window.devicePixelRatio || 1).toFixed(1)].join('');

    const raw = [canvasHash, webglInfo, audioHash, hw, touch, platform, plugins, media].join('§');
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        h1 = (Math.imul(h1, 31) ^ c) >>> 0;
        h2 = (Math.imul(h2, 33) ^ c) >>> 0;
    }
    const fpHash = ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));

    _fpCache = JSON.stringify({
        fp: fpHash, user_agent: navigator.userAgent || '',
        lang: navigator.language || '', screen: `${screen.width}x${screen.height}`,
        tz_offset: new Date().getTimezoneOffset(), hw_cores: navigator.hardwareConcurrency || 0,
        hw_mem: navigator.deviceMemory || 0, touch_pts: navigator.maxTouchPoints || 0,
        tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        canvas_sig: canvasHash, webgl_sig: webglInfo.slice(0, 60),
        audio_sig: audioHash, dpr: (window.devicePixelRatio || 1).toFixed(2),
        color_depth: screen.colorDepth || 0,
    });
    return _fpCache;
}

async function _createSession() {
    if (_pendingSession) return _pendingSession;
    _pendingSession = (async () => {
        const tg       = window?.Telegram?.WebApp;
        const initData = tg?.initData || '';
        if (!initData) console.warn('[ZT] No initData — attempting dev session');
        try {
            const fpStr = await _buildFingerprint();
            const headers = { 'Content-Type': 'application/json', 'X-Fingerprint': fpStr };
            if (initData) headers['X-Init-Data'] = initData;
            const res = await fetch(API_BASE, {
                method: 'POST', headers, credentials: 'include',
                body: JSON.stringify({ type: 'create_session', data: { initData, fp: JSON.parse(fpStr) } }),
            });
            const result = await res.json();
            if (result.is_banned) { showSecurityWall(); return false; }
            if (result.error === 'account_review') { console.warn('[ZT] Shadow ban'); return false; }
            if (result.ok && result._session_token) {
                _sessionId = result._session_token;
                if (result.user) {
                    if (result.user.points      !== undefined) APP_STATE.balance       = parseInt(result.user.points) || 0;
                    if (result.user.level       !== undefined) APP_STATE.level         = parseInt(result.user.level)  || 1;
                    if (result.user.tg_verified !== undefined) APP_STATE.tasks.tgVerified = !!result.user.tg_verified;
                    if (result.user.streak_day  !== undefined) APP_STATE.gift.dayNumber = Math.max(1, (parseInt(result.user.streak_day) || 0) + 1);
                    const today = new Date().toISOString().slice(0, 10);
                    if (result.user.last_gift_date === today) APP_STATE.gift.claimed = true;
                }
                return true;
            }
            return false;
        } catch (e) { console.warn('[ZT] Session error:', e.message); return false; }
        finally    { _pendingSession = null; }
    })();
    return _pendingSession;
}

async function _dbCall(action, data = {}, _externalNonce = null) {
    if (!_sessionId && !['create_session'].includes(action)) {
        const ok = await _createSession();
        if (!ok) console.warn('[ZT] No session for:', action);
    }

    const SERVER_NONCE_ACTIONS = new Set(['claim_gift', 'verify_tg_task', 'submit_withdraw', 'claim_daily_mission', 'verify_channel_task']);
    const EXTERNAL_NONCE_ACTIONS = new Set(['reward_ad', 'claim_adsgram_task']);
    const SKIP_NONCE = new Set(['get_state', 'load', 'get_referrals', 'create_session', 'track_ad_event', 'start_ad', 'start_adsgram_task', 'get_nonce', 'get_channels']);

    const needsServerNonce = SERVER_NONCE_ACTIONS.has(action) && !_externalNonce;
    const needsNonce = !SKIP_NONCE.has(action) && !SERVER_NONCE_ACTIONS.has(action) && !EXTERNAL_NONCE_ACTIONS.has(action);

    if (EXTERNAL_NONCE_ACTIONS.has(action) && !_externalNonce) {
        console.error(`[ZT] ${action} requires external nonce!`);
        return { ok: false, error: 'nonce_missing' };
    }

    try {
        const fpStr    = await _buildFingerprint();
        const initData = window?.Telegram?.WebApp?.initData || '';
        const headers  = { 'Content-Type': 'application/json', 'X-Fingerprint': fpStr };
        if (initData)  headers['X-Init-Data']  = initData;
        if (_sessionId) headers['X-Session-Id'] = _sessionId;

        let nonce = _externalNonce;
        if (!nonce && needsServerNonce && _sessionId) {
            try {
                const nonceRes = await fetch(API_BASE, {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json', 'X-Fingerprint': fpStr, 'X-Session-Id': _sessionId },
                    body: JSON.stringify({ type: 'get_nonce', data: { action } }),
                });
                const nonceData = await nonceRes.json();
                if (nonceData.ok && nonceData.nonce) nonce = nonceData.nonce;
            } catch (_) {}
        } else if (!nonce && needsNonce) {
            nonce = _genNonce();
        }
        if (nonce) headers['X-Nonce'] = nonce;

        const res = await fetch(API_BASE, {
            method: 'POST', headers, credentials: 'include',
            body: JSON.stringify({ type: action, data }),
        });

        if (res.status === 401) {
            _sessionId = null;
            const renewed = await _createSession();
            if (renewed) return _dbCall(action, data, _externalNonce);
            return { ok: false, error: 'auth_failed' };
        }

        const json = await res.json();
        if (json.is_banned === true) showSecurityWall();
        return json;
    } catch (e) {
        console.warn('[ZT]', action, 'failed:', e.message);
        return { ok: false };
    }
}

// Legacy wrappers
async function fetchApi({ type, data = {}, _nonce = null }) { return _dbCall(type, data, _nonce); }
async function createSession() { return _createSession(); }

// ── Misc helpers ─────────────────────────────────────────────────
function openDepositSupport() {
    const msg = encodeURIComponent('مرحبا أريد إيداع داخل البوت');
    const url = 'https://t.me/YourSupportUsername?text=' + msg;
    if (window.Telegram?.WebApp) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url, '_blank');
}

// ── Telegram user init ────────────────────────────────────────────
const BOT_USERNAME = 'RebhApp_bot';
let REFERRAL_LINK  = 'https://t.me/' + BOT_USERNAME + '?start=ref_0000000000';
let CURRENT_USER_ID = null;

function initTelegramUser() {
    const tg = window?.Telegram?.WebApp;
    if (!tg) { _applyFallbackUser(); return; }
    tg.ready();
    tg.expand();
    const user = tg?.initDataUnsafe?.user;
    if (!user) { _applyFallbackUser(); return; }

    const userId    = user?.id ?? null;
    const firstName = user?.first_name ?? '';
    const lastName  = user?.last_name  ?? '';
    const username  = user?.username   ?? '';
    const photoUrl  = user?.photo_url  ?? '';

    let displayName = '@مستخدم';
    if (username) displayName = '@' + username;
    else if (firstName || lastName) displayName = [firstName, lastName].filter(Boolean).join(' ');

    if (userId) {
        CURRENT_USER_ID = userId;
        REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '?start=ref_' + userId;
    }
    _applyUserToUI(displayName, photoUrl, userId);
    _updateReferralLinkUI();
}

function _applyUserToUI(displayName, photoUrl, userId) {
    const nameEl  = document.getElementById('uc-user-name');
    const photoEl = document.getElementById('uc-user-photo');
    if (nameEl)  nameEl.textContent = displayName || '@مستخدم';
    if (photoEl) {
        if (photoUrl) {
            photoEl.src = photoUrl;
            photoEl.onerror = function () { this.onerror = null; this.src = _generateFallbackAvatar(displayName, userId); };
        } else {
            photoEl.src = _generateFallbackAvatar(displayName, userId);
        }
    }
}

function _generateFallbackAvatar(name, userId) {
    const seed = userId ? String(userId) : (name || 'user');
    return 'https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(seed)
         + '&backgroundColor=1a1a2e,16213e,0f3460&textColor=fbbf24&fontSize=38&fontWeight=700';
}

function _applyFallbackUser() {
    const nameEl  = document.getElementById('uc-user-name');
    const photoEl = document.getElementById('uc-user-photo');
    if (nameEl)  nameEl.textContent = '@مستخدم';
    if (photoEl) photoEl.src = _generateFallbackAvatar('user', null);
}

function _updateReferralLinkUI() {
    const linkEl = document.getElementById('referral-link-text');
    if (linkEl) linkEl.textContent = REFERRAL_LINK;
}

// ── Loading screen ────────────────────────────────────────────────
function _hideLoadingScreen() {
    const screen = document.getElementById('app-loading-screen');
    if (!screen) return;
    screen.style.opacity    = '0';
    screen.style.visibility = 'hidden';
    setTimeout(() => screen.remove(), 600);
}

// ── App entry point ───────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    initTelegramUser();
    try {
        await createSession();
        const loadResult = await fetchApi({ type: 'load', data: {} });

        if (loadResult.ok) {
            const pts = parseInt(loadResult.points) || 0;
            const lvl = parseInt(loadResult.level)  || 1;

            APP_STATE.balance = pts;
            APP_STATE.level   = lvl;
            APP_STATE.first_withdraw_done  = !!loadResult.first_withdraw_done;
            APP_STATE.tasks.tgVerified = !!loadResult.tg_verified;

            if (loadResult.config) {
                const cfg = loadResult.config;
                if (cfg.withdraw) APP_CONFIG.withdraw = cfg.withdraw;
                if (cfg.rewards)  APP_CONFIG.rewards  = cfg.rewards;
                if (cfg.telegram) APP_CONFIG.telegram = cfg.telegram;
                if (cfg.ads)      APP_CONFIG.ads      = cfg.ads;
                if (cfg.ads?.daily_limit) _SERVER_CONFIG.ads_daily_limit = cfg.ads.daily_limit;
                _applyConfigToUI();
            }

            // Ads state
            APP_STATE.ads.total        = parseInt(loadResult.ads_total)        || APP_CONFIG.ads.daily_limit || 10;
            APP_STATE.ads.remaining    = parseInt(loadResult.ads_remaining)     || APP_STATE.ads.total;
            APP_STATE.ads.watched      = parseInt(loadResult.ads_watched_today) || 0;
            APP_STATE.ads.earned       = parseInt(loadResult.earned_today)      || 0;
            updateAdUI();

            // Adsgram task state
            if (loadResult.adsgram_task) syncAdsgramStateFromServer(loadResult.adsgram_task);

            // Gift state
            if (loadResult.streak_day !== undefined)
                APP_STATE.gift.dayNumber = Math.max(1, (parseInt(loadResult.streak_day) || 0) + 1);
            const today = new Date().toISOString().slice(0, 10);
            if (String(loadResult.last_gift_date || '').slice(0, 10) === today)
                APP_STATE.gift.claimed = true;

            // Withdraw history
            if (Array.isArray(loadResult.withdrawals)) {
                WITHDRAW_HISTORY.length = 0;
                loadResult.withdrawals.forEach(w => {
                    WITHDRAW_HISTORY.push({ pts: parseInt(w.pts) || 0, address: w.address || '', ts: parseInt(w.ts) || Date.now(), status: w.status || 'pending' });
                });
                renderWithdrawHistory();
            }

            // Daily missions
            if (Array.isArray(loadResult.completed_tasks)) {
                const taskArr = loadResult.completed_tasks;
                const hasType   = (t) => taskArr.some(x => (typeof x === 'string' ? x : x.task_type) === t);
                const isClaimed = (t) => taskArr.some(x => typeof x === 'object' && x.task_type === t && x.reward_claimed);
                if (hasType('ads_10'))        { APP_STATE.tasks.ads10Done  = true; markDailyTaskDone('dtask-ads10',   isClaimed('ads_10')); }
                if (hasType('ads_25'))        { APP_STATE.tasks.ads25Done  = true; markDailyTaskDone('dtask-ads25',   isClaimed('ads_25')); }
                if (hasType('tg_join'))       { APP_STATE.tasks.tgVerified = true; }
                if (hasType('daily_refs_3'))  { APP_STATE.tasks.invite3Done= true; markDailyTaskDone('dtask-invite3', isClaimed('daily_refs_3')); }
            }

            // Referral stats
            const totalRefs  = parseInt(loadResult.total_referrals)  || 0;
            const earnedRefs = parseInt(loadResult.earned_from_refs) || 0;
            document.querySelectorAll('.uc-stat-val').forEach(el => {
                if (el.classList.contains('green')) el.textContent = totalRefs;
                if (el.classList.contains('gold'))  el.textContent = earnedRefs.toLocaleString('en-US');
                if (el.classList.contains('blue'))  el.textContent = loadResult.completed_tasks?.length || 0;
            });
            document.querySelectorAll('.invite-stat-val').forEach((el, i) => {
                if (i === 0) { const sp = el.querySelector('span'); if (sp) sp.textContent = totalRefs; else el.textContent = totalRefs; }
                if (i === 1) { const sp = el.querySelector('span[style*="color:var(--gold)"]'); if (sp) sp.textContent = earnedRefs.toLocaleString('en-US'); }
            });
            const refBadge = document.getElementById('referral-friends-badge');
            if (refBadge) refBadge.textContent = totalRefs + ' صديق';

            if (Array.isArray(loadResult.referral_list) && loadResult.referral_list.length > 0)
                renderReferralList(loadResult.referral_list, totalRefs);

            if (loadResult.tg_id) {
                REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '?start=ref_' + loadResult.tg_id;
                _updateReferralLinkUI();
            }

            // TG verified UI
            if (APP_STATE.tasks.tgVerified) {
                ['tg-join-btn', 'tg-verify-btn-compact'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
                ['tg-action-wrap', 'tg-done-state', 'tg-done-overlay'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });
                const card = document.getElementById('tg-task-card');
                if (card) card.classList.add('completed');
                const aw = document.getElementById('tg-action-wrap');
                if (aw) aw.style.display = 'flex';
            }

            setTimeout(() => { animateBalance(0, pts, 1600); runCounters(document); }, 120);
        } else {
            setTimeout(() => runCounters(document), 350);
        }
    } catch (e) {
        console.error('[INIT] Error:', e.message);
    } finally {
        _hideLoadingScreen();
    }

    setTimeout(initAdsgramTask, 1000);
    _loadChannels();

    // ── Polling ────────────────────────────────────────────────────
    let _lastPolledPts = APP_STATE.balance;
    let _pollInterval;

    async function _doPoll() {
        try {
            const state = await fetchApi({ type: 'get_state', data: {} });
            if (!state.ok) return;

            // Only sync ads if not actively watching (prevents race condition)
            if (state.ads_remaining !== undefined && !APP_STATE.ads.isWatching && !APP_STATE.adsgram.taskInProgress && !APP_STATE.adsgram.claimInProgress) {
                APP_STATE.ads.remaining = state.ads_remaining;
                APP_STATE.ads.watched   = state.ads_watched_today || 0;
                APP_STATE.ads.earned    = state.earned_today      || 0;
                if (state.ad_cooldown_ms > 0)
                    APP_STATE.ads.cooldownUntil = Date.now() + state.ad_cooldown_ms;
                updateAdUI();
            }

            if (state.points !== undefined && state.points !== _lastPolledPts) {
                animateBalance(_lastPolledPts, state.points, 800);
                _lastPolledPts    = state.points;
                APP_STATE.balance = state.points;
            }
            if (state.level !== undefined) APP_STATE.level = state.level;

            if (state.adsgram_task) syncAdsgramStateFromServer(state.adsgram_task);

            if (state.total_referrals !== undefined)
                document.querySelectorAll('.uc-stat-val.green').forEach(el => { el.textContent = state.total_referrals; });
            if (state.earned_from_refs !== undefined)
                document.querySelectorAll('.uc-stat-val.gold').forEach(el => { el.textContent = state.earned_from_refs.toLocaleString('en-US'); });
        } catch (_) {}
    }

    _pollInterval = setInterval(_doPoll, 5000);

    // ── Offline detection ─────────────────────────────────────────
    const offlineBanner = document.getElementById('offline-banner');
    window.addEventListener('offline', () => { clearInterval(_pollInterval); if (offlineBanner) { offlineBanner.style.display = 'block'; requestAnimationFrame(() => { offlineBanner.style.transform = 'translateY(0)'; }); } });
    window.addEventListener('online',  async () => {
        if (offlineBanner) { offlineBanner.style.transform = 'translateY(-100%)'; setTimeout(() => { offlineBanner.style.display = 'none'; }, 300); }
        await _doPoll();
        _pollInterval = setInterval(_doPoll, 5000);
    });

    try { Object.freeze(_SERVER_CONFIG); } catch (_) {}
});
