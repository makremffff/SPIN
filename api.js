        var API_BASE = '/api';

        // ══════════════════════════════════════════════════════════
        // ✅ APP_CONFIG — Dynamic Config from Server
        // جميع القيم تأتي من /api/config — لا hardcoding في الفرونت
        // أي تعديل في السيرفر ينعكس فوراً
        // ══════════════════════════════════════════════════════════
        var APP_CONFIG = {
            withdraw:  { first_min: 3000, normal_min: 20000, normal_level: 5 },
            rewards:   { referral: 100, telegram_task: 200, adsgram_task: 50,
                         daily_ads_10: 200, daily_ads_25: 300, daily_referrals_3: 1000,
                         points_per_ad: 50 },
            telegram:  { channel_url: 'https://t.me/botbababab' },
            ads:       { daily_limit: 10, cooldown_ms: 30000, min_duration_ms: 14000 },
            adsgram_task: { title_ar: '', title_en: '', block_id: 'task-30166', reward: 50, cooldown_ms: 60000 },
            daily_gift:   { rewards: [], titles_ar: [], descs_ar: [] },
        };

        async function _fetchAppConfig() {
            try {
                const res = await fetch(API_BASE + '/config', { method: 'GET' });
                if (!res.ok) return;
                const data = await res.json();
                if (data.ok !== false) {
                    if (data.withdraw) APP_CONFIG.withdraw = data.withdraw;
                    if (data.rewards)  APP_CONFIG.rewards  = data.rewards;
                    if (data.telegram) APP_CONFIG.telegram = data.telegram;
                    if (data.ads)      APP_CONFIG.ads      = data.ads;
                    if (data.adsgram_task) APP_CONFIG.adsgram_task = data.adsgram_task;
                    if (data.daily_gift)   APP_CONFIG.daily_gift   = data.daily_gift;
                    _applyConfigToUI();
                    console.info('[Config] ✅ Loaded from server:', APP_CONFIG);
                }
            } catch (e) {
                console.warn('[Config] Failed to load — using defaults:', e.message);
            }
        }

        function _applyConfigToUI() {
            // Update TG channel link
            const tgLinks = document.querySelectorAll('[data-tg-channel]');
            tgLinks.forEach(el => {
                el.href = APP_CONFIG.telegram.channel_url;
            });

            // ✅ اسم/عنوان مهمة Adsgram من السيرفر (يتغيّر حسب مزود الإعلان)
            try {
                const lang = (typeof currentLang !== 'undefined') ? currentLang : 'ar';
                const dynTitle = (lang === 'en' && APP_CONFIG.adsgram_task?.title_en)
                    ? APP_CONFIG.adsgram_task.title_en
                    : (APP_CONFIG.adsgram_task?.title_ar || '');
                const titleEl = document.getElementById('adsgram-task-title');
                if (titleEl && dynTitle) titleEl.textContent = dynTitle;

                // ✅ block_id ديناميكي من السيرفر
                const widget = document.getElementById('adsgram-task-widget');
                if (widget && APP_CONFIG.adsgram_task?.block_id) {
                    const cur = widget.getAttribute('data-block-id');
                    if (cur !== APP_CONFIG.adsgram_task.block_id) {
                        widget.setAttribute('data-block-id', APP_CONFIG.adsgram_task.block_id);
                    }
                }
            } catch (_) {}

            // Update reward badges
            const adsgramBadges = document.querySelectorAll('.adsgram-reward-badge, #adsgram-reward-badge');
            adsgramBadges.forEach(el => { el.textContent = APP_CONFIG.rewards.adsgram_task; });

            const refBadges = document.querySelectorAll('.referral-reward-badge');
            refBadges.forEach(el => { el.textContent = APP_CONFIG.rewards.referral; });

            const tgTaskBadges = document.querySelectorAll('.tg-task-reward-badge');
            tgTaskBadges.forEach(el => { el.textContent = APP_CONFIG.rewards.telegram_task; });

            const ads10Badges = document.querySelectorAll('.daily-ads10-reward-badge');
            ads10Badges.forEach(el => { el.textContent = APP_CONFIG.rewards.daily_ads_10; });

            const ads25Badges = document.querySelectorAll('.daily-ads25-reward-badge');
            ads25Badges.forEach(el => { el.textContent = APP_CONFIG.rewards.daily_ads_25; });

            const refs3Badges = document.querySelectorAll('.daily-refs3-reward-badge');
            refs3Badges.forEach(el => { el.textContent = APP_CONFIG.rewards.daily_referrals_3; });

            console.info('[Config] UI updated with server values');
        }
        // Fetch config immediately on load
        _fetchAppConfig();

        // ══════════════════════════════════════════════════════════
        //  ZERO TRUST CLIENT — مطابق لنظام toma
        //  ✅ _sessionId in-memory (لا cookies، لا localStorage)
        //  ✅ X-Session-Id header في كل طلب
        //  ✅ nonce client-side one-time لكل write
        //  ✅ fingerprint multi-signal مُشترك بين جميع الطلبات
        //  ✅ auto-renew عند 401
        //  ✅ showSecurityWall عند حظر
        // ══════════════════════════════════════════════════════════

        var _sessionId      = null;   // session ID — in-memory فقط
        var _fpCache        = null;   // fingerprint cache — لا يتغير بين requests
        var _pendingSession = null;   // منع parallel session creation

        // ── Generate unique Nonce per request ─────────────────────
        function _genNonce() {
            if (crypto?.randomUUID) return crypto.randomUUID();
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('') + '_' + Date.now();
        }

        // ── Security Wall (Ban Screen) ─────────────────────────────
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
                <div style="
                    display:flex;align-items:center;justify-content:center;
                    height:100vh;min-height:100dvh;
                    background:radial-gradient(ellipse at 50% 30%, rgba(239,68,68,0.08) 0%, #0a0a1a 65%);
                    flex-direction:column;gap:0;padding:32px 24px;text-align:center;
                    font-family:'Tajawal',sans-serif;
                ">
                    <!-- GIF -->
                    <div style="margin-bottom:28px;">
                        <img src="asesst/baned.gif" alt="banned"
                             style="width:140px;height:140px;object-fit:contain;
                                    filter:drop-shadow(0 0 32px rgba(239,68,68,0.4));" />
                    </div>

                    <!-- Title -->
                    <div style="
                        color:#f87171;font-size:22px;font-weight:800;
                        letter-spacing:0.3px;margin-bottom:10px;
                        text-shadow:0 0 24px rgba(248,113,113,0.4);
                    ">تم حظر هذا الحساب</div>

                    <!-- Subtitle -->
                    <div style="
                        color:rgba(255,255,255,0.38);font-size:13px;
                        line-height:1.6;max-width:260px;margin-bottom:28px;
                    ">تم رصد نشاط مخالف لسياسة الاستخدام.<br>لا يمكن المتابعة من هذا الحساب.</div>

                    <!-- Divider -->
                    <div style="width:180px;height:1px;background:rgba(255,255,255,0.07);margin-bottom:20px;"></div>

                    <!-- Incident ID -->
                    <div style="
                        background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
                        border-radius:10px;padding:10px 20px;display:inline-flex;
                        flex-direction:column;gap:4px;
                    ">
                        <span style="color:rgba(255,255,255,0.25);font-size:10px;letter-spacing:1px;text-transform:uppercase;">Incident ID</span>
                        <span style="color:rgba(255,255,255,0.45);font-size:12px;font-family:monospace;letter-spacing:1px;">${_genIncidentId()}</span>
                    </div>

                    <!-- Timestamp -->
                    <div style="color:rgba(255,255,255,0.2);font-size:11px;margin-top:14px;">
                        ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC
                    </div>
                </div>`;
        }

        // ── Strong device fingerprint — Multi-Signal ───────────────
        async function _buildFingerprint() {
            if (_fpCache) return _fpCache;

            // Signal 1: Canvas
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

            // Signal 2: WebGL
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

            // Signal 3: Audio
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

            // Signals 4-9: Platform
            const hw       = [navigator.hardwareConcurrency||0, navigator.deviceMemory||0].join('x');
            const touch    = [navigator.maxTouchPoints||0, 'ontouchstart' in window?1:0].join('');
            const platform = [navigator.userAgent||'', navigator.language||'',
                              (navigator.languages||[]).join(','),
                              `${screen.width}x${screen.height}x${screen.colorDepth}`,
                              new Date().getTimezoneOffset(),
                              (Intl.DateTimeFormat().resolvedOptions().timeZone||'')].join('|');
            const plugins  = navigator.plugins?.length || 0;
            const media    = [window.matchMedia('(prefers-color-scheme:dark)').matches?'D':'L',
                              (window.devicePixelRatio||1).toFixed(1)].join('');

            const raw = [canvasHash, webglInfo, audioHash, hw, touch, platform, plugins, media].join('§');

            // djb2 double hash
            let h1 = 5381, h2 = 52711;
            for (let i = 0; i < raw.length; i++) {
                const c = raw.charCodeAt(i);
                h1 = (Math.imul(h1, 31) ^ c) >>> 0;
                h2 = (Math.imul(h2, 33) ^ c) >>> 0;
            }
            const fpHash = ((h1>>>0).toString(16).padStart(8,'0') + (h2>>>0).toString(16).padStart(8,'0'));

            _fpCache = JSON.stringify({
                fp:          fpHash,
                user_agent:  navigator.userAgent        || '',
                lang:        navigator.language         || '',
                screen:      `${screen.width}x${screen.height}`,
                tz_offset:   new Date().getTimezoneOffset(),
                hw_cores:    navigator.hardwareConcurrency || 0,
                hw_mem:      navigator.deviceMemory        || 0,
                touch_pts:   navigator.maxTouchPoints      || 0,
                tz_name:     Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                canvas_sig:  canvasHash,
                webgl_sig:   webglInfo.slice(0, 60),
                audio_sig:   audioHash,
                dpr:         (window.devicePixelRatio||1).toFixed(2),
                color_depth: screen.colorDepth || 0,
            });
            return _fpCache;
        }

        // ── Create Session ─────────────────────────────────────────
        async function _createSession() {
            if (_pendingSession) return _pendingSession;
            _pendingSession = (async () => {
                const tg       = window?.Telegram?.WebApp;
                const initData = tg?.initData || '';
                // ✅ إذا لم يكن initData موجوداً، نُرسل الطلب للسيرفر
                // السيرفر في IS_DEV=true يقبل ذلك ويولّد مستخدم dev تلقائياً
                if (!initData) {
                    console.warn('[ZT] No initData — attempting dev session creation');
                }
                try {
                    const fpStr = await _buildFingerprint();
                    const headers = {
                        'Content-Type':  'application/json',
                        'X-Fingerprint': fpStr,
                    };
                    if (initData) headers['X-Init-Data'] = initData;
                    const res = await fetch(API_BASE, {
                        method:  'POST',
                        headers,
                        credentials: 'include',
                        body: JSON.stringify({ type: 'create_session', data: { initData, fp: JSON.parse(fpStr) } }),
                    });
                    const result = await res.json();
                    if (result.is_banned) {
                        showSecurityWall();
                        return false;
                    }
                    if (result.error === 'account_review') { console.warn('[ZT] Account under review — shadow ban'); return false; }
                    if (result.ok && result._session_token) {
                        _sessionId = result._session_token;
                        console.log('[ZT] Session created:', _sessionId.slice(0, 8) + '...');
                        // تحديث state من بيانات الجلسة
                        if (result.user) {
                            if (result.user.points      !== undefined) USER_STATE.points = parseInt(result.user.points) || 0;
                            if (result.user.level       !== undefined) USER_STATE.level  = parseInt(result.user.level)  || 1;
                            if (result.user.tg_verified !== undefined) TASKS_STATE.tgVerified = !!result.user.tg_verified;
                            if (result.user.streak_day  !== undefined)
                                DAILY_GIFT_STATE.dayNumber = Math.max(1, (parseInt(result.user.streak_day) || 0) + 1);
                            const today = new Date().toISOString().slice(0, 10);
                            if (result.user.last_gift_date === today) DAILY_GIFT_STATE.claimed = true;
                        }
                        return true;
                    }
                    console.warn('[ZT] Session failed:', result.error);
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

        // ── Central request function (Zero Trust) ────────────────────
        async function _dbCall(action, data = {}, _externalNonce = null) {
            if (!_sessionId && !['create_session'].includes(action)) {
                const ok = await _createSession();
                if (!ok) {
                    console.warn('[ZT] No session — dev fallback for:', action);
                }
            }

            // Actions that use server-issued nonces (get_nonce endpoint)
            // Actions التي تحصل على nonce من السيرفر عبر get_nonce
            const SERVER_NONCE_ACTIONS = new Set([
                'claim_gift', 'verify_tg_task', 'submit_withdraw', 'claim_daily_mission', 'verify_channel_task'
            ]);
            // Actions التي تستخدم nonce خارجي (ad_nonce / task_nonce) يُمرَّر يدوياً
            const EXTERNAL_NONCE_ACTIONS = new Set([
                'reward_ad', 'claim_adsgram_task'
            ]);
            // Actions التي لا تحتاج أي nonce
            const SKIP_NONCE = new Set([
                'get_state', 'load', 'get_referrals', 'create_session',
                'track_ad_event', 'start_ad', 'start_adsgram_task',
                'get_nonce', 'get_channels'
            ]);
            const needsServerNonce  = SERVER_NONCE_ACTIONS.has(action) && !_externalNonce;
            const needsNonce        = !SKIP_NONCE.has(action)
                                    && !SERVER_NONCE_ACTIONS.has(action)
                                    && !EXTERNAL_NONCE_ACTIONS.has(action);
            // reward_ad / claim_adsgram_task: يجب أن يُمرَّر _externalNonce دائماً
            if (EXTERNAL_NONCE_ACTIONS.has(action) && !_externalNonce) {
                console.error(`[ZT] ${action} requires external nonce but none provided!`);
                return { ok: false, error: 'nonce_missing' };
            }

            try {
                const fpStr    = await _buildFingerprint();
                const initData = window?.Telegram?.WebApp?.initData || '';

                const headers = {
                    'Content-Type':  'application/json',
                    'X-Fingerprint': fpStr,
                };

                if (initData) headers['X-Init-Data'] = initData;
                if (_sessionId) headers['X-Session-Id'] = _sessionId;

                // ✅ Server-issued nonce for write operations
                let nonce = _externalNonce;
                if (!nonce && needsServerNonce && _sessionId) {
                    try {
                        const nonceRes = await fetch(API_BASE, {
                            method: 'POST',
                            credentials: 'include',
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

                console.log(`[ZT] ${action} | session=${_sessionId?.slice(0,8) || 'none'} | nonce=${nonce?.slice(0,8) || 'skip'}`);

                const res = await fetch(API_BASE, {
                    method: 'POST',
                    headers,
                    credentials: 'include',   // ✅ يُرسل الـ cookie (sid=) مع كل طلب
                    body: JSON.stringify({ type: action, data }),
                });

                if (res.status === 401) {
                    console.warn('[ZT] 401 — renewing session for:', action);
                    _sessionId = null;
                    const renewed = await _createSession();
                    if (renewed) return _dbCall(action, data, _externalNonce);
                    return { ok: false, error: 'auth_failed' };
                }

                const json = await res.json();
                console.log(`[ZT] ${action} response:`, json);

                if (json.is_banned === true) {
                    showSecurityWall();
                }
                return json;
            } catch (e) {
                console.warn('[ZT]', action, 'failed:', e.message);
                return { ok: false };
            }
        }

        // wrappers للتوافق مع الكود القديم
        async function fetchApi({ type, data = {}, _nonce = null }) { return _dbCall(type, data, _nonce); }
        async function createSession() { return _createSession(); }
