// ══════════════════════════════════════════════════════════
// app-core.js — Config · State · Session · Nonce · API
// ══════════════════════════════════════════════════════════

export const API_BASE = '/api';

// ── Central APP_STATE ────────────────────────────────────
export const APP_STATE = {
    balance: 0,
    level:   1,
    usdt_balance: 0,
    first_withdraw_done: false,

    ads: {
        total:          10,
        watched:        0,
        remaining:      10,
        earned:         0,
        isWatching:     false,
        cooldownUntil:  0,
        _cooldownTimer: null,
    },

    tasks: {
        tgJoined:    false,
        tgVerified:  false,
        ads10Done:   false,
        ads25Done:   false,
        invite3Done: false,
    },

    dailyGift: {
        dayNumber: 1,
        claimed:   false,
        isOpening: false,
    },

    serverConfig: {
        pts_per_ton:      100000,
        pts_per_referral: 100,
        ads_daily_limit:  10,
    },

    withdrawHistory: [],
};

export const DAILY_GIFT_STATE = APP_STATE.dailyGift;
export const WITHDRAW_HISTORY = APP_STATE.withdrawHistory;
export const _SERVER_CONFIG   = APP_STATE.serverConfig;

// ── APP_CONFIG ──────────────────────────────────────────
export const APP_CONFIG = {
    withdraw:   { first_min: 3000, normal_min: 20000, normal_level: 5 },
    rewards:    { referral: 100, telegram_task: 200,
                  daily_ads_10: 200, daily_ads_25: 300, daily_referrals_3: 1000,
                  points_per_ad: 50 },
    telegram:   { channel_url: 'https://t.me/botbababab' },
    ads:        { daily_limit: 10, cooldown_ms: 30000, min_duration_ms: 14000 },
    daily_gift: { rewards: [], titles_ar: [], descs_ar: [] },
};

export function _applyConfigToUI() {
    document.querySelectorAll('[data-tg-channel]').forEach(el => {
        el.href = APP_CONFIG.telegram.channel_url;
    });
    document.querySelectorAll('.referral-reward-badge').forEach(el => {
        el.textContent = '+' + (APP_CONFIG.rewards.referral||100).toLocaleString('en-US');
    });
    document.querySelectorAll('.tg-task-reward-badge').forEach(el => {
        el.textContent = '+' + (APP_CONFIG.rewards.telegram_task||200).toLocaleString('en-US');
    });
    document.querySelectorAll('.daily-ads10-reward-badge').forEach(el => {
        el.textContent = '+' + (APP_CONFIG.rewards.daily_ads_10||200).toLocaleString('en-US');
    });
    document.querySelectorAll('.daily-ads25-reward-badge').forEach(el => {
        el.textContent = '+' + (APP_CONFIG.rewards.daily_ads_25||300).toLocaleString('en-US');
    });
    document.querySelectorAll('.daily-refs3-reward-badge').forEach(el => {
        el.textContent = '+' + (APP_CONFIG.rewards.daily_referrals_3||3000).toLocaleString('en-US');
    });
}

// ══════════════════════════════════════════════════════════
// NONCE — يُطلب من السيرفر قبل كل ريكوست يحتاجه
// ══════════════════════════════════════════════════════════
export function _genNonce() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('') + '_' + Date.now();
}

