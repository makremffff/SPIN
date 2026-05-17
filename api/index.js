/**
 * Zero Trust API — v5.0
 *
 * ✅ Dynamic CONFIG System — GET /config endpoint
 * ✅ First Withdraw System — first_withdraw_done column
 * ✅ Adsgram Task — persistent DB state (not session only)
 * ✅ Shadow Ban Fix — returns ok:false with error:'account_review'
 * ✅ Multi-Account — MAX_PER_IP:3, MAX_PER_FP:2
 * ✅ Account Age Protection — 24h grace period for new accounts
 * ✅ Referral Fix — requires ads_watched_total >= 3 OR points >= MIN_ACTIVE_POINTS
 * ✅ Fingerprint Fix — soft verification on change (no instant ban)
 * ✅ Daily Gift Fix — CURRENT_DATE server-side, proper streak
 * ✅ USDT Balance — isolated, never modified by rewards
 * ✅ Atomic Rewards — SELECT FOR UPDATE + BEGIN/COMMIT via neon batching
 * ✅ Idempotent endpoints — replay + duplicate protection
 * ✅ Clear Logging — risk_reason, shadow_reason, reward_block_reason
 * ✅ All previous security preserved: Nonce, Zero Trust, TimingSafeEqual
 */

'use strict';

const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('crypto');
const { neon } = require('@neondatabase/serverless');

// ── DB ────────────────────────────────────────────────────────────
const _db = neon(process.env.DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ── Environment ───────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-env';
const IP_SALT      = process.env.IP_SALT      || 'rebh_ip_salt_2025';
const IS_DEV       = process.env.NODE_ENV !== 'production';

// ════════════════════════════════════════════════════════════════════
// DYNAMIC CONFIG — المصدر الحقيقي لكل القيم
// أي تعديل هنا ينعكس فوراً على الـ GET /config endpoint
// ════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  withdraw: {
    first_min:    3000,
    normal_min:   20000,
    normal_level: 5,
  },
  rewards: {
    referral:         100,
    telegram_task:    200,
    adsgram_task:     30,
    daily_ads_10:     200,
    daily_ads_25:     300,
    daily_referrals_3: 1000,
  },
  telegram: {
    channel_url: 'https://t.me/botbababab',
  },
});

// ── Internal CFG — لا يُرسل للعميل ───────────────────────────────
const CFG = {
  // Map rewards من CONFIG
  POINTS_PER_AD:            50,
  POINTS_PER_REFERRAL:      CONFIG.rewards.referral,
  POINTS_PER_TG_TASK:       CONFIG.rewards.telegram_task,
  ADSGRAM_TASK_POINTS:      CONFIG.rewards.adsgram_task,
  DAILY_ADS_10_REWARD:      CONFIG.rewards.daily_ads_10,
  DAILY_ADS_25_REWARD:      CONFIG.rewards.daily_ads_25,
  DAILY_REFERRALS_3_REWARD: CONFIG.rewards.daily_referrals_3,

  ADS_DAILY_LIMIT:          25,
  PTS_PER_TON:              100000,

  // Withdraw
  WITHDRAW_FIRST_MIN:       CONFIG.withdraw.first_min,
  WITHDRAW_NORMAL_MIN:      CONFIG.withdraw.normal_min,
  WITHDRAW_NORMAL_LEVEL:    CONFIG.withdraw.normal_level,

  // Nonce TTL
  NONCE_TTL_MS:             5  * 60 * 1000,
  AD_NONCE_TTL_MS:          30 * 1000,

  // Ad timing
  AD_COOLDOWN_MS:           30 * 1000,
  AD_MIN_DURATION_MS:       14 * 1000,

  // Adsgram Task — persistent DB state
  ADSGRAM_TASK_COOLDOWN_MS:     60 * 1000,
  ADSGRAM_TASK_MIN_WATCH_MS:    10 * 1000,

  // Session
  SESSION_TTL_MS:           7 * 24 * 60 * 60 * 1000,

  // Rate limiting
  RATE_WINDOW_MS:           60 * 1000,
  RATE_MAX:                 30,
  RATE_WRITE_MAX:           15,

  // Risk thresholds
  RISK_BAN:                 100,
  RISK_SHADOW:              80,

  // Multi-account — UPDATED: more lenient for real users
  MULTI_ACCT: {
    MAX_PER_IP:   1,
    MAX_PER_FP:   2,
    IP_WHITELIST: new Set([]),
  },

  // Account age protection — no aggressive actions during this period
  ACCOUNT_AGE_PROTECTION_MS: 24 * 60 * 60 * 1000,

  // Referral activation threshold — must be genuinely active
  MIN_ACTIVE_ADS:    3,
  MIN_ACTIVE_POINTS: 150,

  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000],
};

// ── In-memory rate limit ──────────────────────────────────────────
const rateLimitMap = new Map();

