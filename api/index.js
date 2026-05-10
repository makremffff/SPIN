/**
 * ═══════════════════════════════════════════════════════════════
 *  الربح عربي — Zero Trust Backend
 *  index.js — Production-Grade Anti-Fraud System
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const express     = require('express');
const crypto      = require('crypto');
const { Pool }    = require('pg');

const app = express();
app.use(express.json({ limit: '64kb' }));

/* ─────────────────────────────────────────
   ENV / CONFIG
───────────────────────────────────────── */
const BOT_TOKEN         = process.env.BOT_TOKEN         || '';
const DATABASE_URL      = process.env.DATABASE_URL       || '';
const SERVER_SECRET     = process.env.SERVER_SECRET      || crypto.randomBytes(32).toString('hex');
const CHANNEL_USERNAME  = process.env.CHANNEL_USERNAME   || 'YourChannelUsername';
const SUPPORT_USERNAME  = process.env.SUPPORT_USERNAME   || 'YourSupportUsername';
const BOT_USERNAME      = process.env.BOT_USERNAME       || 'YourBot';

// Reward config (server-only — never sent to frontend)
const REWARDS = {
    ad_per_watch   : 50,
    ad_daily_max   : 10,
    gift_days      : [100, 150, 200, 250, 300, 400, 750],
    referral_bonus : 1000,
    tg_task_reward : 2500,
    withdraw_min   : 50000,
    pts_per_ton    : 100000,
};

const RATE_LIMITS = {
    global_per_min     : 60,
    auth_per_min       : 10,
    write_per_min      : 30,
    ad_cooldown_sec    : 0,
};

const RISK_THRESHOLDS = {
    shadow_ban  : 60,
    hard_ban    : 85,
};

/* ─────────────────────────────────────────
   DATABASE  (pg Pool — works with Neon DATABASE_URL)
───────────────────────────────────────── */
if (!DATABASE_URL) throw new Error('DATABASE_URL environment variable is not set');

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,                  // serverless: keep pool small
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
});

async function query(sql, params = []) {
    const client = await pool.connect();
    try {
        return await client.query(sql, params);
    } finally {
        client.release();
    }
}

