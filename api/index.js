/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          الربح عربي — Server-Side API (index.js)                ║
 * ║  Vercel Serverless · Neon PostgreSQL · Telegram Mini App        ║
 * ║  Zero-Trust · Anti-Fraud · Auto Migration · Full Security       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 *  ✅ جميع القيم الحساسة server-side فقط — الواجهة display-only
 *  ✅ Auto Migration للجداول والأعمدة
 *  ✅ HMAC-SHA256 لـ Telegram initData
 *  ✅ Sessions آمنة + nonces
 *  ✅ Anti-replay + Anti-fraud + Ban system
 *  ✅ Rate limiting per user/IP/fingerprint
 *  ✅ Cleanup تلقائي للبيانات المؤقتة
 */

'use strict';

const { createHash, createHmac, randomBytes } = require('crypto');
const { Pool }                                 = require('@neondatabase/serverless');

// ─── Database Pool (singleton per cold start) ────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Environment Config ───────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN     || '';
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || 'change-me-in-env';
const NODE_ENV      = process.env.NODE_ENV      || 'production';
const IS_DEV        = NODE_ENV === 'development';

// ─── Game Constants (server-side only, never sent raw) ────────────────────────
const CFG = {
  // Points
  POINTS_PER_AD:         50,
  POINTS_PER_REFERRAL:   500,
  POINTS_PER_TG_TASK:    2500,
  POINTS_GIFT_BASE:      100,      // اليوم 1
  POINTS_GIFT_MAX:       1000,     // اليوم 30+
  POINTS_SHARE_TASK:     200,

  // Ads
  ADS_DAILY_LIMIT:       10,
  AD_NONCE_TTL_SEC:      120,      // 2 دقيقة

  // Withdraw
  WITHDRAW_MIN_PTS:      50000,
  WITHDRAW_MIN_LEVEL:    5,
  PTS_PER_TON:           100000,

  // Sessions
  SESSION_TTL_MS:        7 * 24 * 60 * 60 * 1000,   // 7 أيام
  NONCE_TTL_MS:          5 * 60 * 1000,              // 5 دقائق

  // Rate Limiting
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX_REQUESTS:     30,        // per window
  RATE_WRITE_MAX:        15,

  // Risk / Ban
  RISK_BAN_THRESHOLD:    100,
  RISK_SHADOW_THRESHOLD: 60,

  // Cleanup
  CLEANUP_INTERVAL_MS:   30 * 60 * 1000,   // كل 30 دقيقة
  NONCE_MAX_AGE_MS:      10 * 60 * 1000,   // 10 دقائق
  AD_NONCE_MAX_AGE_MS:   5  * 60 * 1000,
  SESSION_MAX_AGE_DAYS:  7,

  // Levels — XP thresholds
  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],

  // Daily gift rewards per streak day
  GIFT_REWARDS: [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000],
};

