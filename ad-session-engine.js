// ══════════════════════════════════════════════════════════════════
// ad-session-engine.js
// Smart Ad Session Layer — طبقة ذكية فوق النظام الحالي
// لا تعدّل app-ads.js مباشرة — تُضاف كـ import فقط
// ══════════════════════════════════════════════════════════════════

// ─── 1. NETWORK QUALITY MONITOR ──────────────────────────────────
const NetworkMonitor = (() => {
    let _samples = [];
    const MAX_SAMPLES = 8;

    function _sample() {
        const t = performance.now();
        return new Promise(resolve => {
            const img = new Image();
            img.onload = img.onerror = () => {
                const rtt = performance.now() - t;
                _samples.push(rtt);
                if (_samples.length > MAX_SAMPLES) _samples.shift();
                resolve(rtt);
            };
            img.src = `data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=?_=${t}`;
        });
    }

    function getScore() {
        if (_samples.length === 0) return 0.75;
        const avg = _samples.reduce((a, b) => a + b, 0) / _samples.length;
        if (avg < 100) return 1.0;
        if (avg < 300) return 0.8;
        if (avg < 600) return 0.6;
        return 0.4;
    }

    function getConnectionInfo() {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) return { type: 'unknown', downlink: null, rtt: null, saveData: false };
        return {
            type:     conn.effectiveType || conn.type || 'unknown',
            downlink: conn.downlink  || null,
            rtt:      conn.rtt       || null,
            saveData: conn.saveData  || false,
        };
    }

    function isStable() {
        const info = getConnectionInfo();
        if (info.saveData)           return false;
        if (info.type === '2g')      return false;
        if (info.rtt && info.rtt > 500) return false;
        return getScore() >= 0.5;
    }

    return { sample: _sample, getScore, getConnectionInfo, isStable };
})();

// ─── 2. FPS STABILITY TRACKER ────────────────────────────────────
const FPSTracker = (() => {
    let _fps        = 60;
    let _frames     = 0;
    let _lastTime   = performance.now();
    let _rafId      = null;
    let _running    = false;
    let _dropEvents = 0;

    function _tick() {
        _frames++;
        const now   = performance.now();
        const delta = now - _lastTime;
        if (delta >= 1000) {
            const current = Math.round((_frames * 1000) / delta);
            if (current < 20 && _fps >= 20) _dropEvents++;
            _fps      = current;
            _frames   = 0;
            _lastTime = now;
        }
        if (_running) _rafId = requestAnimationFrame(_tick);
    }

    function start() {
        if (_running) return;
        _running    = true;
        _dropEvents = 0;
        _lastTime   = performance.now();
        _frames     = 0;
        _rafId = requestAnimationFrame(_tick);
    }

    function stop() {
        _running = false;
        if (_rafId) cancelAnimationFrame(_rafId);
        _rafId = null;
    }

    function getStabilityScore() {
        if (_dropEvents === 0) return 1.0;
        if (_dropEvents <= 2)  return 0.85;
        if (_dropEvents <= 5)  return 0.6;
        return 0.4;
    }

    return { start, stop, getStabilityScore, getFPS: () => _fps, getDrops: () => _dropEvents };
})();

// ─── 3. USER ENGAGEMENT SIGNALS ──────────────────────────────────
const EngagementTracker = (() => {
    let _touchCount        = 0;
    let _scrollCount       = 0;
    let _visibilityChanges = 0;
    let _active            = false;

    function _onTouch()      { _touchCount++; }
    function _onScroll()     { _scrollCount++; }
    function _onVisibility() { if (document.hidden) _visibilityChanges++; }

    function start() {
        if (_active) return;
        _active            = true;
        _touchCount        = 0;
        _scrollCount       = 0;
        _visibilityChanges = 0;
        document.addEventListener('touchstart',       _onTouch,      { passive: true });
        document.addEventListener('scroll',           _onScroll,     { passive: true });
        document.addEventListener('visibilitychange', _onVisibility);
    }

    function stop() {
        _active = false;
        document.removeEventListener('touchstart',       _onTouch);
        document.removeEventListener('scroll',           _onScroll);
        document.removeEventListener('visibilitychange', _onVisibility);
    }

    function wasInForeground() { return _visibilityChanges === 0; }

    function getScore() {
        // backgrounded = low quality session
        if (_visibilityChanges > 0) return 0.2;
        const activity = Math.min(_touchCount + _scrollCount * 2, 20);
        // baseline 0.4 حتى لو ما تحرك المستخدم
        return 0.4 + (activity / 20) * 0.6;
    }

    return {
        start, stop, wasInForeground, getScore,
        getSignals: () => ({
            touches:    _touchCount,
            scrolls:    _scrollCount,
            hidden:     _visibilityChanges,
        }),
    };
})();