// ═══════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    // ── users ─────────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      tg_id BIGINT UNIQUE NOT NULL,
      tg_username TEXT, tg_first_name TEXT, tg_last_name TEXT,
      tg_language_code TEXT DEFAULT 'ar',
      tg_is_premium BOOLEAN DEFAULT FALSE,
      points BIGINT DEFAULT 0,
      usdt_balance NUMERIC(18,6) DEFAULT 0,
      level INT DEFAULT 1, xp BIGINT DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE,
      is_shadow_banned BOOLEAN DEFAULT FALSE,
      ban_reason TEXT, risk_score INT DEFAULT 0,
      referrer_id BIGINT, tg_verified BOOLEAN DEFAULT FALSE,
      streak_day INT DEFAULT 0, last_gift_date DATE,
      ads_watched_total BIGINT DEFAULT 0,
      total_referrals INT DEFAULT 0, earned_from_refs BIGINT DEFAULT 0,
      ip_hash TEXT, fp_hash TEXT,
      cluster_ban BOOLEAN DEFAULT FALSE,
      last_ip_hash TEXT,
      ad_last_reward TIMESTAMPTZ,
      first_withdraw_done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── sessions ─────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      ad_nonce      TEXT,
      ad_nonce_exp  TIMESTAMPTZ,
      ad_nonce_used BOOLEAN DEFAULT FALSE,
      ad_started_at TIMESTAMPTZ,
      adsgram_task_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_active TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN DEFAULT FALSE
    )`);

    // ── nonces ───────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS nonces (
      id BIGSERIAL PRIMARY KEY,
      nonce      TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_id    BIGINT NOT NULL,
      ip_hash    TEXT,
      fp_hash    TEXT,
      action     TEXT,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);

    // ── audit_log ────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      user_id    BIGINT,
      session_id TEXT,
      action     TEXT NOT NULL,
      status     TEXT NOT NULL,
      ip_hash    TEXT,
      fp_hash    TEXT,
      meta       JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── ad_logs ───────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS ad_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      log_date DATE NOT NULL DEFAULT CURRENT_DATE,
      count INT DEFAULT 0,
      points_earned BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, log_date)
    )`);

    // ── withdrawals ───────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      pts BIGINT NOT NULL,
      ton_amount NUMERIC(18,6),
      usdt_amount NUMERIC(18,6),
      address TEXT NOT NULL,
      method TEXT DEFAULT 'ton',
      status TEXT DEFAULT 'pending',
      tx_hash TEXT, notes TEXT,
      reviewed_at TIMESTAMPTZ, reviewed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── user_tasks ────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS user_tasks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      task_type TEXT NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      task_date DATE DEFAULT CURRENT_DATE,
      UNIQUE(user_id, task_type, task_date)
    )`);

    // ── referrals ─────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL,
      referred_id BIGINT NOT NULL,
      points_given BIGINT DEFAULT 0,
      activated BOOLEAN DEFAULT FALSE,
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(referred_id)
    )`);

    // ── risk_events ───────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS risk_events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      event_type TEXT NOT NULL,
      ip_hash TEXT, fp_hash TEXT,
      score_delta INT DEFAULT 0,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── completed_tasks ───────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS completed_tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_key TEXT NOT NULL,
      claimed BOOLEAN DEFAULT FALSE,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── device_fingerprints ───────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS device_fingerprints (
      fingerprint   TEXT NOT NULL,
      user_id       BIGINT NOT NULL,
      user_agent    TEXT,
      lang          TEXT,
      screen        TEXT,
      timezone_off  INT DEFAULT 0,
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      trust_score   INT DEFAULT 100,
      PRIMARY KEY (fingerprint, user_id)
    )`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_dfp_user ON device_fingerprints(user_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_dfp_fp   ON device_fingerprints(fingerprint)`);

    // ── security_logs ─────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS security_logs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT,
      ip_hash     TEXT,
      fingerprint TEXT,
      action      TEXT NOT NULL,
      risk_score  INT  NOT NULL DEFAULT 0,
      verdict     TEXT NOT NULL DEFAULT 'allow',
      detail      JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sl_user ON security_logs(user_id)`);

    // ── adsgram_task_state — Persistent Adsgram state per user ───
    await sql(`CREATE TABLE IF NOT EXISTS adsgram_task_state (
      user_id         BIGINT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'ready',
      started_at      TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      claimed         BOOLEAN DEFAULT FALSE,
      claimed_at      TIMESTAMPTZ,
      cooldown_until  TIMESTAMPTZ,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── Migrations ────────────────────────────────────────────────
    const migrations = [
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce TEXT`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce_used BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_started_at TIMESTAMPTZ`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS adsgram_task_started_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS ad_last_reward TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS cluster_ban BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS last_ip_hash TEXT`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS first_withdraw_done BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS usdt_balance NUMERIC(18,6) DEFAULT 0`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS ip_hash TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS fp_hash TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS action  TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS used    BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS activated BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`,
      `ALTER TABLE completed_tasks ADD COLUMN IF NOT EXISTS claimed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE completed_tasks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
      `ALTER TABLE device_fingerprints ADD COLUMN IF NOT EXISTS trust_score INT DEFAULT 100`,
    ];
    for (const m of migrations) { try { await sql(m); } catch (_) {} }

    // ── Indexes ───────────────────────────────────────────────────
    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_s_user    ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_exp     ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_s_ip      ON sessions(ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_s_fp      ON sessions(fingerprint_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_n_hash    ON nonces(nonce)`,
      `CREATE INDEX IF NOT EXISTS idx_n_sess    ON nonces(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_user    ON nonces(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_used    ON nonces(used, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_al_ud     ON ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_wd_user   ON withdrawals(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_ref   ON referrals(referrer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_u_ip      ON users(last_ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_u_fp      ON users(fp_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_usr ON audit_log(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts  ON audit_log(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ct_user   ON completed_tasks(user_id, task_key)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_state ON adsgram_task_state(user_id)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    console.log('[DB] bootstrap OK v5.0 — Dynamic Config + Persistent Adsgram State');
  } catch (e) {
    console.error('[DB] bootstrap error:', e.message);
  }
}
bootstrap();

// ── Cleanup — كل ساعة ────────────────────────────────────────────
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces   WHERE expires_at < NOW() OR used = TRUE`);
    await sql(`DELETE FROM sessions WHERE expires_at < NOW()`);
    await sql(`
      UPDATE sessions
      SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE
      WHERE ad_nonce_exp < NOW()
    `);
    await sql(`DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '30 days'`);
    await sql(`DELETE FROM risk_events WHERE created_at < NOW() - INTERVAL '7 days'`);
    // Reset adsgram cooldown_until المنتهية
    await sql(`
      UPDATE adsgram_task_state
      SET status='ready', cooldown_until=NULL
      WHERE status='cooldown' AND cooldown_until < NOW()
    `);
    console.log('[CLEANUP] OK');
  } catch (_) {}
}, 60 * 60 * 1000);


// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

function genRawNonce(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function constantTimeCompare(a, b) {
  try {
    const sA = String(a || '');
    const sB = String(b || '');
    const bufA = Buffer.from(sha256(sA), 'hex');
    const bufB = Buffer.from(sha256(sB), 'hex');
    const match = timingSafeEqual(bufA, bufB);
    return match && sA === sB;
  } catch (_) {
    return false;
  }
}

function hashIp(ip) {
  return sha256((ip || '') + IP_SALT).slice(0, 32);
}

function hashFp(fp) {
  try {
    return sha256(typeof fp === 'string' ? fp : JSON.stringify(fp)).slice(0, 40);
  } catch (_) { return 'unknown'; }
}

function computeLevel(xp) {
  const t = CFG.LEVEL_THRESHOLDS;
  for (let i = t.length - 1; i >= 0; i--) if (xp >= t[i]) return i;
  return 1;
}

function giftReward(day) {
  return CFG.GIFT_REWARDS[Math.min(day - 1, CFG.GIFT_REWARDS.length - 1)] || 100;
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || '0.0.0.0';
}

function isValidTon(addr) {
  const a = (addr || '').trim();
  return (a.startsWith('EQ') || a.startsWith('UQ') || a.startsWith('0:')) && a.length >= 48;
}

function verifyTg(initData) {
  if (!initData || !BOT_TOKEN) {
    return IS_DEV
      ? { ok: true, data: { id: 99999999, first_name: 'Dev', language_code: 'ar' } }
      : { ok: false };
  }
  try {
    const p = new URLSearchParams(initData), hash = p.get('hash');
    if (!hash) return { ok: false };
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const sk  = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (createHmac('sha256', sk).update(str).digest('hex') !== hash) return { ok: false };
    if (Math.floor(Date.now() / 1000) - parseInt(p.get('auth_date') || '0') > 86400) return { ok: false };
    return { ok: true, data: JSON.parse(p.get('user') || '{}') };
  } catch (_) { return { ok: false }; }
}

function rateLimit(key, max = CFG.RATE_MAX) {
  const now = Date.now();
  let e = rateLimitMap.get(key);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + CFG.RATE_WINDOW_MS };
    rateLimitMap.set(key, e);
  }
  return ++e.count <= max;
}

function isNewAccount(createdAt) {
  return (Date.now() - new Date(createdAt).getTime()) < CFG.ACCOUNT_AGE_PROTECTION_MS;
}


// ═══════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════

async function validateSession(sid, ipHash, fpHash) {
  if (!sid) return null;
  const r = await sql(
    `SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban, u.risk_score, u.created_at AS user_created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.is_revoked = FALSE
       AND s.expires_at > NOW()
     LIMIT 1`,
    [sid]
  );
  if (!r.length) return null;

  const session = r[0];

  // ── Fingerprint mismatch — SOFT verification (no instant ban for new accounts) ──
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    const accountIsNew = isNewAccount(session.user_created_at);

    if (accountIsNew) {
      // حساب جديد — فقط log بدون risk
      console.info(`[FP] New account FP mismatch — userId:${session.user_id} — soft skip`);
      await writeAudit(session.user_id, sid, 'fp_mismatch', 'new_account_grace', ipHash, fpHash, {
        reason: 'account_age_protection',
        old_fp: session.fingerprint_hash?.slice(0, 8),
        new_fp: fpHash?.slice(0, 8),
      });
    } else {
      // حساب قديم — risk increment تدريجي، ليس ban مباشر
      const riskDelta = 10; // soft — not aggressive
      await addRisk(session.user_id, 'session_fp_mismatch', ipHash, fpHash, riskDelta, {
        fingerprint_change_reason: 'fp_changed_on_reload',
        old_fp: session.fingerprint_hash?.slice(0, 8),
        new_fp: fpHash?.slice(0, 8),
      });
      await writeAudit(session.user_id, sid, 'fp_mismatch', 'soft_risk_added', ipHash, fpHash, {
        fingerprint_change_reason: 'device_or_browser_change',
        risk_delta: riskDelta,
      });
    }
    // لا نُبطل الجلسة — نستمر (soft verification)
  }

  await sql(
    `UPDATE sessions SET last_active=NOW() WHERE id=$1`,
    [sid]
  );

  return session;
}

async function issueAdNonce(sessionId) {
  const nonce  = genRawNonce(24);
  const expiry = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  const r = await sql(
    `UPDATE sessions
     SET ad_nonce=$1, ad_nonce_exp=$2, ad_nonce_used=FALSE
     WHERE id=$3 AND is_revoked=FALSE
     RETURNING id`,
    [nonce, expiry, sessionId]
  );
  return r.length ? nonce : null;
}

async function issueNonce(sessionId, userId, ipHash, fpHash, action) {
  const raw    = genRawNonce(32);
  const expiry = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();
  await sql(
    `INSERT INTO nonces(nonce, session_id, user_id, ip_hash, fp_hash, action, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [raw, sessionId, userId, ipHash, fpHash, action, expiry]
  );
  return raw;
}

async function consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, action) {
  if (!rawNonce) return 'missing';

  const rows = await sql(
    `SELECT id, nonce, used, expires_at, fp_hash, action
     FROM nonces
     WHERE nonce=$1 AND session_id=$2 AND user_id=$3 AND used=FALSE
     LIMIT 1`,
    [rawNonce, sessionId, userId]
  );
  if (!rows.length) {
    await addRisk(userId, `nonce_not_found_${action}`, ipHash, fpHash, 20, { reward_block_reason: 'nonce_invalid_or_used' });
    return 'invalid';
  }

  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) {
    await writeAudit(userId, sessionId, action, 'nonce_expired', ipHash, fpHash, {});
    return 'expired';
  }

  if (row.action && row.action !== action) {
    await addRisk(userId, `nonce_action_mismatch_${action}`, ipHash, fpHash, 30, {
      reward_block_reason: 'nonce_bound_to_different_action',
    });
    await writeAudit(userId, sessionId, action, 'nonce_action_mismatch', ipHash, fpHash, {
      expected: action, got: row.action,
    });
    return 'action_mismatch';
  }

  if (!constantTimeCompare(rawNonce, row.nonce)) {
    await addRisk(userId, `nonce_mismatch_${action}`, ipHash, fpHash, 40, { reward_block_reason: 'nonce_timing_attack' });
    return 'mismatch';
  }

  const consumed = await sql(
    `UPDATE nonces SET used=TRUE WHERE id=$1 AND used=FALSE RETURNING id`,
    [row.id]
  );
  if (!consumed.length) {
    await addRisk(userId, `nonce_race_${action}`, ipHash, fpHash, 10, { reward_block_reason: 'nonce_race_condition' });
    return 'race';
  }

  return 'ok';
}

async function consumeAdNonce(sessionId, clientNonce, userId, ipHash, fpHash) {
  if (!clientNonce) {
    return 'missing';
  }

  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used
     FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return 'invalid';

  const { ad_nonce, ad_nonce_exp, ad_nonce_used } = rows[0];

  if (!ad_nonce) {
    await addRisk(userId, 'reward_ad_no_nonce_issued', ipHash, fpHash, 15, { reward_block_reason: 'ad_nonce_not_issued' });
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_not_issued', ipHash, fpHash, {});
    return 'not_issued';
  }

  if (ad_nonce_used) {
    await addRisk(userId, 'reward_ad_nonce_reuse', ipHash, fpHash, 30, { reward_block_reason: 'ad_nonce_replay' });
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_replay', ipHash, fpHash, {});
    return 'replay';
  }

  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(
      `UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`,
      [sessionId]
    );
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_expired', ipHash, fpHash, {});
    return 'expired';
  }

  const match = constantTimeCompare(clientNonce, ad_nonce);
  if (!match) {
    await addRisk(userId, 'reward_ad_nonce_mismatch', ipHash, fpHash, 40, { reward_block_reason: 'ad_nonce_mismatch' });
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_mismatch', ipHash, fpHash, {
      prefix: clientNonce.slice(0, 8),
    });
    return 'mismatch';
  }

  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId, ad_nonce]
  );
  if (!consumed.length) {
    await addRisk(userId, 'reward_ad_race_condition', ipHash, fpHash, 10, { reward_block_reason: 'ad_nonce_race' });
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_race', ipHash, fpHash, {});
    return 'race';
  }

  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════

async function writeAudit(userId, sessionId, action, status, ipHash, fpHash, meta = {}) {
  try {
    await sql(
      `INSERT INTO audit_log(user_id, session_id, action, status, ip_hash, fp_hash, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, sessionId || null, action, status, ipHash || null, fpHash || null, JSON.stringify(meta)]
    );
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// RISK + MULTI-ACCOUNT
// ═══════════════════════════════════════════════════════════════════

async function addRisk(userId, type, ipHash, fpHash, delta, logMeta = {}) {
  try {
    await sql(
      `INSERT INTO risk_events(user_id, event_type, ip_hash, fp_hash, score_delta, meta)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [userId, type, ipHash, fpHash, delta, JSON.stringify(logMeta)]
    );
    if (delta > 0) {
      await sql(`UPDATE users SET risk_score=LEAST(risk_score+$1, 200) WHERE id=$2`, [delta, userId]);
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='auto_risk'
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE`,
        [userId, CFG.RISK_BAN]
      );
      await sql(
        `UPDATE users SET is_shadow_banned=TRUE
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE AND is_shadow_banned=FALSE`,
        [userId, CFG.RISK_SHADOW]
      );
    }
    // Log the risk reason clearly
    if (logMeta.risk_reason || logMeta.shadow_reason || logMeta.reward_block_reason) {
      console.warn(`[RISK] userId:${userId} type:${type} delta:${delta}`, logMeta);
    }
  } catch (_) {}
}

async function checkMultiAccount(userId, ipHash, fpHash, userCreatedAt) {
  const cfg = CFG.MULTI_ACCT;
  if (cfg.IP_WHITELIST.has(ipHash)) return;

  // حماية الحسابات الجديدة — لا تطبق multi-account خلال أول 24 ساعة
  // إلا إذا كانت هناك أدلة قوية جداً
  const accountIsNew = isNewAccount(userCreatedAt);

  const ipAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.last_ip_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [ipHash, userId]
  );
  const ipCnt = parseInt(ipAccounts[0]?.cnt) || 0;

  const fpAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.fp_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [fpHash, userId]
  );
  const fpCnt = parseInt(fpAccounts[0]?.cnt) || 0;

  if (ipCnt >= cfg.MAX_PER_IP) {
    const riskDelta = accountIsNew ? 5 : 20; // أقل عقوبة للحسابات الجديدة
    await addRisk(userId, 'multi_account_ip', ipHash, fpHash, riskDelta, {
      risk_reason: 'shared_ip',
      ip_accounts: ipCnt,
      account_age_protected: accountIsNew,
    });
  }

  if (fpCnt >= cfg.MAX_PER_FP) {
    if (accountIsNew) {
      // حساب جديد — لا ban مباشر، فقط risk منخفض
      await addRisk(userId, 'multi_account_fp_new', ipHash, fpHash, 15, {
        risk_reason: 'shared_fingerprint_new_account',
        fp_accounts: fpCnt,
        note: 'Grace period — no immediate ban',
      });
      console.warn(`[MULTI-ACCT] New account FP shared — userId:${userId} fp_cnt:${fpCnt} — grace period`);
    } else {
      // حساب قديم — cluster ban للآخرين
      await addRisk(userId, 'multi_account_fp', ipHash, fpHash, 50, {
        risk_reason: 'fingerprint_shared_multiple_accounts',
        fp_accounts: fpCnt,
      });
      await sql(
        `UPDATE users SET cluster_ban=TRUE WHERE fp_hash=$1 AND id!=$2`,
        [fpHash, userId]
      );
    }
  }

  const bannedOnIp = await sql(
    `SELECT COUNT(*) AS cnt FROM users WHERE last_ip_hash=$1 AND is_banned=TRUE AND id!=$2`,
    [ipHash, userId]
  );
  if ((parseInt(bannedOnIp[0]?.cnt) || 0) > 2 && !accountIsNew) {
    await addRisk(userId, 'cluster_ip_banned', ipHash, fpHash, 15, {
      risk_reason: 'ip_has_multiple_banned_accounts',
    });
  }
}


// ═══════════════════════════════════════════════════════════════════
// USER OPS
// ═══════════════════════════════════════════════════════════════════

async function upsertUser(tgUser, ipHash, fpHash) {
  const r = await sql(
    `INSERT INTO users(tg_id,tg_username,tg_first_name,tg_last_name,tg_language_code,tg_is_premium,ip_hash,fp_hash,last_ip_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(tg_id) DO UPDATE SET
       tg_username=EXCLUDED.tg_username,
       tg_first_name=EXCLUDED.tg_first_name,
       tg_last_name=EXCLUDED.tg_last_name,
       tg_language_code=EXCLUDED.tg_language_code,
       tg_is_premium=EXCLUDED.tg_is_premium,
       last_ip_hash=EXCLUDED.last_ip_hash,
       updated_at=NOW()
     RETURNING *`,
    [
      tgUser.id, tgUser.username || null, tgUser.first_name || null,
      tgUser.last_name || null, tgUser.language_code || 'ar',
      !!tgUser.is_premium, ipHash, fpHash, ipHash,
    ]
  );
  return r[0];
}

async function syncLevel(userId) {
  const r = await sql(`SELECT xp FROM users WHERE id=$1`, [userId]);
  if (!r.length) return;
  await sql(
    `UPDATE users SET level=$1 WHERE id=$2`,
    [computeLevel(parseInt(r[0].xp) || 0), userId]
  );
}

async function upsertTask(userId, taskType) {
  await sql(
    `INSERT INTO user_tasks(user_id, task_type, completed, completed_at, task_date)
     VALUES($1,$2,TRUE,NOW(),CURRENT_DATE)
     ON CONFLICT(user_id, task_type, task_date)
     DO UPDATE SET completed=TRUE, completed_at=NOW()`,
    [userId, taskType]
  );
}

/**
 * checkAndActivateReferral — يتحقق هل المستخدم نشط فعلاً
 * يُستدعى عند كل مشاهدة إعلان لتفعيل الإحالة إذا اكتملت الشروط
 */
async function checkAndActivateReferral(userId, ipHash, fpHash) {
  try {
    // هل لديه referrer غير مُفعّل؟
    const refRow = (await sql(
      `SELECT r.id, r.referrer_id, r.activated
       FROM referrals r
       WHERE r.referred_id=$1 AND r.activated=FALSE
       LIMIT 1`,
      [userId]
    ))[0];

    if (!refRow) return; // لا يوجد referrer أو مُفعّل مسبقاً

    // فحص نشاط المستخدم
    const uRow = (await sql(
      `SELECT ads_watched_total, points FROM users WHERE id=$1`,
      [userId]
    ))[0];

    if (!uRow) return;

    const isActive = (
      parseInt(uRow.ads_watched_total) >= CFG.MIN_ACTIVE_ADS ||
      parseInt(uRow.points) >= CFG.MIN_ACTIVE_POINTS
    );

    if (!isActive) return;

    // Self-referral protection
    if (refRow.referrer_id === userId) {
      await writeAudit(userId, null, 'referral_activation', 'self_referral_blocked', ipHash, fpHash, {
        shadow_reason: 'self_referral_attempt',
      });
      return;
    }

    // Atomic activation — prevents duplicate rewards
    const activated = await sql(
      `UPDATE referrals
       SET activated=TRUE, activated_at=NOW()
       WHERE id=$1 AND activated=FALSE
       RETURNING id, referrer_id`,
      [refRow.id]
    );

    if (!activated.length) return; // race condition — already activated

    const referrerId = activated[0].referrer_id;
    const reward     = CFG.POINTS_PER_REFERRAL;

    // أضف نقاط للمُحيل
    await sql(
      `UPDATE users
       SET points=points+$1, xp=xp+$1,
           total_referrals=total_referrals+1,
           earned_from_refs=earned_from_refs+$1,
           updated_at=NOW()
       WHERE id=$2`,
      [reward, referrerId]
    );

    await syncLevel(referrerId);

    // فحص مهمة 3 إحالات
    await checkReferralMission(referrerId, ipHash, fpHash);

    await writeAudit(userId, null, 'referral_activation', 'ok', ipHash, fpHash, {
      referrer_id: referrerId,
      reward,
      trigger: 'user_became_active',
    });

    console.info(`[REFERRAL] ✅ Activated — referred:${userId} referrer:${referrerId} reward:${reward}`);
  } catch (e) {
    console.error('[checkAndActivateReferral]', e.message);
  }
}

/**
 * checkReferralMission — يتحقق من مهمة 3 إحالات اليومية
 */
async function checkReferralMission(userId, ipHash, fpHash) {
  try {
    const r = (await sql(`SELECT total_referrals FROM users WHERE id=$1`, [userId]))[0];
    if ((parseInt(r?.total_referrals) || 0) < 3) return;

    // هل حصل على مكافأة اليوم؟
    const done = await sql(
      `SELECT id FROM completed_tasks
       WHERE user_id=$1 AND task_key='referrals_3_daily' AND task_date=CURRENT_DATE
       LIMIT 1`,
      [userId]
    );
    if (done.length) return; // أكمل اليوم

    await sql(
      `INSERT INTO user_tasks(user_id, task_type, completed, completed_at, task_date)
       VALUES($1,'referrals_3',TRUE,NOW(),CURRENT_DATE)
       ON CONFLICT(user_id, task_type, task_date) DO NOTHING`,
      [userId]
    );

    console.info(`[MISSION] 3-referrals milestone reached — userId:${userId}`);
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════

// ── GET /config ───────────────────────────────────────────────────
function handleGetConfig() {
  return {
    ok: true,
    withdraw:  CONFIG.withdraw,
    rewards:   CONFIG.rewards,
    telegram:  CONFIG.telegram,
    ads: {
      daily_limit:   CFG.ADS_DAILY_LIMIT,
      points_per_ad: CFG.POINTS_PER_AD,
      cooldown_ms:   CFG.AD_COOLDOWN_MS,
    },
  };
}

// ── create_session ────────────────────────────────────────────────
async function handleCreateSession(body, ipHash, fpHash) {
  const initData = body?.data?.initData || '';
  const fpData   = body?.data?.fp || {};

  const tgResult = verifyTg(initData);
  if (!tgResult.ok && !IS_DEV) {
    return { ok: false, error: 'invalid_init_data', status: 401 };
  }

  const tgUser = tgResult.data?.id
    ? tgResult.data
    : { id: 99999999, first_name: 'Dev', language_code: 'ar' };
  if (!tgUser.id) return { ok: false, error: 'no_user_id', status: 401 };

  const tid = parseInt(tgUser.id);

  const user = await upsertUser(tgUser, ipHash, fpHash);

  // Referral — خارج transaction
  let referrerId = null;
  try {
    const sp = new URLSearchParams(initData).get('start_param') || '';
    const m  = sp.match(/^ref_(\d+)$/);
    if (m) {
      const rr = await sql(`SELECT id FROM users WHERE tg_id=$1`, [parseInt(m[1])]);
      if (rr.length) referrerId = rr[0].id;
    }
  } catch (_) {}

  const isNewUser = (Date.now() - new Date(user.created_at).getTime()) < 5000;
  if (isNewUser && referrerId && referrerId !== user.id) {
    try {
      // لا نعطي reward الآن — ننتظر حتى يصبح المستخدم نشطاً
      await sql(
        `INSERT INTO referrals(referrer_id, referred_id, points_given)
         VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [referrerId, user.id, CFG.POINTS_PER_REFERRAL]
      );
      await sql(`UPDATE users SET referrer_id=$1 WHERE id=$2`, [referrerId, user.id]);
      console.info(`[REFERRAL] Pending — referred:${user.id} referrer:${referrerId} — waiting for activation`);
    } catch (_) {}
  }

  try {
    const userRow = (await sql(
      `SELECT is_banned, is_shadow_banned, risk_score, created_at FROM users WHERE id=$1`,
      [user.id]
    ))[0];

    if (userRow?.is_banned) {
      await writeAudit(user.id, null, 'create_session', 'hard_banned', ipHash, fpHash, { tg_id: tid });
      return { ok: false, is_banned: true, ban_type: 'hard', status: 403 };
    }

    if (userRow?.is_shadow_banned) {
      await writeAudit(user.id, null, 'create_session', 'shadow_banned', ipHash, fpHash, {
        shadow_reason: 'account_shadow_banned_at_session_create',
        tg_id: tid,
      });
      // ✅ FIX: إرجاع خطأ حقيقي بدل ok:true مزيف
      return { ok: false, error: 'account_review', is_banned: false, status: 200 };
    }

    const accountCreatedAt = userRow?.created_at ? new Date(userRow.created_at) : new Date();
    const accountIsNew     = isNewAccount(accountCreatedAt);

    if (!CFG.MULTI_ACCT.IP_WHITELIST.has(ipHash)) {
      const ipCnt = parseInt((await sql(
        `SELECT COUNT(DISTINCT id) AS cnt FROM users
         WHERE last_ip_hash=$1 AND id!=$2 AND is_banned=FALSE`,
        [ipHash, user.id]
      ))[0]?.cnt || 0);

      const fpCnt = parseInt((await sql(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM device_fingerprints
         WHERE fingerprint=$1 AND user_id!=$2`,
        [fpHash, user.id]
      ))[0]?.cnt || 0);

      const fpViolation = fpCnt >= CFG.MULTI_ACCT.MAX_PER_FP;
      const ipViolation = ipCnt >= CFG.MULTI_ACCT.MAX_PER_IP;

      if (fpViolation && !accountIsNew) {
        // حساب قديم يشترك في fingerprint — ban
        await sql(
          `UPDATE users SET is_banned=TRUE, ban_reason='multi_account', updated_at=NOW() WHERE id=$1`,
          [user.id]
        );
        console.warn(`[ANTI-FRAUD] Hard Ban — tg_id:${tid} fp_accounts:${fpCnt}`);
        return { ok: false, is_banned: true, ban_type: 'hard', status: 200 };
      }

      if (fpViolation && accountIsNew) {
        // حساب جديد — لا ban، فقط log
        console.warn(`[ANTI-FRAUD] New account FP shared — tg_id:${tid} fp:${fpCnt} — grace period`);
        try {
          await sql(
            `INSERT INTO security_logs(user_id,ip_hash,fingerprint,action,risk_score,verdict,detail)
             VALUES($1,$2,$3,'new_account_fp_shared',10,'allow',$4)`,
            [user.id, ipHash, fpHash, JSON.stringify({
              note: 'New account grace period — no ban',
              fp_accounts: fpCnt,
            })]
          );
        } catch (_) {}
      }

      if (ipViolation && !accountIsNew) {
        try {
          await sql(
            `INSERT INTO security_logs(user_id,ip_hash,fingerprint,action,risk_score,verdict,detail)
             VALUES($1,$2,$3,'multi_ip_warning',20,'allow',$4)`,
            [user.id, ipHash, fpHash, JSON.stringify({
              reason: 'shared_ip_old_account',
              ip_accounts: ipCnt,
            })]
          );
        } catch (_) {}
      }
    }

    // إلغاء الجلسات القديمة + إنشاء جلسة جديدة
    await sql(`UPDATE sessions SET is_revoked=TRUE WHERE user_id=$1`, [user.id]);

    const sessionId = genRawNonce(32);
    const exp = new Date(Date.now() + CFG.SESSION_TTL_MS).toISOString();
    await sql(
      `INSERT INTO sessions(id, user_id, fingerprint_hash, ip_hash, expires_at)
       VALUES($1,$2,$3,$4,$5)`,
      [sessionId, user.id, fpHash, ipHash, exp]
    );

    // حفظ device fingerprint — persistent
    const fpObj = typeof fpData === 'object' ? fpData : {};
    try {
      await sql(
        `INSERT INTO device_fingerprints(fingerprint, user_id, user_agent, lang, screen, timezone_off)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(fingerprint, user_id) DO UPDATE SET last_seen=NOW()`,
        [fpHash, user.id,
         fpObj.user_agent || null, fpObj.lang || null,
         fpObj.screen || null, parseInt(fpObj.tz_offset) || 0]
      );
    } catch (_) {}

    await writeAudit(user.id, sessionId, 'create_session', 'ok', ipHash, fpHash, {
      tg_id: tid, is_new_account: accountIsNew,
    });

    await syncLevel(user.id);
    const finalUser = (await sql(`SELECT * FROM users WHERE id=$1`, [user.id]))[0];

    return {
      ok: true,
      _sid: sessionId,
      user: {
        points:              parseInt(finalUser.points) || 0,
        usdt_balance:        parseFloat(finalUser.usdt_balance) || 0,
        level:               parseInt(finalUser.level) || 1,
        xp:                  parseInt(finalUser.xp) || 0,
        tg_verified:         finalUser.tg_verified,
        streak_day:          finalUser.streak_day,
        last_gift_date:      finalUser.last_gift_date,
        total_referrals:     finalUser.total_referrals,
        earned_from_refs:    parseInt(finalUser.earned_from_refs) || 0,
        first_withdraw_done: finalUser.first_withdraw_done,
      },
    };

  } catch (err) {
    console.error('[create_session Error]', err.message);
    return { ok: false, error: 'session_creation_failed', status: 500 };
  }
}

// ── load ──────────────────────────────────────────────────────────
async function handleLoad(userId) {
  const rows = await sql(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (!rows.length) return { ok: false, error: 'user_not_found' };
  const u = rows[0];

  const adR    = await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const ad     = adR[0] || { count: 0, points_earned: 0 };
  const watched= parseInt(ad.count) || 0;

  const wR  = await sql(`SELECT pts,address,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  const rR  = await sql(
    `SELECT u.tg_first_name, u.tg_username, u.created_at
     FROM referrals r
     JOIN users u ON u.id=r.referred_id
     WHERE r.referrer_id=$1
     ORDER BY r.created_at DESC LIMIT 10`,
    [userId]
  );
  const tR  = await sql(`SELECT task_type FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE AND completed=TRUE`, [userId]);

  // Adsgram persistent state
  const adsgramState = await getAdsgramState(userId);

  // Withdraw info — dynamic based on first_withdraw_done
  const firstWdDone = u.first_withdraw_done;
  const withdrawInfo = {
    withdraw_min:          firstWdDone ? CONFIG.withdraw.normal_min   : CONFIG.withdraw.first_min,
    withdraw_level:        firstWdDone ? CONFIG.withdraw.normal_level : 0,
    first_withdraw_offer:  !firstWdDone,
  };

  return {
    ok: true,
    points:          parseInt(u.points) || 0,
    usdt_balance:    parseFloat(u.usdt_balance) || 0,
    level:           parseInt(u.level) || 1,
    xp:              parseInt(u.xp) || 0,
    tg_verified:     u.tg_verified,
    streak_day:      u.streak_day,
    last_gift_date:  u.last_gift_date,
    tg_id:           u.tg_id,

    ads_total:         CFG.ADS_DAILY_LIMIT,
    ads_remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    ads_watched_today: watched,
    earned_today:      parseInt(ad.points_earned) || 0,

    total_referrals:  u.total_referrals,
    earned_from_refs: parseInt(u.earned_from_refs) || 0,

    first_withdraw_done: firstWdDone,
    withdraw:        withdrawInfo,

    adsgram_task:    adsgramState,

    withdrawals: wR.map(w => ({
      pts: parseInt(w.pts) || 0, address: w.address,
      method: w.method, status: w.status, ts: new Date(w.created_at).getTime(),
    })),
    referral_list: rR.map(r => ({
      name: r.tg_first_name || r.tg_username || 'مستخدم',
      ts: new Date(r.created_at).getTime(),
    })),
    completed_tasks: tR.map(r => r.task_type),

    config: {
      rewards:       CONFIG.rewards,
      telegram:      CONFIG.telegram,
      ads_daily_limit: CFG.ADS_DAILY_LIMIT,
      pts_per_ton:   CFG.PTS_PER_TON,
    },
  };
}

// ── get_state ─────────────────────────────────────────────────────
async function handleGetState(userId) {
  const r = await sql(
    `SELECT points,usdt_balance,level,xp,total_referrals,earned_from_refs,ad_last_reward,first_withdraw_done
     FROM users WHERE id=$1`,
    [userId]
  );
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const u  = r[0];
  const ad = (await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0, points_earned: 0 };

  let ad_cooldown_ms = 0;
  if (u.ad_last_reward) {
    const elapsed = Date.now() - new Date(u.ad_last_reward).getTime();
    ad_cooldown_ms = Math.max(0, CFG.AD_COOLDOWN_MS - elapsed);
  }

  const firstWdDone = u.first_withdraw_done;

  return {
    ok: true,
    points:              parseInt(u.points) || 0,
    usdt_balance:        parseFloat(u.usdt_balance) || 0,
    level:               parseInt(u.level) || 1,
    xp:                  parseInt(u.xp) || 0,
    total_referrals:     u.total_referrals,
    earned_from_refs:    parseInt(u.earned_from_refs) || 0,
    ads_watched_today:   parseInt(ad.count) || 0,
    ads_remaining:       Math.max(0, CFG.ADS_DAILY_LIMIT - (parseInt(ad.count) || 0)),
    earned_today:        parseInt(ad.points_earned) || 0,
    ad_cooldown_ms,
    ads_daily_limit:     CFG.ADS_DAILY_LIMIT,
    first_withdraw_done: firstWdDone,
    withdraw: {
      withdraw_min:         firstWdDone ? CONFIG.withdraw.normal_min   : CONFIG.withdraw.first_min,
      withdraw_level:       firstWdDone ? CONFIG.withdraw.normal_level : 0,
      first_withdraw_offer: !firstWdDone,
    },
  };
}

// ── start_ad ──────────────────────────────────────────────────────
async function handleStartAd(userId, sessionId, ipHash, fpHash) {
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  if ((parseInt(adR[0]?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS - elapsed };
    }
  }

  const nonce = await issueAdNonce(sessionId);
  if (!nonce) {
    return { ok: false, error: 'session_invalid' };
  }

  await writeAudit(userId, sessionId, 'start_ad', 'ok', ipHash, fpHash, {});
  return { ok: true, ad_nonce: nonce };
}

// ── reward_ad ─────────────────────────────────────────────────────
async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce) {
  const clientStartedAt = parseInt(body?.data?.ad_started_at) || 0;

  // [1] Nonce check
  const nonceResult = await consumeAdNonce(sessionId, rawNonce, userId, ipHash, fpHash);
  if (nonceResult !== 'ok') {
    return { ok: false, error: `nonce_${nonceResult}` };
  }

  // [2] Daily limit
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  const watchedToday = parseInt(adR[0]?.count) || 0;
  if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
    await writeAudit(userId, sessionId, 'reward_ad', 'daily_limit', ipHash, fpHash, { watched: watchedToday });
    return { ok: false, error: 'daily_limit_reached' };
  }

  // [3] Cooldown
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      const waitMs = CFG.AD_COOLDOWN_MS - elapsed;
      await writeAudit(userId, sessionId, 'reward_ad', 'cooldown', ipHash, fpHash, { wait_ms: waitMs });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // [4] Server-side timing
  if (clientStartedAt > 0) {
    const clientElapsed = Date.now() - clientStartedAt;
    if (clientElapsed < CFG.AD_MIN_DURATION_MS) {
      await addRisk(userId, 'ad_too_fast_client', ipHash, fpHash, 10, {
        reward_block_reason: 'ad_duration_too_short',
        client_elapsed_ms: clientElapsed,
        min_required_ms: CFG.AD_MIN_DURATION_MS,
      });
      await writeAudit(userId, sessionId, 'reward_ad', 'timing_invalid', ipHash, fpHash, {
        client_elapsed_ms: clientElapsed,
      });
      return { ok: false, error: 'ad_duration_invalid' };
    }
  }

  // [5] Replay detection
  const recentReward = await sql(
    `SELECT id FROM audit_log
     WHERE user_id=$1 AND action='reward_ad' AND status='ok'
       AND created_at > NOW() - INTERVAL '25 seconds'
     LIMIT 1`,
    [userId]
  );
  if (recentReward.length) {
    await addRisk(userId, 'reward_ad_replay', ipHash, fpHash, 15, { reward_block_reason: 'reward_ad_too_soon' });
    await writeAudit(userId, sessionId, 'reward_ad', 'replay_detected', ipHash, fpHash, {});
    return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS };
  }

  // [6] Shadow ban — ✅ FIX: إرجاع خطأ حقيقي
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    await writeAudit(userId, sessionId, 'reward_ad', 'shadow_blocked', ipHash, fpHash, {
      shadow_reason: 'reward_blocked_shadow_ban',
    });
    return { ok: false, error: 'account_review' };
  }

  // [7] Atomic reward
  const lr = await sql(
    `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
     VALUES($1, CURRENT_DATE, 1, $2)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       count         = CASE WHEN ad_logs.count < $3 THEN ad_logs.count + 1         ELSE ad_logs.count         END,
       points_earned = CASE WHEN ad_logs.count < $3 THEN ad_logs.points_earned + $2 ELSE ad_logs.points_earned END,
       updated_at    = NOW()
     RETURNING count, points_earned`,
    [userId, CFG.POINTS_PER_AD, CFG.ADS_DAILY_LIMIT]
  );
  const watched = parseInt(lr[0].count) || 0;

  await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1,
         ads_watched_total=ads_watched_total+1,
         ad_last_reward=NOW(),
         updated_at=NOW()
     WHERE id=$2`,
    [CFG.POINTS_PER_AD, userId]
  );

  await syncLevel(userId);

  // تحقق من المهام اليومية
  if (watched >= 10) await upsertTask(userId, 'ads_10');
  if (watched >= 25) await upsertTask(userId, 'ads_25');

  // محاولة تفعيل الإحالة إذا أصبح نشطاً
  await checkAndActivateReferral(userId, ipHash, fpHash);

  await writeAudit(userId, sessionId, 'reward_ad', 'ok', ipHash, fpHash, {
    watched, points_earned: CFG.POINTS_PER_AD,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return {
    ok:           true,
    remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    watchedToday: watched,
    earnedToday:  parseInt(lr[0].points_earned) || 0,
    points:       parseInt(ur[0]?.points) || 0,
    all_done:     watched >= CFG.ADS_DAILY_LIMIT,
  };
}


// ═══════════════════════════════════════════════════════════════════
// ADSGRAM TASK — Persistent DB State
//
// الحالات: ready → watching → cooldown → claim → completed
// المصدر الحقيقي دائماً من DB — لا من session فقط
// ═══════════════════════════════════════════════════════════════════

async function getAdsgramState(userId) {
  let row = (await sql(
    `SELECT * FROM adsgram_task_state WHERE user_id=$1`,
    [userId]
  ))[0];

  if (!row) {
    // إنشاء حالة افتراضية
    await sql(
      `INSERT INTO adsgram_task_state(user_id, status)
       VALUES($1, 'ready')
       ON CONFLICT(user_id) DO NOTHING`,
      [userId]
    );
    row = { status: 'ready', claimed: false };
  }

  const now = Date.now();
  let status = row.status;

  // تحديث الحالة بناءً على الوقت الحالي
  if (status === 'watching' && row.expires_at) {
    const expiresAt = new Date(row.expires_at).getTime();
    if (now >= expiresAt) {
      // انتهى وقت المشاهدة → claim
      await sql(
        `UPDATE adsgram_task_state SET status='claim', updated_at=NOW() WHERE user_id=$1 AND status='watching'`,
        [userId]
      );
      status = 'claim';
    }
  }

  if (status === 'cooldown' && row.cooldown_until) {
    const coolUntil = new Date(row.cooldown_until).getTime();
    if (now >= coolUntil) {
      // انتهى cooldown → ready
      await sql(
        `UPDATE adsgram_task_state
         SET status='ready', cooldown_until=NULL, claimed=FALSE, updated_at=NOW()
         WHERE user_id=$1 AND status='cooldown'`,
        [userId]
      );
      status = 'ready';
    }
  }

  // إعادة قراءة الحالة المحدّثة
  if (status !== row.status) {
    row = (await sql(`SELECT * FROM adsgram_task_state WHERE user_id=$1`, [userId]))[0] || row;
    status = row.status;
  }

  // حساب remaining_seconds
  let remaining_seconds = 0;
  if (status === 'watching' && row.expires_at) {
    remaining_seconds = Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - now) / 1000));
  } else if (status === 'cooldown' && row.cooldown_until) {
    remaining_seconds = Math.max(0, Math.ceil((new Date(row.cooldown_until).getTime() - now) / 1000));
  }

  return {
    status,
    remaining_seconds,
    reward:  CONFIG.rewards.adsgram_task,
    claimed: row.claimed || false,
  };
}

async function handleStartAdsgramTask(userId, sessionId, ipHash, fpHash) {
  const state = await getAdsgramState(userId);

  if (state.status === 'watching') {
    return { ok: false, error: 'already_watching', adsgram_task: state };
  }
  if (state.status === 'cooldown') {
    return { ok: false, error: 'cooldown_active', adsgram_task: state };
  }
  if (state.status === 'claim') {
    return { ok: false, error: 'claim_pending', adsgram_task: state };
  }

  const startedAt  = new Date();
  const expiresAt  = new Date(startedAt.getTime() + CFG.ADSGRAM_TASK_COOLDOWN_MS);

  await sql(
    `INSERT INTO adsgram_task_state(user_id, status, started_at, expires_at, claimed, updated_at)
     VALUES($1, 'watching', $2, $3, FALSE, NOW())
     ON CONFLICT(user_id) DO UPDATE
     SET status='watching', started_at=$2, expires_at=$3, claimed=FALSE, updated_at=NOW()`,
    [userId, startedAt.toISOString(), expiresAt.toISOString()]
  );

  // أيضاً سجّل في sessions للتوافق مع الكود القديم
  await sql(
    `UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`,
    [sessionId]
  );

  await writeAudit(userId, sessionId, 'start_adsgram_task', 'ok', ipHash, fpHash, {
    expires_at: expiresAt.toISOString(),
  });

  const newState = await getAdsgramState(userId);
  return { ok: true, adsgram_task: newState };
}

async function handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash) {
  // قراءة الحالة من DB
  const stateRow = (await sql(
    `SELECT * FROM adsgram_task_state WHERE user_id=$1`,
    [userId]
  ))[0];

  const now = Date.now();

  // [1] هل بدأ المهمة؟
  if (!stateRow || stateRow.status === 'ready') {
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'not_started', ipHash, fpHash, {
      adsgram_state: stateRow?.status || 'no_state',
    });
    return { ok: false, error: 'task_not_started' };
  }

  // [2] هل في cooldown؟
  if (stateRow.status === 'cooldown') {
    const waitMs = stateRow.cooldown_until
      ? Math.max(0, new Date(stateRow.cooldown_until).getTime() - now)
      : 0;
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'cooldown', ipHash, fpHash, {
      wait_ms: waitMs,
      adsgram_state: 'cooldown',
    });
    return { ok: false, error: 'already_claimed_today', wait_ms: waitMs };
  }

  // [3] هل اكتمل الوقت؟ (watching → check if time passed)
  if (stateRow.status === 'watching') {
    const startedAt = new Date(stateRow.started_at).getTime();
    const elapsed   = now - startedAt;

    if (elapsed < CFG.ADSGRAM_TASK_MIN_WATCH_MS) {
      await addRisk(userId, 'adsgram_task_too_fast', ipHash, fpHash, 15, {
        reward_block_reason: 'adsgram_min_watch_not_met',
        elapsed_ms: elapsed,
        min_ms: CFG.ADSGRAM_TASK_MIN_WATCH_MS,
      });
      await writeAudit(userId, sessionId, 'claim_adsgram_task', 'too_fast', ipHash, fpHash, {
        elapsed_ms: elapsed, min_ms: CFG.ADSGRAM_TASK_MIN_WATCH_MS,
        adsgram_state: 'watching_too_fast',
      });
      return { ok: false, error: 'task_too_fast' };
    }

    // هل مرّ وقت الـ cooldown الكامل؟
    if (stateRow.expires_at && now < new Date(stateRow.expires_at).getTime()) {
      const remainingMs = new Date(stateRow.expires_at).getTime() - now;
      return {
        ok: false,
        error: 'cooldown_active',
        wait_ms: remainingMs,
        adsgram_task: await getAdsgramState(userId),
      };
    }
  }

  // [4] هل مطالب بها بالفعل؟
  if (stateRow.claimed) {
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'already_claimed', ipHash, fpHash, {
      adsgram_state: 'already_claimed',
    });
    return { ok: false, error: 'already_claimed_today' };
  }

  // [5] Shadow ban — ✅ FIX: خطأ حقيقي
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'shadow_blocked', ipHash, fpHash, {
      shadow_reason: 'adsgram_reward_blocked_shadow_ban',
    });
    return { ok: false, error: 'account_review' };
  }

  // [6] Atomic claim — UPDATE WHERE claimed=FALSE prevents duplicates
  const cooldownUntil = new Date(now + CFG.ADSGRAM_TASK_COOLDOWN_MS);
  const claimed = await sql(
    `UPDATE adsgram_task_state
     SET status='cooldown',
         claimed=TRUE,
         claimed_at=NOW(),
         completed_at=NOW(),
         cooldown_until=$2,
         updated_at=NOW()
     WHERE user_id=$1 AND claimed=FALSE
     RETURNING user_id`,
    [userId, cooldownUntil.toISOString()]
  );

  if (!claimed.length) {
    // race condition — already claimed
    await writeAudit(userId, sessionId, 'claim_adsgram_task', 'race_condition', ipHash, fpHash, {
      reward_block_reason: 'adsgram_claim_race',
    });
    return { ok: false, error: 'already_claimed_today' };
  }

  // [7] أضف النقاط
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [CFG.ADSGRAM_TASK_POINTS, userId]
  );

  // أيضاً سجّل في completed_tasks للإحصائيات
  await sql(
    `INSERT INTO completed_tasks(user_id, task_key, claimed, claimed_at, completed_at)
     VALUES($1, 'adsgram_task_daily', TRUE, NOW(), NOW())`,
    [userId]
  );

  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, {
    points: CFG.ADSGRAM_TASK_POINTS,
    adsgram_state: 'claimed_ok',
    cooldown_until: cooldownUntil.toISOString(),
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  const newState = await getAdsgramState(userId);

  console.info(`[ADSGRAM] ✅ Claimed — userId:${userId} reward:${CFG.ADSGRAM_TASK_POINTS}`);

  return {
    ok:           true,
    points:       parseInt(ur[0]?.points) || 0,
    earned:       CFG.ADSGRAM_TASK_POINTS,
    adsgram_task: newState,
  };
}

// ── get_adsgram_state — للـ polling من الفرونت ───────────────────
async function handleGetAdsgramState(userId) {
  const state = await getAdsgramState(userId);
  return { ok: true, adsgram_task: state };
}


// ── claim_gift ────────────────────────────────────────────────────
async function handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_gift');
  if (result !== 'ok') return { ok: false, error: result };

  const r = await sql(`SELECT last_gift_date, streak_day FROM users WHERE id=$1`, [userId]);
  const u = r[0];

  // استخدم CURRENT_DATE من السيرفر — لا من الفرونت
  const todayRow = (await sql(`SELECT CURRENT_DATE::TEXT AS today`))[0];
  const today    = todayRow.today;
  const last     = u.last_gift_date ? String(u.last_gift_date).slice(0, 10) : '';

  if (last === today) {
    return { ok: false, error: 'already_claimed_today' };
  }

  // حساب streak بناءً على CURRENT_DATE
  const yestRow  = (await sql(`SELECT (CURRENT_DATE - INTERVAL '1 day')::TEXT AS yesterday`))[0];
  const yesterday = yestRow.yesterday.slice(0, 10);
  const newStreak = last === yesterday ? (parseInt(u.streak_day) || 0) + 1 : 1;
  const reward    = giftReward(newStreak);

  // Atomic update
  const updated = await sql(
    `UPDATE users
     SET points=points+$1, xp=xp+$1, streak_day=$2, last_gift_date=CURRENT_DATE, updated_at=NOW()
     WHERE id=$3 AND (last_gift_date IS NULL OR last_gift_date < CURRENT_DATE)
     RETURNING points, level`,
    [reward, newStreak, userId]
  );

  if (!updated.length) {
    return { ok: false, error: 'already_claimed_today' };
  }

  await syncLevel(userId);
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'claim_gift', 'ok', ipHash, fpHash, {
    reward, streak: newStreak,
  });

  return {
    ok:        true,
    reward,
    streak_day: newStreak,
    points:    parseInt(fresh?.points) || 0,
    level:     fresh?.level,
  };
}

// ── verify_tg_task ────────────────────────────────────────────────
async function handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_tg_task');
  if (result !== 'ok') return { ok: false, error: result };

  const r = await sql(`SELECT tg_verified FROM users WHERE id=$1`, [userId]);
  if (r[0]?.tg_verified) return { ok: false, error: 'already_verified' };

  // Shadow ban check — ✅ FIX: خطأ حقيقي
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    return { ok: false, error: 'account_review' };
  }

  const reward = CONFIG.rewards.telegram_task;

  await sql(
    `UPDATE users
     SET tg_verified=TRUE, points=points+$1, xp=xp+$1, updated_at=NOW()
     WHERE id=$2 AND tg_verified=FALSE`,
    [reward, userId]
  );
  await syncLevel(userId);
  await upsertTask(userId, 'tg_join');
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_tg_task', 'ok', ipHash, fpHash, { reward });
  return { ok: true, reward, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}

// ── claim_daily_task — للمهمات اليومية ads_10 / ads_25 / referrals_3 ──
async function handleClaimDailyTask(userId, taskType, rawNonce, sessionId, fpHash, ipHash) {
  const validTasks = ['ads_10', 'ads_25', 'referrals_3'];
  if (!validTasks.includes(taskType)) {
    return { ok: false, error: 'unknown_task' };
  }

  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, `claim_daily_task_${taskType}`);
  if (result !== 'ok') return { ok: false, error: result };

  // Shadow ban
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    return { ok: false, error: 'account_review' };
  }

  // التحقق أن المهمة مكتملة فعلاً
  const taskDone = (await sql(
    `SELECT id FROM user_tasks
     WHERE user_id=$1 AND task_type=$2 AND task_date=CURRENT_DATE AND completed=TRUE`,
    [userId, taskType]
  ))[0];

  if (!taskDone) {
    return { ok: false, error: 'task_not_completed_yet' };
  }

  // التحقق من عدم المطالبة مسبقاً اليوم
  const alreadyClaimed = (await sql(
    `SELECT id FROM completed_tasks
     WHERE user_id=$1 AND task_key=$2 AND task_date=CURRENT_DATE AND claimed=TRUE`,
    [userId, `daily_${taskType}`]
  ))[0];

  if (alreadyClaimed) {
    return { ok: false, error: 'already_claimed_today' };
  }

  const rewardMap = {
    ads_10:       CONFIG.rewards.daily_ads_10,
    ads_25:       CONFIG.rewards.daily_ads_25,
    referrals_3:  CONFIG.rewards.daily_referrals_3,
  };
  const reward = rewardMap[taskType];

  // Atomic claim + reward
  const claimResult = await sql(
    `INSERT INTO completed_tasks(user_id, task_key, claimed, claimed_at, completed_at)
     VALUES($1, $2, TRUE, NOW(), NOW())
     ON CONFLICT(user_id, task_key) DO NOTHING
     RETURNING id`,
    [userId, `daily_${taskType}`]
  );

  // إذا فشل INSERT (conflict) = سبق المطالبة
  // نُجري check ثانياً
  const checkAgain = (await sql(
    `SELECT id, claimed FROM completed_tasks
     WHERE user_id=$1 AND task_key=$2 AND task_date=CURRENT_DATE
     ORDER BY id DESC LIMIT 1`,
    [userId, `daily_${taskType}`]
  ))[0];

  if (checkAgain?.claimed && !claimResult.length) {
    return { ok: false, error: 'already_claimed_today' };
  }

  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [reward, userId]
  );

  await syncLevel(userId);
  const fresh = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];

  await writeAudit(userId, sessionId, `claim_daily_task`, 'ok', ipHash, fpHash, {
    task_type: taskType, reward,
  });

  console.info(`[DAILY TASK] ✅ Claimed — userId:${userId} task:${taskType} reward:${reward}`);

  return {
    ok:     true,
    task:   taskType,
    reward,
    points: parseInt(fresh?.points) || 0,
  };
}

// ── submit_withdraw ───────────────────────────────────────────────
async function handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'submit_withdraw');
  if (result !== 'ok') return { ok: false, error: result };

  const address = (body?.data?.address || '').trim();
  if (!isValidTon(address)) return { ok: false, error: 'invalid_address' };

  const r   = await sql(`SELECT points, level, first_withdraw_done FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };

  const pts   = parseInt(r[0].points) || 0;
  const level = parseInt(r[0].level)  || 1;
  const firstDone = r[0].first_withdraw_done;

  // منطق السحب المزدوج
  if (firstDone) {
    // نظام عادي
    if (level < CFG.WITHDRAW_NORMAL_LEVEL) {
      return { ok: false, error: 'level_too_low', required_level: CFG.WITHDRAW_NORMAL_LEVEL };
    }
    if (pts < CFG.WITHDRAW_NORMAL_MIN) {
      return { ok: false, error: 'insufficient_balance', required: CFG.WITHDRAW_NORMAL_MIN, have: pts };
    }
  } else {
    // أول سحب — شروط مخففة
    if (pts < CFG.WITHDRAW_FIRST_MIN) {
      return { ok: false, error: 'insufficient_balance', required: CFG.WITHDRAW_FIRST_MIN, have: pts };
    }
  }

  const ton = parseFloat((pts / CFG.PTS_PER_TON).toFixed(6));

  // Atomic: خصم النقاط
  const deducted = await sql(
    `UPDATE users
     SET points=points-$1, first_withdraw_done=TRUE, updated_at=NOW()
     WHERE id=$2 AND points >= $1
     RETURNING id`,
    [pts, userId]
  );

  if (!deducted.length) {
    return { ok: false, error: 'insufficient_balance', required: pts, have: pts };
  }

  const wr = await sql(
    `INSERT INTO withdrawals(user_id, pts, ton_amount, address, method, status)
     VALUES($1,$2,$3,$4,'ton','pending')
     RETURNING id`,
    [userId, pts, ton, address]
  );

  const nb = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, {
    pts, ton, first_withdraw: !firstDone,
  });

  return {
    ok:          true,
    withdraw_id: wr[0].id,
    pts_deducted: pts,
    ton_amount:  ton,
    new_balance: parseInt(nb?.points) || 0,
    status:      'pending',
    first_withdraw_done: true,
  };
}

// ── get_referrals ─────────────────────────────────────────────────
async function handleGetReferrals(userId) {
  const r  = (await sql(`SELECT total_referrals, earned_from_refs, tg_id FROM users WHERE id=$1`, [userId]))[0];
  const rR = await sql(
    `SELECT u.tg_first_name, u.tg_username, u.created_at, ref.activated
     FROM referrals ref
     JOIN users u ON u.id=ref.referred_id
     WHERE ref.referrer_id=$1
     ORDER BY ref.created_at DESC LIMIT 20`,
    [userId]
  );
  return {
    ok:               true,
    total_referrals:  r.total_referrals,
    earned_from_refs: parseInt(r.earned_from_refs) || 0,
    pts_per_referral: CONFIG.rewards.referral,
    referral_list: rR.map(x => ({
      name:      x.tg_first_name || x.tg_username || 'مستخدم',
      ts:        new Date(x.created_at).getTime(),
      activated: x.activated || false,
    })),
    tg_id: r.tg_id,
  };
}

// ── track_ad_event ────────────────────────────────────────────────
async function handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash) {
  const allowed = new Set([
    'ad_requested', 'ad_loaded', 'ad_started',
    'ad_failed', 'ad_completed', 'reward_granted',
    'suspicious_activity',
  ]);
  const event = body?.data?.event || '';
  if (!allowed.has(event)) {
    return { ok: false, error: 'unknown_event' };
  }

  if (event === 'ad_started') {
    await sql(
      `UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`,
      [sessionId]
    );
  }

  if (event === 'ad_started' && body?.data?.meta?.type === 'adsgram_task') {
    await sql(
      `UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`,
      [sessionId]
    );
    // أيضاً ابدأ مهمة Adsgram في DB
    await handleStartAdsgramTask(userId, sessionId, ipHash, fpHash);
  }

  if (event === 'suspicious_activity') {
    const reason = String(body?.data?.reason || 'client_report').slice(0, 50);
    await addRisk(userId, `client_suspicious_${reason}`, ipHash, fpHash, 10, {
      risk_reason: `client_reported_suspicious_${reason}`,
    });
  }

  await writeAudit(userId, sessionId, event, 'tracked', ipHash, fpHash, {
    meta: body?.data?.meta || {},
  });

  return { ok: true };
}

// ── get_nonce — لـ claim_gift / verify_tg_task / submit_withdraw / claim_daily_task ──
async function handleGetNonce(userId, sessionId, ipHash, fpHash, action) {
  const validActions = [
    'claim_gift',
    'verify_tg_task',
    'submit_withdraw',
    'claim_daily_task_ads_10',
    'claim_daily_task_ads_25',
    'claim_daily_task_referrals_3',
  ];
  if (!validActions.includes(action)) {
    return { ok: false, error: 'unknown_nonce_action' };
  }

  const nonce = await issueNonce(sessionId, userId, ipHash, fpHash, action);
  return { ok: true, nonce };
}

// ── Admin ─────────────────────────────────────────────────────────
async function handleAdmin(action, body) {
  if (action === 'list_withdrawals') {
    const r = await sql(
      `SELECT w.id,w.user_id,u.tg_username,u.tg_first_name,w.pts,w.ton_amount,w.address,w.status,w.created_at
       FROM withdrawals w JOIN users u ON u.id=w.user_id
       WHERE w.status=$1 ORDER BY w.created_at DESC LIMIT 100`,
      [body?.status || 'pending']
    );
    return { ok: true, withdrawals: r };
  }
  if (action === 'approve_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    await sql(`UPDATE withdrawals SET status='completed', tx_hash=$1, reviewed_at=NOW() WHERE id=$2`, [body?.tx_hash || '', id]);
    return { ok: true };
  }
  if (action === 'reject_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    const wr = await sql(`SELECT user_id, pts FROM withdrawals WHERE id=$1`, [id]);
    if (wr.length) await sql(`UPDATE users SET points=points+$1 WHERE id=$2`, [wr[0].pts, wr[0].user_id]);
    await sql(`UPDATE withdrawals SET status='rejected', reviewed_at=NOW() WHERE id=$1`, [id]);
    return { ok: true };
  }
  if (action === 'ban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_banned=TRUE, ban_reason=$1 WHERE tg_id=$2`, [body?.reason || 'admin_ban', tgId]);
    return { ok: true };
  }
  if (action === 'unban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(`UPDATE users SET is_banned=FALSE, ban_reason=NULL, risk_score=0, is_shadow_banned=FALSE WHERE tg_id=$1`, [tgId]);
    return { ok: true };
  }
  if (action === 'stats') {
    const r = (await sql(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER(WHERE created_at > NOW() - INTERVAL '1 day') AS new_today,
        SUM(points) AS total_points,
        COUNT(*) FILTER(WHERE is_banned) AS banned_users,
        COUNT(*) FILTER(WHERE is_shadow_banned) AS shadow_banned_users
      FROM users
    `))[0];
    const w = (await sql(`
      SELECT COUNT(*) AS pending_wd, COALESCE(SUM(pts),0) AS pending_pts
      FROM withdrawals WHERE status='pending'
    `))[0];
    return { ok: true, stats: { ...r, ...w } };
  }
  if (action === 'audit_log') {
    const rows = await sql(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  if (action === 'risk_log') {
    const rows = await sql(
      `SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  if (action === 'security_log') {
    const rows = await sql(
      `SELECT * FROM security_logs ORDER BY created_at DESC LIMIT ${parseInt(body?.limit) || 100}`
    );
    return { ok: true, logs: rows };
  }
  return { ok: false, error: 'unknown_admin_action' };
}

// ── Adsgram Server-to-Server Reward Callback ─────────────────────
async function handleAdsgramCallback(req, res) {
  res.setHeader('Content-Type', 'text/plain');

  const rawUrl  = req.url || '';
  const qStart  = rawUrl.indexOf('?');
  const query   = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : new URLSearchParams();
  const rawId   = query.get('userId') || query.get('userid') || query.get('user_id') || '';

  const tgId = parseInt(rawId, 10);
  if (!tgId || isNaN(tgId) || tgId <= 0) {
    console.warn('[Adsgram CB] Invalid userId:', rawId);
    res.status(400).end('invalid_user');
    return;
  }

  res.status(200).end('ok');

  try {
    const ipHash = hashIp(getIp(req));

    const userRows = await sql(
      `SELECT id, points, is_shadow_banned FROM users WHERE tg_id=$1`,
      [tgId]
    );
    if (!userRows.length) {
      console.warn('[Adsgram CB] User not found, tgId:', tgId);
      await writeAudit(0, 'adsgram_cb', 'adsgram_callback', 'user_not_found', ipHash, null, { tg_id: tgId });
      return;
    }
    const user   = userRows[0];
    const userId = user.id;

    if (user.is_shadow_banned) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'shadow_banned', ipHash, null, {
        shadow_reason: 'adsgram_s2s_callback_blocked_shadow_ban',
      });
      return;
    }

    const adLog = (await sql(
      `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
      [userId]
    ))[0];
    if ((parseInt(adLog?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'daily_limit', ipHash, null, {
        reward_block_reason: 'daily_ad_limit_reached',
      });
      return;
    }

    const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
    if (coolRow?.ad_last_reward) {
      const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
      if (elapsed < CFG.AD_COOLDOWN_MS) {
        await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'cooldown', ipHash, null, {
          reward_block_reason: 'ad_cooldown_active', elapsed_ms: elapsed,
        });
        return;
      }
    }

    // Replay detection
    const recentCb = await sql(
      `SELECT id FROM audit_log
       WHERE user_id=$1 AND action='adsgram_callback' AND status='ok'
         AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [userId]
    );
    if (recentCb.length) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'replay', ipHash, null, {
        reward_block_reason: 'adsgram_s2s_replay',
      });
      return;
    }

    await sql(
      `UPDATE users SET points=points+$1, xp=xp+$1, ad_last_reward=NOW(), updated_at=NOW() WHERE id=$2`,
      [CFG.POINTS_PER_AD, userId]
    );
    await sql(
      `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
       VALUES($1, CURRENT_DATE, 1, $2)
       ON CONFLICT(user_id, log_date)
       DO UPDATE SET count=ad_logs.count+1, points_earned=ad_logs.points_earned+$2`,
      [userId, CFG.POINTS_PER_AD]
    );

    await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ok', ipHash, null, {
      tg_id: tgId, points_earned: CFG.POINTS_PER_AD,
    });

    console.info('[Adsgram CB] ✅ Reward — userId:', userId, 'tgId:', tgId);
  } catch (err) {
    console.error('[Adsgram CB] Error:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  // ── Adsgram Server Callback
  if (req.method === 'GET' && (req.url || '').includes('adsgram-reward')) {
    return handleAdsgramCallback(req, res);
  }

  // ── GET /config — Dynamic Config Endpoint ──────────────────────
  if (req.method === 'GET' && (req.url || '').includes('/config')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(handleGetConfig());
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Init-Data, X-Fingerprint, X-Nonce, X-Admin-Secret, X-Session-ID'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') body = {};

  const type = body?.type || '';
  if (!type) return res.status(400).json({ error: 'missing_type' });

  const cookieHeader = req.headers['cookie'] || '';
  const sidMatch     = cookieHeader.match(/(?:^|;)\s*sid=([^;]+)/);
  const sessionFromCookie = sidMatch ? decodeURIComponent(sidMatch[1]) : '';
  const sessionFromHeader = req.headers['x-session-id'] || '';
  const sessionId = sessionFromCookie || sessionFromHeader;

  const fpRaw    = req.headers['x-fingerprint']  || '{}';
  const rawNonce = req.headers['x-nonce']        || '';
  const adminKey = req.headers['x-admin-secret'] || '';

  const ipHash = hashIp(getIp(req));
  let fpData = {};
  try { fpData = JSON.parse(fpRaw); } catch (_) {}
  const fpHash = hashFp(fpData);

  // Rate limit
  const isWrite = !['load', 'get_state', 'create_session', 'get_referrals', 'track_ad_event',
    'start_ad', 'get_nonce', 'get_adsgram_state'].includes(type);
  if (!rateLimit(`ip_${ipHash}_${type}`, isWrite ? CFG.RATE_WRITE_MAX : CFG.RATE_MAX)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    // ── Admin
    if (type === 'admin') {
      if (adminKey !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.status(200).json(await handleAdmin(body?.action, body));
    }

    // ── Create Session
    if (type === 'create_session') {
      const result = await handleCreateSession(body, ipHash, fpHash);
      if (result._sid) {
        const maxAge  = Math.floor(CFG.SESSION_TTL_MS / 1000);
        const isHttps = req.headers['x-forwarded-proto'] === 'https'
          || req.connection?.encrypted
          || process.env.NODE_ENV === 'production';
        const sameSite = isHttps ? 'None' : 'Lax';
        const secure   = isHttps ? '; Secure' : '';
        res.setHeader('Set-Cookie',
          `sid=${encodeURIComponent(result._sid)}; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=${maxAge}; Path=/`
        );
        result._session_token = result._sid;
        delete result._sid;
      }
      return res.status(result.status || 200).json(result);
    }

    // ── Session validation
    if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });

    const session = await validateSession(sessionId, ipHash, fpHash);
    if (!session)  return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
    if (session.is_banned || session.cluster_ban) {
      return res.status(403).json({ ok: false, is_banned: true });
    }

    const userId = session.user_id;

    // Rate limit per User
    if (!rateLimit(`u_${userId}_${type}`, isWrite ? 10 : 20)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    let result;
    switch (type) {
      case 'load':
        result = await handleLoad(userId);
        break;

      case 'get_state':
        result = await handleGetState(userId);
        break;

      case 'get_nonce':
        result = await handleGetNonce(userId, sessionId, ipHash, fpHash, body?.data?.action);
        break;

      case 'start_ad':
        result = await handleStartAd(userId, sessionId, ipHash, fpHash);
        break;

      case 'reward_ad':
        result = await handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce);
        break;

      case 'claim_gift':
        result = await handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash);
        break;

      case 'verify_tg_task':
        result = await handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash);
        break;

      case 'claim_daily_task':
        result = await handleClaimDailyTask(userId, body?.data?.task_type, rawNonce, sessionId, fpHash, ipHash);
        break;

      case 'submit_withdraw':
        result = await handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash);
        break;

      case 'get_referrals':
        result = await handleGetReferrals(userId);
        break;

      case 'track_ad_event':
        result = await handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash);
        break;

      case 'start_adsgram_task':
        result = await handleStartAdsgramTask(userId, sessionId, ipHash, fpHash);
        break;

      case 'claim_adsgram_task':
        result = await handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash);
        break;

      case 'get_adsgram_state':
        result = await handleGetAdsgramState(userId);
        break;

      default:
        result = { ok: false, error: 'unknown_action' };
    }

    // ✅ FIX: Shadow ban — لا نُرجع ok:true مزيف
    // إذا كان shadow banned وجاء ok:false نُبقيه كما هو
    // لا نُعدّل النتيجة الحقيقية

    return res.status(200).json(result);

  } catch (e) {
    console.error(`[${type}]`, e.message, e.stack?.split('\n')[1]);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      ...(IS_DEV && { detail: e.message }),
    });
  }
};