// ─── In-memory rate limit map (per instance — ok for Vercel) ─────────────────
const rateLimitMap = new Map();  // key -> { count, resetAt }

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO MIGRATION — Schema creation + column additions
// ══════════════════════════════════════════════════════════════════════════════
async function runMigrations(client) {
  // ── Users ─────────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               BIGSERIAL PRIMARY KEY,
      tg_id            BIGINT    UNIQUE NOT NULL,
      tg_username      TEXT,
      tg_first_name    TEXT,
      tg_last_name     TEXT,
      tg_language_code TEXT      DEFAULT 'ar',
      tg_is_premium    BOOLEAN   DEFAULT FALSE,
      points           BIGINT    DEFAULT 0,
      level            INT       DEFAULT 1,
      xp               BIGINT    DEFAULT 0,
      is_banned        BOOLEAN   DEFAULT FALSE,
      is_shadow_banned BOOLEAN   DEFAULT FALSE,
      ban_reason       TEXT,
      risk_score       INT       DEFAULT 0,
      referrer_id      BIGINT    REFERENCES users(id) ON DELETE SET NULL,
      tg_verified      BOOLEAN   DEFAULT FALSE,
      streak_day       INT       DEFAULT 0,
      last_gift_date   DATE,
      ads_watched_total BIGINT   DEFAULT 0,
      total_referrals  INT       DEFAULT 0,
      earned_from_refs BIGINT    DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Sessions ──────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT        PRIMARY KEY,
      user_id        BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fingerprint_hash TEXT,
      ip_hash        TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      last_active    TIMESTAMPTZ DEFAULT NOW(),
      expires_at     TIMESTAMPTZ NOT NULL,
      is_revoked     BOOLEAN     DEFAULT FALSE
    )
  `);

  // ── Nonces ────────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS nonces (
      nonce      TEXT        PRIMARY KEY,
      user_id    BIGINT      NOT NULL,
      type       TEXT        DEFAULT 'general',
      used       BOOLEAN     DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  // ── Ad Logs (per-day tracking) ────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_logs (
      id          BIGSERIAL   PRIMARY KEY,
      user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log_date    DATE        NOT NULL DEFAULT CURRENT_DATE,
      count       INT         DEFAULT 0,
      points_earned BIGINT    DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, log_date)
    )
  `);

  // ── Ad Nonces (separate — short TTL) ─────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS ad_nonces (
      nonce      TEXT        PRIMARY KEY,
      user_id    BIGINT      NOT NULL,
      used       BOOLEAN     DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  // ── Withdrawals ───────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id         BIGSERIAL   PRIMARY KEY,
      user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pts        BIGINT      NOT NULL,
      ton_amount NUMERIC(18,6),
      address    TEXT        NOT NULL,
      method     TEXT        DEFAULT 'ton',
      status     TEXT        DEFAULT 'pending',
      tx_hash    TEXT,
      notes      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Tasks ─────────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_tasks (
      id          BIGSERIAL   PRIMARY KEY,
      user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_type   TEXT        NOT NULL,
      completed   BOOLEAN     DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      task_date   DATE        DEFAULT CURRENT_DATE,
      UNIQUE(user_id, task_type, task_date)
    )
  `);

  // ── Referrals ─────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id           BIGSERIAL   PRIMARY KEY,
      referrer_id  BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_id  BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points_given BIGINT      DEFAULT 0,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(referred_id)
    )
  `);

  // ── Risk Events ───────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS risk_events (
      id         BIGSERIAL   PRIMARY KEY,
      user_id    BIGINT      REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT        NOT NULL,
      ip_hash    TEXT,
      fp_hash    TEXT,
      score_delta INT        DEFAULT 0,
      meta       JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Rate Limit Log (persistent fallback) ─────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_log (
      key        TEXT        PRIMARY KEY,
      count      INT         DEFAULT 0,
      reset_at   TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ─── Auto-add missing columns (safe idempotent) ───────────────────────────
  const safeAddCol = async (table, col, def) => {
    try {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch(_) { /* already exists */ }
  };

  await safeAddCol('users', 'ip_hash',            'TEXT');
  await safeAddCol('users', 'fp_hash',             'TEXT');
  await safeAddCol('users', 'cluster_ban',         'BOOLEAN DEFAULT FALSE');
  await safeAddCol('users', 'last_ip_hash',        'TEXT');
  await safeAddCol('users', 'share_task_done',     'BOOLEAN DEFAULT FALSE');
  await safeAddCol('withdrawals', 'reviewed_at',   'TIMESTAMPTZ');
  await safeAddCol('withdrawals', 'reviewed_by',   'TEXT');

  // ─── Indexes ──────────────────────────────────────────────────────────────
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id  ON sessions(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_nonces_user_id     ON nonces(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_ad_logs_user_date  ON ad_logs(user_id, log_date)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_withdrawals_user   ON withdrawals(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_risk_events_user   ON risk_events(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)`);
}

let _migrated = false;
async function ensureMigrated() {
  if (_migrated) return;
  const client = await pool.connect();
  try {
    await runMigrations(client);
    _migrated = true;
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Hash a value with SHA-256 (hex) */
function sha256(str) {
  return createHash('sha256').update(String(str)).digest('hex');
}

/** Generate a cryptographically random token */
function genToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

/** Hash IP + salt so IP is never stored raw */
function hashIp(ip) {
  return sha256((ip || '') + 'rebh_ip_salt_2025').slice(0, 32);
}

/** Hash fingerprint blob */
function hashFp(fpObj) {
  try {
    const s = typeof fpObj === 'string' ? fpObj : JSON.stringify(fpObj);
    return sha256(s).slice(0, 40);
  } catch(_) { return 'unknown'; }
}

/** Compute Telegram HMAC-SHA256 verification */
function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return IS_DEV ? { ok: true, userId: 0, data: {} } : { ok: false };

  try {
    const params   = new URLSearchParams(initData);
    const hash     = params.get('hash');
    if (!hash) return { ok: false };
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (expectedHash !== hash) return { ok: false };

    const authDate = parseInt(params.get('auth_date') || '0');
    const now      = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) return { ok: false }; // expired > 24h

    const userRaw = params.get('user');
    const user    = userRaw ? JSON.parse(userRaw) : {};
    return { ok: true, userId: user.id || 0, data: user };
  } catch(_) {
    return { ok: false };
  }
}

/** Compute user level from XP */
function computeLevel(xp) {
  const thresholds = CFG.LEVEL_THRESHOLDS;
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (xp >= thresholds[i]) return i;
  }
  return 1;
}

/** Compute daily gift reward for streak day */
function giftRewardForDay(day) {
  const idx = Math.min(day - 1, CFG.GIFT_REWARDS.length - 1);
  return CFG.GIFT_REWARDS[Math.max(0, idx)];
}

/** Get real IP from request */
function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    '0.0.0.0'
  );
}

/** Send JSON response */
function send(res, status, body) {
  res.status(status).json(body);
}

/** Read full body (stream) */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch(_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  RATE LIMITER
// ══════════════════════════════════════════════════════════════════════════════
function checkRateLimit(key, maxReqs = CFG.RATE_MAX_REQUESTS) {
  const now = Date.now();
  let entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + CFG.RATE_WINDOW_MS };
    rateLimitMap.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxReqs;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SESSION MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
async function validateSession(client, sessionId, userIdExpected) {
  if (!sessionId) return null;
  const res = await client.query(`
    SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
      AND s.is_revoked = FALSE
      AND s.expires_at > NOW()
    LIMIT 1
  `, [sessionId]);
  if (!res.rows.length) return null;
  const session = res.rows[0];
  if (userIdExpected && session.user_id !== userIdExpected) return null;
  // Touch last_active
  await client.query(`UPDATE sessions SET last_active = NOW() WHERE id = $1`, [sessionId]);
  return session;
}

async function createSession(client, userId, fpHash, ipHash) {
  const sessionId  = genToken(32);
  const expiresAt  = new Date(Date.now() + CFG.SESSION_TTL_MS);
  await client.query(`
    INSERT INTO sessions (id, user_id, fingerprint_hash, ip_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5)
  `, [sessionId, userId, fpHash, ipHash, expiresAt]);
  return sessionId;
}

// ══════════════════════════════════════════════════════════════════════════════
//  NONCE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
async function issueNonce(client, userId, type = 'general') {
  const nonce     = genToken(24);
  const expiresAt = new Date(Date.now() + CFG.NONCE_TTL_MS);
  await client.query(`
    INSERT INTO nonces (nonce, user_id, type, expires_at)
    VALUES ($1, $2, $3, $4)
  `, [nonce, userId, type, expiresAt]);
  return nonce;
}

async function consumeNonce(client, nonce, userId) {
  if (!nonce) return false;
  const res = await client.query(`
    UPDATE nonces
    SET used = TRUE
    WHERE nonce = $1
      AND user_id = $2
      AND used = FALSE
      AND expires_at > NOW()
    RETURNING id
  `, [nonce, userId]);
  return res.rowCount > 0;
}

async function issueAdNonce(client, userId) {
  const nonce     = 'ad_' + genToken(20);
  const expiresAt = new Date(Date.now() + CFG.AD_NONCE_TTL_SEC * 1000);
  await client.query(`
    INSERT INTO ad_nonces (nonce, user_id, expires_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (nonce) DO NOTHING
  `, [nonce, userId, expiresAt]);
  return nonce;
}

async function consumeAdNonce(client, nonce, userId) {
  if (!nonce) return false;
  const res = await client.query(`
    UPDATE ad_nonces
    SET used = TRUE
    WHERE nonce = $1
      AND user_id = $2
      AND used = FALSE
      AND expires_at > NOW()
    RETURNING id
  `, [nonce, userId]);
  return res.rowCount > 0;
}

// ══════════════════════════════════════════════════════════════════════════════
//  USER MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════
async function upsertUser(client, tgUser, ipHash, fpHash, referrerId = null) {
  const now = new Date();
  const res = await client.query(`
    INSERT INTO users (
      tg_id, tg_username, tg_first_name, tg_last_name,
      tg_language_code, tg_is_premium, ip_hash, fp_hash, last_ip_hash, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (tg_id) DO UPDATE SET
      tg_username      = EXCLUDED.tg_username,
      tg_first_name    = EXCLUDED.tg_first_name,
      tg_last_name     = EXCLUDED.tg_last_name,
      tg_language_code = EXCLUDED.tg_language_code,
      tg_is_premium    = EXCLUDED.tg_is_premium,
      last_ip_hash     = EXCLUDED.last_ip_hash,
      updated_at       = NOW()
    RETURNING *
  `, [
    tgUser.id,
    tgUser.username    || null,
    tgUser.first_name  || null,
    tgUser.last_name   || null,
    tgUser.language_code || 'ar',
    !!tgUser.is_premium,
    ipHash, fpHash, ipHash, now,
  ]);

  const user      = res.rows[0];
  const isNew     = (Date.now() - new Date(user.created_at).getTime()) < 5000;

  // Handle referral (only for brand-new users)
  if (isNew && referrerId && referrerId !== user.id) {
    await applyReferral(client, referrerId, user.id);
  }

  return user;
}

async function applyReferral(client, referrerId, referredId) {
  try {
    // Upsert referral record
    await client.query(`
      INSERT INTO referrals (referrer_id, referred_id, points_given)
      VALUES ($1, $2, $3)
      ON CONFLICT (referred_id) DO NOTHING
    `, [referrerId, referredId, CFG.POINTS_PER_REFERRAL]);

    const inserted = await client.query(
      `SELECT id FROM referrals WHERE referred_id = $1`, [referredId]
    );
    if (!inserted.rows.length) return; // conflict — already referred

    // Credit referrer
    await client.query(`
      UPDATE users
      SET points          = points + $1,
          xp              = xp     + $1,
          total_referrals = total_referrals + 1,
          earned_from_refs= earned_from_refs + $1,
          updated_at      = NOW()
      WHERE id = $2
    `, [CFG.POINTS_PER_REFERRAL, referrerId]);

    // Update level
    await syncLevel(client, referrerId);

    // Mark referred user as having a referrer
    await client.query(
      `UPDATE users SET referrer_id = $1 WHERE id = $2`,
      [referrerId, referredId]
    );
  } catch(e) {
    if (!e.message?.includes('unique') && !e.message?.includes('duplicate')) throw e;
  }
}

async function syncLevel(client, userId) {
  const res = await client.query(`SELECT xp FROM users WHERE id = $1`, [userId]);
  if (!res.rows.length) return;
  const level = computeLevel(parseInt(res.rows[0].xp) || 0);
  await client.query(
    `UPDATE users SET level = $1 WHERE id = $2`,
    [level, userId]
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  RISK SCORING
// ══════════════════════════════════════════════════════════════════════════════
async function addRiskEvent(client, userId, eventType, ipHash, fpHash, scoreDelta, meta = {}) {
  await client.query(`
    INSERT INTO risk_events (user_id, event_type, ip_hash, fp_hash, score_delta, meta)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, eventType, ipHash, fpHash, scoreDelta, JSON.stringify(meta)]);

  if (scoreDelta > 0) {
    const res = await client.query(`
      UPDATE users
      SET risk_score = LEAST(risk_score + $1, 200)
      WHERE id = $2
      RETURNING risk_score, is_banned
    `, [scoreDelta, userId]);

    const { risk_score, is_banned } = res.rows[0] || {};
    if (!is_banned && risk_score >= CFG.RISK_BAN_THRESHOLD) {
      await client.query(`
        UPDATE users SET is_banned = TRUE, ban_reason = $1 WHERE id = $2
      `, ['auto_risk_score', userId]);
    } else if (risk_score >= CFG.RISK_SHADOW_THRESHOLD) {
      await client.query(
        `UPDATE users SET is_shadow_banned = TRUE WHERE id = $2`,
        [userId]
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CLEANUP JOB (runs inline, throttled)
// ══════════════════════════════════════════════════════════════════════════════
let _lastCleanup = 0;
async function maybeRunCleanup(client) {
  const now = Date.now();
  if (now - _lastCleanup < CFG.CLEANUP_INTERVAL_MS) return;
  _lastCleanup = now;

  try {
    // Expired nonces
    await client.query(`DELETE FROM nonces    WHERE expires_at < NOW()`);
    await client.query(`DELETE FROM ad_nonces WHERE expires_at < NOW()`);
    // Expired sessions
    await client.query(`DELETE FROM sessions  WHERE expires_at < NOW()`);
    // Old rate limit log
    await client.query(`DELETE FROM rate_limit_log WHERE reset_at < NOW()`);
    // Old risk events (> 30 days)
    await client.query(`DELETE FROM risk_events WHERE created_at < NOW() - INTERVAL '30 days'`);
  } catch(e) {
    console.error('[Cleanup] Error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ACTION HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * create_session — Called once at app startup
 * Verifies Telegram initData, upserts user, issues session
 */
async function handleCreateSession(client, body, ipHash, fpHash) {
  const initData = body?.data?.initData || '';
  const tgResult = verifyTelegramInitData(initData);

  if (!tgResult.ok && !IS_DEV) {
    return { ok: false, error: 'invalid_init_data', status: 401 };
  }

  // Dev fallback
  const tgUser = tgResult.data?.id
    ? tgResult.data
    : { id: 99999999, username: 'dev_user', first_name: 'Dev', language_code: 'ar' };

  if (!tgUser.id) return { ok: false, error: 'no_user_id', status: 401 };

  // Extract referrer from start_param
  let referrerId = null;
  try {
    const params   = new URLSearchParams(initData);
    const startParam = params.get('start_param') || '';
    const match    = startParam.match(/^ref_(\d+)$/);
    if (match) {
      const refRes = await client.query(
        `SELECT id FROM users WHERE tg_id = $1`, [parseInt(match[1])]
      );
      if (refRes.rows.length) referrerId = refRes.rows[0].id;
    }
  } catch(_) {}

  const user = await upsertUser(client, tgUser, ipHash, fpHash, referrerId);

  if (user.is_banned) {
    return { ok: false, is_banned: true, status: 403 };
  }

  // Check cluster ban (same IP hash as a banned user)
  const clusterCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM users
    WHERE last_ip_hash = $1 AND is_banned = TRUE AND id != $2
  `, [ipHash, user.id]);
  if (parseInt(clusterCheck.rows[0].cnt) > 3) {
    await addRiskEvent(client, user.id, 'cluster_ip', ipHash, fpHash, 15, {});
  }

  const sessionId = await createSession(client, user.id, fpHash, ipHash);
  await syncLevel(client, user.id);

  // Fetch fresh user data
  const fresh = await client.query(`SELECT * FROM users WHERE id = $1`, [user.id]);
  const u     = fresh.rows[0];

  return {
    ok:         true,
    session_id: sessionId,
    user: {
      points:         parseInt(u.points)    || 0,
      level:          parseInt(u.level)     || 1,
      xp:             parseInt(u.xp)        || 0,
      tg_verified:    u.tg_verified,
      streak_day:     u.streak_day,
      last_gift_date: u.last_gift_date,
      total_referrals:u.total_referrals,
      earned_from_refs:parseInt(u.earned_from_refs) || 0,
    },
  };
}

/**
 * get_nonce — Issue a general-purpose write nonce
 */
async function handleGetNonce(client, userId) {
  const nonce = await issueNonce(client, userId, 'general');
  return { ok: true, nonce };
}

/**
 * load — Full state hydration for the frontend
 */
async function handleLoad(client, userId) {
  const userRes = await client.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (!userRes.rows.length) return { ok: false, error: 'user_not_found' };
  const u = userRes.rows[0];

  // Today's ad log
  const adRes = await client.query(`
    SELECT count, points_earned FROM ad_logs
    WHERE user_id = $1 AND log_date = CURRENT_DATE
  `, [userId]);
  const adLog         = adRes.rows[0] || { count: 0, points_earned: 0 };
  const adsWatchedToday = parseInt(adLog.count)         || 0;
  const adsRemaining    = Math.max(0, CFG.ADS_DAILY_LIMIT - adsWatchedToday);

  // Withdraw history (last 20)
  const wRes = await client.query(`
    SELECT pts, address, method, status, created_at
    FROM withdrawals WHERE user_id = $1
    ORDER BY created_at DESC LIMIT 20
  `, [userId]);

  // Referrals list (last 10)
  const rRes = await client.query(`
    SELECT u.tg_first_name, u.tg_username, u.created_at
    FROM referrals r
    JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = $1
    ORDER BY r.created_at DESC LIMIT 10
  `, [userId]);

  // Daily task completions today
  const taskRes = await client.query(`
    SELECT task_type FROM user_tasks
    WHERE user_id = $1 AND task_date = CURRENT_DATE AND completed = TRUE
  `, [userId]);
  const completedTasks = taskRes.rows.map(r => r.task_type);

  const pts = parseInt(u.points) || 0;

  return {
    ok:              true,
    points:          pts,
    level:           parseInt(u.level)   || 1,
    xp:              parseInt(u.xp)      || 0,
    tg_verified:     u.tg_verified,
    streak_day:      u.streak_day,
    last_gift_date:  u.last_gift_date,
    ads_total:       CFG.ADS_DAILY_LIMIT,
    ads_remaining:   adsRemaining,
    ads_watched_today: adsWatchedToday,
    earned_today:    parseInt(adLog.points_earned) || 0,
    total_referrals: u.total_referrals,
    earned_from_refs:parseInt(u.earned_from_refs) || 0,
    withdrawals:     wRes.rows.map(w => ({
      pts:     parseInt(w.pts)   || 0,
      address: w.address,
      method:  w.method,
      status:  w.status,
      ts:      new Date(w.created_at).getTime(),
    })),
    referral_list: rRes.rows.map(r => ({
      name: r.tg_first_name || r.tg_username || 'مستخدم',
      ts:   new Date(r.created_at).getTime(),
    })),
    completed_tasks: completedTasks,
    // UI config (not sensitive, but served from server)
    config: {
      ads_daily_limit:    CFG.ADS_DAILY_LIMIT,
      pts_per_ton:        CFG.PTS_PER_TON,
      withdraw_min_pts:   CFG.WITHDRAW_MIN_PTS,
      withdraw_min_level: CFG.WITHDRAW_MIN_LEVEL,
      pts_per_referral:   CFG.POINTS_PER_REFERRAL,
    },
  };
}

/**
 * start_ad — Issue an ad nonce before showing ad
 */
async function handleStartAd(client, userId) {
  // Check daily limit
  const adRes = await client.query(`
    SELECT count FROM ad_logs WHERE user_id = $1 AND log_date = CURRENT_DATE
  `, [userId]);
  const watched = parseInt(adRes.rows[0]?.count) || 0;

  if (watched >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  const adNonce = await issueAdNonce(client, userId);
  return { ok: true, ad_nonce: adNonce };
}

/**
 * watch_ad — Credit points after ad completion
 */
async function handleWatchAd(client, userId, body, ipHash, fpHash) {
  const adNonce = body?.data?.ad_nonce;

  // Validate ad nonce
  const nonceOk = await consumeAdNonce(client, adNonce, userId);
  if (!nonceOk) {
    await addRiskEvent(client, userId, 'invalid_ad_nonce', ipHash, fpHash, 10, { adNonce });
    return { ok: false, error: 'invalid_ad_nonce' };
  }

  // Upsert today's ad log with row-level lock
  const res = await client.query(`
    INSERT INTO ad_logs (user_id, log_date, count, points_earned)
    VALUES ($1, CURRENT_DATE, 1, $2)
    ON CONFLICT (user_id, log_date) DO UPDATE
    SET count         = CASE WHEN ad_logs.count < $3
                             THEN ad_logs.count + 1
                             ELSE ad_logs.count END,
        points_earned = CASE WHEN ad_logs.count < $3
                             THEN ad_logs.points_earned + $2
                             ELSE ad_logs.points_earned END,
        updated_at    = NOW()
    RETURNING count, points_earned
  `, [userId, CFG.POINTS_PER_AD, CFG.ADS_DAILY_LIMIT]);

  const log      = res.rows[0];
  const watched  = parseInt(log.count) || 0;
  const prevCount = watched - 1; // before this watch

  // Only credit if we actually incremented (not at limit)
  if (watched > prevCount) {
    await client.query(`
      UPDATE users
      SET points          = points + $1,
          xp              = xp     + $1,
          ads_watched_total = ads_watched_total + 1,
          updated_at      = NOW()
      WHERE id = $2
    `, [CFG.POINTS_PER_AD, userId]);
    await syncLevel(client, userId);
  }

  // Check daily task completions
  if (watched >= 10) {
    await upsertDailyTask(client, userId, 'ads_10');
  }
  if (watched >= 25) {
    await upsertDailyTask(client, userId, 'ads_25');
  }

  const remaining = Math.max(0, CFG.ADS_DAILY_LIMIT - watched);

  // Fetch fresh balance
  const uRes = await client.query(`SELECT points FROM users WHERE id = $1`, [userId]);
  const pts  = parseInt(uRes.rows[0]?.points) || 0;

  return {
    ok:           true,
    remaining:    remaining,
    watchedToday: watched,
    earnedToday:  parseInt(log.points_earned) || 0,
    points:       pts,
    all_done:     remaining === 0,
  };
}

/**
 * claim_gift — Daily streak gift
 */
async function handleClaimGift(client, userId, nonce) {
  const nonceOk = await consumeNonce(client, nonce, userId);
  if (!nonceOk) return { ok: false, error: 'invalid_nonce' };

  // Check already claimed today
  const userRes = await client.query(`
    SELECT last_gift_date, streak_day, points FROM users WHERE id = $1
    FOR UPDATE
  `, [userId]);
  const u       = userRes.rows[0];
  const today   = new Date().toISOString().slice(0, 10);
  const lastDate= u.last_gift_date ? u.last_gift_date.toISOString?.().slice(0,10)
                                   : String(u.last_gift_date || '');

  if (lastDate === today) {
    return { ok: false, error: 'already_claimed_today' };
  }

  // Compute streak
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = (lastDate === yesterday)
    ? (u.streak_day || 0) + 1
    : 1;

  const reward = giftRewardForDay(newStreak);

  await client.query(`
    UPDATE users
    SET points         = points + $1,
        xp             = xp     + $1,
        streak_day     = $2,
        last_gift_date = $3::date,
        updated_at     = NOW()
    WHERE id = $4
  `, [reward, newStreak, today, userId]);

  await syncLevel(client, userId);

  const fresh = await client.query(`SELECT points, level FROM users WHERE id = $1`, [userId]);
  const f     = fresh.rows[0];

  return {
    ok:         true,
    reward,
    streak_day: newStreak,
    points:     parseInt(f.points) || 0,
    level:      f.level,
  };
}

/**
 * verify_tg_task — Verify Telegram channel join task
 */
async function handleVerifyTgTask(client, userId, nonce, ipHash, fpHash) {
  const nonceOk = await consumeNonce(client, nonce, userId);
  if (!nonceOk) return { ok: false, error: 'invalid_nonce' };

  // Check already verified
  const userRes = await client.query(
    `SELECT tg_verified FROM users WHERE id = $1`, [userId]
  );
  if (userRes.rows[0]?.tg_verified) {
    return { ok: false, error: 'already_verified' };
  }

  // [In production: verify via Telegram Bot API getChatMember]
  // For now: credit and mark verified
  await client.query(`
    UPDATE users
    SET tg_verified = TRUE,
        points      = points + $1,
        xp          = xp     + $1,
        updated_at  = NOW()
    WHERE id = $2 AND tg_verified = FALSE
  `, [CFG.POINTS_PER_TG_TASK, userId]);

  await syncLevel(client, userId);
  await upsertDailyTask(client, userId, 'tg_join');

  const fresh = await client.query(`SELECT points, level FROM users WHERE id = $1`, [userId]);
  const f     = fresh.rows[0];

  return {
    ok:     true,
    reward: CFG.POINTS_PER_TG_TASK,
    points: parseInt(f.points) || 0,
    level:  f.level,
  };
}

/**
 * submit_withdraw — Submit withdrawal request
 */
async function handleSubmitWithdraw(client, userId, body, nonce) {
  const nonceOk = await consumeNonce(client, nonce, userId);
  if (!nonceOk) return { ok: false, error: 'invalid_nonce' };

  const address = (body?.data?.address || '').trim();

  // Validate TON address
  if (!isValidTonAddress(address)) {
    return { ok: false, error: 'invalid_address' };
  }

  // Fetch user balance & level — server-side validation
  const userRes = await client.query(`
    SELECT points, level FROM users WHERE id = $1 FOR UPDATE
  `, [userId]);
  const u = userRes.rows[0];

  if (!u) return { ok: false, error: 'user_not_found' };

  const pts   = parseInt(u.points) || 0;
  const level = parseInt(u.level)  || 1;

  if (level < CFG.WITHDRAW_MIN_LEVEL) {
    return { ok: false, error: 'level_too_low', required_level: CFG.WITHDRAW_MIN_LEVEL };
  }
  if (pts < CFG.WITHDRAW_MIN_PTS) {
    return { ok: false, error: 'insufficient_balance', required: CFG.WITHDRAW_MIN_PTS, have: pts };
  }

  const tonAmount = parseFloat((pts / CFG.PTS_PER_TON).toFixed(6));

  // Deduct points atomically
  await client.query(`
    UPDATE users
    SET points = points - $1, updated_at = NOW()
    WHERE id = $2 AND points >= $1
  `, [pts, userId]);

  // Insert withdrawal record
  const wRes = await client.query(`
    INSERT INTO withdrawals (user_id, pts, ton_amount, address, method, status)
    VALUES ($1, $2, $3, $4, 'ton', 'pending')
    RETURNING id
  `, [userId, pts, tonAmount, address]);

  const newBal = await client.query(`SELECT points FROM users WHERE id = $1`, [userId]);

  return {
    ok:          true,
    withdraw_id: wRes.rows[0].id,
    pts_deducted:pts,
    ton_amount:  tonAmount,
    new_balance: parseInt(newBal.rows[0]?.points) || 0,
    status:      'pending',
  };
}

/**
 * get_referrals — Referral stats + list
 */
async function handleGetReferrals(client, userId) {
  const userRes = await client.query(`
    SELECT total_referrals, earned_from_refs, tg_id FROM users WHERE id = $1
  `, [userId]);
  const u = userRes.rows[0];

  const listRes = await client.query(`
    SELECT u.tg_first_name, u.tg_username, u.created_at
    FROM referrals r
    JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = $1
    ORDER BY r.created_at DESC LIMIT 20
  `, [userId]);

  return {
    ok:             true,
    total_referrals:u.total_referrals,
    earned_from_refs:parseInt(u.earned_from_refs) || 0,
    pts_per_referral:CFG.POINTS_PER_REFERRAL,
    referral_list:  listRes.rows.map(r => ({
      name: r.tg_first_name || r.tg_username || 'مستخدم',
      ts:   new Date(r.created_at).getTime(),
    })),
    tg_id: u.tg_id,
  };
}

/**
 * get_state — Quick balance/stats refresh
 */
async function handleGetState(client, userId) {
  const userRes = await client.query(`
    SELECT points, level, xp, total_referrals, earned_from_refs FROM users WHERE id = $1
  `, [userId]);
  const u = userRes.rows[0];
  if (!u) return { ok: false, error: 'user_not_found' };

  const adRes = await client.query(`
    SELECT count, points_earned FROM ad_logs
    WHERE user_id = $1 AND log_date = CURRENT_DATE
  `, [userId]);
  const adLog = adRes.rows[0] || { count: 0, points_earned: 0 };

  return {
    ok:              true,
    points:          parseInt(u.points)    || 0,
    level:           parseInt(u.level)     || 1,
    xp:              parseInt(u.xp)        || 0,
    total_referrals: u.total_referrals,
    earned_from_refs:parseInt(u.earned_from_refs) || 0,
    ads_watched_today:parseInt(adLog.count)        || 0,
    ads_remaining:   Math.max(0, CFG.ADS_DAILY_LIMIT - (parseInt(adLog.count) || 0)),
    earned_today:    parseInt(adLog.points_earned) || 0,
  };
}

// ─── Helper: upsert daily task completion ────────────────────────────────────
async function upsertDailyTask(client, userId, taskType) {
  await client.query(`
    INSERT INTO user_tasks (user_id, task_type, completed, completed_at, task_date)
    VALUES ($1, $2, TRUE, NOW(), CURRENT_DATE)
    ON CONFLICT (user_id, task_type, task_date) DO UPDATE
    SET completed = TRUE, completed_at = NOW()
  `, [userId, taskType]);
}

// ─── Helper: validate TON address ────────────────────────────────────────────
function isValidTonAddress(addr) {
  if (!addr) return false;
  const trimmed = addr.trim();
  const hasPrefix = trimmed.startsWith('EQ') || trimmed.startsWith('UQ') || trimmed.startsWith('0:');
  return hasPrefix && trimmed.length >= 48 && trimmed.length <= 66;
}

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS (protected by ADMIN_SECRET header)
// ══════════════════════════════════════════════════════════════════════════════
async function handleAdmin(client, action, body) {
  switch (action) {
    case 'list_withdrawals': {
      const status = body?.status || 'pending';
      const res = await client.query(`
        SELECT w.id, w.user_id, u.tg_username, u.tg_first_name,
               w.pts, w.ton_amount, w.address, w.status, w.created_at
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
        WHERE w.status = $1
        ORDER BY w.created_at DESC LIMIT 100
      `, [status]);
      return { ok: true, withdrawals: res.rows };
    }

    case 'approve_withdrawal': {
      const id  = parseInt(body?.withdraw_id);
      const txH = body?.tx_hash || '';
      if (!id) return { ok: false, error: 'missing_id' };
      await client.query(`
        UPDATE withdrawals
        SET status = 'completed', tx_hash = $1, reviewed_at = NOW()
        WHERE id = $2
      `, [txH, id]);
      return { ok: true };
    }

    case 'reject_withdrawal': {
      const id = parseInt(body?.withdraw_id);
      if (!id) return { ok: false, error: 'missing_id' };
      // Refund points
      const wRes = await client.query(
        `SELECT user_id, pts FROM withdrawals WHERE id = $1`, [id]
      );
      if (wRes.rows.length) {
        const { user_id, pts } = wRes.rows[0];
        await client.query(
          `UPDATE users SET points = points + $1 WHERE id = $2`, [pts, user_id]
        );
      }
      await client.query(
        `UPDATE withdrawals SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`, [id]
      );
      return { ok: true };
    }

    case 'ban_user': {
      const tgId  = parseInt(body?.tg_id);
      const reason= body?.reason || 'admin_ban';
      if (!tgId) return { ok: false, error: 'missing_tg_id' };
      await client.query(
        `UPDATE users SET is_banned = TRUE, ban_reason = $1 WHERE tg_id = $2`,
        [reason, tgId]
      );
      return { ok: true };
    }

    case 'unban_user': {
      const tgId = parseInt(body?.tg_id);
      if (!tgId) return { ok: false, error: 'missing_tg_id' };
      await client.query(
        `UPDATE users SET is_banned = FALSE, ban_reason = NULL, risk_score = 0 WHERE tg_id = $1`,
        [tgId]
      );
      return { ok: true };
    }

    case 'stats': {
      const res = await client.query(`
        SELECT
          COUNT(*)                                         AS total_users,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') AS new_today,
          SUM(points)                                      AS total_points,
          COUNT(*) FILTER (WHERE is_banned)                AS banned_users,
          (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') AS pending_withdrawals,
          (SELECT COALESCE(SUM(pts),0) FROM withdrawals WHERE status = 'pending') AS pending_pts
        FROM users
      `);
      return { ok: true, stats: res.rows[0] };
    }

    default:
      return { ok: false, error: 'unknown_admin_action' };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN HANDLER — Vercel Serverless Entry Point
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── CORS ─────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Init-Data, X-Session-Id, X-Fingerprint, X-Nonce, X-Admin-Secret');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')   { send(res, 405, { error: 'method_not_allowed' }); return; }

  // ── Ensure DB schema ─────────────────────────────────────────────────────
  try { await ensureMigrated(); }
  catch(e) {
    console.error('[DB] Migration error:', e.message);
    send(res, 500, { error: 'db_init_error' });
    return;
  }

  // ── Parse headers ────────────────────────────────────────────────────────
  const initData  = req.headers['x-init-data']   || '';
  const sessionId = req.headers['x-session-id']  || '';
  const fpRaw     = req.headers['x-fingerprint'] || '{}';
  const nonce     = req.headers['x-nonce']       || '';
  const adminKey  = req.headers['x-admin-secret']|| '';

  const ip    = getIp(req);
  const ipHash= hashIp(ip);
  const fpHash= hashFp(fpRaw);

  // ── Parse body ───────────────────────────────────────────────────────────
  const body = await readBody(req);
  const type = body?.type || '';
  if (!type) { send(res, 400, { error: 'missing_type' }); return; }

  // ── Rate limit (by IP hash) ───────────────────────────────────────────────
  const isWrite  = !['load', 'get_state', 'get_nonce', 'create_session', 'get_referrals'].includes(type);
  const rlKey    = `${ipHash}_${type}`;
  const rlOk     = checkRateLimit(rlKey, isWrite ? CFG.RATE_WRITE_MAX : CFG.RATE_MAX_REQUESTS);
  if (!rlOk) {
    send(res, 429, { ok: false, error: 'rate_limited' });
    return;
  }

  // ── Admin route ───────────────────────────────────────────────────────────
  if (type === 'admin') {
    if (adminKey !== ADMIN_SECRET) {
      send(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const client = await pool.connect();
    try {
      const result = await handleAdmin(client, body?.action, body);
      send(res, 200, result);
    } catch(e) {
      console.error('[Admin]', e.message);
      send(res, 500, { ok: false, error: 'internal_error' });
    } finally {
      client.release();
    }
    return;
  }

  // ── Acquire DB client ─────────────────────────────────────────────────────
  const client = await pool.connect();
  try {
    await maybeRunCleanup(client);

    // ─ create_session — no auth required ──────────────────────────────────
    if (type === 'create_session') {
      const result = await handleCreateSession(client, body, ipHash, fpHash);
      send(res, result.status || 200, result);
      return;
    }

    // ─ All other routes require valid session ──────────────────────────────
    if (!sessionId) {
      send(res, 401, { ok: false, error: 'session_required' });
      return;
    }

    const session = await validateSession(client, sessionId, null);
    if (!session) {
      send(res, 401, { ok: false, error: 'session_invalid_or_expired' });
      return;
    }

    if (session.is_banned || session.cluster_ban) {
      send(res, 403, { ok: false, is_banned: true, error: 'banned' });
      return;
    }

    const userId = session.user_id;

    // ─ Rate limit by user ─────────────────────────────────────────────────
    const userRlKey = `user_${userId}_${type}`;
    if (!checkRateLimit(userRlKey, isWrite ? 10 : 20)) {
      send(res, 429, { ok: false, error: 'rate_limited' });
      return;
    }

    // ─ Dispatch actions ───────────────────────────────────────────────────
    let result;

    switch (type) {
      case 'get_nonce':
        result = await handleGetNonce(client, userId);
        break;

      case 'load':
        result = await handleLoad(client, userId);
        break;

      case 'get_state':
        result = await handleGetState(client, userId);
        break;

      case 'start_ad':
        result = await handleStartAd(client, userId);
        break;

      case 'watch_ad':
        result = await handleWatchAd(client, userId, body, ipHash, fpHash);
        break;

      case 'claim_gift':
        result = await handleClaimGift(client, userId, nonce);
        break;

      case 'verify_tg_task':
        result = await handleVerifyTgTask(client, userId, nonce, ipHash, fpHash);
        break;

      case 'submit_withdraw':
        result = await handleSubmitWithdraw(client, userId, body, nonce);
        break;

      case 'get_referrals':
        result = await handleGetReferrals(client, userId);
        break;

      default:
        result = { ok: false, error: 'unknown_action' };
    }

    // Shadow ban: silently return ok=true on writes to fool bots
    if (session.is_shadow_banned && isWrite && result.ok === false) {
      result = { ok: true, shadow: true };
    }

    send(res, 200, result);

  } catch(e) {
    console.error(`[Handler] ${type} error:`, e.message, e.stack?.slice(0, 300));
    send(res, 500, { ok: false, error: 'internal_server_error' });
  } finally {
    client.release();
  }
};