// ─── 4. DYNAMIC TIMING ENGINE ────────────────────────────────────
const TimingEngine = (() => {
    // reward thresholds (ثابتة حسب المتطلبات)
    const REWARD_THRESHOLDS = {
        MIN_COMPLETE:    30_000,  // 30s → basic reward
        HIGH_ENGAGEMENT: 32_000,  // 32s+ → full reward
    };

    // نطاقات المدة المتوقعة حسب نوع الإعلان (ms)
    const DURATION_PROFILES = {
        short:    { min: 15_000, base: 20_000, max: 28_000 },
        standard: { min: 28_000, base: 35_000, max: 50_000 },
        long:     { min: 45_000, base: 65_000, max: 95_000 },
        extended: { min: 70_000, base: 82_000, max: 125_000 },
    };

    // cooldown تصاعدي (ms)
    const COOLDOWN_SCHEDULE = [
        { after: 0, ms: 60_000  },   // أول إعلان → 60s
        { after: 2, ms: 90_000  },   // بعد الثاني → 90s
        { after: 3, ms: 120_000 },   // بعد الثالث+ → 120s
    ];

    // jitter ±pct% لمنع الأنماط الثابتة تماماً
    function _jitter(ms, pct = 0.10) {
        const delta = ms * pct;
        return Math.round(ms + (Math.random() * 2 - 1) * delta);
    }

    function getExpectedDuration(adType = 'standard', networkScore = 1.0) {
        const profile = DURATION_PROFILES[adType] || DURATION_PROFILES.standard;
        let base = profile.base;
        // شبكة ضعيفة → مدة متوقعة أعلى قليلاً (buffering)
        if (networkScore < 0.6) base = Math.round(base * 1.12);
        return { min: profile.min, base: _jitter(base), max: profile.max };
    }

    function getDynamicCooldown(consecutiveCount) {
        const entry = [...COOLDOWN_SCHEDULE]
            .reverse()
            .find(e => consecutiveCount > e.after);
        const base = (entry || COOLDOWN_SCHEDULE[0]).ms;
        return _jitter(base, 0.08); // ±8% jitter
    }

    function classifySession(durationMs) {
        if (durationMs < REWARD_THRESHOLDS.MIN_COMPLETE)    return 'incomplete';
        if (durationMs < REWARD_THRESHOLDS.HIGH_ENGAGEMENT) return 'basic';
        return 'high_engagement';
    }

    function getRewardMultiplier(sessionClass, engagementScore, fpsScore) {
        if (sessionClass === 'incomplete') return 0;
        if (sessionClass === 'basic')      return 1.0;
        // high_engagement: bonus بناءً على جودة الجلسة — حد أقصى 1.2
        const quality = (engagementScore + fpsScore) / 2;
        const bonus   = Math.max(0, (quality - 0.5) * 0.4);
        return Math.min(1.2, 1.0 + bonus);
    }

    return {
        getExpectedDuration,
        getDynamicCooldown,
        classifySession,
        getRewardMultiplier,
        REWARD_THRESHOLDS,
    };
})();