/* ─────────────────────────────────────────
   SCHEMA — AUTO MIGRATION
───────────────────────────────────────── */
async function ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id     BIGINT PRIMARY KEY,
            username        TEXT,
            first_name      TEXT,
            last_name       TEXT,
            photo_url       TEXT,
            points          BIGINT      DEFAULT 0,
            level           INT         DEFAULT 1,
            streak_day      INT         DEFAULT 0,
            last_gift_date  DATE,
            tg_verified     BOOLEAN     DEFAULT FALSE,
            referral_by     BIGINT,
            total_referrals INT         DEFAULT 0,
            earned_refs     BIGINT      DEFAULT 0,
            is_banned       BOOLEAN     DEFAULT FALSE,
            is_shadow       BOOLEAN     DEFAULT FALSE,
            risk_score      INT         DEFAULT 0,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS sessions (
            session_id      TEXT        PRIMARY KEY,
            telegram_id     BIGINT      NOT NULL,
            ip_hash         TEXT        NOT NULL,
            fingerprint_hash TEXT       NOT NULL,
            nonce           TEXT,
            nonce_used      BOOLEAN     DEFAULT FALSE,
            nonce_action    TEXT,
            nonce_expires   TIMESTAMPTZ,
            risk_score      INT         DEFAULT 0,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
            last_seen       TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS ad_events (
            id              BIGSERIAL   PRIMARY KEY,
            telegram_id     BIGINT      NOT NULL,
            session_id      TEXT        NOT NULL,
            ad_nonce        TEXT        UNIQUE,
            ad_nonce_used   BOOLEAN     DEFAULT FALSE,
            pts_awarded     INT         DEFAULT 0,
            is_shadow       BOOLEAN     DEFAULT FALSE,
            event_date      DATE        DEFAULT CURRENT_DATE,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS tasks (
            id              BIGSERIAL   PRIMARY KEY,
            telegram_id     BIGINT      NOT NULL,
            task_type       TEXT        NOT NULL,
            completed_at    TIMESTAMPTZ DEFAULT NOW(),
            pts_awarded     INT         DEFAULT 0,
            UNIQUE(telegram_id, task_type)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS withdraw_requests (
            id              BIGSERIAL   PRIMARY KEY,
            telegram_id     BIGINT      NOT NULL,
            pts_amount      BIGINT      NOT NULL,
            ton_address     TEXT        NOT NULL,
            status          TEXT        DEFAULT 'pending',
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id              BIGSERIAL   PRIMARY KEY,
            telegram_id     BIGINT,
            session_id      TEXT,
            ip_hash         TEXT,
            fp_hash         TEXT,
            action          TEXT        NOT NULL,
            verdict         TEXT,
            attack_type     TEXT,
            risk_score      INT,
            meta            JSONB,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS rate_limit_log (
            id              BIGSERIAL   PRIMARY KEY,
            key             TEXT        NOT NULL,
            bucket          TEXT        NOT NULL,
            hit_at          TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // Auto-add missing columns (migration safety)
    const migrations = [
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_verified BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_by BIGINT`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_referrals INT DEFAULT 0`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS earned_refs BIGINT DEFAULT 0`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score INT DEFAULT 0`,
        `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS nonce TEXT`,
        `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS nonce_used BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS nonce_action TEXT`,
        `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS nonce_expires TIMESTAMPTZ`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_tg ON sessions(telegram_id)`,
        `CREATE INDEX IF NOT EXISTS idx_ad_events_tg_date ON ad_events(telegram_id, event_date)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_tg ON audit_logs(telegram_id)`,
        `CREATE INDEX IF NOT EXISTS idx_rate_limit ON rate_limit_log(key, bucket, hit_at)`,
    ];
    for (const sql of migrations) {
        await query(sql).catch(() => {});
    }
}

/* ─────────────────────────────────────────
   SECURITY HELPERS
───────────────────────────────────────── */

function hashIp(ip) {
    return crypto.createHmac('sha256', SERVER_SECRET).update(ip || 'unknown').digest('hex').slice(0, 32);
}

function hashFp(fpObj) {
    const str = typeof fpObj === 'string' ? fpObj : JSON.stringify(fpObj || {});
    return crypto.createHmac('sha256', SERVER_SECRET).update(str).digest('hex').slice(0, 40);
}

function timingSafeEqual(a, b) {
    try {
        const ba = Buffer.from(String(a));
        const bb = Buffer.from(String(b));
        if (ba.length !== bb.length) {
            crypto.timingSafeEqual(ba, Buffer.alloc(ba.length));
            return false;
        }
        return crypto.timingSafeEqual(ba, bb);
    } catch {
        return false;
    }
}

function genId(len = 32) {
    return crypto.randomBytes(len).toString('hex');
}

function getClientIp(req) {
    return (
        req.headers['cf-connecting-ip'] ||
        req.headers['x-real-ip'] ||
        (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket?.remoteAddress ||
        'unknown'
    );
}

/* ─────────────────────────────────────────
   TELEGRAM initData VERIFICATION
───────────────────────────────────────── */
function verifyInitData(initDataRaw) {
    if (!initDataRaw) return null;

    // DEV MODE: no BOT_TOKEN → accept any initData containing a user field
    if (!BOT_TOKEN) {
        try {
            const params = new URLSearchParams(initDataRaw);
            const userStr = params.get('user');
            return userStr ? JSON.parse(userStr) : null;
        } catch { return null; }
    }

    try {
        const params = new URLSearchParams(initDataRaw);
        const hash   = params.get('hash');
        if (!hash) return null;

        params.delete('hash');
        const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
        const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computed  = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (!timingSafeEqual(computed, hash)) return null;

        // 15 minutes window — handles clock drift & slow connections
        const authDate = parseInt(params.get('auth_date') || '0', 10);
        if (Date.now() / 1000 - authDate > 900) return null;

        const userStr = params.get('user');
        return userStr ? JSON.parse(userStr) : null;
    } catch {
        return null;
    }
}

/* ─────────────────────────────────────────
   SLIDING-WINDOW RATE LIMITER
───────────────────────────────────────── */
const _rateMem = new Map(); // in-memory fast path

function rateLimitCheck(key, maxHits, windowMs) {
    const now = Date.now();
    const arr = _rateMem.get(key) || [];
    const recent = arr.filter(t => now - t < windowMs);
    if (recent.length >= maxHits) return false;
    recent.push(now);
    _rateMem.set(key, recent);
    return true;
}

/* ─────────────────────────────────────────
   RISK ENGINE
───────────────────────────────────────── */
async function adjustRisk(telegramId, sessionId, delta, reason) {
    if (!telegramId) return;
    await query(
        `UPDATE users SET risk_score = LEAST(100, GREATEST(0, risk_score + $1)), updated_at = NOW() WHERE telegram_id = $2`,
        [delta, telegramId]
    ).catch(() => {});
    await query(
        `UPDATE sessions SET risk_score = LEAST(100, GREATEST(0, risk_score + $1)) WHERE session_id = $2`,
        [delta, sessionId]
    ).catch(() => {});
    await auditLog({ telegram_id: telegramId, session_id: sessionId, action: 'risk_adjust', verdict: reason, risk_score: delta });
}

async function getUserRisk(telegramId) {
    const r = await query(`SELECT risk_score, is_banned, is_shadow FROM users WHERE telegram_id = $1`, [telegramId]);
    return r.rows[0] || { risk_score: 0, is_banned: false, is_shadow: false };
}

async function checkAndApplyBan(telegramId, sessionId, riskScore) {
    if (riskScore >= RISK_THRESHOLDS.hard_ban) {
        await query(`UPDATE users SET is_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [telegramId]);
        await auditLog({ telegram_id: telegramId, session_id: sessionId, action: 'hard_ban', verdict: 'auto_ban', risk_score: riskScore });
        return 'hard';
    }
    if (riskScore >= RISK_THRESHOLDS.shadow_ban) {
        await query(`UPDATE users SET is_shadow = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [telegramId]);
        await auditLog({ telegram_id: telegramId, session_id: sessionId, action: 'shadow_ban', verdict: 'auto_shadow', risk_score: riskScore });
        return 'shadow';
    }
    return 'none';
}

/* ─────────────────────────────────────────
   AUDIT LOGGER
───────────────────────────────────────── */
async function auditLog({ telegram_id, session_id, ip_hash, fp_hash, action, verdict, attack_type, risk_score, meta }) {
    await query(
        `INSERT INTO audit_logs (telegram_id, session_id, ip_hash, fp_hash, action, verdict, attack_type, risk_score, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [telegram_id || null, session_id || null, ip_hash || null, fp_hash || null,
         action, verdict || null, attack_type || null, risk_score || 0, meta ? JSON.stringify(meta) : null]
    ).catch(() => {});
}

/* ─────────────────────────────────────────
   MULTI-ACCOUNT DETECTION
───────────────────────────────────────── */
async function detectMultiAccount(telegramId, ipHash, fpHash) {
    const byFp = await query(
        `SELECT COUNT(DISTINCT telegram_id) as cnt FROM sessions WHERE fingerprint_hash = $1 AND telegram_id != $2`,
        [fpHash, telegramId]
    );
    const byIp = await query(
        `SELECT COUNT(DISTINCT telegram_id) as cnt FROM sessions WHERE ip_hash = $1 AND telegram_id != $2 AND created_at > NOW() - INTERVAL '24 hours'`,
        [ipHash, telegramId]
    );
    const fpCount = parseInt(byFp.rows[0]?.cnt || '0');
    const ipCount = parseInt(byIp.rows[0]?.cnt || '0');

    let risk = 0;
    if (fpCount >= 1) risk += 30;
    if (fpCount >= 2) risk += 20;
    if (ipCount >= 3) risk += 15;
    if (ipCount >= 5) risk += 20;
    return { risk, fpCount, ipCount };
}

/* ─────────────────────────────────────────
   SESSION MANAGER
───────────────────────────────────────── */
async function createSession({ telegramId, ipHash, fpHash }) {
    const sessionId = genId(32);
    await query(
        `INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint_hash, expires_at)
         VALUES ($1,$2,$3,$4, NOW() + INTERVAL '24 hours')`,
        [sessionId, telegramId, ipHash, fpHash]
    );
    return sessionId;
}

async function getSession(sessionId) {
    if (!sessionId) return null;
    const r = await query(
        `SELECT * FROM sessions WHERE session_id = $1 AND expires_at > NOW()`,
        [sessionId]
    );
    return r.rows[0] || null;
}

async function touchSession(sessionId) {
    await query(`UPDATE sessions SET last_seen = NOW() WHERE session_id = $1`, [sessionId]).catch(() => {});
}

/* ─────────────────────────────────────────
   NONCE MANAGER (stored in sessions table)
───────────────────────────────────────── */
async function issueNonce(sessionId, action = 'generic') {
    const nonce = genId(24);
    await query(
        `UPDATE sessions SET nonce = $1, nonce_used = FALSE, nonce_action = $2, nonce_expires = NOW() + INTERVAL '3 minutes'
         WHERE session_id = $3`,
        [nonce, action, sessionId]
    );
    return nonce;
}

async function consumeNonce(sessionId, nonce, expectedAction = null) {
    const r = await query(
        `SELECT nonce, nonce_used, nonce_action, nonce_expires FROM sessions WHERE session_id = $1`,
        [sessionId]
    );
    const row = r.rows[0];
    if (!row || !row.nonce) return { ok: false, reason: 'no_nonce' };
    if (row.nonce_used) return { ok: false, reason: 'nonce_reused' };
    if (new Date(row.nonce_expires) < new Date()) return { ok: false, reason: 'nonce_expired' };
    if (!timingSafeEqual(row.nonce, nonce)) return { ok: false, reason: 'nonce_mismatch' };
    if (expectedAction && row.nonce_action !== expectedAction) return { ok: false, reason: 'nonce_action_mismatch' };

    await query(`UPDATE sessions SET nonce_used = TRUE WHERE session_id = $1`, [sessionId]);
    return { ok: true };
}

/* ─────────────────────────────────────────
   AD NONCE (separate flow)
───────────────────────────────────────── */
async function issueAdNonce(telegramId, sessionId) {
    const nonce = genId(20);
    await query(
        `INSERT INTO ad_events (telegram_id, session_id, ad_nonce, event_date)
         VALUES ($1,$2,$3,CURRENT_DATE)`,
        [telegramId, sessionId, nonce]
    );
    return nonce;
}

async function consumeAdNonce(adNonce, telegramId) {
    if (!adNonce) return { ok: false, reason: 'no_ad_nonce' };
    const r = await query(
        `SELECT id, ad_nonce_used, telegram_id FROM ad_events WHERE ad_nonce = $1`,
        [adNonce]
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: 'ad_nonce_invalid' };
    if (row.ad_nonce_used) return { ok: false, reason: 'ad_nonce_reused' };
    if (String(row.telegram_id) !== String(telegramId)) return { ok: false, reason: 'ad_nonce_owner_mismatch' };

    await query(`UPDATE ad_events SET ad_nonce_used = TRUE WHERE ad_nonce = $1`, [adNonce]);
    return { ok: true, eventId: row.id };
}

/* ─────────────────────────────────────────
   USER HELPERS
───────────────────────────────────────── */
async function ensureUser(telegramId, userData) {
    await query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (telegram_id) DO UPDATE
           SET username   = EXCLUDED.username,
               first_name = EXCLUDED.first_name,
               last_name  = EXCLUDED.last_name,
               photo_url  = COALESCE(EXCLUDED.photo_url, users.photo_url),
               updated_at = NOW()`,
        [telegramId, userData.username || null, userData.first_name || null,
         userData.last_name || null, userData.photo_url || null]
    );
}

async function getUser(telegramId) {
    const r = await query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
    return r.rows[0] || null;
}

async function addPoints(telegramId, pts) {
    await query(
        `UPDATE users SET points = points + $1, updated_at = NOW() WHERE telegram_id = $2`,
        [pts, telegramId]
    );
}

async function computeLevel(points) {
    if (points >= 500000) return 10;
    if (points >= 200000) return 9;
    if (points >= 100000) return 8;
    if (points >= 50000)  return 7;
    if (points >= 25000)  return 6;
    if (points >= 10000)  return 5;
    if (points >= 5000)   return 4;
    if (points >= 2000)   return 3;
    if (points >= 500)    return 2;
    return 1;
}

/* ─────────────────────────────────────────
   CORE SECURITY MIDDLEWARE
───────────────────────────────────────── */
async function securityMiddleware(req, res, next) {
    const ip     = getClientIp(req);
    const ipHash = hashIp(ip);

    // Global rate limit
    if (!rateLimitCheck(`global:${ipHash}`, RATE_LIMITS.global_per_min, 60000)) {
        await auditLog({ ip_hash: ipHash, action: 'rate_limit', verdict: 'blocked', attack_type: 'flood' });
        return res.status(429).json({ error: 'rate_limited' });
    }

    const fpRaw  = req.headers['x-fingerprint'] || '{}';
    const fpObj  = (() => { try { return JSON.parse(fpRaw); } catch { return {}; } })();
    const fpHash = hashFp(fpObj);

    req._ipHash  = ipHash;
    req._fpHash  = fpHash;
    req._fpObj   = fpObj;

    next();
}

/* ─────────────────────────────────────────
   CORS — must be BEFORE securityMiddleware
   so OPTIONS preflight never hits rate limiter
───────────────────────────────────────── */
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Init-Data, X-Session-Id, X-Fingerprint, X-Nonce');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(securityMiddleware);

/* ─────────────────────────────────────────
   MAIN API ENDPOINT
───────────────────────────────────────── */
app.post('/api', async (req, res) => {
    const { type, data = {} } = req.body || {};
    const initDataRaw  = req.headers['x-init-data']  || '';
    const sessionId    = req.headers['x-session-id'] || '';
    const nonceHeader  = req.headers['x-nonce']      || '';
    const ipHash       = req._ipHash;
    const fpHash       = req._fpHash;

    // ── DISPATCH ──
    try {
        switch (type) {

            /* ════════════════════════════════════
               CREATE SESSION
            ════════════════════════════════════ */
            case 'create_session': {
                if (!rateLimitCheck(`auth:${ipHash}`, RATE_LIMITS.auth_per_min, 60000)) {
                    return res.status(429).json({ error: 'rate_limited' });
                }

                // Verify Telegram initData
                const tgUser = verifyInitData(initDataRaw);
                if (!tgUser || !tgUser.id) {
                    await auditLog({ ip_hash: ipHash, fp_hash: fpHash, action: 'create_session', verdict: 'rejected', attack_type: 'fake_init_data' });
                    return res.status(401).json({ error: 'invalid_init_data' });
                }

                const telegramId = BigInt(tgUser.id);

                // Upsert user
                await ensureUser(telegramId, tgUser);
                const user = await getUser(telegramId);

                if (user.is_banned) {
                    await auditLog({ telegram_id: telegramId, ip_hash: ipHash, action: 'create_session', verdict: 'banned' });
                    return res.json({ is_banned: true });
                }

                // Multi-account detection
                const { risk: maRisk, fpCount, ipCount } = await detectMultiAccount(telegramId, ipHash, fpHash);
                if (maRisk > 0) {
                    await adjustRisk(telegramId, null, maRisk, `multi_account fp=${fpCount} ip=${ipCount}`);
                }

                const sid = await createSession({ telegramId, ipHash, fpHash });

                // Refresh user for latest state
                const freshUser = await getUser(telegramId);
                const riskInfo  = await getUserRisk(telegramId);
                const banResult = await checkAndApplyBan(telegramId, sid, riskInfo.risk_score);

                if (banResult === 'hard') return res.json({ is_banned: true });

                // Referral processing (new users only)
                const refParam = data.ref || null;
                if (refParam && !freshUser.referral_by) {
                    const refId = BigInt(refParam.replace(/\D/g, '') || '0');
                    if (refId && refId !== telegramId) {
                        await query(
                            `UPDATE users SET referral_by = $1 WHERE telegram_id = $2 AND referral_by IS NULL`,
                            [refId, telegramId]
                        ).catch(() => {});
                        const refUser = await getUser(refId);
                        if (refUser && !refUser.is_banned) {
                            await addPoints(refId, REWARDS.referral_bonus);
                            await query(
                                `UPDATE users SET total_referrals = total_referrals + 1, earned_refs = earned_refs + $1, updated_at = NOW() WHERE telegram_id = $2`,
                                [REWARDS.referral_bonus, refId]
                            ).catch(() => {});
                        }
                    }
                }

                // Level sync
                const level = await computeLevel(parseInt(freshUser.points || 0));
                await query(`UPDATE users SET level = $1, updated_at = NOW() WHERE telegram_id = $2`, [level, telegramId]).catch(() => {});

                await auditLog({ telegram_id: telegramId, session_id: sid, ip_hash: ipHash, fp_hash: fpHash, action: 'create_session', verdict: 'ok' });

                return res.json({
                    session_id: sid,
                    user: {
                        points        : parseInt(freshUser.points || 0),
                        level,
                        tg_verified   : !!freshUser.tg_verified,
                        streak_day    : parseInt(freshUser.streak_day || 0),
                        last_gift_date: freshUser.last_gift_date ? freshUser.last_gift_date.toISOString().slice(0, 10) : null,
                        total_referrals: parseInt(freshUser.total_referrals || 0),
                        earned_refs   : parseInt(freshUser.earned_refs || 0),
                        is_shadow     : riskInfo.is_shadow,
                    },
                    bot_username: BOT_USERNAME,
                });
            }

            /* ════════════════════════════════════
               GET NONCE
            ════════════════════════════════════ */
            case 'get_nonce': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });

                await touchSession(sessionId);
                const nonce = await issueNonce(sessionId, data.action || 'generic');
                return res.json({ nonce });
            }

            /* ════════════════════════════════════
               LOAD STATE
            ════════════════════════════════════ */
            case 'load':
            case 'get_state': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const user = await getUser(session.telegram_id);
                if (!user) return res.status(404).json({ error: 'user_not_found' });
                if (user.is_banned) return res.json({ is_banned: true });

                // Verify fingerprint consistency
                if (!timingSafeEqual(session.fingerprint_hash, fpHash)) {
                    await adjustRisk(session.telegram_id, sessionId, 20, 'fp_mismatch_load');
                    await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'load', verdict: 'fp_mismatch', attack_type: 'session_hijack' });
                }

                const today = new Date().toISOString().slice(0, 10);
                const adCountR = await query(
                    `SELECT COUNT(*) as cnt FROM ad_events WHERE telegram_id = $1 AND event_date = CURRENT_DATE AND ad_nonce_used = TRUE AND is_shadow = FALSE`,
                    [session.telegram_id]
                );
                const watchedToday = parseInt(adCountR.rows[0]?.cnt || 0);

                const referralsR = await query(
                    `SELECT COUNT(*) as cnt FROM users WHERE referral_by = $1`,
                    [session.telegram_id]
                );
                const refCount = parseInt(referralsR.rows[0]?.cnt || 0);
                const level = await computeLevel(parseInt(user.points || 0));

                return res.json({
                    ok     : true,
                    points : parseInt(user.points || 0),
                    level,
                    tg_verified   : !!user.tg_verified,
                    streak_day    : parseInt(user.streak_day || 0),
                    last_gift_date: user.last_gift_date ? user.last_gift_date.toISOString().slice(0, 10) : null,
                    total_referrals: refCount,
                    earned_refs   : parseInt(user.earned_refs || 0),
                    ads_watched_today: watchedToday,
                    ads_remaining : Math.max(0, REWARDS.ad_daily_max - watchedToday),
                    earned_today  : watchedToday * REWARDS.ad_per_watch,
                    today,
                });
            }

            /* ════════════════════════════════════
               START AD (issue ad nonce)
            ════════════════════════════════════ */
            case 'start_ad': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const user = await getUser(session.telegram_id);
                if (!user || user.is_banned) return res.status(403).json({ error: 'forbidden' });

                if (!rateLimitCheck(`start_ad:${session.telegram_id}`, 15, 60000)) {
                    await adjustRisk(session.telegram_id, sessionId, 10, 'ad_spam');
                    return res.status(429).json({ error: 'rate_limited' });
                }

                // Check daily limit
                const countR = await query(
                    `SELECT COUNT(*) as cnt FROM ad_events WHERE telegram_id = $1 AND event_date = CURRENT_DATE AND ad_nonce_used = TRUE`,
                    [session.telegram_id]
                );
                const watchedToday = parseInt(countR.rows[0]?.cnt || 0);
                if (watchedToday >= REWARDS.ad_daily_max) {
                    return res.json({ ok: false, error: 'daily_limit_reached' });
                }

                const adNonce = await issueAdNonce(session.telegram_id, sessionId);
                return res.json({ ok: true, ad_nonce: adNonce });
            }

            /* ════════════════════════════════════
               WATCH AD (claim reward)
            ════════════════════════════════════ */
            case 'watch_ad': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const user = await getUser(session.telegram_id);
                if (!user || user.is_banned) return res.status(403).json({ error: 'forbidden' });

                if (!rateLimitCheck(`watch_ad:${session.telegram_id}`, 12, 60000)) {
                    await adjustRisk(session.telegram_id, sessionId, 15, 'ad_abuse_rate');
                    return res.status(429).json({ error: 'rate_limited' });
                }

                // FP consistency check
                if (!timingSafeEqual(session.fingerprint_hash, fpHash)) {
                    await adjustRisk(session.telegram_id, sessionId, 25, 'fp_mismatch_ad');
                    await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'watch_ad', verdict: 'fp_mismatch', attack_type: 'modified_client' });
                }

                // Consume ad nonce
                const adNonce    = data.ad_nonce || null;
                const nonceCheck = await consumeAdNonce(adNonce, session.telegram_id);
                if (!nonceCheck.ok) {
                    await adjustRisk(session.telegram_id, sessionId, 20, `ad_nonce_fail:${nonceCheck.reason}`);
                    await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'watch_ad', verdict: 'rejected', attack_type: `replay_${nonceCheck.reason}` });
                    return res.json({ ok: false, error: nonceCheck.reason });
                }

                // Daily count (server-authoritative)
                const countR = await query(
                    `SELECT COUNT(*) as cnt FROM ad_events WHERE telegram_id = $1 AND event_date = CURRENT_DATE AND ad_nonce_used = TRUE`,
                    [session.telegram_id]
                );
                const watchedToday = parseInt(countR.rows[0]?.cnt || 0);
                if (watchedToday > REWARDS.ad_daily_max) { // already over limit — shouldn't happen but guard anyway
                    await query(`UPDATE ad_events SET is_shadow = TRUE WHERE ad_nonce = $1`, [adNonce]).catch(() => {});
                    return res.json({ ok: true, shadow: true, remaining: 0, watchedToday, earnedToday: 0 });
                }

                const isShadow = user.is_shadow;
                if (!isShadow) {
                    await addPoints(session.telegram_id, REWARDS.ad_per_watch);
                    await query(
                        `UPDATE ad_events SET pts_awarded = $1 WHERE ad_nonce = $2`,
                        [REWARDS.ad_per_watch, adNonce]
                    ).catch(() => {});
                } else {
                    await query(`UPDATE ad_events SET is_shadow = TRUE WHERE ad_nonce = $1`, [adNonce]).catch(() => {});
                }

                await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'watch_ad', verdict: isShadow ? 'shadow' : 'rewarded', risk_score: REWARDS.ad_per_watch });

                const freshUser    = await getUser(session.telegram_id);
                const remaining    = Math.max(0, REWARDS.ad_daily_max - watchedToday);
                const earnedToday  = watchedToday * REWARDS.ad_per_watch;

                return res.json({
                    ok          : true,
                    remaining,
                    watchedToday,
                    earnedToday,
                    points      : parseInt(freshUser?.points || 0),
                });
            }

            /* ════════════════════════════════════
               CLAIM GIFT (daily streak)
            ════════════════════════════════════ */
            case 'claim_gift': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                // Nonce validation
                const nc = await consumeNonce(sessionId, nonceHeader, 'generic');
                if (!nc.ok) {
                    await adjustRisk(session.telegram_id, sessionId, 15, `gift_nonce_fail:${nc.reason}`);
                    return res.json({ ok: false, error: nc.reason });
                }

                const user = await getUser(session.telegram_id);
                if (!user || user.is_banned) return res.status(403).json({ error: 'forbidden' });

                const today = new Date().toISOString().slice(0, 10);
                const lastGift = user.last_gift_date ? user.last_gift_date.toISOString().slice(0, 10) : null;

                if (lastGift === today) return res.json({ ok: false, error: 'already_claimed' });

                // Calculate streak
                const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
                const newStreak = lastGift === yesterday ? Math.min((parseInt(user.streak_day || 0) + 1), 7) : 1;
                const giftPts   = REWARDS.gift_days[newStreak - 1] || REWARDS.gift_days[0];

                if (!user.is_shadow) {
                    await addPoints(session.telegram_id, giftPts);
                }

                await query(
                    `UPDATE users SET streak_day = $1, last_gift_date = $2, updated_at = NOW() WHERE telegram_id = $3`,
                    [newStreak, today, session.telegram_id]
                );

                await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'claim_gift', verdict: 'ok', risk_score: giftPts });

                const freshUser = await getUser(session.telegram_id);
                return res.json({
                    ok       : true,
                    pts      : giftPts,
                    streak   : newStreak,
                    points   : parseInt(freshUser?.points || 0),
                });
            }

            /* ════════════════════════════════════
               VERIFY TG MEMBERSHIP
            ════════════════════════════════════ */
            case 'verify_tg_membership': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const nc = await consumeNonce(sessionId, nonceHeader, 'generic');
                if (!nc.ok) {
                    await adjustRisk(session.telegram_id, sessionId, 10, `tg_verify_nonce:${nc.reason}`);
                    return res.json({ ok: false, error: nc.reason });
                }

                const user = await getUser(session.telegram_id);
                if (!user || user.is_banned) return res.status(403).json({ error: 'forbidden' });
                if (user.tg_verified) return res.json({ ok: true, already_done: true });

                // Server-side Telegram API check
                let isMember = false;
                if (BOT_TOKEN && CHANNEL_USERNAME) {
                    try {
                        const chkUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${session.telegram_id}`;
                        const chkRes = await fetch(chkUrl);
                        const chkJson = await chkRes.json();
                        const status  = chkJson?.result?.status;
                        isMember = ['member', 'administrator', 'creator'].includes(status);
                    } catch { isMember = false; }
                }

                if (!isMember) return res.json({ ok: false, error: 'not_member' });

                await query(
                    `UPDATE users SET tg_verified = TRUE, updated_at = NOW() WHERE telegram_id = $1`,
                    [session.telegram_id]
                );

                const existing = await query(
                    `SELECT id FROM tasks WHERE telegram_id = $1 AND task_type = 'tg_channel'`,
                    [session.telegram_id]
                );
                if (existing.rows.length === 0) {
                    if (!user.is_shadow) {
                        await addPoints(session.telegram_id, REWARDS.tg_task_reward);
                    }
                    await query(
                        `INSERT INTO tasks (telegram_id, task_type, pts_awarded) VALUES ($1,'tg_channel',$2) ON CONFLICT DO NOTHING`,
                        [session.telegram_id, REWARDS.tg_task_reward]
                    );
                }

                await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'verify_tg_membership', verdict: 'ok' });

                const freshUser = await getUser(session.telegram_id);
                return res.json({ ok: true, pts: REWARDS.tg_task_reward, points: parseInt(freshUser?.points || 0) });
            }

            /* ════════════════════════════════════
               SUBMIT WITHDRAW
            ════════════════════════════════════ */
            case 'submit_withdraw': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const nc = await consumeNonce(sessionId, nonceHeader, 'generic');
                if (!nc.ok) {
                    await adjustRisk(session.telegram_id, sessionId, 10, `withdraw_nonce:${nc.reason}`);
                    return res.json({ ok: false, error: nc.reason });
                }

                const user = await getUser(session.telegram_id);
                if (!user || user.is_banned) return res.status(403).json({ error: 'forbidden' });

                if (!rateLimitCheck(`withdraw:${session.telegram_id}`, 3, 3600000)) {
                    return res.json({ ok: false, error: 'rate_limited' });
                }

                const addr = String(data.address || '').trim();
                if (!addr || addr.length < 48) return res.json({ ok: false, error: 'invalid_address' });
                if (!addr.startsWith('EQ') && !addr.startsWith('UQ') && !addr.startsWith('0:')) {
                    return res.json({ ok: false, error: 'invalid_address' });
                }

                const pts = parseInt(user.points || 0);
                if (pts < REWARDS.withdraw_min) return res.json({ ok: false, error: 'insufficient_balance' });
                if (user.level < 5) return res.json({ ok: false, error: 'level_too_low' });

                if (!user.is_shadow) {
                    await query(
                        `UPDATE users SET points = points - $1, updated_at = NOW() WHERE telegram_id = $2`,
                        [pts, session.telegram_id]
                    );
                    await query(
                        `INSERT INTO withdraw_requests (telegram_id, pts_amount, ton_address) VALUES ($1,$2,$3)`,
                        [session.telegram_id, pts, addr]
                    );
                }

                await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'submit_withdraw', verdict: 'ok', meta: { pts, addr } });

                const freshUser = await getUser(session.telegram_id);
                return res.json({ ok: true, pts, points: parseInt(freshUser?.points || 0) });
            }

            /* ════════════════════════════════════
               GET REFERRALS
            ════════════════════════════════════ */
            case 'get_referrals': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const refs = await query(
                    `SELECT first_name, username, points, created_at FROM users WHERE referral_by = $1 ORDER BY created_at DESC LIMIT 50`,
                    [session.telegram_id]
                );
                const user  = await getUser(session.telegram_id);
                const total = await query(`SELECT COUNT(*) as cnt FROM users WHERE referral_by = $1`, [session.telegram_id]);

                return res.json({
                    ok            : true,
                    referrals     : refs.rows.map(r => ({
                        name      : r.first_name || r.username || 'مستخدم',
                        username  : r.username || null,
                        pts       : parseInt(r.points || 0),
                        joined    : r.created_at,
                    })),
                    total_referrals: parseInt(total.rows[0]?.cnt || 0),
                    earned_refs    : parseInt(user?.earned_refs || 0),
                });
            }

            /* ════════════════════════════════════
               GET WITHDRAW HISTORY
            ════════════════════════════════════ */
            case 'get_withdraw_history': {
                const session = await getSession(sessionId);
                if (!session) return res.status(401).json({ error: 'invalid_session' });
                await touchSession(sessionId);

                const hist = await query(
                    `SELECT pts_amount, ton_address, status, created_at FROM withdraw_requests WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 20`,
                    [session.telegram_id]
                );
                return res.json({ ok: true, history: hist.rows });
            }

            /* ════════════════════════════════════
               TRACK COPY LINK (analytics)
            ════════════════════════════════════ */
            case 'track_copy_link': {
                const session = await getSession(sessionId);
                if (!session) return res.status(200).json({ ok: true });
                await auditLog({ telegram_id: session.telegram_id, session_id: sessionId, action: 'copy_link', verdict: 'tracked' });
                return res.json({ ok: true });
            }

            /* ════════════════════════════════════
               HEALTH
            ════════════════════════════════════ */
            case 'health':
                return res.json({ ok: true, ts: Date.now() });

            default:
                return res.status(400).json({ error: 'unknown_action' });
        }
    } catch (err) {
        console.error('[API] Unhandled error:', err);
        return res.status(500).json({ error: 'internal_error' });
    }
});

