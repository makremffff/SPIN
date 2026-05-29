'use strict';

const { neon } = require('@neondatabase/serverless');

// ── Lazy DB — آمن لـ Vercel Serverless ───────────────────────────
let _db = null;
function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _db = neon(url);
  }
  return _db;
}
async function sql(query, params = []) {
  return await getDb()(query, params);
}

// ── In-memory rate limit ──────────────────────────────────────────
const rateLimitMap = new Map();

// ═══════════════════════════════════════════════════════════════════
// BOOTSTRAP — يُشغَّل مرة واحدة عند أول request فقط
// ═══════════════════════════════════════════════════════════════════
let _bootstrapped = false;
let _bootstrapPromise = null;

async function _doBootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    await sql(`CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      tg_id BIGINT UNIQUE NOT NULL,
      tg_username TEXT, tg_first_name TEXT, tg_last_name TEXT,
      tg_language_code TEXT DEFAULT 'ar',
      tg_is_premium BOOLEAN DEFAULT FALSE,
      points BIGINT DEFAULT 0, level INT DEFAULT 1, xp BIGINT DEFAULT 0,
      usdt_balance NUMERIC(18,6) DEFAULT 0,
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
      adsgram_status TEXT DEFAULT 'ready',
      adsgram_started_at TIMESTAMPTZ,
      adsgram_expires_at TIMESTAMPTZ,
      adsgram_completed BOOLEAN DEFAULT FALSE,
      adsgram_claimed BOOLEAN DEFAULT FALSE,
      adsgram_last_claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      ad_nonce TEXT, ad_nonce_exp TIMESTAMPTZ,
      ad_nonce_used BOOLEAN DEFAULT FALSE,
      ad_started_at TIMESTAMPTZ,
      adsgram_task_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_active TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN DEFAULT FALSE
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS nonces (
      id BIGSERIAL PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      ip_hash TEXT, fp_hash TEXT, action TEXT,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT, session_id TEXT,
      action TEXT NOT NULL, status TEXT NOT NULL,
      ip_hash TEXT, fp_hash TEXT, meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS ad_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      log_date DATE NOT NULL DEFAULT CURRENT_DATE,
      count INT DEFAULT 0, points_earned BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, log_date)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL, pts BIGINT NOT NULL,
      ton_amount NUMERIC(18,6), address TEXT NOT NULL,
      method TEXT DEFAULT 'ton', status TEXT DEFAULT 'pending',
      tx_hash TEXT, notes TEXT,
      reviewed_at TIMESTAMPTZ, reviewed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS user_tasks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL, task_type TEXT NOT NULL,
      completed BOOLEAN DEFAULT FALSE, completed_at TIMESTAMPTZ,
      task_date DATE DEFAULT CURRENT_DATE,
      reward_claimed BOOLEAN DEFAULT FALSE,
      UNIQUE(user_id, task_type, task_date)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL, referred_id BIGINT NOT NULL,
      points_given BIGINT DEFAULT 0,
      activated BOOLEAN DEFAULT FALSE, activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(referred_id)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS risk_events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT, event_type TEXT NOT NULL,
      ip_hash TEXT, fp_hash TEXT, score_delta INT DEFAULT 0,
      meta JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS channels (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL, url TEXT NOT NULL,
      tg_chat_id TEXT DEFAULT NULL,
      reward INT DEFAULT 2500, max_members INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // إضافة tg_chat_id لقواعد البيانات الموجودة
    await sql(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS tg_chat_id TEXT DEFAULT NULL`);
    await sql(`
      INSERT INTO channels(title, url, reward, max_members, is_active, sort_order)
      SELECT 'قناة الربح عربي', 'https://t.me/botbababab', 2500, 0, TRUE, 0
      WHERE NOT EXISTS (SELECT 1 FROM channels LIMIT 1)
    `);
    await sql(`CREATE TABLE IF NOT EXISTS completed_tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL, task_key TEXT NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, task_key)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS device_fingerprints (
      fingerprint TEXT NOT NULL, user_id BIGINT NOT NULL,
      user_agent TEXT, lang TEXT, screen TEXT,
      timezone_off INT DEFAULT 0,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fingerprint, user_id)
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS user_photos (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      photo_url TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await sql(`CREATE TABLE IF NOT EXISTS security_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT, ip_hash TEXT, fingerprint TEXT,
      action TEXT NOT NULL, risk_score INT NOT NULL DEFAULT 0,
      verdict TEXT NOT NULL DEFAULT 'allow',
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const migrations = [
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce TEXT`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_nonce_used BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS ad_started_at TIMESTAMPTZ`,
      `ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS adsgram_task_started_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS ad_last_reward TIMESTAMPTZ`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS session_id TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS ip_hash TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS fp_hash TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS action  TEXT`,
      `ALTER TABLE nonces    ADD COLUMN IF NOT EXISTS used    BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS cluster_ban BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS last_ip_hash TEXT`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS first_withdraw_done BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS usdt_balance NUMERIC(18,6) DEFAULT 0`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_status TEXT DEFAULT 'ready'`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_started_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_expires_at TIMESTAMPTZ`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_completed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_claimed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS ad_next_cooldown_ms INTEGER DEFAULT 30000`,
      `ALTER TABLE users     ADD COLUMN IF NOT EXISTS adsgram_last_claimed_at TIMESTAMPTZ`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS activated BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`,
      `ALTER TABLE user_tasks ADD COLUMN IF NOT EXISTS reward_claimed BOOLEAN DEFAULT FALSE`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='completed_tasks_user_key_unique') THEN ALTER TABLE completed_tasks ADD CONSTRAINT completed_tasks_user_key_unique UNIQUE(user_id, task_key); END IF; END $$`,
      // ── Taddy Ads ──
      `CREATE TABLE IF NOT EXISTS taddy_ad_logs (
        user_id TEXT NOT NULL,
        log_date DATE NOT NULL DEFAULT CURRENT_DATE,
        count INTEGER NOT NULL DEFAULT 0,
        points_earned INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, log_date)
      )`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS taddy_nonce TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS taddy_nonce_exp TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS taddy_nonce_used BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS taddy_last_reward TIMESTAMPTZ`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS taddy_next_cooldown_ms INTEGER DEFAULT 30000`,
    ];
    for (const m of migrations) { try { await sql(m); } catch (_) {} }

    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_dfp_user ON device_fingerprints(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_dfp_fp   ON device_fingerprints(fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_sl_user  ON security_logs(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_user   ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_exp    ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_s_ip     ON sessions(ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_s_fp     ON sessions(fingerprint_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_n_hash   ON nonces(nonce)`,
      `CREATE INDEX IF NOT EXISTS idx_n_sess   ON nonces(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_user   ON nonces(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_used   ON nonces(used, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_al_ud    ON ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_tal_ud   ON taddy_ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_wd_user  ON withdrawals(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_ref  ON referrals(referrer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_u_ip     ON users(last_ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_u_fp     ON users(fp_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_u  ON audit_log(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ct_user  ON completed_tasks(user_id, task_key)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    // ── Cleanup expired/used nonces (تنظيف دوري) ──────────────────
    try {
      await sql(
        `DELETE FROM nonces WHERE (used=TRUE OR expires_at < NOW() - INTERVAL '10 minutes')`
      );
    } catch (_) {}

    console.log('[DB] bootstrap OK v5.1-sec');
  } catch (e) {
    console.error('[DB] bootstrap error:', e.message);
    _bootstrapped = false; // retry on next request
  }
}

function ensureBootstrap() {
  if (!_bootstrapPromise) _bootstrapPromise = _doBootstrap();
  return _bootstrapPromise;
}

module.exports = { sql, rateLimitMap, ensureBootstrap };