// ─── 5. ANTI-REPEAT LOGIC ─────────────────────────────────────────
const AntiRepeat = (() => {
    const HISTORY_SIZE = 10;
    const _recent = [];

    // fingerprint مبسط: bucket 5s × network bucket
    function _fp(durationMs, networkScore) {
        const bucket = Math.floor(durationMs / 5000) * 5000;
        const net    = Math.round(networkScore * 10);
        return `${bucket}_${net}`;
    }

    function record(durationMs, networkScore) {
        _recent.push({ fp: _fp(durationMs, networkScore), ts: Date.now() });
        if (_recent.length > HISTORY_SIZE) _recent.shift();
    }

    // 3 جلسات متطابقة من آخر 5 → مريب
    function isSuspicious(durationMs, networkScore) {
        const key   = _fp(durationMs, networkScore);
        const last5 = _recent.slice(-5);
        return last5.filter(s => s.fp === key).length >= 3;
    }

    // هل المدة المبلغ عنها منطقية؟
    function isPlausible(durationMs, expectedProfile) {
        return durationMs >= expectedProfile.min && durationMs <= expectedProfile.max * 1.15;
    }

    return { record, isSuspicious, isPlausible };
})();

// ─── 6. RETRY MANAGER ────────────────────────────────────────────
const RetryManager = (() => {
    let _count = 0;
    const MAX  = 3;
    const NO_RETRY_ERRORS = new Set([
        'daily_limit_reached', 'invalid_session', 'banned', 'account_review',
    ]);

    function getDelay(attempt) {
        // exponential backoff مع jitter: 1.5s → 3s → 6s
        const base   = 1500 * Math.pow(2, attempt);
        const jitter = Math.random() * 500;
        return Math.min(base + jitter, 8000);
    }

    function shouldRetry(error, networkScore) {
        if (_count >= MAX)               return false;
        if (networkScore < 0.4)          return false;
        if (NO_RETRY_ERRORS.has(error))  return false;
        return true;
    }

    function record()   { _count++; }
    function reset()    { _count = 0; }
    function getCount() { return _count; }

    return { getDelay, shouldRetry, record, reset, getCount };
})();

// ─── 7. SESSION STORE ────────────────────────────────────────────
const _store = {
    current:         null,   // { sessionId, adType, startedAt, networkScore, expectedDuration }
    history:         [],     // آخر 20 جلسة
    consecutiveCount: 0,     // عدد الإعلانات المتتالية الناجحة
};

// ─── 8. REWARD VALIDATOR (double-claim guard) ─────────────────────
const RewardValidator = (() => {
    const _claimed = new Set();

    function canClaim(sessionId) {
        return !_claimed.has(sessionId);
    }

    function markClaimed(sessionId) {
        _claimed.add(sessionId);
        if (_claimed.size > 30) {
            const first = _claimed.values().next().value;
            _claimed.delete(first);
        }
    }

    function buildPayload(session, analysis) {
        return {
            // الحقول التي يتوقعها السيرفر الحالي (لا تغيير في reward_ad API)
            ad_started_at:    session.startedAt,
            ad_ended_at:      session.endedAt,
            preload_count:    session.preloadCount,
            // حقول إضافية للطبقة الجديدة (السيرفر يتجاهلها إن لم يعرفها)
            duration_ms:      session.durationMs,
            session_class:    analysis.sessionClass,
            network_score:    Math.round(analysis.scores.network    * 100),
            fps_score:        Math.round(analysis.scores.fps        * 100),
            engagement_score: Math.round(analysis.scores.engagement * 100),
            quality_flags:    analysis.flags,
        };
    }

    return { canClaim, markClaimed, buildPayload };
})();

