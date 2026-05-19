        const API_BASE = '/api';

        // ══════════════════════════════════════════════════════════
        // ✅ APP_CONFIG — Dynamic Config from Server
        // جميع القيم تأتي من /api/config — لا hardcoding في الفرونت
        // أي تعديل في السيرفر ينعكس فوراً
        // ══════════════════════════════════════════════════════════
        let APP_CONFIG = {
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

        let _sessionId      = null;   // session ID — in-memory فقط
        let _fpCache        = null;   // fingerprint cache — لا يتغير بين requests
        let _pendingSession = null;   // منع parallel session creation

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

        /* ─── Ad System ─── */
        /* ─── Deposit via Telegram Support ─── */
        function openDepositSupport() {
            const msg = encodeURIComponent('مرحبا أريد إيداع داخل البوت');
            const url = 'https://t.me/YourSupportUsername?text=' + msg;
            if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.openTelegramLink(url);
            } else {
                window.open(url, '_blank');
            }
        }

        // ✅ Adsgram Block ID — غيّره لـ block ID الخاص بك
        const AD_BLOCK_ID = '30161';

        // ══════════════════════════════════════════════════════════
        // ✅ AdController — Robust initialization per Adsgram docs
        // حسب الدوكيمنت: AdController.init() يُعيد نفس الـ instance
        // لنفس blockId — آمن للاستدعاء المتعدد
        //
        // Anti-fraud:
        //   • الإعلان لا يُشغَّل إلا بعد التحقق من SDK load
        //   • _adWatchStartedAt يُسجَّل لحظة بدء الإعلان
        //   • reward يُرفض إذا مر أقل من 14s
        //   • كل حدث يُرسَل للسيرفر عبر trackAdEvent
        // ══════════════════════════════════════════════════════════
        let _adController      = null;
        let _adWatchStartedAt  = 0;   // timestamp لبداية الإعلان — anti-fraud
        let _adRetryCount      = 0;
        const AD_MAX_RETRIES   = 2;
        const AD_MIN_DURATION  = 7000;  // 7s minimum client-side check

        // ── تهيئة الـ controller مع callbacks رسمية ──────────────────
        function _initAdController() {
            if (!window.Adsgram) return null;
            if (_adController) return _adController;

            try {
                _adController = window.Adsgram.init({
                    blockId: AD_BLOCK_ID,
                    debug:   false,
                    debugBanners: false,
                });
                console.info('[Adsgram] ✅ Controller initialized — blockId:', AD_BLOCK_ID);
            } catch (e) {
                console.error('[Adsgram] ❌ init failed:', e.message);
                _adController = null;
            }
            return _adController;
        }

        // ── _getAdController — يتحقق من SDK ثم يُهيئ الـ controller ──
        function _getAdController() {
            if (!window.Adsgram) {
                console.warn('[Adsgram] SDK not loaded yet');
                return null;
            }
            return _initAdController();
        }

        // ✅ Adsgram Task — DB-persistent state sync
        // السيرفر هو المصدر الحقيقي — الكارد لا يختفي عند refresh
        let _adsgramLocalTimer = null;

        function _syncAdsgramStateFromServer(adsgramState) {
            if (!adsgramState) return;
            const { status, remaining_seconds, reward, claimed } = adsgramState;
            const card   = document.getElementById('adsgram-task-card');
            const done   = document.getElementById('adsgram-task-done');
            const outer  = document.getElementById('adsgram-task-outer');

            logAdsgramState(status, { remaining_seconds, claimed });

            // ✅ إذا لم يُرسل title من /config — استخدم نص افتراضي بدلاً من الإخفاء
            const hasTitle = !!(APP_CONFIG?.adsgram_task?.title_ar || APP_CONFIG?.adsgram_task?.title_en);
            if (!hasTitle) {
                // ضع نصاً افتراضياً حتى لا يظل الكارد فارغاً
                const titleEl = document.getElementById('adsgram-task-title');
                if (titleEl && !titleEl.textContent.trim()) titleEl.textContent = 'مهمة إعلانية';
            }

            if (status === 'ready') {
                // Ready — show card, hide done panel
                if (card)  { card.style.display = 'flex'; card.style.opacity = '1'; }
                if (done)  done.style.display = 'none';
                if (outer) outer.style.display = 'block';
                _clearAdsgramTimer();
            } else if (status === 'watching') {
                // Watching — show countdown
                if (card)  { card.style.display = 'flex'; card.style.opacity = '1'; }
                if (done)  done.style.display = 'none';
                if (outer) outer.style.display = 'block';
                _startAdsgramCountdown(remaining_seconds, reward);
            } else if (status === 'claim') {
                // Ready to claim — show claim button
                if (card) { card.style.display = 'none'; }
                if (done) { done.style.display = 'block'; }
                if (outer) outer.style.display = 'block';
                _showAdsgramClaimReady(reward);
                _clearAdsgramTimer();
            } else if (status === 'cooldown') {
                // Cooldown — show timer
                if (card) card.style.display = 'none';
                if (done) { done.style.display = 'block'; }
                if (outer) outer.style.display = 'block';
                _showAdsgramCooldown(remaining_seconds);
            } else if (status === 'completed') {
                // Completed — hide card after delay
                if (card) card.style.display = 'none';
                if (done) done.style.display = 'none';
                if (outer) outer.style.display = 'none';
                _clearAdsgramTimer();
            }
        }

        function logAdsgramState(status, extra) {
            console.info(`[ADSGRAM] state=${status}`, JSON.stringify(extra));
        }

        function _clearAdsgramTimer() {
            if (_adsgramLocalTimer) { clearInterval(_adsgramLocalTimer); _adsgramLocalTimer = null; }
        }

        function _startAdsgramCountdown(seconds, reward) {
            const done = document.getElementById('adsgram-task-done');
            if (!done) return;
            done.style.display = 'block';
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
            _adsgramLocalTimer = setInterval(() => {
                s--;
                if (s <= 0) {
                    _clearAdsgramTimer();
                    _showAdsgramClaimReady(reward);
                } else { render(); }
            }, 1000);
        }

        function _showAdsgramClaimReady(reward) {
            const done = document.getElementById('adsgram-task-done');
            if (!done) return;
            const r = reward || APP_CONFIG.rewards.adsgram_task || 30;
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
                    width:100%;padding:12px;border-radius:12px;border:none;cursor:pointer;
                    background:linear-gradient(135deg,rgba(52,211,153,0.2),rgba(52,211,153,0.1));
                    border:1px solid rgba(52,211,153,0.3);
                    font-family:'Tajawal',sans-serif;font-size:14px;font-weight:800;
                    color:#34d399;display:flex;align-items:center;justify-content:center;gap:8px;
                    transition:all 0.25s ease;">
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
            _adsgramLocalTimer = setInterval(() => {
                s--;
                if (s <= 0) {
                    _clearAdsgramTimer();
                    // Reset to ready state
                    const outer = document.getElementById('adsgram-task-outer');
                    const card  = document.getElementById('adsgram-task-card');
                    if (done)  done.style.display = 'none';
                    if (card)  { card.style.display = 'flex'; card.style.opacity = '1'; }
                    if (outer) outer.style.display = 'block';
                } else { render(); }
            }, 1000);
        }

        // ✅ Claim Adsgram reward — calls server for verification
        // حالات المهمة:
        //   _adsgramClaimInProgress = طلب claim جارٍ الآن (يمنع التزامن)
        //   _adsgramClaimSucceeded  = نجحت في هذه الدورة — يمنع أي توست خطأ بعد النجاح
        let _adsgramClaimInProgress = false;
        let _adsgramClaimSucceeded  = false;

        async function claimAdsgramTaskReward() {
            if (_adsgramClaimSucceeded) {
                console.warn('[AdsgramTask] already succeeded in this cycle — ignoring');
                return;
            }
            if (_adsgramClaimInProgress) {
                console.warn('[AdsgramTask] claim already in progress — ignoring');
                return;
            }
            _adsgramClaimInProgress = true;
            try {
                await _claimAdsgramTaskRewardInner();
            } finally {
                _adsgramClaimInProgress = false;
            }
        }

        async function _claimAdsgramTaskRewardInner() {
            // claim_adsgram_task يحتاج task_nonce صادر من start_adsgram_task
            const nonce = window._adsgramTaskNonce || null;

            // ✅ إذا لم يكن nonce موجوداً — لا تستدعِ start_adsgram_task هنا
            // لأن ذلك سيعيد ضبط adsgram_started_at=NOW() على السيرفر،
            // فتفشل أي محاولة claim لاحقة بسبب task_too_fast
            if (!nonce) {
                console.warn('[AdsgramTask] no task_nonce — aborting silently');
                return;
            }

            const result = await _dbCall('claim_adsgram_task', {}, nonce);
            if (result.ok) {
                // ✅ علّم النجاح أولاً — يمنع أي reward listener لاحق من المحاولة
                _adsgramClaimSucceeded = true;
                window._adsgramTaskNonce = null; // استُهلك الـ nonce
                animateBalance(USER_STATE.points, result.points, 1000);
                USER_STATE.points = result.points;

                // ✅ توست + إشعار بالمكافأة
                const _taskReward = result.reward || APP_CONFIG.rewards?.adsgram_task || 50;
                showToast('trophy', 'مبروك! 🎁', `+${_taskReward.toLocaleString()} نقطة من المهمة الإعلانية`, 'green', `+${_taskReward}`);
                try {
                    addNotification('gold', 'مكافأة المهمة الإعلانية ✓',
                        `+${_taskReward.toLocaleString('ar-EG')} نقطة أُضيفت لرصيدك`, Date.now());
                } catch (_) {}

                // ── إخفاء الكارد فوراً بعد الاستلام ─────────────────
                const _outerEl = document.getElementById('adsgram-task-outer');
                const _cardEl  = document.getElementById('adsgram-task-card');
                const _doneEl  = document.getElementById('adsgram-task-done');
                if (_outerEl) _outerEl.style.display = 'none';
                if (_cardEl)  _cardEl.style.display  = 'none';
                if (_doneEl)  _doneEl.style.display  = 'none';
                _clearAdsgramTimer();

                // ── إعادة الكارد بعد 230 ثانية ───────────────────────
                setTimeout(() => {
                    _adsgramClaimSucceeded = false; // ابدأ دورة جديدة
                    if (_outerEl) _outerEl.style.display = 'block';
                    if (_cardEl)  { _cardEl.style.display = 'flex'; _cardEl.style.opacity = '1'; }
                    if (_doneEl)  _doneEl.style.display = 'none';
                    if (result.adsgram_task) _syncAdsgramStateFromServer(result.adsgram_task);
                }, 230000);

            } else {
                const e = result.error;
                // ✅ لا نُعيد محاولة start+claim هنا أبداً — لأن start يعيد ضبط الساعة
                if (e === 'already_claimed_today' || e === 'cooldown_active') {
                    // المستخدم استلم من نافذة أخرى — لا تُظهر خطأ
                    _adsgramClaimSucceeded = true;
                    if (result.adsgram_task) _syncAdsgramStateFromServer(result.adsgram_task);
                } else if (e === 'task_too_fast') {
                    // النافذة أُغلقت بسرعة — لا توست؛ Adsgram يتحكم بالمدة
                    console.warn('[AdsgramTask] too_fast — silent, widget controls timing');
                } else if (e === 'task_not_started') {
                    console.warn('[AdsgramTask] not_started — silent');
                } else if (e === 'account_review') {
                    showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
                } else if (e === 'nonce_used' || e === 'nonce_expired' || e === 'invalid' || e === 'nonce_missing') {
                    // الـ nonce استُهلك مسبقاً — يعني claim نجحت بالفعل
                    _adsgramClaimSucceeded = true;
                } else {
                    console.warn('[AdsgramTask] claim failed silently:', e);
                }
            }
        }

        // ✅ watchAdsgramTask — يُستدعى عند ضغط المستخدم على زر Adsgram
        // المنطق الصحيح: start_adsgram_task أولاً → ثم widget.show()
        let _adsgramTaskInProgress = false;

        async function watchAdsgramTask() {
            if (_adsgramTaskInProgress) return;
            _adsgramTaskInProgress = true;

            const widget = document.getElementById('adsgram-task-widget');
            if (!widget) { _adsgramTaskInProgress = false; return; }

            // [1] start_adsgram_task — يسجل started_at في DB ويُصدر task_nonce
            let startRes;
            try {
                startRes = await _dbCall('start_adsgram_task', {});
            } catch (_) {
                startRes = { ok: false, error: 'network_error' };
            }

            if (!startRes.ok) {
                _adsgramTaskInProgress = false;
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

            // خزّن task_nonce لاستخدامه في claim_adsgram_task
            window._adsgramTaskNonce = startRes.task_nonce || null;

            // [2] track ad_started
            await trackAdEvent('ad_started', { block_id: AD_BLOCK_ID, type: 'adsgram_task' }, 'adsgram_task');

            // [3] widget.show() — يفتح Adsgram Task الحقيقي
            // الجائزة تأتي عبر event 'reward' في _initAdsgramTask
            try {
                if (typeof widget.show === 'function') {
                    widget.show();
                } else {
                    const inner = widget.querySelector('button');
                    if (inner) inner.click();
                }
            } catch (e) {
                console.warn('[AdsgramTask] show() error:', e.message);
                _adsgramTaskInProgress = false;
                return;
            }

            _adsgramTaskInProgress = false;
        }

        // ── Adsgram Task — DB state driven, refresh-safe ─────────────
        let _taskCountdown = null;
        let _taskStartedAt = 0;

        function _initAdsgramTask() {
            const widget = document.getElementById('adsgram-task-widget');
            if (!widget) return;

            widget.addEventListener('start', async () => {
                _taskStartedAt = Date.now();
                _adsgramClaimSucceeded = false; // دورة جديدة
                console.info('[AdsgramTask] widget started at', _taskStartedAt);
                // إذا كان watchAdsgramTask() استدعى start_adsgram_task بالفعل وحصل على nonce — تجاهل
                if (window._adsgramTaskNonce) {
                    console.info('[AdsgramTask] nonce already set by watchAdsgramTask — skip double start');
                    return;
                }
                // حالة نادرة: المستخدم ضغط GO مباشرة داخل الـ widget بدون مرور بـ watchAdsgramTask
                try {
                    const startRes = await _dbCall('start_adsgram_task', {});
                    if (startRes.ok || startRes.already_watching) {
                        window._adsgramTaskNonce = startRes.task_nonce || null;
                    } else if (startRes.error === 'cooldown_active') {
                        const sec = Math.ceil((startRes.wait_ms || 60000) / 1000);
                        showToast('coin', 'انتظر قليلاً', `${sec} ثانية`, 'red', '');
                    }
                } catch (e) {
                    console.warn('[AdsgramTask] start failed:', e.message);
                }
            });

            widget.addEventListener('reward', async () => {
                // إذا أُطلق reward قبل start (نادر) — سجّل بداية الآن لتجنّب nonce فارغ
                if (!_taskStartedAt) _taskStartedAt = Date.now();
                // ✅ ضمان مرور الحد الأدنى من الوقت قبل claim
                const elapsed = Date.now() - _taskStartedAt;
                const MIN_WAIT = 1800;
                if (elapsed < MIN_WAIT) {
                    await new Promise(r => setTimeout(r, MIN_WAIT - elapsed));
                }
                // claim مرة واحدة فقط — متعدد النداء آمن (الحارس داخل claimAdsgramTaskReward)
                await claimAdsgramTaskReward();
                // ✅ track ad_completed بعد الـ claim — لا يؤثر على عداد الإعلانات اليومي
                trackAdEvent('ad_completed', { elapsed_ms: Date.now() - _taskStartedAt }, 'adsgram_task').catch(()=>{});
            });

            widget.addEventListener('error', () => {
                console.warn('[AdsgramTask] widget error event');
            });
        }

        // ── trackAdEvent — يرسل حدث للسيرفر بشكل آمن ────────────────
        // ad_type: 'adsgram_task' | 'daily_ad' — فصل تام بين النوعين
        async function trackAdEvent(event, meta, ad_type) {
            try {
                await fetchApi({
                    type: 'track_ad_event',
                    data: { event, ad_type: ad_type || 'daily_ad', meta: meta || {} },
                });
            } catch (_) {}
        }

        // ── عدد الإعلانات المطلوب تحميلها قبل إعطاء الجائزة ────────
        // حسب نظام Adsgram: نُحمّل 3 إعلانات — نُعطي جائزة بعد الثالث فقط
        const AD_PRELOAD_REQUIRED = 1;

        const AD_STATE = {
            total: 10,
            remaining: 10,
            watchedToday: 0,
            earnedToday: 0,
            isWatching: false,
            cooldownUntil: 0,      // timestamp — from server get_state
            _cooldownTimer: null,  // internal countdown interval
            preloadCount: 0,       // عدد الإعلانات المحمّلة في الجلسة الحالية
            pendingReward: false,  // انتظار إرسال reward بعد الـ 3rd ad
        };

        function updateAdUI() {
            const r = AD_STATE.remaining;
            const elRem      = document.getElementById('ads-remaining');
            const elWatched  = document.getElementById('ads-watched');
            const elEarned   = document.getElementById('earned-today');
            const elProgress = document.getElementById('ads-progress');
            const elBtn      = document.getElementById('ad-watch-btn');
            const elDone     = document.getElementById('ad-done-state');
            const elCooldown = document.getElementById('ad-cooldown-msg');

            if (elRem)     elRem.textContent     = r;
            if (elWatched) elWatched.textContent  = AD_STATE.watchedToday;
            if (elEarned)  elEarned.textContent   = AD_STATE.earnedToday.toLocaleString('ar-EG');
            if (elProgress) elProgress.style.width = (((AD_STATE.total - r) / AD_STATE.total) * 100) + '%';
            // تحديث الحد اليومي من السيرفر
            const quotaTotal = document.querySelector('.ad-quota-total');
            if (quotaTotal) quotaTotal.textContent = '/ ' + AD_STATE.total;

            // ── Cooldown state ──────────────────────────────────────
            const coolLeft = AD_STATE.cooldownUntil - Date.now();
            if (coolLeft > 0 && r > 0) {
                if (elBtn) elBtn.classList.add('disabled');
                if (elCooldown) {
                    const sec = Math.ceil(coolLeft / 1000);
                    elCooldown.textContent = `⏳ انتظر ${sec}s`;
                    elCooldown.style.display = 'block';
                }
                // Update countdown every second
                if (!AD_STATE._cooldownTimer) {
                    AD_STATE._cooldownTimer = setInterval(() => {
                        const left = AD_STATE.cooldownUntil - Date.now();
                        if (left <= 0) {
                            clearInterval(AD_STATE._cooldownTimer);
                            AD_STATE._cooldownTimer = null;
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
            }

            syncDailyTasksFromAds();
        }

        // ══════════════════════════════════════════════════════════
        // ✅ watchAd — يُستدعى عند ضغط المستخدم (user-initiated)
        //
        // حسب نظام Adsgram الرسمي:
        //   • يجب أن يكون الاستدعاء مباشراً من حدث مستخدم (click/tap)
        //   • نُحمّل AD_PRELOAD_REQUIRED إعلانات أولاً
        //   • نُنقص من progress عند تحميل كل إعلان
        //   • نُعطي reward فقط بعد اكتمال الثالث
        // ══════════════════════════════════════════════════════════
        async function watchAd() {
            if (AD_STATE.remaining <= 0 || AD_STATE.isWatching) return;

            if (AD_STATE.cooldownUntil && Date.now() < AD_STATE.cooldownUntil) {
                const waitSec = Math.ceil((AD_STATE.cooldownUntil - Date.now()) / 1000);
                showToast('coin', 'انتظر قليلاً ⏳', `${waitSec} ثانية`, 'red', '');
                return;
            }

            AD_STATE.isWatching = true;
            const overlay    = document.getElementById('ad-watch-overlay');
            const countEl    = document.getElementById('overlay-count');
            const adBtn      = document.getElementById('ad-watch-btn');
            const preloadBar = document.getElementById('ad-preload-bar');
            if (adBtn) adBtn.classList.add('disabled');

            // ── تحقق SDK ──────────────────────────────────────────────
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

            // ══════════════════════════════════════════════════════════
            // التسلسل الصحيح (مطابق للـ curl):
            //  لكل إعلان:
            //    1. track_ad_event(ad_started)
            //    2. تشغيل الإعلان عبر Adsgram
            //    3. track_ad_event(ad_completed)
            //  بعد كل الإعلانات:
            //    4. start_ad  → يرجع { ok, ad_nonce }
            //    5. reward_ad مع X-Nonce = ad_nonce
            // ══════════════════════════════════════════════════════════
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

                // [1] track قبل تشغيل الإعلان
                await trackAdEvent('ad_started', { block_id: AD_BLOCK_ID, attempt: i + 1 }, 'daily_ad');

                // [2] تشغيل الإعلان
                const adShown = await _showAdsgramAd();

                if (!adShown) {
                    const elapsed = Date.now() - _adWatchStartedAt;
                    const failTitle = elapsed < 1000 ? '❌ لم تبدأ مشاهدة الإعلان'
                                    : elapsed < 6000 ? `⚠️ الإعلان ${i+1} لم يكتمل`
                                    : '⚠️ تعذّر تشغيل الإعلان';
                    const failSub = elapsed < 6000
                        ? `شاهده حتى النهاية (${successCount}/${AD_PRELOAD_REQUIRED} مكتمل)`
                        : 'حاول مرة أخرى';
                    showToast('coin', failTitle, failSub, 'red', '');
                    _adReset(adBtn);
                    _updatePreloadBar(preloadBar, successCount, AD_PRELOAD_REQUIRED);
                    return;
                }

                // [3] track بعد اكتمال الإعلان
                await trackAdEvent('ad_completed', { elapsed_ms: Date.now() - _adWatchStartedAt }, 'daily_ad');

                successCount++;
                // ✅ لا نُعدّل AD_STATE.remaining يدوياً —
                // السيرفر يُعيد القيمة الصحيحة في reward_ad ثم updateAdUI يُزامنها

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

            // [4] start_ad → يرجع ad_nonce
            const startRes = await _dbCall('start_ad', {});
            if (!startRes.ok) {
                _adReset(adBtn);
                _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);
                if (startRes.error === 'daily_limit_reached') { AD_STATE.remaining = 0; updateAdUI(); }
                else if (startRes.error === 'cooldown_active') {
                    const waitMs = startRes.wait_ms || 30000;
                    AD_STATE.cooldownUntil = Date.now() + waitMs;
                    updateAdUI(); // يظهر العداد في الزر فقط، بدون toast
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

            // [5] reward_ad مع X-Nonce = ad_nonce
            const result = await fetchApi({
                type: 'reward_ad',
                data: { ad_started_at: _adWatchStartedAt, preload_count: successCount },
                _nonce: _adNonce,
            });

            _adReset(adBtn);
            _updatePreloadBar(preloadBar, 0, AD_PRELOAD_REQUIRED);

            if (result.ok) {
                // ✅ أولاً: حدّث الـ state
                AD_STATE.remaining    = result.remaining;
                AD_STATE.watchedToday = result.watchedToday;
                AD_STATE.earnedToday  = result.earnedToday;
                const cdMs = result.cooldown_ms || APP_CONFIG.ads?.cooldown_ms || 30000;
                AD_STATE.cooldownUntil = Date.now() + cdMs;
                if (result.points !== undefined) {
                    animateBalance(USER_STATE.points, result.points, 1200);
                    USER_STATE.points = result.points;
                }

                // ✅ ثانياً: توست + إشعار بالمكافأة
                const earnedPts = APP_CONFIG.rewards?.points_per_ad || 50;
                showToast('trophy', 'مبروك! 🎉', `+${earnedPts.toLocaleString()} نقطة أُضيفت لرصيدك`, 'green', `+${earnedPts}`);
                try {
                    addNotification('gold', 'مكافأة إعلان يومي ✓',
                        `+${earnedPts.toLocaleString('ar-EG')} نقطة — شاهدت ${result.watchedToday || AD_STATE.watchedToday} إعلان اليوم`,
                        Date.now());
                } catch (_) {}

                // ✅ ثالثاً: حدّث UI (cooldown يظهر في الزر فقط)
                updateAdUI();
                await trackAdEvent('reward_granted', { watched_today: result.watchedToday }, 'daily_ad');

            } else {
                console.warn('[Ad] reward_ad rejected:', result.error);
                if (result.error === 'cooldown_active') {
                    const waitMs = result.wait_ms || 30000;
                    AD_STATE.cooldownUntil = Date.now() + waitMs;
                    updateAdUI(); // يظهر العداد في ad-cooldown-msg فقط، بدون toast
                } else if (result.error === 'ad_duration_invalid') {
                    showToast('coin', 'الإعلان لم يكتمل', 'شاهد الإعلان بالكامل', 'red', '');
                } else if (result.error === 'daily_limit_reached') {
                    AD_STATE.remaining = 0;
                    showToast('trophy', 'انتهت إعلانات اليوم 🏆', 'عُد غداً لمزيد من النقاط', 'green', '');
                } else if (['nonce_missing','nonce_not_issued','nonce_expired','invalid'].includes(result.error)) {
                    showToast('coin', 'انتهت الجلسة', 'اضغط مرة أخرى', 'red', '');
                } else {
                    showToast('coin', 'خطأ في المعالجة', 'حاول مرة أخرى', 'red', '');
                }
                updateAdUI();
            }
        }

        // ── helpers ───────────────────────────────────────────────────
        function _adReset(adBtn) {
            AD_STATE.isWatching = false;
            if (adBtn) adBtn.classList.remove('disabled');
        }

        function _updatePreloadBar(el, done, total) {
            if (!el) return;
            const pct = total > 0 ? (done / total) * 100 : 0;
            el.style.width = pct + '%';
            el.style.background = done >= total
                ? 'linear-gradient(90deg, #34d399, #10b981)'
                : 'linear-gradient(90deg, #f59e0b, #fbbf24)';
            // تحديث label
            const label = document.getElementById('ad-preload-label');
            if (label) label.textContent = `${done} / ${total}`;
        }

        // ══════════════════════════════════════════════════════════
        // ✅ _showAdsgramAd — Official Adsgram SDK implementation
        //
        // Per Adsgram docs:
        //   • AdController.show() → Promise
        //   • .then(result) → result.done === true means full watch
        //   • .catch(result) → result.error === true means technical error
        //                    → result.done === false means user skipped
        //
        // Security:
        //   • نسجّل _adWatchStartedAt قبل show()
        //   • نتحقق أن 14s+ مرت قبل إرسال reward_ad
        //   • نرسل كل حدث للسيرفر عبر trackAdEvent
        //   • نمنع reward إذا أُغلق الإعلان مبكراً
        // ══════════════════════════════════════════════════════════
        function _showAdsgramAd() {
            return new Promise(async (resolve) => {
                const controller = _getAdController();
                if (!controller) {
                    console.warn('[Adsgram] SDK not ready');
                    await trackAdEvent('ad_failed', { reason: 'sdk_not_ready' }, 'daily_ad');
                    resolve(false);
                    return;
                }

                // ── تتبع: طلب الإعلان ─────────────────────────────────
                await trackAdEvent('ad_requested', { block_id: AD_BLOCK_ID }, 'daily_ad');

                // ── تسجيل وقت بداية الإعلان — anti-fraud ─────────────
                _adWatchStartedAt = Date.now();

                try {
                    const result = await controller.show();

                    // ── result.done === true = مشاهدة كاملة ─────────────
                    if (result && result.done === true) {
                        const elapsed = Date.now() - _adWatchStartedAt;

                        // ── Client-side 14s check — طبقة أمان إضافية ──
                        if (elapsed < AD_MIN_DURATION) {
                            console.warn('[Adsgram] ⚠️ Ad too short:', elapsed + 'ms');
                            await trackAdEvent('suspicious_activity', {
                                reason: 'ad_too_short',
                                elapsed_ms: elapsed,
                            }, 'daily_ad');
                            resolve(false);
                            return;
                        }

                        await trackAdEvent('ad_completed', { elapsed_ms: elapsed }, 'daily_ad');
                        _adRetryCount = 0;
                        resolve(true);
                    } else {
                        // result.done = false → المستخدم أغلق الإعلان
                        await trackAdEvent('ad_failed', {
                            reason:      'user_skipped',
                            result_done: result?.done,
                            result_error:result?.error,
                        }, 'daily_ad');
                        resolve(false);
                    }
                } catch (result) {
                    // .catch() → خطأ تقني أو إغلاق
                    const errReason = result?.description || result?.state || 'unknown';
                    console.warn('[Adsgram] catch:', errReason);

                    if (result?.error === true) {
                        // خطأ تقني — retry
                        await trackAdEvent('ad_failed', {
                            reason:  'technical_error',
                            message: errReason,
                        }, 'daily_ad');
                        if (_adRetryCount < AD_MAX_RETRIES) {
                            _adRetryCount++;
                            console.info('[Adsgram] Retry', _adRetryCount, '/', AD_MAX_RETRIES);
                            // reset controller for next attempt
                            _adController = null;
                            setTimeout(() => resolve(_showAdsgramAd()), 1500);
                            return;
                        }
                        _adRetryCount = 0;
                    } else {
                        // المستخدم أغلق الإعلان
                        await trackAdEvent('ad_failed', { reason: 'user_closed' }, 'daily_ad');
                    }
                    resolve(false);
                }
            });
        }


        /* Toast icons */
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
            const container = document.getElementById('ad-toast-container');

            const toast = document.createElement('div');
            toast.className = 'ad-toast';
            toast.innerHTML = `
                <div class="toast-icon-wrap ${color}">${TOAST_ICONS[iconKey]}</div>
                <div class="toast-body">
                    <div class="toast-title">${title}</div>
                    <div class="toast-desc">${desc}</div>
                </div>
                <div class="toast-badge ${color}">${badge}</div>
            `;

            container.appendChild(toast);

            // Animate in
            requestAnimationFrame(() => {
                requestAnimationFrame(() => toast.classList.add('show'));
            });

            // Auto dismiss after 3.2s
            setTimeout(() => {
                toast.classList.add('hide');
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 400);
            }, 3200);
        }

        /* ─── Daily Gift System ─── */
        const DAILY_GIFT_STATE = {
            dayNumber: 1,   // اليوم الحالي للمستخدم (1–7+)
            claimed: false,
            isOpening: false
        };

        // ✅ هدية الربح اليومي — نصوص افتراضية فقط (fallback)
        // القيم الفعلية تأتي من السيرفر عبر APP_CONFIG.daily_gift
        const GIFT_DAYS_FALLBACK = [
            { day: 'اليوم الأول',   desc: 'مبروك! بداية رائعة معنا.\nاستمر يومياً لتضاعف مكافآتك!', pts: 100 },
            { day: 'اليوم الثاني',  desc: 'يومان متتاليان!\nالمثابرة هي مفتاح النجاح.', pts: 150 },
            { day: 'اليوم الثالث',  desc: 'ثلاثة أيام متتالية!\nمكافأة خاصة بانتظارك.', pts: 200 },
            { day: 'اليوم الرابع',  desc: 'أسبوعك يقترب!\nاستمر في التحدي.', pts: 250 },
            { day: 'اليوم الخامس', desc: 'خمسة أيام!\nأنت من الملتزمين الحقيقيين.', pts: 300 },
            { day: 'اليوم السادس', desc: 'يوم واحد ويكتمل أسبوعك!\nلا تتوقف.', pts: 400 },
            { day: 'اليوم السابع',  desc: 'أسبوع كامل!\nمكافأة ضخمة بانتظارك.', pts: 750 },
        ];

        // يبني بيانات اليوم من السيرفر إن وُجدت، وإلا من fallback
        function _getGiftDayData(day) {
            const idx = Math.max(0, day - 1);
            const sv = APP_CONFIG?.daily_gift || {};
            const pts   = (sv.rewards   && sv.rewards[idx])   != null ? sv.rewards[idx]
                        : (sv.rewards   && sv.rewards.length) ? sv.rewards[sv.rewards.length - 1]
                        : (GIFT_DAYS_FALLBACK[Math.min(idx, GIFT_DAYS_FALLBACK.length - 1)]?.pts || 100);
            const dayT  = (sv.titles_ar && sv.titles_ar[idx]) || GIFT_DAYS_FALLBACK[Math.min(idx, GIFT_DAYS_FALLBACK.length - 1)]?.day || ('اليوم ' + day);
            const desc  = (sv.descs_ar  && sv.descs_ar[idx])  || GIFT_DAYS_FALLBACK[Math.min(idx, GIFT_DAYS_FALLBACK.length - 1)]?.desc || '';
            return { day: dayT, desc, amount: '+' + pts, pts };
        }

        function openDailyGiftOverlay() {
            if (DAILY_GIFT_STATE.isOpening) return;
            DAILY_GIFT_STATE.isOpening = true;

            const day = DAILY_GIFT_STATE.dayNumber;
            const data = _getGiftDayData(day);

            const dayTextEl  = document.getElementById('gift-day-text');
            const descTextEl = document.getElementById('gift-desc-text');
            const amountEl   = document.getElementById('gift-amount');
            const dotsEl     = document.getElementById('gift-streak-dots');
            const btn        = document.getElementById('gift-claim-btn');
            const label      = document.getElementById('gift-loading-label');
            const ringIcon   = document.getElementById('gift-ring-icon');
            const overlay    = document.getElementById('daily-gift-overlay');

            if (!overlay) { DAILY_GIFT_STATE.isOpening = false; return; }

            if (dayTextEl)  dayTextEl.textContent  = data.day;
            if (descTextEl) descTextEl.textContent = data.desc;
            if (amountEl)   amountEl.textContent   = data.amount;

            // Build streak dots
            if (dotsEl) {
                dotsEl.innerHTML = '';
                for (let i = 1; i <= 7; i++) {
                    const dot = document.createElement('div');
                    dot.style.cssText = `
                        width:${i === day ? '22px' : '8px'};height:8px;border-radius:4px;
                        background:${i < day ? 'rgba(251,191,36,0.75)' : i === day ? '#fbbf24' : 'rgba(255,255,255,0.1)'};
                        box-shadow:${i <= day ? '0 0 6px rgba(251,191,36,0.4)' : 'none'};
                    `;
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
                <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" stroke="#fcd34d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            `;

            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'all';

            if (DAILY_GIFT_STATE.claimed) {
                const t2 = TRANSLATIONS[currentLang];
                if (label) {
                    label.textContent   = t2.gift_already_claimed || 'تم استلام هديتك اليوم ✓';
                    label.style.color      = '#34d399';
                    label.style.fontSize   = '14px';
                    label.style.fontWeight = '700';
                }
                DAILY_GIFT_STATE.isOpening = false;
                setTimeout(() => closeDailyGiftOverlay(), 2200);
                return;
            }

            // Countdown 3 seconds like ad overlay
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
                        btn.style.display = 'block';
                        btn.style.transform = 'scale(0.8)';
                        btn.style.opacity = '0';
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                btn.style.transition = 'all 0.4s cubic-bezier(0.34,1.56,0.64,1)';
                                btn.style.transform = 'scale(1)';
                                btn.style.opacity = '1';
                            });
                        });
                    }
                    DAILY_GIFT_STATE.isOpening = false;
                }
            }, 1000);
        }

        function closeDailyGiftOverlay() {
            const overlay = document.getElementById('daily-gift-overlay');
            if (overlay) { overlay.style.opacity = '0'; overlay.style.pointerEvents = 'none'; }
            DAILY_GIFT_STATE.isOpening = false;
        }

        // Legacy alias (for home button compatibility)
        function openDailyGift() { openDailyGiftOverlay(); }
        function closeDailyGift() { closeDailyGiftOverlay(); }

        async function claimGift() {
            if (DAILY_GIFT_STATE.claimed) return;
            DAILY_GIFT_STATE.claimed = true;

            // ✅ fetchApi يطلب nonce تلقائياً مرتبط بـ action 'claim_gift'
            // السيرفر يتحقق أن هذا الـ nonce صدر لـ claim_gift تحديداً
            const result = await fetchApi({ type: 'claim_gift', data: {} });

            if (!result.ok) {
                // Rollback على فشل الـ backend
                console.warn('[Gift] Backend رفض الطلب — rollback:', result.error);
                DAILY_GIFT_STATE.claimed = false;
                return;
            }

            // ✅ تحديث state من السيرفر
            if (result.streak_day) DAILY_GIFT_STATE.dayNumber = result.streak_day;
            if (result.points !== undefined) {
                animateBalance(USER_STATE.points, result.points);
                USER_STATE.points = result.points;
            }

            const ringIcon = document.getElementById('gift-ring-icon');
            if (ringIcon) ringIcon.innerHTML = `
                <path d="M20 6L9 17l-5-5" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            `;

            const btn = document.getElementById('gift-claim-btn');
            const tc = TRANSLATIONS[currentLang];
            if (btn) {
                btn.textContent = tc.gift_claimed || 'تم الاستلام ✓';
                btn.style.background = 'rgba(52,211,153,0.15)';
                btn.style.color = '#34d399';
                btn.style.border = '1px solid rgba(52,211,153,0.28)';
                btn.style.cursor = 'default';
                btn.onclick = null;
                btn.onmouseenter = null;
                btn.onmouseleave = null;
            }

            // ✅ reward يأتي من السيرفر
            const reward = result.reward || 0;
            showToast('trophy', tc.toast_gift_title || 'تم استلام هديتك!', `+${reward} ${tc.pts || 'نقطة'}`, 'green', `+${reward}`);

            setTimeout(() => closeDailyGiftOverlay(), 1600);
        }


        // ملاحظة: REFERRAL_LINK و BOT_USERNAME معرّفان أعلاه داخل initTelegramUser block

        function copyReferralLink() {
            const btn = document.getElementById('copy-btn');
            navigator.clipboard.writeText(REFERRAL_LINK).catch(() => {
                // fallback
                const ta = document.createElement('textarea');
                ta.value = REFERRAL_LINK;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            });

            // نسخ الرابط — عملية محلية فقط

            // Feedback
            btn.classList.add('copied');
            const t = TRANSLATIONS[currentLang];
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
                </svg>
                ${t.copy_btn_done || 'تم النسخ!'}
            `;

            showToast('trophy', t.toast_copy_title || 'تم نسخ الرابط ✓', t.toast_copy_desc || 'شارك رابطك مع أصدقائك', 'green', '🔗');

            setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                    </svg>
                    ${t.copy_btn_default || t.copy_link}
                `;
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

        /* ═══════════════════════════════════════
           TASKS PAGE — LOGIC
        ═══════════════════════════════════════ */

        const TASKS_STATE = {
            tgJoined: false,
            tgVerified: false,
            // daily counts (sync with AD_STATE)
            ads10Done: false,
            ads25Done: false,
            invite3Done: false,
        };

        // Called when "انضم للقناة" pressed
        function handleTelegramTask() {
            if (TASKS_STATE.tgVerified) return;

            // ✅ Dynamic channel URL from APP_CONFIG (server-driven)
            const channelUrl = APP_CONFIG.telegram.channel_url || 'https://t.me/botbababab';
            if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.openTelegramLink(channelUrl);
            } else {
                window.open(channelUrl, '_blank');
            }

            TASKS_STATE.tgJoined = true;

            const joinBtn    = document.getElementById('tg-join-btn');
            const verifyBtn  = document.getElementById('tg-verify-btn-compact');
            const verifyHint = document.getElementById('tg-verify-hint');

            if (joinBtn)    { joinBtn.style.display = 'none'; }
            if (verifyBtn)  { verifyBtn.style.display = 'inline-flex'; verifyBtn.style.animation = 'pageIn 0.3s ease both'; }
            if (verifyHint) { verifyHint.style.display = 'block'; }
        }

        async function verifyTelegramTask() {
            if (TASKS_STATE.tgVerified) return;

            const verifyBtn = document.getElementById('tg-verify-btn-compact');
            if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.style.opacity = '0.6'; }

            // التسلسل الصحيح: get_nonce(verify_tg_task) أولاً → ثم verify_tg_task + X-Nonce
            const result = await fetchApi({ type: 'verify_tg_task', data: {} });
            // fetchApi يستدعي get_nonce تلقائياً لـ SERVER_NONCE_ACTIONS

            if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.style.opacity = '1'; }

            if (!result.ok) {
                if (result.error === 'account_review') {
                    showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
                } else if (result.error === 'not_in_channel') {
                    showToast('coin', 'لم تنضم للقناة بعد ❌', 'اضغط «انضم» أولاً ثم حاول مجدداً', 'red', '!');
                    // أعد إظهار زر الانضمام
                    const joinBtn = document.getElementById('tg-join-btn');
                    if (joinBtn) { joinBtn.style.display = 'inline-flex'; }
                    if (verifyBtn) { verifyBtn.style.display = 'none'; }
                } else if (result.error === 'already_verified') {
                    showToast('coin', 'تم التحقق مسبقاً ✓', '', 'green', '✓');
                } else {
                    showToast('coin', 'لم يتم التحقق بعد', 'تأكد من انضمامك للقناة ثم حاول مجدداً', 'gold', '!');
                }
                return;
            }

            // ✅ تحديث balance من السيرفر
            if (result.points !== undefined) {
                animateBalance(USER_STATE.points, result.points);
                USER_STATE.points = result.points;
            }

            TASKS_STATE.tgVerified = true;

            const verifyHint = document.getElementById('tg-verify-hint');
            const actionWrap = document.getElementById('tg-action-wrap');
            const doneState  = document.getElementById('tg-done-state');
            const doneOverlay= document.getElementById('tg-done-overlay');
            const card       = document.getElementById('tg-task-card');

            if (verifyBtn)  verifyBtn.style.display  = 'none';
            if (verifyHint) verifyHint.style.display = 'none';
            if (actionWrap) actionWrap.style.display = 'none';

            if (doneState)   { doneState.style.display = 'block'; doneState.style.animation = 'pageIn 0.4s cubic-bezier(0.22,1,0.36,1) both'; }
            if (doneOverlay) doneOverlay.style.display = 'block';
            if (card)        card.classList.add('completed');

            const reward = parseInt(result.reward) || APP_CONFIG.rewards.telegram_task || 200;
            console.log('[TG Task] reward from server:', result.reward, '→ using:', reward);
            showToast('trophy', 'انضممت للقناة! 🎉',
                `+${reward.toLocaleString('ar-EG')} نقطة أضيفت لرصيدك`, 'gold', `+${reward}`);
        }

        /* Daily tasks — update from AD_STATE */
        function syncDailyTasksFromAds() {
            const watched = AD_STATE.watchedToday;

            // Task: 10 ads — dynamic limit from APP_CONFIG
            const pct10 = Math.min(watched / 10, 1) * 100;
            const fill10 = document.getElementById('ads10-fill');
            const prog10 = document.getElementById('ads10-prog');
            if (fill10) fill10.style.width = pct10 + '%';
            if (prog10) prog10.textContent = Math.min(watched, 10) + ' / 10';
            if (watched >= 10 && !TASKS_STATE.ads10Done) {
                TASKS_STATE.ads10Done = true;
                markDailyTaskDone('dtask-ads10', false);
            }

            // Task: 25 ads
            const pct25 = Math.min(watched / 25, 1) * 100;
            const fill25 = document.getElementById('ads25-fill');
            const prog25 = document.getElementById('ads25-prog');
            if (fill25) fill25.style.width = pct25 + '%';
            if (prog25) prog25.textContent = Math.min(watched, 25) + ' / 25';
            if (watched >= 25 && !TASKS_STATE.ads25Done) {
                TASKS_STATE.ads25Done = true;
                markDailyTaskDone('dtask-ads25', false);
            }

            updateDailyBadge();
        }

        // Map: cardId → taskType for claim button IDs
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
                icon.style.border = '1px solid rgba(52,211,153,0.22)';
                icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
            }
            // Show/hide claim button based on reward_claimed
            const taskType  = DTASK_CLAIM_MAP[cardId];
            const claimBtn  = taskType ? document.getElementById('dtask-claim-' + taskType) : null;
            const claimedBadge = card.querySelector('.dtask-claimed-badge');
            if (!rewardClaimed) {
                if (claimBtn)     claimBtn.style.display = 'inline-flex';
                if (claimedBadge) claimedBadge.style.display = 'none';
            } else {
                if (claimBtn)     claimBtn.style.display = 'none';
                if (claimedBadge) claimedBadge.style.display = 'inline-flex';
            }
        }

        // ✅ Claim daily mission reward
        async function claimDailyMission(taskType) {
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
                animateBalance(USER_STATE.points, result.points);
                USER_STATE.points = result.points;
            }

            if (btn) btn.style.display = 'none';
            const cardId = 'dtask-' + taskType.replace('_', '');
            const claimedBadge = document.getElementById(cardId)?.querySelector('.dtask-claimed-badge');
            if (claimedBadge) claimedBadge.style.display = 'inline-flex';

            showToast('trophy', 'تم استلام المكافأة! 🎁', `+${(result.reward||0).toLocaleString()} نقطة`, 'green', `+${result.reward||0}`);
            try {
                addNotification('gold', 'تم استلام مكافأة المهمة اليومية ✓',
                    `+${(result.reward||0).toLocaleString('ar-EG')} نقطة أُضيفت لرصيدك`, Date.now());
            } catch (_) {}
        }

        function updateDailyBadge() {
            const done = [TASKS_STATE.ads10Done, TASKS_STATE.ads25Done, TASKS_STATE.invite3Done].filter(Boolean).length;
            const badge = document.getElementById('daily-tasks-badge');
            if (badge) badge.textContent = done + ' / 3';
        }

        function handleDailyTask(type, el) {
            if (type === 'ads10' || type === 'ads25') {
                showPage('earn', null);
                const navEarn = document.querySelector('.nav-item[data-page="earn"]');
                if (navEarn) {
                    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                    navEarn.classList.add('active');
                }
            } else if (type === 'invite3') {
                showPage('invite', null);
                const navInvite = document.querySelector('.nav-item[data-page="invite"]');
                if (navInvite) {
                    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
                    navInvite.classList.add('active');
                }
            }
        }

        /* ─── Page Navigation ─── */
        function showPage(pageName, btn) {
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

            const target = document.getElementById('page-' + pageName);
            if (target) target.classList.add('active');

            document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));

            if (btn) {
                btn.classList.add('active');
            } else {
                const navBtn = document.querySelector(`.nav-item[data-page="${pageName}"]`);
                if (navBtn) navBtn.classList.add('active');
            }

            // ✅ أعد رسم الرصيد بالقيمة الحالية — بدون reset إلى 0
            updateBalanceUI(USER_STATE.points);

            // ✅ عند فتح صفحة السحب — حدّث الرصيد والحد الأدنى ديناميكياً
            if (pageName === 'withdraw') {
                _refreshWithdrawPageUI();
            }
        }

        // ✅ تحديث عناصر صفحة السحب من APP_CONFIG + USER_STATE
        function _refreshWithdrawPageUI() {
            // رصيد hero
            const heroEl = document.getElementById('withdraw-balance-hero');
            if (heroEl) {
                heroEl.textContent = USER_STATE.points.toLocaleString();
            }
            // الحد الأدنى لزر TON
            const minDisplay = document.getElementById('withdraw-ton-min-display');
            if (minDisplay) {
                minDisplay.textContent = TON_CONFIG.minPts.toLocaleString();
            }
        }

        /* ─── Number Counter ─── */
        function runCounters(scope) {
            scope = scope || document;
            scope.querySelectorAll('.counter').forEach(counter => {
                const target = parseInt(counter.getAttribute('data-target'));
                if (!target) return;

                const duration = 1800;
                const startTime = performance.now();

                function update(now) {
                    const elapsed = now - startTime;
                    const progress = Math.min(elapsed / duration, 1);
                    // Cubic ease-out
                    const ease = 1 - Math.pow(1 - progress, 3);
                    const current = Math.floor(ease * target);
                    counter.textContent = current.toLocaleString('en-US');

                    if (progress < 1) {
                        requestAnimationFrame(update);
                    } else {
                        counter.textContent = target.toLocaleString('en-US');
                    }
                }

                requestAnimationFrame(update);
            });
        }

        /* ═══ انيميشن رصيد — يتحرك من قيمة قديمة إلى قيمة جديدة ═══ */
        function animateBalance(fromPts, toPts, duration) {
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
                // ease-out cubic
                const ease    = 1 - Math.pow(1 - progress, 3);
                const current = Math.round(fromPts + (toPts - fromPts) * ease);
                const fmt     = current.toLocaleString('en-US');
                if (balEl)   balEl.textContent   = fmt;
                if (heroNum) heroNum.textContent  = fmt;
                // تحديث USDT أثناء الأنيميشن
                const usdtLive = document.getElementById('uc-usdt-val');
                if (usdtLive) usdtLive.textContent = (current / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(2);
                if (progress < 1) {
                    requestAnimationFrame(tick);
                } else {
                    updateBalanceUI(toPts); // نهاية — نحدّث كل العناصر بالكامل
                }
            }
            requestAnimationFrame(tick);
        }

        /* ═══ helper: تحديث عناصر الرصيد في الواجهة ═══ */
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
            // ✅ حدّث data-target حتى لا يُعيد runCounters القيمة لـ 0
            if (balEl)   { balEl.textContent  = formatted; balEl.dataset.target  = pts; }
            if (heroNum) { heroNum.textContent = formatted; heroNum.dataset.target = pts; }
            if (tonSheet) tonSheet.textContent = pts.toLocaleString('en-US');
            if (tonEquiv) tonEquiv.textContent = '≈ ' + (pts / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(3) + ' TON';
            if (usdtEl)   usdtEl.textContent  = (pts / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(2);

            // XP bar — نعيد حسابه من النقاط
            const lvl  = USER_STATE.level || 1;
            const THRESHOLDS = [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000];
            const curr = THRESHOLDS[lvl] || 0;
            const next = THRESHOLDS[lvl + 1] || curr + 10000;
            const pct  = next > curr ? Math.min(100, Math.floor((pts - curr) / (next - curr) * 100)) : 100;
            if (xpLevel) xpLevel.textContent = `المستوى ${lvl}`;
            if (xpPct)   xpPct.textContent   = pct + '%';
            if (xpFill)  xpFill.style.width  = pct + '%';
        }

        /* ─── Init ─── */
        // ── Hide loading screen ──────────────────────────────────
        function _hideLoadingScreen() {
            const screen = document.getElementById('app-loading-screen');
            if (!screen) return;
            screen.style.opacity = '0';
            screen.style.visibility = 'hidden';
            setTimeout(() => screen.remove(), 600);
        }

        window.addEventListener('DOMContentLoaded', async () => {
            initTelegramUser();
            try {
            /* Create session right after TG init */
            await createSession();
            /* Load full state from server */
            const loadResult = await fetchApi({ type: 'load', data: {} });
            if (loadResult.ok) {
                const pts = parseInt(loadResult.points) || 0;
                const lvl = parseInt(loadResult.level)  || 1;

                // ✅ تحديث state من السيرفر — كل القيم تأتي من هناك
                USER_STATE.points = pts;
                USER_STATE.level  = lvl;
                USER_STATE.first_withdraw_done = !!loadResult.first_withdraw_done;
                TASKS_STATE.tgVerified = !!loadResult.tg_verified;

                // ✅ config من السيرفر — Dynamic CONFIG
                if (loadResult.config) {
                    const cfg = loadResult.config;
                    // cfg IS the config object directly (not nested)
                    if (cfg.withdraw) APP_CONFIG.withdraw = cfg.withdraw;
                    if (cfg.rewards)  APP_CONFIG.rewards  = cfg.rewards;
                    if (cfg.telegram) APP_CONFIG.telegram = cfg.telegram;
                    if (cfg.ads)      APP_CONFIG.ads       = cfg.ads;
                    // flat keys for backward compat
                    if (cfg.ads?.daily_limit)       _SERVER_CONFIG.ads_daily_limit    = cfg.ads.daily_limit;
                    if (cfg.rewards?.points_per_ad) _SERVER_CONFIG.pts_per_ton        = _SERVER_CONFIG.pts_per_ton; // unchanged
                    _applyConfigToUI();
                }

                // ✅ Ads state من السيرفر
                AD_STATE.total        = parseInt(loadResult.ads_total)        || APP_CONFIG.ads.daily_limit || 10;
                AD_STATE.remaining    = parseInt(loadResult.ads_remaining)     || AD_STATE.total;
                AD_STATE.watchedToday = parseInt(loadResult.ads_watched_today) || 0;
                AD_STATE.earnedToday  = parseInt(loadResult.earned_today)      || 0;
                updateAdUI();

                // ✅ Adsgram Task — DB state (persistent across refresh)
                if (loadResult.adsgram_task) {
                    _syncAdsgramStateFromServer(loadResult.adsgram_task);
                }

                // ✅ Daily gift state
                if (loadResult.streak_day !== undefined) {
                    DAILY_GIFT_STATE.dayNumber = Math.max(1, (parseInt(loadResult.streak_day) || 0) + 1);
                }
                const today = new Date().toISOString().slice(0, 10);
                const lastGift = loadResult.last_gift_date
                    ? String(loadResult.last_gift_date).slice(0, 10) : '';
                if (lastGift === today) DAILY_GIFT_STATE.claimed = true;

                // ✅ Withdraw history من السيرفر
                if (Array.isArray(loadResult.withdrawals)) {
                    WITHDRAW_HISTORY.length = 0;
                    loadResult.withdrawals.forEach(w => {
                        WITHDRAW_HISTORY.push({
                            pts:     parseInt(w.pts)  || 0,
                            address: w.address        || '',
                            ts:      parseInt(w.ts)   || Date.now(),
                            status:  w.status         || 'pending',
                        });
                    });
                    renderWithdrawHistory();
                }

                // ✅ sync daily tasks — new format supports {task_type, reward_claimed}
                if (Array.isArray(loadResult.completed_tasks)) {
                    const taskArr = loadResult.completed_tasks;
                    // Support both old format (strings) and new format (objects)
                    const hasType  = (t) => taskArr.some(x => (typeof x === 'string' ? x : x.task_type) === t);
                    const isClaimed = (t) => taskArr.some(x => typeof x === 'object' && x.task_type === t && x.reward_claimed);

                    if (hasType('ads_10')) {
                        TASKS_STATE.ads10Done = true;
                        markDailyTaskDone('dtask-ads10', isClaimed('ads_10'));
                    }
                    if (hasType('ads_25')) {
                        TASKS_STATE.ads25Done = true;
                        markDailyTaskDone('dtask-ads25', isClaimed('ads_25'));
                    }
                    if (hasType('tg_join')) {
                        TASKS_STATE.tgVerified = true;
                    }
                    if (hasType('daily_refs_3')) {
                        TASKS_STATE.invite3Done = true;
                        markDailyTaskDone('dtask-invite3', isClaimed('daily_refs_3'));
                    }
                }

                // ✅ Referral stats — تحديث مباشر بدون data-target
                const totalRefs  = parseInt(loadResult.total_referrals)  || 0;
                const earnedRefs = parseInt(loadResult.earned_from_refs) || 0;

                // home page stats
                const statEls = document.querySelectorAll('.uc-stat-val');
                statEls.forEach(el => {
                    if (el.classList.contains('green'))  el.textContent = totalRefs;
                    if (el.classList.contains('gold'))   el.textContent = earnedRefs.toLocaleString('en-US');
                    if (el.classList.contains('blue'))   el.textContent = loadResult.completed_tasks?.length || 0;
                });
                // invite page stat cards
                const inviteStatVals = document.querySelectorAll('.invite-stat-val');
                if (inviteStatVals[0]) inviteStatVals[0].querySelector('span')
                    ? (inviteStatVals[0].querySelector('span').textContent = totalRefs)
                    : (inviteStatVals[0].textContent = totalRefs);
                if (inviteStatVals[1]) {
                    const sp = inviteStatVals[1].querySelector('span[style*="color:var(--gold)"]');
                    if (sp) sp.textContent = earnedRefs.toLocaleString('en-US');
                }
                // badge الأصدقاء
                const refBadge = document.getElementById('referral-friends-badge');
                if (refBadge) refBadge.textContent = totalRefs + ' صديق';

                // ✅ Referral list
                if (Array.isArray(loadResult.referral_list) && loadResult.referral_list.length > 0) {
                    renderReferralList(loadResult.referral_list, totalRefs);
                }

                // ✅ رابط الإحالة من tg_id السيرفر — أكثر موثوقية من Telegram.WebApp
                if (loadResult.tg_id) {
                    REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '?start=ref_' + loadResult.tg_id;
                    _updateReferralLinkUI();
                }

                // ✅ tgVerified — إخفاء زر الانضمام إن كان مكتملاً
                if (TASKS_STATE.tgVerified) {
                    const joinBtn     = document.getElementById('tg-join-btn');
                    const verifyBtn   = document.getElementById('tg-verify-btn-compact');
                    const actionWrap  = document.getElementById('tg-action-wrap');
                    const doneState   = document.getElementById('tg-done-state');
                    const doneOverlay = document.getElementById('tg-done-overlay');
                    const card        = document.getElementById('tg-task-card');
                    if (joinBtn)    joinBtn.style.display    = 'none';
                    if (verifyBtn)  verifyBtn.style.display  = 'none';
                    if (actionWrap) actionWrap.style.display = 'flex';
                    if (doneState)  doneState.style.display  = 'block';
                    if (doneOverlay)doneOverlay.style.display= 'block';
                    if (card)       card.classList.add('completed');
                }

                // ✅ انيميشن الرصيد — يبدأ من 0 حتى القيمة الحقيقية عند أول تحميل
                // data-target للعناصر الأخرى (إحصائيات وغيرها)
                setTimeout(() => {
                    animateBalance(0, pts, 1600);
                    runCounters(document);
                }, 120);

            } else {
                // ✅ fallback counters بالأصفار
                setTimeout(() => runCounters(document), 350);
            }

            } catch (e) {
                console.error('[INIT] Error:', e.message);
            } finally {
                // ضمان إخفاء شاشة التحميل دائماً حتى لو فشل شيء
                _hideLoadingScreen();
            }
            setTimeout(_initAdsgramTask, 1000);
            // ── جلب قائمة القنوات من السيرفر ────────────────────────
            _loadChannels();

            // ══════════════════════════════════════════════════════
            // ✅ Auto-refresh — يحدث كل البيانات كل 5 ثواني
            //    • الرصيد + المستوى
            //    • حالة الإعلانات + cooldown
            //    • إحصائيات الإحالات
            //    • حالة المهام
            // ══════════════════════════════════════════════════════
            let _lastPolledPts  = USER_STATE.points;
            let _pollFailCount  = 0;
            const MAX_POLL_FAIL = 5;

            async function _doPoll() {
                try {
                    const state = await fetchApi({ type: 'get_state', data: {} });
                    if (!state.ok) {
                        _pollFailCount++;
                        return;
                    }
                    _pollFailCount = 0;

                    // ── Ads state + cooldown ──────────────────────────
                    // لا نُزامن إذا كان المستخدم يشاهد إعلاناً الآن
                    if (state.ads_remaining !== undefined && !AD_STATE.isWatching) {
                        AD_STATE.remaining    = state.ads_remaining;
                        AD_STATE.watchedToday = state.ads_watched_today || 0;
                        AD_STATE.earnedToday  = state.earned_today || 0;
                        if (state.ad_cooldown_ms > 0) {
                            AD_STATE.cooldownUntil = Date.now() + state.ad_cooldown_ms;
                        }
                        updateAdUI();
                    }

                    // ── Balance animation إذا تغيّر ──────────────────
                    if (state.points !== undefined && state.points !== _lastPolledPts) {
                        animateBalance(_lastPolledPts, state.points, 800);
                        _lastPolledPts    = state.points;
                        USER_STATE.points = state.points;
                    }
                    if (state.level !== undefined) USER_STATE.level = state.level;

                    // ── Adsgram state sync on every poll ─────────────
                    if (state.adsgram_task) {
                        _syncAdsgramStateFromServer(state.adsgram_task);
                    }

                    // ── Referral stats ────────────────────────────────
                    if (state.total_referrals !== undefined) {
                        const statEls = document.querySelectorAll('.uc-stat-val.green');
                        statEls.forEach(el => { el.textContent = state.total_referrals; });
                    }
                    if (state.earned_from_refs !== undefined) {
                        const statEls = document.querySelectorAll('.uc-stat-val.gold');
                        statEls.forEach(el => { el.textContent = state.earned_from_refs.toLocaleString('en-US'); });
                    }

                } catch (_) {
                    _pollFailCount++;
                }
            }

            // Polling interval — 5s normal, slower if offline
            let _pollInterval = setInterval(_doPoll, 5000);

            // ══════════════════════════════════════════════════════
            // ✅ Offline detection + reconnect handling
            // ══════════════════════════════════════════════════════
            const offlineBanner = document.getElementById('offline-banner');

            function showOfflineBanner() {
                if (!offlineBanner) return;
                offlineBanner.style.display = 'block';
                requestAnimationFrame(() => {
                    offlineBanner.style.transform = 'translateY(0)';
                });
            }

            function hideOfflineBanner() {
                if (!offlineBanner) return;
                offlineBanner.style.transform = 'translateY(-100%)';
                setTimeout(() => { offlineBanner.style.display = 'none'; }, 300);
            }

            window.addEventListener('offline', () => {
                clearInterval(_pollInterval);
                showOfflineBanner();
                console.warn('[Network] ⚡ Offline');
            });

            window.addEventListener('online', async () => {
                hideOfflineBanner();
                console.info('[Network] ✅ Back online — re-polling');
                await _doPoll();
                _pollInterval = setInterval(_doPoll, 5000);
            });

            // ── Anti-tamper: freeze _SERVER_CONFIG so no console override ─
            try { Object.freeze(_SERVER_CONFIG); } catch(_) {}

        });

        /* ══════════════════════════════════════════
           TELEGRAM USER DATA — PROFESSIONAL v2
        ══════════════════════════════════════════ */

        // اسم بوت الإحالة — غيّر هذا باسم بوتك الحقيقي
        const BOT_USERNAME = 'RebhApp_bot';

        // متغير عالمي للرابط — يُحدَّث من initTelegramUser()
        let REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '?start=ref_0000000000';

        // معرّف المستخدم العالمي — يُحدَّث عند التهيئة
        let CURRENT_USER_ID = null;

        function initTelegramUser() {
            // ─── 1. التحقق من وجود Telegram WebApp SDK ───
            const tg = window?.Telegram?.WebApp;

            if (!tg) {
                console.warn('[TG] ⚠️ لم يتم تشغيل التطبيق داخل Telegram WebApp — SDK غير محمّل أو البيئة خارجية');
                _applyFallbackUser();
                return;
            }

            // ─── 2. إخبار تيليغرام أن التطبيق جاهز ───
            tg.ready();

            // ─── 3. توسيع التطبيق ليملأ الشاشة ───
            tg.expand();

            // ─── 4. قراءة بيانات المستخدم بأمان ───
            const user = tg?.initDataUnsafe?.user;

            if (!user) {
                console.warn('[TG] ⚠️ initDataUnsafe.user غير متوفر — ربما البيئة dev أو Bot لا يمرر البيانات');
                _applyFallbackUser();
                return;
            }

            // ─── 5. استخراج البيانات بـ optional chaining ───
            const userId    = user?.id          ?? null;
            const firstName = user?.first_name  ?? '';
            const lastName  = user?.last_name   ?? '';
            const username  = user?.username    ?? '';
            const photoUrl  = user?.photo_url   ?? '';
            const langCode  = user?.language_code ?? 'ar';
            const isPremium = user?.is_premium  ?? false;

            // ─── 6. بناء اسم العرض (بدون undefined/null/فارغ) ───
            let displayName = '@مستخدم'; // fallback آمن
            if (username) {
                displayName = '@' + username;
            } else if (firstName || lastName) {
                displayName = [firstName, lastName].filter(Boolean).join(' ');
            }

            // ─── 7. حفظ ID عالمياً وبناء رابط الإحالة الديناميكي ───
            if (userId) {
                CURRENT_USER_ID = userId;
                REFERRAL_LINK = 'https://t.me/' + BOT_USERNAME + '?start=ref_' + userId;
            }

            // ─── 8. تحديث واجهة المستخدم ───
            _applyUserToUI(displayName, photoUrl, userId);

            // ─── 9. تحديث نص رابط الإحالة في صفحة الدعوة ───
            _updateReferralLinkUI();

            // ─── 10. طباعة كل البيانات في Console للتأكد ───
            console.group('[TG] ✅ بيانات المستخدم — Telegram WebApp');
            console.log('🆔 User ID       :', userId   ?? '—');
            console.log('👤 First Name    :', firstName || '—');
            console.log('👤 Last Name     :', lastName  || '—');
            console.log('🔗 Username      :', username  ? '@' + username : '—');
            console.log('🌐 Language      :', langCode  || '—');
            console.log('⭐ Premium       :', isPremium);
            console.log('🖼️  Photo URL     :', photoUrl  || '(لا توجد صورة)');
            console.log('🔗 Referral Link :', REFERRAL_LINK);
            console.log('📦 Raw initData  :', tg.initDataUnsafe);
            console.groupEnd();
        }

        // ─── تطبيق البيانات على الـ UI ───
        function _applyUserToUI(displayName, photoUrl, userId) {
            const nameEl  = document.getElementById('uc-user-name');
            const photoEl = document.getElementById('uc-user-photo');

            // اسم المستخدم — مضمون بدون undefined/null
            if (nameEl) {
                nameEl.textContent = displayName || '@مستخدم';
            }

            // صورة المستخدم — مع fallback تلقائي
            if (photoEl) {
                if (photoUrl) {
                    photoEl.src = photoUrl;
                    photoEl.onerror = function () {
                        console.warn('[TG] 🖼️ فشل تحميل الصورة — تطبيق avatar بديل');
                        this.onerror = null; // منع حلقة لا نهائية
                        this.src = _generateFallbackAvatar(displayName, userId);
                    };
                } else {
                    // لا توجد صورة أصلاً — استخدم avatar مولّد من الاسم/ID
                    photoEl.src = _generateFallbackAvatar(displayName, userId);
                }
            }
        }

        // ─── توليد avatar بديل ذكي ───
        function _generateFallbackAvatar(name, userId) {
            // استخدم seed من userId لضمان ثبات الصورة لكل مستخدم
            const seed = userId ? String(userId) : (name || 'user');
            return 'https://api.dicebear.com/7.x/initials/svg?seed=' + encodeURIComponent(seed)
                 + '&backgroundColor=1a1a2e,16213e,0f3460&textColor=fbbf24&fontSize=38&fontWeight=700';
        }

        // ─── fallback عند غياب بيانات Telegram ───
        function _applyFallbackUser() {
            const nameEl  = document.getElementById('uc-user-name');
            const photoEl = document.getElementById('uc-user-photo');

            if (nameEl)  nameEl.textContent = '@مستخدم';
            if (photoEl) photoEl.src = _generateFallbackAvatar('user', null);

            console.info('[TG] ℹ️ تم تطبيق بيانات افتراضية — لا بيانات Telegram متاحة');
        }

        // ─── تحديث نص الرابط في صفحة الدعوة ───
        function _updateReferralLinkUI() {
            const linkEl = document.getElementById('referral-link-text');
            if (linkEl) {
                linkEl.textContent = REFERRAL_LINK;
            }
        }

        /* ══════════════════════════════════════════
           WITHDRAW HISTORY STATE
        ══════════════════════════════════════════ */
        const WITHDRAW_HISTORY = [];
        const NOTIF_LIST_DATA = [];

        /* ═══ Render Channels from server data ═══ */
        const _channelJoined = {}; // channelId → true (تم الضغط على انضم)

        function renderChannels(channels) {
            const wrap = document.getElementById('channel-tasks-wrap');
            if (!wrap) return;

            if (!channels || !channels.length) {
                wrap.innerHTML = '';
                return;
            }

            wrap.innerHTML = channels.map(ch => {
                const isDone = !!ch.verified;
                const id = ch.id;
                const membersText = ch.max_members > 0
                    ? `<span style="font-size:10px;color:rgba(37,178,248,0.5);font-weight:500;">أقصى ${ch.max_members.toLocaleString()} عضو</span>`
                    : '';

                return `
                <div class="glass" style="border-radius:var(--radius-xl);overflow:hidden;${isDone ? 'border:1px solid rgba(52,211,153,0.2)!important;' : ''}">
                    <div id="ch-card-${id}" style="display:flex;align-items:center;gap:14px;padding:16px 18px;position:relative;transition:background 0.2s ease;">
                        ${isDone ? '<div style="position:absolute;inset:0;background:rgba(52,211,153,0.04);pointer-events:none;"></div>' : ''}
                        <!-- أيقونة تلغرام -->
                        <div style="width:46px;height:46px;border-radius:14px;background:rgba(37,178,248,0.1);border:1px solid rgba(37,178,248,0.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 16px rgba(37,178,248,0.08);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(37,178,248,0.12)" stroke="rgba(37,178,248,0.5)" stroke-width="1.2"/>
                                <path d="M17.5 7.5L15 16.5l-3-3-2 2-1-4-3-1 8.5-3.5z" fill="#29b6f6"/>
                                <path d="M12 13.5l-2 2-1-4 3 2z" fill="rgba(255,255,255,0.4)"/>
                            </svg>
                        </div>
                        <!-- النص -->
                        <div style="flex:1;min-width:0;">
                            <div style="font-family:'Tajawal',sans-serif;font-size:14px;font-weight:800;color:rgba(255,255,255,0.92);margin-bottom:4px;line-height:1.2;">${ch.title}</div>
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                <div style="display:flex;align-items:center;gap:5px;">
                                    <img src="asesst/coins.png" alt="" style="width:11px;height:11px;object-fit:contain;filter:drop-shadow(0 0 3px rgba(251,191,36,0.7));">
                                    <span style="font-family:'Readex Pro',sans-serif;font-size:11px;font-weight:600;color:rgba(251,191,36,0.75);">+${(ch.reward||2500).toLocaleString()} نقطة</span>
                                </div>
                                ${membersText}
                            </div>
                        </div>
                        <!-- الزر -->
                        <div id="ch-action-${id}" style="flex-shrink:0;">
                            ${isDone
                                ? `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                                    <span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span>
                                   </div>`
                                : `<button id="ch-join-btn-${id}" onclick="handleChannelJoin(${id}, '${ch.url}')"
                                        style="display:inline-flex;align-items:center;gap:7px;padding:10px 18px;border-radius:12px;border:1px solid rgba(37,178,248,0.45);background:linear-gradient(135deg,rgba(37,178,248,0.22),rgba(37,178,248,0.08));color:#fff;font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;cursor:pointer;transition:all 0.22s cubic-bezier(0.34,1.56,0.64,1);white-space:nowrap;box-shadow:0 4px 14px rgba(37,178,248,0.13);">
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(41,182,246,0.2)" stroke="rgba(41,182,246,0.8)" stroke-width="1.4"/><path d="M17.5 7.5L15 16.5l-3-3-2 2-1-4-3-1 8.5-3.5z" fill="#fff"/></svg>
                                        انضم
                                   </button>
                                   <button id="ch-verify-btn-${id}" onclick="verifyChannelTask(${id})"
                                        style="display:none;align-items:center;gap:7px;padding:10px 16px;border-radius:12px;border:1px solid rgba(52,211,153,0.38);background:rgba(52,211,153,0.1);color:#34d399;font-family:'Tajawal',sans-serif;font-size:13px;font-weight:800;cursor:pointer;transition:all 0.22s ease;white-space:nowrap;">
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                                        تحقق
                                   </button>`
                            }
                        </div>
                    </div>
                    ${!isDone ? `
                    <div id="ch-hint-${id}" style="display:none;margin:0 18px 14px;padding:9px 13px;border-radius:10px;background:rgba(37,178,248,0.05);border:1px solid rgba(37,178,248,0.13);">
                        <div style="display:flex;align-items:center;gap:7px;">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(37,178,248,0.65)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                            <span style="font-size:11px;color:rgba(37,178,248,0.65);font-weight:600;font-family:'Readex Pro',sans-serif;">اضغط «تحقق» بعد الانضمام للقناة</span>
                        </div>
                    </div>` : ''}
                </div>`;
            }).join('');
        }

        function handleChannelJoin(channelId, url) {
            if (window.Telegram && window.Telegram.WebApp) {
                window.Telegram.WebApp.openTelegramLink(url);
            } else {
                window.open(url, '_blank');
            }
            _channelJoined[channelId] = true;
            const joinBtn   = document.getElementById('ch-join-btn-' + channelId);
            const verifyBtn = document.getElementById('ch-verify-btn-' + channelId);
            const hint      = document.getElementById('ch-hint-' + channelId);
            if (joinBtn)   joinBtn.style.display   = 'none';
            if (verifyBtn) { verifyBtn.style.display = 'inline-flex'; }
            if (hint)      hint.style.display      = 'block';
        }

        async function verifyChannelTask(channelId) {
            const verifyBtn = document.getElementById('ch-verify-btn-' + channelId);
            if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.style.opacity = '0.6'; }

            // التسلسل الصحيح: get_nonce(verify_tg_task) أولاً → ثم verify_channel_task + X-Nonce
            const result = await fetchApi({ type: 'verify_channel_task', data: { channel_id: channelId } });
            // fetchApi يستدعي get_nonce تلقائياً لأن verify_channel_task ضمن SERVER_NONCE_ACTIONS

            if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.style.opacity = '1'; }

            if (!result.ok) {
                if (result.error === 'not_in_channel') {
                    showToast('coin', 'لم تنضم للقناة بعد ❌', 'اضغط «انضم» أولاً ثم حاول مجدداً', 'red', '!');
                    const joinBtn = document.getElementById('ch-join-btn-' + channelId);
                    if (joinBtn)   { joinBtn.style.display = 'inline-flex'; }
                    if (verifyBtn) verifyBtn.style.display = 'none';
                } else if (result.error === 'already_verified') {
                    showToast('coin', 'تم التحقق مسبقاً ✓', '', 'green', '✓');
                    _markChannelDone(channelId, 0, '');
                } else if (result.error === 'account_review') {
                    showToast('coin', 'الحساب قيد المراجعة', 'تواصل مع الدعم', 'red', '!');
                } else {
                    showToast('coin', 'تأكد من انضمامك للقناة ثم أعد المحاولة', '', 'gold', '!');
                }
                return;
            }

            if (result.points !== undefined) {
                animateBalance(USER_STATE.points, result.points);
                USER_STATE.points = result.points;
            }

            const reward = result.reward || 2500;
            showToast('trophy', 'انضممت للقناة! 🎉', `+${reward.toLocaleString()} نقطة أضيفت لرصيدك`, 'gold', `+${reward}`);
            _markChannelDone(channelId, reward, '');
        }

        function _markChannelDone(channelId) {
            const action = document.getElementById('ch-action-' + channelId);
            const hint   = document.getElementById('ch-hint-' + channelId);
            const card   = document.getElementById('ch-card-' + channelId);

            if (hint)  hint.style.display = 'none';
            if (action) action.innerHTML = `
                <div style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.28);padding:9px 14px;border-radius:12px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                    <span style="font-size:12px;font-weight:800;color:#34d399;font-family:'Tajawal',sans-serif;">مكتمل</span>
                </div>`;
            if (card) card.style.background = 'rgba(52,211,153,0.04)';
        }

        async function _loadChannels() {
            const result = await fetchApi({ type: 'get_channels', data: {} });
            const loading = document.getElementById('channel-tasks-loading');
            if (loading) loading.remove();
            if (result.ok && Array.isArray(result.channels)) {
                renderChannels(result.channels);
            }
        }

        /* ═══ Render Referral List from server data ═══ */
        function renderReferralList(list, total) {
            const container = document.getElementById('referral-list-container');
            if (!container) return;

            const colors = [
                { bg: 'linear-gradient(135deg,rgba(167,139,250,0.2),rgba(96,165,250,0.2))', border: 'rgba(167,139,250,0.2)', color: 'var(--purple)' },
                { bg: 'linear-gradient(135deg,rgba(96,165,250,0.2),rgba(52,211,153,0.2))',  border: 'rgba(96,165,250,0.2)',  color: 'var(--blue)'   },
                { bg: 'linear-gradient(135deg,rgba(251,191,36,0.15),rgba(251,191,36,0.05))',border: 'rgba(251,191,36,0.2)',  color: 'var(--gold)'   },
                { bg: 'linear-gradient(135deg,rgba(52,211,153,0.15),rgba(52,211,153,0.05))',border: 'rgba(52,211,153,0.2)',  color: 'var(--green)'  },
            ];
            const pts = APP_CONFIG.rewards.referral || _SERVER_CONFIG.pts_per_referral || 100;

            if (!list.length) return; // keep empty state

            let html = '';
            list.forEach((r, i) => {
                const c    = colors[i % colors.length];
                const ch   = (r.name || 'م')[0];
                const time = formatTimeAgo(r.ts || Date.now());
                html += `
                    <div class="referral-item">
                        <div class="referral-avatar" style="background:${c.bg};border-color:${c.border};color:${c.color};">${ch}</div>
                        <div class="referral-info">
                            <div class="referral-name">${r.name || 'مستخدم'}</div>
                            <div class="referral-date">${time}</div>
                        </div>
                        <div class="referral-reward">
                            <img src="asesst/coins.png" alt="" style="width:14px;height:14px;object-fit:contain;filter:drop-shadow(0 0 3px rgba(251,191,36,0.6));">
                            <span class="referral-reward-text">+${pts}</span>
                        </div>
                    </div>
                    <div class="shine-line-sm" style="margin:2px 10px;"></div>
                `;
            });
            const extra = total - list.length;
            if (extra > 0) {
                html += `<div style="text-align:center;padding:12px 0 4px;"><span style="font-size:12px;font-weight:700;color:var(--purple);opacity:0.7;">+${extra} صديق آخر</span></div>`;
            }
            container.innerHTML = html;
        }

        function formatTimeAgo(ts) {
            const diff = Math.floor((Date.now() - ts) / 1000);
            if (diff < 60)    return 'الآن';
            if (diff < 3600)  return `منذ ${Math.floor(diff/60)} دقيقة`;
            if (diff < 86400) return `منذ ${Math.floor(diff/3600)} ساعة`;
            return `منذ ${Math.floor(diff/86400)} يوم`;
        }

        function renderWithdrawHistory() {
            const list = document.getElementById('withdraw-history-list');
            const empty = document.getElementById('withdraw-empty');
            const badge = document.getElementById('withdraw-count-badge');

            if (WITHDRAW_HISTORY.length === 0) {
                if (empty) empty.style.display = '';
                if (badge) badge.style.display = 'none';
                return;
            }

            if (empty) empty.style.display = 'none';
            if (badge) { badge.style.display = ''; badge.textContent = WITHDRAW_HISTORY.length + ' طلب'; }

            let html = '';
            WITHDRAW_HISTORY.slice().reverse().forEach(item => {
                const tonAmt = (item.pts / 100000).toFixed(3);
                const addrShort = item.address.length > 14
                    ? item.address.substring(0, 6) + '...' + item.address.slice(-6)
                    : item.address;
                html += `
                <div class="withdraw-hist-item">
                    <div class="withdraw-hist-icon">
                        <img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:26px;height:26px;border-radius:7px;object-fit:cover;">
                    </div>
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
            });
            list.innerHTML = html;
        }

        /* ══════════════════════════════════════════
           NOTIFICATIONS
        ══════════════════════════════════════════ */
        let unreadNotifCount = 0;

        function addNotification(type, title, sub, ts) {
            NOTIF_LIST_DATA.unshift({ type, title, sub, ts: ts || Date.now(), read: false });
            unreadNotifCount++;
            updateNotifBadge();
            renderNotifList();
        }

        function updateNotifBadge() {
            const badge = document.getElementById('notif-badge');
            if (!badge) return;
            if (unreadNotifCount > 0) {
                badge.classList.add('visible');
                badge.textContent = unreadNotifCount > 9 ? '9+' : unreadNotifCount;
            } else {
                badge.classList.remove('visible');
                badge.textContent = '';
            }
        }

        function renderNotifList() {
            const list = document.getElementById('notif-list');
            const emptyMsg = document.getElementById('notif-empty-msg');
            if (!list) return;

            if (NOTIF_LIST_DATA.length === 0) {
                if (emptyMsg) emptyMsg.style.display = '';
                return;
            }
            if (emptyMsg) emptyMsg.style.display = 'none';

            const tonIcon = `<img src="https://files.catbox.moe/tym38y.jpg" alt="TON" style="width:22px;height:22px;border-radius:7px;object-fit:cover;">`;
            const coinIcon = `<img src="asesst/coins.png" alt="" style="width:20px;height:20px;object-fit:contain;filter:drop-shadow(0 0 4px rgba(251,191,36,0.7));">`;

            let html = '';
            NOTIF_LIST_DATA.forEach((n, i) => {
                const icon = n.type === 'ton' ? tonIcon : coinIcon;
                const iconClass = n.type === 'ton' ? 'ton' : 'gold';
                html += `
                <div class="notif-item ${n.read ? '' : 'unread'}" onclick="markNotifRead(${i})">
                    ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
                    <div class="notif-item-icon ${iconClass}">${icon}</div>
                    <div class="notif-item-body">
                        <div class="notif-item-title">${n.title}</div>
                        <div class="notif-item-sub">${n.sub}</div>
                    </div>
                    <div class="notif-item-time">${formatTimeAgo(n.ts)}</div>
                </div>`;
            });
            list.innerHTML = html;
        }

        function markNotifRead(idx) {
            if (!NOTIF_LIST_DATA[idx].read) {
                NOTIF_LIST_DATA[idx].read = true;
                unreadNotifCount = Math.max(0, unreadNotifCount - 1);
                updateNotifBadge();
                renderNotifList();
            }
        }

        function openNotifPanel() {
            document.getElementById('notif-panel').classList.add('open');
            document.getElementById('notif-backdrop').classList.add('visible');
            // mark all read when panel opens
            NOTIF_LIST_DATA.forEach(n => { n.read = true; });
            unreadNotifCount = 0;
            updateNotifBadge();
            renderNotifList();
        }

        function closeNotifPanel() {
            document.getElementById('notif-panel').classList.remove('open');
            document.getElementById('notif-backdrop').classList.remove('visible');
        }

        /* ══════════════════════════════════════════
           TON WITHDRAW LOGIC
        ══════════════════════════════════════════ */
        // ✅ _SERVER_CONFIG — قيم ابتدائية، تُحدَّث من السيرفر عند load
        // مُعرَّف أولاً لأن TON_CONFIG يعتمد عليه
        let _SERVER_CONFIG = {
            withdraw_min_pts:   20000,
            withdraw_min_level: 5,
            pts_per_ton:        100000,
            pts_per_referral:   100,
            ads_daily_limit:    10,
        };

        // ✅ USER_STATE — قيم ابتدائية صفر، تُحدَّث من السيرفر عند load
        const USER_STATE = {
            points: 0,
            level:  1,
            first_withdraw_done: false,
        };

        // ✅ TON_CONFIG — Dynamic from APP_CONFIG + first withdraw support
        const TON_CONFIG = new Proxy({}, {
            get(_, k) {
                const fw = USER_STATE.first_withdraw_done;
                if (k === 'minPts')    return fw
                    ? (APP_CONFIG.withdraw.normal_min  || _SERVER_CONFIG.withdraw_min_pts   || 20000)
                    : (APP_CONFIG.withdraw.first_min   || _SERVER_CONFIG.withdraw_min_pts   || 3000);
                if (k === 'minLevel')  return fw
                    ? (APP_CONFIG.withdraw.normal_level || _SERVER_CONFIG.withdraw_min_level || 5)
                    : 0;
                if (k === 'ptsPerTon') return _SERVER_CONFIG.pts_per_ton || 100000;
                if (k === 'isFirstWithdraw') return !fw;
            }
        });

        function openTonWithdraw() {
            const overlay = document.getElementById('ton-withdraw-overlay');
            const ptsEl   = document.getElementById('ton-sheet-pts');
            const equivEl = document.getElementById('ton-sheet-equiv');
            const levelWarn = document.getElementById('ton-level-warn');
            const ptsWarn   = document.getElementById('ton-pts-warn');
            const currentLevelEl = document.getElementById('ton-current-level');
            const submitBtn = document.getElementById('ton-submit-btn');
            const input = document.getElementById('ton-address-input');

            input.value = '';
            document.getElementById('ton-error-msg').style.display = 'none';

            ptsEl.textContent = USER_STATE.points.toLocaleString();
            const tonEquiv = (USER_STATE.points / TON_CONFIG.ptsPerTon).toFixed(3);
            equivEl.textContent = '≈ ' + tonEquiv + ' TON';

            const isFirst  = TON_CONFIG.isFirstWithdraw;
            const hasLevel = isFirst ? true : USER_STATE.level >= TON_CONFIG.minLevel;
            const hasPts   = USER_STATE.points >= TON_CONFIG.minPts;

            levelWarn.style.display = 'none';
            ptsWarn.style.display   = 'none';

            // ── تحديث شريحة "الحد الأدنى" ديناميكياً ──────────────
            const minChipVal = document.getElementById('ton-min-chip-val');
            if (minChipVal) {
                minChipVal.textContent = TON_CONFIG.minPts.toLocaleString() + ' نقطة';
                // لون أخضر للسحب الأول (3000) وعادي بعدها
                minChipVal.style.color = isFirst ? 'var(--green)' : 'var(--gold)';
            }

            // Show first withdraw offer banner
            const firstOfferEl = document.getElementById('first-withdraw-offer');
            if (firstOfferEl) firstOfferEl.style.display = isFirst ? 'flex' : 'none';

            // Update minimum required display
            const minPtsEl = document.getElementById('ton-min-pts');
            if (minPtsEl) minPtsEl.textContent = TON_CONFIG.minPts.toLocaleString();

            // تحديث نص التحذير بالحد الأدنى الفعلي
            const ptsWarnMin = document.getElementById('ton-pts-warn-min');
            if (ptsWarnMin) ptsWarnMin.textContent = TON_CONFIG.minPts.toLocaleString();

            if (!hasLevel) {
                levelWarn.style.display = '';
                if (currentLevelEl) currentLevelEl.textContent = USER_STATE.level;
                submitBtn.disabled = true;
            } else if (!hasPts) {
                ptsWarn.style.display = '';
                submitBtn.disabled = true;
            } else {
                submitBtn.disabled = false;
            }

            overlay.classList.add('visible');
        }

        function closeTonWithdraw() {
            document.getElementById('ton-withdraw-overlay').classList.remove('visible');
        }

        function handleTonOverlayClick(e) {
            if (e.target === document.getElementById('ton-withdraw-overlay')) {
                closeTonWithdraw();
            }
        }

        function clearTonError() {
            document.getElementById('ton-error-msg').style.display = 'none';
            document.getElementById('ton-address-input').style.borderColor = 'rgba(83,147,255,0.3)';
        }

        function isValidTonAddress(addr) {
            addr = addr.trim();
            return (addr.startsWith('EQ') || addr.startsWith('UQ') || addr.startsWith('0:')) && addr.length >= 48;
        }

        async function submitTonWithdraw() {
            const input = document.getElementById('ton-address-input');
            const addr  = input.value.trim();
            const errEl = document.getElementById('ton-error-msg');
            const submitBtn = document.getElementById('ton-submit-btn');

            if (!isValidTonAddress(addr)) {
                errEl.style.display = 'block';
                input.style.borderColor = 'rgba(248,113,113,0.5)';
                return;
            }

            // ─── Loading state ───
            submitBtn.disabled = true;
            submitBtn.textContent = '⏳ جاري الإرسال...';

            const result = await fetchApi({ type: 'submit_withdraw', data: { address: addr } });

            // Restore button
            submitBtn.disabled = false;
            submitBtn.textContent = 'إرسال طلب السحب';

            if (!result.ok) {
                errEl.textContent = result.error === 'insufficient_balance'
                    ? 'رصيدك غير كافٍ'
                    : result.error === 'level_too_low'
                    ? `يتطلب المستوى ${result.required_level || 5} للسحب`
                    : 'حدث خطأ، حاول مجدداً';
                errEl.style.display = 'block';
                return;
            }

            // ✅ تحديث balance من السيرفر مباشرة
            if (result.new_balance !== undefined) {
                animateBalance(USER_STATE.points, result.new_balance);
                USER_STATE.points = result.new_balance;
                _refreshWithdrawPageUI();
            }

            // ✅ بعد أول سحبة — تحديث state وإعادة رسم الحد الأدنى
            if (result.first_withdraw === true) {
                USER_STATE.first_withdraw_done = true;
                // إعادة تحميل chip الحد الأدنى لتعكس 20,000 بدل 3,000
                const minChipVal = document.getElementById('ton-min-chip-val');
                if (minChipVal) {
                    minChipVal.textContent = (APP_CONFIG.withdraw.normal_min || 20000).toLocaleString() + ' نقطة';
                    minChipVal.style.color = 'var(--gold)';
                }
            }

            // ✅ بيانات history من السيرفر
            const item = {
                pts:     result.pts_deducted || USER_STATE.points,
                address: addr,
                ts:      Date.now(),
                status:  result.status || 'pending',
            };
            WITHDRAW_HISTORY.push(item);

            // Add notification
            addNotification(
                'ton',
                'تم استلام طلب السحب',
                `${item.pts.toLocaleString()} نقطة ≈ ${(result.ton_amount || item.pts / (_SERVER_CONFIG.pts_per_ton || 100000)).toFixed(3)} TON`,
                item.ts
            );

            // Render history
            renderWithdrawHistory();

            // Close overlay
            closeTonWithdraw();

            // Toast
            showToast('trophy', 'تم إرسال طلب السحب! 🎉', 'سيتم معالجة طلبك قريباً', 'green', '✓');
        }