/* ─────────────────────────────────────────
   ADMIN PANEL
───────────────────────────────────────── */
app.get('/admin', async (req, res) => {
    const key = req.query.key || '';
    if (!timingSafeEqual(key, process.env.ADMIN_KEY || 'change_me')) {
        return res.status(403).send('Forbidden');
    }

    const users    = await query(`SELECT telegram_id, first_name, username, points, level, streak_day, total_referrals, risk_score, is_banned, is_shadow, created_at FROM users ORDER BY points DESC LIMIT 100`);
    const sessions = await query(`SELECT COUNT(*) as cnt FROM sessions WHERE expires_at > NOW()`);
    const todayAds = await query(`SELECT COUNT(*) as cnt FROM ad_events WHERE event_date = CURRENT_DATE AND ad_nonce_used = TRUE`);
    const pending  = await query(`SELECT COUNT(*) as cnt FROM withdraw_requests WHERE status = 'pending'`);
    const bans     = await query(`SELECT COUNT(*) as cnt FROM users WHERE is_banned = TRUE`);
    const shadows  = await query(`SELECT COUNT(*) as cnt FROM users WHERE is_shadow = TRUE`);

    const rows = users.rows.map(u => `
        <tr style="border-bottom:1px solid rgba(255,255,255,0.06)">
            <td>${u.telegram_id}</td>
            <td>${u.first_name || ''} ${u.username ? '@' + u.username : ''}</td>
            <td style="color:#fbbf24">${parseInt(u.points || 0).toLocaleString()}</td>
            <td>${u.level}</td>
            <td>${u.total_referrals}</td>
            <td style="color:${u.risk_score > 60 ? '#f87171' : '#34d399'}">${u.risk_score}</td>
            <td>${u.is_banned ? '🚫' : u.is_shadow ? '👻' : '✅'}</td>
            <td style="font-size:11px">${new Date(u.created_at).toLocaleDateString()}</td>
        </tr>`).join('');

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin</title>
    <style>*{box-sizing:border-box}body{background:#0a0a1a;color:#fff;font-family:monospace;padding:20px}
    table{width:100%;border-collapse:collapse;font-size:12px}th{background:#1a1a2e;padding:8px;text-align:right}
    td{padding:7px 8px;text-align:right}.stat{display:inline-block;background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px 20px;margin:5px;font-size:13px}
    h1{color:#fbbf24;margin-bottom:16px}</style></head>
    <body><h1>🔐 Admin Panel — الربح عربي</h1>
    <div>
        <span class="stat">👤 Active Sessions: ${sessions.rows[0]?.cnt}</span>
        <span class="stat">📺 Today Ads: ${todayAds.rows[0]?.cnt}</span>
        <span class="stat">💸 Pending Withdraws: ${pending.rows[0]?.cnt}</span>
        <span class="stat">🚫 Banned: ${bans.rows[0]?.cnt}</span>
        <span class="stat">👻 Shadow: ${shadows.rows[0]?.cnt}</span>
    </div><br>
    <table><tr><th>ID</th><th>Name</th><th>Points</th><th>Level</th><th>Refs</th><th>Risk</th><th>Status</th><th>Joined</th></tr>${rows}</table>
    </body></html>`);
});

/* ─────────────────────────────────────────
   BACKGROUND CLEANUP
───────────────────────────────────────── */
async function cleanup() {
    await query(`DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 hour'`).catch(() => {});
    await query(`DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '30 days'`).catch(() => {});
    await query(`DELETE FROM rate_limit_log WHERE hit_at < NOW() - INTERVAL '2 hours'`).catch(() => {});
    await query(`UPDATE users SET is_shadow = FALSE, risk_score = GREATEST(0, risk_score - 5) WHERE is_shadow = TRUE AND risk_score < 60 AND updated_at < NOW() - INTERVAL '7 days'`).catch(() => {});
}

/* ─────────────────────────────────────────
   BOOT  (supports both Vercel serverless & local server)
───────────────────────────────────────── */
const PORT = process.env.PORT || 3000;

// Vercel / serverless: export the express app as the handler
module.exports = app;

// Local dev: also start a server when run directly with `node index.js`
if (require.main === module) {
    (async () => {
        try {
            await ensureSchema();
            console.log('[DB] Schema ready');
        } catch (e) {
            console.error('[DB] Schema error:', e.message);
        }

        app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));

        // Cleanup every 6 hours
        setInterval(cleanup, 6 * 60 * 60 * 1000);
        cleanup();
    })();
} else {
    // Serverless cold-start: run schema migration once
    ensureSchema().catch(e => console.error('[DB] Schema error:', e.message));
}