// ═══════════════════════════════════════════════════════════════════
// MAIN ENGINE — نقطة الدخول الوحيدة
// ═══════════════════════════════════════════════════════════════════
export const AdSessionEngine = {

    // ── يُستدعى قبل بدء الإعلان ──────────────────────────────────
    async prepareSession(adType = 'standard') {
        await NetworkMonitor.sample();
        const networkScore    = NetworkMonitor.getScore();
        const connectionInfo  = NetworkMonitor.getConnectionInfo();

        if (!NetworkMonitor.isStable()) {
            return { ok: false, reason: 'unstable_network', networkScore, connectionInfo };
        }

        FPSTracker.start();
        EngagementTracker.start();

        const sessionId      = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const expectedDuration = TimingEngine.getExpectedDuration(adType, networkScore);

        _store.current = {
            sessionId,
            adType,
            startedAt:       Date.now(),
            networkScore,
            expectedDuration,
            preloadCount:    0,
        };

        return { ok: true, sessionId, expectedDuration, networkScore };
    },

    // ── يُستدعى بعد انتهاء الإعلان بنجاح ────────────────────────
    finalizeSession(preloadCount = 1) {
        const session = _store.current;
        if (!session) return { ok: false, reason: 'no_active_session' };

        FPSTracker.stop();
        EngagementTracker.stop();

        const endedAt        = Date.now();
        const durationMs     = endedAt - session.startedAt;
        const networkScore   = session.networkScore;
        const fpsScore       = FPSTracker.getStabilityScore();
        const engagementScore = EngagementTracker.getScore();
        const inForeground   = EngagementTracker.wasInForeground();
        const signals        = EngagementTracker.getSignals();

        const sessionClass   = TimingEngine.classifySession(durationMs);
        const rewardMult     = TimingEngine.getRewardMultiplier(sessionClass, engagementScore, fpsScore);
        const expectedProfile = TimingEngine.getExpectedDuration(session.adType, networkScore);
        const plausible      = AntiRepeat.isPlausible(durationMs, expectedProfile);
        const suspicious     = AntiRepeat.isSuspicious(durationMs, networkScore);

        const flags = [];
        if (!inForeground)   flags.push('backgrounded');
        if (!plausible)      flags.push('implausible_duration');
        if (networkScore < 0.4) flags.push('unstable_network');
        if (fpsScore < 0.4)  flags.push('poor_fps');
        if (suspicious)      flags.push('suspicious_repeat');

        // الجلسة صالحة إذا: in foreground + مدة منطقية + أقل من 2 flags
        const isValid = inForeground && plausible && flags.length < 2;

        AntiRepeat.record(durationMs, networkScore);

        // cooldown ديناميكي حسب عدد الإعلانات المتتالية
        if (isValid) {
            _store.consecutiveCount++;
        } else {
            _store.consecutiveCount = Math.max(0, _store.consecutiveCount - 1);
        }
        const cooldownMs = TimingEngine.getDynamicCooldown(_store.consecutiveCount);

        const fullSession = {
            ...session,
            endedAt,
            durationMs,
            fpsScore,
            engagementScore,
            inForeground,
            preloadCount,
        };

        const analysis = {
            sessionClass,
            rewardMultiplier: rewardMult,
            isValid,
            flags,
            scores: {
                network:    networkScore,
                fps:        fpsScore,
                engagement: engagementScore,
                overall:    (networkScore + fpsScore + engagementScore) / 3,
            },
        };

        _store.history.push({ ...fullSession, analysis, cooldownMs });
        if (_store.history.length > 20) _store.history.shift();
        _store.current = null;

        return {
            ok:       isValid,
            analysis,
            cooldownMs,
            payload:  RewardValidator.buildPayload(fullSession, analysis),
            signals,
        };
    },

    // ── يُستدعى عند فشل الإعلان أو إلغائه ───────────────────────
    handleFailure(error = '') {
        FPSTracker.stop();
        EngagementTracker.stop();
        _store.current = null;
        // فشل يعيد العداد
        _store.consecutiveCount = Math.max(0, _store.consecutiveCount - 1);

        const networkScore = NetworkMonitor.getScore();
        const canRetry     = RetryManager.shouldRetry(error, networkScore);
        const retryDelay   = canRetry ? RetryManager.getDelay(RetryManager.getCount()) : null;
        if (canRetry) RetryManager.record();

        return { canRetry, retryDelay, networkScore };
    },

    resetRetries() { RetryManager.reset(); },

    getNetworkQuality() {
        return {
            score:  NetworkMonitor.getScore(),
            info:   NetworkMonitor.getConnectionInfo(),
            stable: NetworkMonitor.isStable(),
        };
    },

    canClaimReward(sessionId) { return RewardValidator.canClaim(sessionId); },
    markRewardClaimed(sessionId) { RewardValidator.markClaimed(sessionId); },

    getHistory()          { return [..._store.history]; },
    getConsecutiveCount() { return _store.consecutiveCount; },
};