// طلب nonce من السيرفر (مسجّل في جدول nonces) بدلاً من توليده محلياً
async function _getServerNonce(action) {
    try {
        const fpStr    = await _buildFingerprint();
        const initData = window?.Telegram?.WebApp?.initData || '';
        const headers  = { 'Content-Type':'application/json', 'X-Fingerprint': fpStr };
        if (initData)   headers['X-Init-Data']  = initData;
        if (_sessionId) headers['X-Session-Id'] = _sessionId;
        const res  = await fetch(API_BASE, {
            method: 'POST', headers, credentials: 'include',
            body: JSON.stringify({ type: 'get_nonce', data: { action } }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json.ok ? json.nonce : null;
    } catch (e) {
        console.warn('[ZT] get_nonce failed:', e.message);
        return null;
    }
}

// هذه الـ actions لا تحتاج nonce (polling / session / tracking فقط)
const SKIP_NONCE = new Set([
    'create_session', 'get_state', 'load',
    'track_ad_event', 'get_channels', 'get_referrals',
]);

// ══════════════════════════════════════════════════════════
// SECURITY WALL
// ══════════════════════════════════════════════════════════
function _genIncidentId() {
    const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = 'INC-';
    for (let i = 0; i < 12; i++) {
        if (i === 4 || i === 8) id += '-';
        id += ch[Math.floor(Math.random() * ch.length)];
    }
    return id;
}

export function showSecurityWall() {
    const lp = document.getElementById('loading-page');
    if (lp) lp.remove();
    document.body.style.pointerEvents = 'none';
    document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;
            background:radial-gradient(ellipse at 50% 30%,rgba(239,68,68,0.08) 0%,#0a0a1a 65%);
            flex-direction:column;gap:0;padding:32px 24px;text-align:center;font-family:'Tajawal',sans-serif;">
            <div style="margin-bottom:28px;">
                <img src="asesst/baned.gif" alt=""
                     style="width:140px;height:140px;object-fit:contain;filter:drop-shadow(0 0 32px rgba(239,68,68,0.4));"/>
            </div>
            <div style="color:#f87171;font-size:22px;font-weight:800;margin-bottom:10px;
                text-shadow:0 0 24px rgba(248,113,113,0.4);">تم حظر هذا الحساب</div>
            <div style="color:rgba(255,255,255,0.38);font-size:13px;line-height:1.6;max-width:260px;margin-bottom:28px;">
                تم رصد نشاط مخالف لسياسة الاستخدام.<br>لا يمكن المتابعة من هذا الحساب.
            </div>
            <div style="width:180px;height:1px;background:rgba(255,255,255,0.07);margin-bottom:20px;"></div>
            <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
                border-radius:10px;padding:10px 20px;display:inline-flex;flex-direction:column;gap:4px;">
                <span style="color:rgba(255,255,255,0.25);font-size:10px;letter-spacing:1px;text-transform:uppercase;">Incident ID</span>
                <span style="color:rgba(255,255,255,0.45);font-size:12px;font-family:monospace;letter-spacing:1px;">${_genIncidentId()}</span>
            </div>
            <div style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:14px;">
                ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC
            </div>
        </div>`;
}

// ══════════════════════════════════════════════════════════
// FINGERPRINT
// ══════════════════════════════════════════════════════════
let _fpCache = null;

export async function _buildFingerprint() {
    if (_fpCache) return _fpCache;

    let canvasHash = '';
    try {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top'; ctx.font = '14px Arial';
        ctx.fillStyle = '#f60'; ctx.fillRect(125,1,62,20);
        ctx.fillStyle = '#069'; ctx.fillText('Cwm fjordbank glyphs vext quiz',2,15);
        ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('Cwm fjordbank glyphs vext quiz',4,17);
        canvasHash = c.toDataURL().slice(-40);
    } catch (_) { canvasHash = 'canvas_blocked'; }

    let webglInfo = '';
    try {
        const gl = document.createElement('canvas').getContext('webgl');
        if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            webglInfo = ext
                ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)+'|'+gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
                : gl.getParameter(gl.RENDERER);
        }
    } catch (_) { webglInfo = 'webgl_blocked'; }

    let audioHash = '';
    try {
        const ac = new (window.AudioContext||window.webkitAudioContext)({ sampleRate:44100 });
        const osc = ac.createOscillator(); const an = ac.createAnalyser();
        const gain = ac.createGain(); gain.gain.value = 0;
        osc.connect(an); an.connect(gain); gain.connect(ac.destination);
        osc.start(0);
        const buf = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(buf); osc.stop(); await ac.close();
        audioHash = buf.slice(0,8).reduce((s,v) => s+Math.abs(v).toFixed(2), '');
    } catch (_) { audioHash = 'audio_blocked'; }

    const hw       = [navigator.hardwareConcurrency||0, navigator.deviceMemory||0].join('x');
    const platform = [navigator.userAgent||'', navigator.language||'',
                      `${screen.width}x${screen.height}x${screen.colorDepth}`,
                      new Date().getTimezoneOffset(),
                      Intl.DateTimeFormat().resolvedOptions().timeZone||''].join('|');

    const raw = [canvasHash, webglInfo, audioHash, hw, platform].join('§');
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        h1 = (Math.imul(h1,31)^c)>>>0;
        h2 = (Math.imul(h2,33)^c)>>>0;
    }
    const fpHash = (h1>>>0).toString(16).padStart(8,'0') + (h2>>>0).toString(16).padStart(8,'0');

    _fpCache = JSON.stringify({
        fp:         fpHash,
        user_agent: navigator.userAgent        || '',
        lang:       navigator.language         || '',
        screen:     `${screen.width}x${screen.height}`,
        tz_offset:  new Date().getTimezoneOffset(),
        hw_cores:   navigator.hardwareConcurrency || 0,
        hw_mem:     navigator.deviceMemory        || 0,
        touch_pts:  navigator.maxTouchPoints      || 0,
        tz_name:    Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        canvas_sig: canvasHash,
        webgl_sig:  webglInfo.slice(0,60),
        audio_sig:  audioHash,
        dpr:        (window.devicePixelRatio||1).toFixed(2),
        color_depth: screen.colorDepth || 0,
    });
    return _fpCache;
}

// ══════════════════════════════════════════════════════════
// SESSION
// ══════════════════════════════════════════════════════════
let _sessionId      = null;
let _pendingSession = null;

export async function _createSession() {
    if (_pendingSession) return _pendingSession;
    _pendingSession = (async () => {
        const tg       = window?.Telegram?.WebApp;
        const initData = tg?.initData || '';
        try {
            const fpStr  = await _buildFingerprint();
            const headers = { 'Content-Type':'application/json', 'X-Fingerprint': fpStr };
            if (initData) headers['X-Init-Data'] = initData;
            const res    = await fetch(API_BASE, {
                method: 'POST', headers, credentials: 'include',
                body: JSON.stringify({ type:'create_session', data:{ initData, fp: JSON.parse(fpStr) } }),
            });
            const result = await res.json();
            if (result.is_banned) { showSecurityWall(); return false; }
            if (result.error === 'account_review') return false;
            if (result.ok && result._session_token) {
                _sessionId = result._session_token;
                if (result.user) {
                    const u = result.user;
                    if (u.points       !== undefined) APP_STATE.balance       = parseInt(u.points)           || 0;
                    if (u.level        !== undefined) APP_STATE.level         = parseInt(u.level)            || 1;
                    if (u.usdt_balance !== undefined) APP_STATE.usdt_balance  = parseFloat(u.usdt_balance)  || 0;
                    if (u.tg_verified  !== undefined) APP_STATE.tasks.tgVerified = !!u.tg_verified;
                    if (u.streak_day  !== undefined) APP_STATE.dailyGift.dayNumber = Math.max(1,(parseInt(u.streak_day)||0)+1);
                    const today = new Date().toISOString().slice(0,10);
                    if (u.last_gift_date === today) APP_STATE.dailyGift.claimed = true;
                }
                return true;
            }
            return false;
        } catch (e) {
            console.warn('[ZT] Session error:', e.message);
            return false;
        } finally {
            _pendingSession = null;
        }
    })();
    return _pendingSession;
}

// ══════════════════════════════════════════════════════════
// _dbCall — نونس جديد في كل ريكوست مرة وحدة
// ══════════════════════════════════════════════════════════
export async function _dbCall(action, data = {}, externalNonce = null) {
    if (!_sessionId && action !== 'create_session') {
        const ok = await _createSession();
        if (!ok) console.warn('[ZT] No session for:', action);
    }

    try {
        const fpStr    = await _buildFingerprint();
        const initData = window?.Telegram?.WebApp?.initData || '';
        const headers  = { 'Content-Type':'application/json', 'X-Fingerprint': fpStr };
        if (initData)   headers['X-Init-Data']  = initData;
        if (_sessionId) headers['X-Session-Id'] = _sessionId;

        // نونس: إما external (لـ reward_ad) أو مُصدَر من السيرفر لكل ريكوست يحتاجه
        const nonce = externalNonce || (!SKIP_NONCE.has(action) ? await _getServerNonce(action) : null);
        if (nonce) headers['X-Nonce'] = nonce;

        const res  = await fetch(API_BASE, {
            method: 'POST', headers, credentials: 'include',
            body: JSON.stringify({ type: action, data }),
        });

        if (res.status === 401) {
            _sessionId = null;
            const renewed = await _createSession();
            if (renewed) return _dbCall(action, data, externalNonce);
            return { ok:false, error:'auth_failed' };
        }

        const json = await res.json();
        if (json.is_banned === true) showSecurityWall();
        return json;
    } catch (e) {
        console.warn('[ZT]', action, 'failed:', e.message);
        return { ok: false };
    }
}

export async function fetchApi({ type, data = {}, _nonce = null }) {
    return _dbCall(type, data, _nonce);
}
export async function createSession() { return _createSession(); }

// ══════════════════════════════════════════════════════════
// TELEGRAM USER
// ══════════════════════════════════════════════════════════
export const BOT_USERNAME = 'SPINN_TON_Bot';
export const APP_NAME     = 'earn';
export let REFERRAL_LINK  = 'https://t.me/' + BOT_USERNAME + '/' + APP_NAME + '?startapp=ref_0000000000';

export function initTelegramUser() {
    const tg = window?.Telegram?.WebApp;
    if (!tg) { _applyFallbackUser(); return; }
    tg.ready(); tg.expand();
    const user = tg?.initDataUnsafe?.user;
    if (!user) { _applyFallbackUser(); return; }

    const userId    = user.id          ?? null;
    const firstName = user.first_name  ?? '';
    const lastName  = user.last_name   ?? '';
    const username  = user.username    ?? '';
    const photoUrl  = user.photo_url   ?? '';

    let displayName = '@مستخدم';
    if (username)               displayName = '@' + username;
    else if (firstName||lastName) displayName = [firstName,lastName].filter(Boolean).join(' ');

    if (userId) {
        REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '/' + APP_NAME + '?startapp=ref_' + userId;
    }
    _applyUserToUI(displayName, photoUrl, userId);
    _updateReferralLinkUI();
}

function _applyUserToUI(name, photoUrl, userId) {
    const nameEl  = document.getElementById('uc-user-name');
    const photoEl = document.getElementById('uc-user-photo');
    if (nameEl) nameEl.textContent = name || '@مستخدم';
    if (photoEl) {
        if (photoUrl) {
            photoEl.src = photoUrl;
            photoEl.onerror = function() { this.onerror=null; this.src=_fallbackAvatar(name,userId); };
        } else {
            photoEl.src = _fallbackAvatar(name, userId);
        }
    }
}

function _applyFallbackUser() {
    const nameEl  = document.getElementById('uc-user-name');
    const photoEl = document.getElementById('uc-user-photo');
    if (nameEl)  nameEl.textContent = '@مستخدم';
    if (photoEl) photoEl.src = _fallbackAvatar('user', null);
    REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '/' + APP_NAME + '?startapp=ref_0000000000';
    _updateReferralLinkUI();
}

function _fallbackAvatar(name, userId) {
    const seed = userId ? String(userId) : (name||'user');
    return 'https://api.dicebear.com/7.x/initials/svg?seed='+encodeURIComponent(seed)
         + '&backgroundColor=1a1a2e,16213e,0f3460&textColor=fbbf24&fontSize=38&fontWeight=700';
}

export function _updateReferralLinkUI() {
    document.querySelectorAll('.referral-link-display').forEach(el => { el.textContent = REFERRAL_LINK; });
    const inp = document.getElementById('referral-link-input');
    if (inp) inp.value = REFERRAL_LINK;
}

window.showSecurityWall = showSecurityWall;
