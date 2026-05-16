/**
 * Zero Trust API — v6.0 — Production-Grade Tolerant Anti-Abuse
 *
 * ✅ Implicit Internal Nonce — server-derived, never exposed to client
 * ✅ Monotonic request counter per session — race-safe via advisory locks
 * ✅ HMAC(method+path+canonical_body+request_id+counter+timestamp+secret)
 * ✅ Canonical JSON serialization — key-order-independent hashing
 * ✅ Relaxed Ad Ticket — 4 min TTL + soft expiry grace window (60s)
 * ✅ Grace-based State Machine — tolerant transitions, duplicate-safe
 * ✅ Soft Locking — wait+retry before reject on collision
 * ✅ Idempotent Retries — same request_id = same result, zero risk penalty
 * ✅ Smart Rate Limit — per-user sliding window, burst-friendly, read/write separated
 * ✅ AdsGram Resilience — timeout, retry, stale-ticket cleanup
 * ✅ Risk Engine — only fires on real abuse, not mobile lag / reconnect / polling
 * ✅ Nonce Expiration — time-bound + grace handling for slow networks
 * ✅ Replay Protection — request_id + counter + derived nonce hash
 * ✅ Shadow Ban System — silent fake-ok for abusers
 * ✅ Device Trust Score — anti-bot, headless, automation detection
 * ✅ Multi-account detection — IP + fingerprint cluster
 * ✅ PostgreSQL advisory locks — race-safe counter sync
 * ✅ Production-grade UX — smooth ad flow, stable reward, mobile-friendly
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

// ── Config ────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-env';
const IP_SALT      = process.env.IP_SALT      || 'rebh_ip_salt_2025';
const HMAC_SECRET  = process.env.HMAC_SECRET  || 'zt_hmac_secret_v6_2025';
const IS_DEV       = process.env.NODE_ENV !== 'production';

const CFG = {
  POINTS_PER_AD:         50,
  POINTS_PER_REFERRAL:   500,
  POINTS_PER_TG_TASK:    2500,
  ADS_DAILY_LIMIT:       10,
  WITHDRAW_MIN_PTS:      50000,
  WITHDRAW_MIN_LEVEL:    5,
  PTS_PER_TON:           100000,

  // ── Implicit Nonce / Session ──────────────────────────────────────
  // العميل لا يرى nonce — السيرفر يشتقه داخلياً
  NONCE_TTL_MS:                5  * 60 * 1000,   // 5 دقائق للـ nonce العادي
  NONCE_GRACE_MS:              30 * 1000,          // 30 ثانية grace للشبكات البطيئة
  SESSION_COUNTER_JUMP_MAX:    50,                 // الحد الأقصى للقفز في counter
  SESSION_COUNTER_WINDOW_MS:   10 * 1000,          // نافذة الطلبات المتزامنة

  // ── Ad Ticket — Relaxed (4 min TTL + soft grace) ──────────────────
  AD_TICKET_TTL_MS:            4  * 60 * 1000,    // 4 دقائق (رُفع من 90s)
  AD_TICKET_SOFT_GRACE_MS:     60 * 1000,          // 60 ثانية soft expiry grace
  AD_TICKET_REFRESH_WINDOW_MS: 30 * 1000,          // إذا انتهت منذ < 30s يُسمح بـ refresh

  // ── Ad timing ─────────────────────────────────────────────────────
  AD_COOLDOWN_MS:              30 * 1000,
  AD_MIN_DURATION_MS:          14 * 1000,
  AD_LOAD_TIMEOUT_MS:          15 * 1000,          // AdsGram load timeout
  AD_LOAD_MAX_RETRIES:         3,                   // عدد محاولات تحميل الإعلان

  // ── Adsgram Task ──────────────────────────────────────────────────
  ADSGRAM_TASK_COOLDOWN_MS:    60 * 1000,
  ADSGRAM_TASK_POINTS:         70,
  ADSGRAM_TASK_MIN_WATCH_MS:   10 * 1000,

  // ── Session ───────────────────────────────────────────────────────
  SESSION_TTL_MS:              7  * 24 * 60 * 60 * 1000,

  // ── Rate Limiting — Smart, Tolerant ──────────────────────────────
  // نافذة زمنية منفصلة لـ read vs write
  RATE_READ_WINDOW_MS:         60 * 1000,
  RATE_WRITE_WINDOW_MS:        60 * 1000,
  RATE_READ_MAX_IP:            120,                 // قراءة: سخي (كان 30)
  RATE_WRITE_MAX_IP:           30,                  // كتابة: معقول (كان 15)
  RATE_READ_MAX_USER:          60,                  // قراءة per-user
  RATE_WRITE_MAX_USER:         20,                  // كتابة per-user (كان 10)
  RATE_BURST_EXTRA:            10,                  // burst إضافي للموبايل البطيء
  RATE_MOBILE_GRACE_MS:        3 * 1000,            // grace للموبايل

  // ── Soft Lock — wait + retry ──────────────────────────────────────
  LOCK_WAIT_MS:                500,                 // انتظر 500ms قبل retry
  LOCK_RETRY_TIMES:            2,                   // حاول مرتين قبل الرفض

  // ── Request signing tolerance ─────────────────────────────────────
  REQ_TIMESTAMP_TOLERANCE_MS:  10 * 60 * 1000,     // 10 دقائق (رُفع من 5)

  // ── Risk — Conservative, Real-Abuse Only ─────────────────────────
  RISK_BAN:                    100,
  RISK_SHADOW:                 60,

  // هذه الأحداث لا تُعطي risk أبداً (mobile lag, retry, reconnect)
  RISK_EXEMPT_EVENTS: new Set([
    'duplicate_retry',
    'idempotent_replay',
    'soft_state_duplicate',
    'reconnect_recovery',
    'polling_overlap',
    'ad_load_retry',
    'mobile_lag',
    'ticket_soft_expired',   // grace window
  ]),

  // ── Device Trust Score ───────────────────────────────────────────
  DEVICE_TRUST: {
    MIN_TRUSTED:    70,
    HEADLESS_SCORE: 0,
    NORMAL_SCORE:   100,
  },

  // ── Multi-account ────────────────────────────────────────────────
  MULTI_ACCT: {
    MAX_PER_IP:  1,
    MAX_PER_FP:  1,
    IP_WHITELIST: new Set([]),
  },

  // ── Ad State Machine — Grace-based ───────────────────────────────
  AD_STATES: Object.freeze({
    IDLE:          'IDLE',
    START_AD:      'START_AD',
    WATCHING:      'WATCHING',
    CLAIM_ALLOWED: 'CLAIM_ALLOWED',
    CLAIMED:       'CLAIMED',
    EXPIRED:       'EXPIRED',
  }),

  // الانتقالات الأساسية
  AD_TRANSITIONS: Object.freeze({
    'IDLE→START_AD':          true,
    'START_AD→WATCHING':      true,
    'WATCHING→CLAIM_ALLOWED': true,
    'CLAIM_ALLOWED→CLAIMED':  true,
    'WATCHING→EXPIRED':       true,
    'START_AD→EXPIRED':       true,
    'CLAIMED→IDLE':           true,
    'EXPIRED→IDLE':           true,
    // Grace transitions — duplicate-safe (لا ترفع risk)
    'START_AD→START_AD':      'grace',  // retry بعد reconnect
    'WATCHING→WATCHING':      'grace',  // polling مكرر
    'CLAIM_ALLOWED→CLAIM_ALLOWED': 'grace', // double-tap
    'IDLE→IDLE':              'grace',  // no-op safe
    // Recovery transitions
    'WATCHING→START_AD':      'recovery',
    'CLAIM_ALLOWED→START_AD': 'recovery',
    'EXPIRED→START_AD':       true,
  }),

  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000],
};

// ── In-Memory Sliding Window Rate Limiter (per-process) ───────────
// ملاحظة: في serverless/edge functions هذا يعمل per-instance
// للإنتاج الحقيقي مع load balancers متعددة — استخدم Redis Upstash
// لكن per-instance rate limiting يكفي لـ Vercel/Cloudflare Workers
const _rateBuckets = new Map();

function slidingWindowRateLimit(key, maxReqs, windowMs, burstExtra = 0) {
  const now    = Date.now();
  const cutoff = now - windowMs;
  let bucket   = _rateBuckets.get(key);
  if (!bucket) { bucket = []; _rateBuckets.set(key, bucket); }

  // حذف الطلبات القديمة
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();

  const effectiveMax = maxReqs + burstExtra;
  if (bucket.length >= effectiveMax) return false;
  bucket.push(now);
  return true;
}

// تنظيف كل 5 دقائق
setInterval(() => {
  const cutoff = Date.now() - Math.max(CFG.RATE_READ_WINDOW_MS, CFG.RATE_WRITE_WINDOW_MS);
  for (const [k, v] of _rateBuckets) {
    const fresh = v.filter(t => t > cutoff);
    if (fresh.length === 0) _rateBuckets.delete(k);
    else _rateBuckets.set(k, fresh);
  }
}, 5 * 60 * 1000);


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
      points BIGINT DEFAULT 0, level INT DEFAULT 1, xp BIGINT DEFAULT 0,
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
      device_trust_score INT DEFAULT 100,
      ad_state TEXT DEFAULT 'IDLE',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── sessions — مع nonce_seed للـ implicit nonce system ────────
    await sql(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      -- Implicit Nonce System
      nonce_seed TEXT NOT NULL,              -- server-side HMAC seed (لا يُرسل للعميل أبداً)
      request_counter BIGINT DEFAULT 0,     -- monotonic counter — يزيد فقط
      last_counter_ts TIMESTAMPTZ DEFAULT NOW(),
      -- Ad session tracking
      ad_nonce TEXT, ad_nonce_exp TIMESTAMPTZ, ad_nonce_used BOOLEAN DEFAULT FALSE,
      ad_started_at TIMESTAMPTZ,
      adsgram_task_started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_active TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN DEFAULT FALSE
    )`);

    // ── used_request_ids — replay protection ──────────────────────
    // بدلاً من تخزين nonces الخام — نخزن request_ids المستخدمة + counter hashes
    await sql(`CREATE TABLE IF NOT EXISTS used_request_ids (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      counter BIGINT NOT NULL,
      derived_nonce_hash TEXT NOT NULL,     -- hash فقط وليس الـ nonce الخام
      action TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE(request_id),
      UNIQUE(session_id, counter)            -- لا يُسمح بنفس counter مرتين
    )`);

    // ── nonces — للعمليات التي تحتاج nonce صريح (gift, withdraw) ─
    await sql(`CREATE TABLE IF NOT EXISTS nonces (
      id BIGSERIAL PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      ip_hash TEXT, fp_hash TEXT,
      action TEXT,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);

    // ── ad_tickets ────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS ad_tickets (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL UNIQUE,
      user_id BIGINT NOT NULL,
      session_id TEXT NOT NULL,
      fp_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'reward_ad',
      state TEXT NOT NULL DEFAULT 'IDLE',
      signature TEXT NOT NULL,
      started_at TIMESTAMPTZ,
      watched_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      soft_expires_at TIMESTAMPTZ NOT NULL, -- للـ soft expiry grace
      is_consumed BOOLEAN DEFAULT FALSE,
      lock_count INT DEFAULT 0,
      refresh_count INT DEFAULT 0,           -- عدد مرات التجديد
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── processed_requests — idempotency ──────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS processed_requests (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      user_id BIGINT,
      action TEXT,
      response JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── audit_log ────────────────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT,
      user_id BIGINT,
      session_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      ip_hash TEXT,
      fp_hash TEXT,
      lock_collision BOOLEAN DEFAULT FALSE,
      is_grace BOOLEAN DEFAULT FALSE,
      meta JSONB,
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
      completed_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── Migrations ────────────────────────────────────────────────
    const migrations = [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS nonce_seed TEXT DEFAULT ''`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS request_counter BIGINT DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_counter_ts TIMESTAMPTZ DEFAULT NOW()`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_used BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_started_at TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS adsgram_task_started_at TIMESTAMPTZ`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS ad_last_reward TIMESTAMPTZ`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS cluster_ban BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS last_ip_hash TEXT`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS device_trust_score INT DEFAULT 100`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS ad_state TEXT DEFAULT 'IDLE'`,
      `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id TEXT`,
      `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS lock_collision BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS is_grace BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE ad_tickets ADD COLUMN IF NOT EXISTS soft_expires_at TIMESTAMPTZ`,
      `ALTER TABLE ad_tickets ADD COLUMN IF NOT EXISTS refresh_count INT DEFAULT 0`,
      // تحديث soft_expires_at للتذاكر القديمة
      `UPDATE ad_tickets SET soft_expires_at = expires_at WHERE soft_expires_at IS NULL`,
    ];
    for (const m of migrations) { try { await sql(m); } catch (_) {} }

    // ── Indexes ───────────────────────────────────────────────────
    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_s_user    ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_exp     ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_s_ip      ON sessions(ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_s_fp      ON sessions(fingerprint_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_uri_rid   ON used_request_ids(request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_uri_sess  ON used_request_ids(session_id, counter)`,
      `CREATE INDEX IF NOT EXISTS idx_uri_exp   ON used_request_ids(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_n_hash    ON nonces(nonce)`,
      `CREATE INDEX IF NOT EXISTS idx_n_sess    ON nonces(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_user    ON nonces(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_at_ticket ON ad_tickets(ticket_id)`,
      `CREATE INDEX IF NOT EXISTS idx_at_user   ON ad_tickets(user_id, is_consumed)`,
      `CREATE INDEX IF NOT EXISTS idx_at_exp    ON ad_tickets(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_at_soft   ON ad_tickets(soft_expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_pr_rid    ON processed_requests(request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_pr_exp    ON processed_requests(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_al_ud     ON ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_wd_user   ON withdrawals(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_ref   ON referrals(referrer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_u_ip      ON users(last_ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_u_fp      ON users(fp_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_usr ON audit_log(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts  ON audit_log(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_rid ON audit_log(request_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ct_user   ON completed_tasks(user_id, task_key)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    console.log('[DB] bootstrap OK v6.0 — Production-Grade Tolerant Anti-Abuse');
  } catch (e) {
    console.error('[DB] bootstrap error:', e.message);
  }
}
bootstrap();

// ── Cleanup ───────────────────────────────────────────────────────
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces WHERE expires_at < NOW() OR used = TRUE`);
    await sql(`DELETE FROM sessions WHERE expires_at < NOW()`);
    // نحتفظ بالتذاكر المنتهية لفترة أطول (قد يطلبها retry)
    await sql(`DELETE FROM ad_tickets WHERE expires_at < NOW() - INTERVAL '5 minutes' OR is_consumed = TRUE`);
    await sql(`DELETE FROM processed_requests WHERE created_at < NOW() - INTERVAL '24 hours'`);
    await sql(`DELETE FROM used_request_ids WHERE expires_at < NOW()`);
    await sql(`
      UPDATE sessions
      SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE
      WHERE ad_nonce_exp < NOW()
    `);
    await sql(`DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '30 days'`);
    await sql(`DELETE FROM risk_events WHERE created_at < NOW() - INTERVAL '7 days'`);
    // إعادة ضبط ad_state للمستخدمين بدون تذاكر حية (أو في soft grace)
    await sql(`
      UPDATE users SET ad_state = 'IDLE'
      WHERE ad_state NOT IN ('IDLE','CLAIMED')
        AND id NOT IN (
          SELECT DISTINCT user_id FROM ad_tickets
          WHERE is_consumed = FALSE
            AND expires_at > NOW() - INTERVAL '${Math.floor(CFG.AD_TICKET_SOFT_GRACE_MS/1000)} seconds'
        )
    `);
    console.log('[CLEANUP] OK v6.0');
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

// ── Canonical JSON — key-order-independent ────────────────────────
// يمنع مشاكل serialization بسبب ترتيب المفاتيح
function canonicalJson(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return JSON.stringify(sorted);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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


// ═══════════════════════════════════════════════════════════════════
// IMPLICIT NONCE SYSTEM — v6.0
//
// النظام:
// 1. عند إنشاء session → السيرفر يولد nonce_seed عشوائي ويخزنه server-side
// 2. كل request حساس → السيرفر يشتق nonce متوقع:
//    HMAC(nonce_seed + counter + method + path + timestamp_bucket)
// 3. العميل يُرسل فقط: session_id + request_id + timestamp + signed body
// 4. السيرفر يُولّد التوقيع المتوقع ويقارنه بما أرسله العميل
// 5. Counter monotonic — يزيد فقط، race-safe عبر advisory lock
// ═══════════════════════════════════════════════════════════════════

/**
 * deriveImplicitNonce — يشتق nonce داخلياً من seed + counter + context
 * لا يُرسل للعميل أبداً — يُستخدم للتحقق من التوقيع
 */
function deriveImplicitNonce(nonceSeed, counter, method, path, timestampBucket) {
  const msg = [nonceSeed, counter, method.toUpperCase(), path, timestampBucket].join('|');
  return createHmac('sha256', HMAC_SECRET).update(msg).digest('hex');
}

/**
 * buildExpectedSignature — يبني التوقيع المتوقع للطلب
 * HMAC(method + path + canonical_body + request_id + counter + timestamp + session_secret)
 */
function buildExpectedSignature(method, path, canonicalBody, requestId, counter, timestamp, nonceSeed) {
  const bodyHash = sha256(canonicalBody || '');
  const msg = [
    method.toUpperCase(),
    path,
    bodyHash,
    requestId || '',
    String(counter),
    String(timestamp),
    nonceSeed,
  ].join('|');
  return createHmac('sha256', HMAC_SECRET).update(msg).digest('hex');
}

/**
 * incrementSessionCounter — يزيد counter بشكل atomic + race-safe
 * يستخدم advisory lock لمنع race conditions بين 50 طلب متزامن
 * Returns: { ok, counter, nonce_seed } أو { ok: false, reason }
 */
async function incrementSessionCounter(sessionId, userId) {
  const lockId = Math.abs(userId % 2147483647);
  let lockAcquired = false;

  // محاولة الحصول على lock (soft lock)
  for (let attempt = 0; attempt < CFG.LOCK_RETRY_TIMES; attempt++) {
    const r = await sql(`SELECT pg_try_advisory_lock($1) AS acquired`, [lockId]);
    if (r[0]?.acquired === true) {
      lockAcquired = true;
      break;
    }
    if (attempt < CFG.LOCK_RETRY_TIMES - 1) {
      await sleep(CFG.LOCK_WAIT_MS);
    }
  }

  if (!lockAcquired) {
    return { ok: false, reason: 'counter_lock_failed' };
  }

  try {
    const sessRows = await sql(
      `SELECT request_counter, nonce_seed FROM sessions
       WHERE id=$1 AND is_revoked=FALSE AND expires_at > NOW()
       FOR UPDATE`,
      [sessionId]
    );
    if (!sessRows.length) return { ok: false, reason: 'session_not_found' };

    const current = parseInt(sessRows[0].request_counter) || 0;
    const nonceSeed = sessRows[0].nonce_seed || '';
    const next = current + 1;

    await sql(
      `UPDATE sessions SET request_counter=$1, last_counter_ts=NOW() WHERE id=$2`,
      [next, sessionId]
    );

    return { ok: true, counter: next, prev_counter: current, nonce_seed: nonceSeed };
  } finally {
    try {
      await sql(`SELECT pg_advisory_unlock($1)`, [lockId]);
    } catch (_) {}
  }
}

/**
 * verifyImplicitNonce — يتحقق من التوقيع + counter monotonic + replay
 * يعيد: { ok, counter, isGrace } أو { ok: false, reason }
 *
 * GRACE: إذا نفس request_id مكرر → يُعيد نفس النتيجة بدون risk penalty
 */
async function verifyImplicitNonce(req, sessionRow, rawBody, requestId, userId, sessionId) {
  const sig       = req.headers['x-req-sig']  || '';
  const ts        = req.headers['x-req-ts']   || '';
  const clientCtr = parseInt(req.headers['x-req-counter'] || '0');

  // في dev: تخطي التحقق إذا لا يوجد توقيع
  if (IS_DEV && !sig) return { ok: true, counter: 0, isGrace: false, skipped: true };
  if (!sig || !ts)    return { ok: false, reason: 'missing_signature' };

  // التحقق من timestamp
  const tsMs = parseInt(ts, 10);
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > CFG.REQ_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'timestamp_expired' };
  }

  // bucket الزمني (دقيقة كاملة — يقلل حساسية التوقيت)
  const timestampBucket = Math.floor(tsMs / 60000);

  const url      = req.url || '/api';
  const path     = url.split('?')[0];
  const method   = req.method || 'POST';
  const nonceSeed = sessionRow.nonce_seed || '';

  // Canonical body للـ hashing
  let bodyObj = rawBody;
  if (typeof rawBody === 'string') {
    try { bodyObj = JSON.parse(rawBody); } catch (_) {}
  }
  const canonBody = typeof bodyObj === 'object' ? canonicalJson(bodyObj) : String(rawBody || '');

  // بناء التوقيع المتوقع
  const currentCounter = parseInt(sessionRow.request_counter) || 0;
  const expectedCounter = currentCounter + 1;

  const expectedSig = buildExpectedSignature(
    method, path, canonBody, requestId,
    expectedCounter, ts, nonceSeed
  );

  // مقارنة timing-safe
  const sigMatch = constantTimeCompare(expectedSig, sig);
  if (!sigMatch) {
    // محاولة قبول مع counter العميل (grace للشبكات البطيئة)
    if (clientCtr > 0 && Math.abs(clientCtr - expectedCounter) <= CFG.SESSION_COUNTER_JUMP_MAX) {
      const altSig = buildExpectedSignature(method, path, canonBody, requestId, clientCtr, ts, nonceSeed);
      if (!constantTimeCompare(altSig, sig)) {
        return { ok: false, reason: 'sig_mismatch' };
      }
      // قبول مع counter العميل (mobile lag grace)
      return { ok: true, counter: clientCtr, isGrace: true };
    }
    return { ok: false, reason: 'sig_mismatch' };
  }

  // التحقق من عدم إعادة استخدام request_id
  const existing = await sql(
    `SELECT counter FROM used_request_ids WHERE request_id=$1`,
    [requestId]
  );
  if (existing.length) {
    // إعادة استخدام request_id = idempotent retry → لا risk
    return { ok: true, counter: existing[0].counter, isGrace: true, isIdempotent: true };
  }

  // التحقق من عدم إعادة استخدام نفس counter في نفس session
  const dupCounter = await sql(
    `SELECT id FROM used_request_ids WHERE session_id=$1 AND counter=$2`,
    [sessionId, expectedCounter]
  );
  if (dupCounter.length) {
    // نفس counter مستخدم — هجوم replay حقيقي
    return { ok: false, reason: 'counter_replay', isRealAbuse: true };
  }

  return { ok: true, counter: expectedCounter, isGrace: false };
}

/**
 * recordUsedRequestId — يسجل request_id + counter لمنع replay
 */
async function recordUsedRequestId(requestId, sessionId, userId, counter, nonceSeed, action) {
  if (!requestId) return;
  const derivedHash = sha256(nonceSeed + ':' + counter + ':' + requestId);
  const exp = new Date(Date.now() + CFG.NONCE_TTL_MS + CFG.NONCE_GRACE_MS).toISOString();
  try {
    await sql(
      `INSERT INTO used_request_ids(request_id, session_id, user_id, counter, derived_nonce_hash, action, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(request_id) DO NOTHING`,
      [requestId, sessionId, userId, counter, derivedHash, action, exp]
    );
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// LEGACY NONCE SYSTEM — للعمليات التي تحتاج nonce صريح (gift, withdraw)
// ═══════════════════════════════════════════════════════════════════
async function consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, action) {
  if (!rawNonce || rawNonce.length < 16) {
    await addRisk(userId, 'missing_nonce', ipHash, fpHash, 5);
    return 'missing';
  }
  if (!sessionId) return 'invalid';

  const exp = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();
  const inserted = await sql(
    `INSERT INTO nonces(nonce, session_id, user_id, ip_hash, fp_hash, action, used, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,TRUE,$7)
     ON CONFLICT(nonce) DO NOTHING
     RETURNING id`,
    [rawNonce, sessionId, userId, ipHash, fpHash, action, exp]
  );

  if (!inserted.length) {
    // nonce مكرر — لكن نتحقق هل هو retry طبيعي أم abuse
    const nonceRow = await sql(
      `SELECT created_at FROM nonces WHERE nonce=$1`,
      [rawNonce]
    );
    const age = nonceRow.length
      ? Date.now() - new Date(nonceRow[0].created_at).getTime()
      : 999999;

    if (age < CFG.NONCE_GRACE_MS) {
      // ضمن grace window → retry طبيعي، لا risk
      return 'replay_grace';
    }

    // بعد grace → replay حقيقي
    await addRisk(userId, `nonce_replay_${action}`, ipHash, fpHash, 25);
    await writeAudit(userId, sessionId, action, 'nonce_replay', ipHash, fpHash, false, {
      nonce_prefix: rawNonce.slice(0, 8), action,
    });
    return 'replay';
  }

  return 'ok';
}


// ═══════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════
async function checkIdempotency(requestId, userId) {
  if (!requestId) return null;
  try {
    const existing = await sql(
      `SELECT response FROM processed_requests WHERE request_id=$1 AND user_id=$2`,
      [requestId, userId]
    );
    if (existing.length) return existing[0].response;
  } catch (_) {}
  return null;
}

async function saveIdempotency(requestId, userId, action, response) {
  if (!requestId) return;
  try {
    await sql(
      `INSERT INTO processed_requests(request_id, user_id, action, response)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(request_id) DO NOTHING`,
      [requestId, userId, action, JSON.stringify(response)]
    );
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════
async function writeAudit(userId, sessionId, action, status, ipHash, fpHash, lockCollision = false, meta = {}) {
  try {
    await sql(
      `INSERT INTO audit_log(request_id, user_id, session_id, action, status, ip_hash, fp_hash, lock_collision, is_grace, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        meta.request_id || null,
        userId || null,
        sessionId || null,
        action, status,
        ipHash || null,
        fpHash || null,
        !!lockCollision,
        !!meta.is_grace,
        JSON.stringify(meta),
      ]
    );
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// RISK ENGINE — Smart, Real-Abuse Only
// ═══════════════════════════════════════════════════════════════════
async function addRisk(userId, type, ipHash, fpHash, delta) {
  // لا نُعطي risk للأحداث المعفاة (mobile lag, retry, reconnect)
  if (CFG.RISK_EXEMPT_EVENTS.has(type)) {
    return; // تجاهل تام — لا تسجيل، لا penalty
  }

  try {
    await sql(
      `INSERT INTO risk_events(user_id, event_type, ip_hash, fp_hash, score_delta)
       VALUES($1,$2,$3,$4,$5)`,
      [userId, type, ipHash, fpHash, delta]
    );
    if (delta > 0) {
      await sql(`UPDATE users SET risk_score=LEAST(risk_score+$1, 200) WHERE id=$2`, [delta, userId]);
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='auto_risk'
         WHERE id=$1 AND risk_score >= $2`,
        [userId, CFG.RISK_BAN]
      );
      await sql(
        `UPDATE users SET is_shadow_banned=TRUE
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE`,
        [userId, CFG.RISK_SHADOW]
      );
    }
  } catch (_) {}
}

async function checkMultiAccount(userId, ipHash, fpHash) {
  const cfg = CFG.MULTI_ACCT;
  if (cfg.IP_WHITELIST.has(ipHash)) return;

  const ipAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.last_ip_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [ipHash, userId]
  );
  if ((parseInt(ipAccounts[0]?.cnt) || 0) >= cfg.MAX_PER_IP) {
    await addRisk(userId, 'multi_account_ip', ipHash, fpHash, 20);
  }

  const fpAccounts = await sql(
    `SELECT COUNT(DISTINCT u.id) AS cnt FROM users u
     WHERE u.fp_hash=$1 AND u.id != $2 AND u.is_banned = FALSE`,
    [fpHash, userId]
  );
  if ((parseInt(fpAccounts[0]?.cnt) || 0) >= cfg.MAX_PER_FP) {
    await addRisk(userId, 'multi_account_fp', ipHash, fpHash, 50);
    await sql(
      `UPDATE users SET cluster_ban=TRUE WHERE fp_hash=$1 AND id!=$2`,
      [fpHash, userId]
    );
  }

  const bannedOnIp = await sql(
    `SELECT COUNT(*) AS cnt FROM users WHERE last_ip_hash=$1 AND is_banned=TRUE AND id!=$2`,
    [ipHash, userId]
  );
  if ((parseInt(bannedOnIp[0]?.cnt) || 0) > 2) {
    await addRisk(userId, 'cluster_ip_banned', ipHash, fpHash, 15);
  }
}


// ═══════════════════════════════════════════════════════════════════
// DEVICE TRUST SCORE
// ═══════════════════════════════════════════════════════════════════
function computeDeviceTrustScore(fpData) {
  if (!fpData || typeof fpData !== 'object') return 0;

  let score = 100;
  const ua = (fpData.user_agent || '').toLowerCase();

  if (ua.includes('headlesschrome') || ua.includes('headless')) score -= 60;
  if (ua.includes('phantomjs')) score -= 80;
  if (ua.includes('selenium') || ua.includes('webdriver')) score -= 70;
  if (fpData.webdriver === true) score -= 70;
  if (ua.includes('playwright')) score -= 60;
  if (ua.includes('puppeteer')) score -= 60;
  if (!fpData.canvas_sig || fpData.canvas_sig === '') score -= 20;
  if (!fpData.webgl_sig  || fpData.webgl_sig  === '') score -= 15;
  if (!fpData.audio_sig  || fpData.audio_sig  === '') score -= 10;
  if (fpData.hw_cores === 0 && fpData.hw_mem === 0) score -= 20;
  if (fpData.touch_pts === 0 && fpData.dpr === 1 && !fpData.webgl_sig) score -= 15;
  if (!fpData.screen || fpData.screen === '0x0x0x0') score -= 30;
  if (fpData.fp === 'unknown') score -= 25;

  return Math.max(0, Math.min(100, score));
}


// ═══════════════════════════════════════════════════════════════════
// AD STATE MACHINE — Grace-based, Tolerant
// ═══════════════════════════════════════════════════════════════════
function classifyTransition(from, to) {
  const key = `${from}→${to}`;
  const val = CFG.AD_TRANSITIONS[key];
  if (!val) return 'invalid';
  if (val === 'grace') return 'grace';
  if (val === 'recovery') return 'recovery';
  return 'valid';
}

/**
 * transitionAdState — Grace-based state machine
 * - Transitions مكررة (grace) → تُتجاهل safely، لا risk
 * - Transitions recovery → تُقبل مع audit
 * - Transitions خاطئة → risk فقط عند abuse حقيقي
 */
async function transitionAdState(userId, expectedFrom, to, sessionId, ipHash, fpHash, requestId) {
  const result = await sql(
    `UPDATE users SET ad_state=$1, updated_at=NOW()
     WHERE id=$2 AND ad_state=$3
     RETURNING id, ad_state`,
    [to, userId, expectedFrom]
  );

  if (result.length) return { ok: true, isGrace: false };

  // الانتقال فشل — نفحص السبب
  const current = (await sql(`SELECT ad_state FROM users WHERE id=$1`, [userId]))[0];
  const actualState = current?.ad_state || 'UNKNOWN';

  const transType = classifyTransition(actualState, to);

  if (transType === 'grace') {
    // duplicate transition — تجاهل safely، لا risk
    await writeAudit(userId, sessionId, 'state_transition', 'grace_noop', ipHash, fpHash, false, {
      request_id: requestId, from: expectedFrom, to, actual: actualState, is_grace: true,
    });
    return { ok: true, isGrace: true };
  }

  if (transType === 'recovery') {
    // recovery transition — قبول مع force update
    await sql(`UPDATE users SET ad_state=$1, updated_at=NOW() WHERE id=$2`, [to, userId]);
    await writeAudit(userId, sessionId, 'state_transition', 'recovery', ipHash, fpHash, false, {
      request_id: requestId, from: actualState, to,
    });
    return { ok: true, isGrace: false };
  }

  if (transType === 'invalid') {
    // انتقال خاطئ — risk فقط إذا لم يكن retry/reconnect
    await addRisk(userId, 'invalid_state_transition', ipHash, fpHash, 20);
    await writeAudit(userId, sessionId, 'state_transition', 'invalid', ipHash, fpHash, false, {
      request_id: requestId, from: expectedFrom, to, actual: actualState,
    });
    return { ok: false, reason: 'invalid_transition', actualState };
  }

  await writeAudit(userId, sessionId, 'state_transition', 'failed', ipHash, fpHash, false, {
    request_id: requestId, from: expectedFrom, to, actual: actualState,
  });
  return { ok: false, reason: 'state_conflict', actualState };
}


// ═══════════════════════════════════════════════════════════════════
// SOFT DISTRIBUTED LOCK — wait + retry before reject
// ═══════════════════════════════════════════════════════════════════
async function tryAcquireLock(userId) {
  const lockId = Math.abs(userId % 2147483647);
  for (let i = 0; i < CFG.LOCK_RETRY_TIMES; i++) {
    const r = await sql(`SELECT pg_try_advisory_lock($1) AS acquired`, [lockId]);
    if (r[0]?.acquired === true) return true;
    if (i < CFG.LOCK_RETRY_TIMES - 1) await sleep(CFG.LOCK_WAIT_MS);
  }
  return false;
}

async function releaseLock(userId) {
  try {
    const lockId = Math.abs(userId % 2147483647);
    await sql(`SELECT pg_advisory_unlock($1)`, [lockId]);
  } catch (_) {}
}


// ═══════════════════════════════════════════════════════════════════
// AD TICKET SYSTEM — Relaxed, Soft Expiry
// TTL: 4 دقائق + 60 ثانية grace (soft expiry)
// ═══════════════════════════════════════════════════════════════════
function signTicket(ticketId, userId, sessionId, fpHash, ipHash, action, expiresAt) {
  const msg = [ticketId, userId, sessionId, fpHash, ipHash, action, expiresAt].join('|');
  return createHmac('sha256', HMAC_SECRET).update(msg).digest('hex');
}

async function issueAdTicket(userId, sessionId, fpHash, ipHash) {
  // فحص تذكرة حية موجودة
  const existing = await sql(
    `SELECT ticket_id, state, expires_at, soft_expires_at, refresh_count
     FROM ad_tickets
     WHERE user_id=$1 AND is_consumed=FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );

  if (existing.length) {
    const t = existing[0];
    const now = Date.now();
    const hardExpiry  = new Date(t.expires_at).getTime();
    const softExpiry  = t.soft_expires_at
      ? new Date(t.soft_expires_at).getTime()
      : hardExpiry;

    // التذكرة حية تماماً — أعدها
    if (now < softExpiry && !['EXPIRED','CLAIMED'].includes(t.state)) {
      return { ticket_id: t.ticket_id, reused: true, refreshed: false };
    }

    // Soft expiry: انتهت منذ أقل من grace window → refresh بدون penalty
    if (now < hardExpiry + CFG.AD_TICKET_SOFT_GRACE_MS && !['CLAIMED'].includes(t.state)) {
      // تجديد التذكرة تلقائياً (soft refresh)
      const newExpiry     = new Date(now + CFG.AD_TICKET_TTL_MS).toISOString();
      const newSoftExpiry = new Date(now + CFG.AD_TICKET_TTL_MS - CFG.AD_TICKET_SOFT_GRACE_MS).toISOString();
      await sql(
        `UPDATE ad_tickets
         SET expires_at=$1, soft_expires_at=$2, state='START_AD', refresh_count=refresh_count+1
         WHERE ticket_id=$3`,
        [newExpiry, newSoftExpiry, t.ticket_id]
      );
      // لا نرفع risk هنا — هذا soft refresh طبيعي
      return { ticket_id: t.ticket_id, reused: true, refreshed: true };
    }
  }

  // إصدار ticket جديد
  const ticketId      = genRawNonce(32);
  const now           = Date.now();
  const expiresAt     = new Date(now + CFG.AD_TICKET_TTL_MS).toISOString();
  const softExpiresAt = new Date(now + CFG.AD_TICKET_TTL_MS - CFG.AD_TICKET_SOFT_GRACE_MS).toISOString();
  const sig           = signTicket(ticketId, userId, sessionId, fpHash, ipHash, 'reward_ad', expiresAt);

  await sql(
    `INSERT INTO ad_tickets(ticket_id, user_id, session_id, fp_hash, ip_hash, action, state, signature, started_at, expires_at, soft_expires_at)
     VALUES($1,$2,$3,$4,$5,'reward_ad','START_AD',$6,NOW(),$7,$8)`,
    [ticketId, userId, sessionId, fpHash, ipHash, sig, expiresAt, softExpiresAt]
  );

  return { ticket_id: ticketId, reused: false, refreshed: false };
}

/**
 * consumeAdTicket — يتحقق من ticket ويستهلكه atomically
 * مع soft expiry grace: إذا انتهت في نطاق grace → تُقبل
 */
async function consumeAdTicket(ticketId, userId, sessionId, fpHash, ipHash) {
  if (!ticketId) return { ok: false, reason: 'missing_ticket' };

  const rows = await sql(
    `SELECT * FROM ad_tickets WHERE ticket_id=$1 FOR UPDATE`,
    [ticketId]
  );

  if (!rows.length)   return { ok: false, reason: 'ticket_not_found' };
  const t = rows[0];

  if (t.is_consumed)  return { ok: false, reason: 'ticket_already_consumed' };

  // فحص انتهاء الصلاحية مع soft grace
  const now       = Date.now();
  const hardExpiry = new Date(t.expires_at).getTime();
  const isInGrace  = now > hardExpiry && now < hardExpiry + CFG.AD_TICKET_SOFT_GRACE_MS;

  if (now > hardExpiry + CFG.AD_TICKET_SOFT_GRACE_MS) {
    return { ok: false, reason: 'ticket_expired', is_hard_expired: true };
  }
  if (now > hardExpiry && !isInGrace) {
    return { ok: false, reason: 'ticket_expired' };
  }

  if (String(t.user_id) !== String(userId))  return { ok: false, reason: 'ticket_user_mismatch' };
  if (t.session_id !== sessionId)            return { ok: false, reason: 'ticket_session_mismatch' };
  if (!constantTimeCompare(t.fp_hash, fpHash)) return { ok: false, reason: 'ticket_fp_mismatch' };
  if (!constantTimeCompare(t.ip_hash, ipHash)) return { ok: false, reason: 'ticket_ip_mismatch' };

  const expectedSig = signTicket(
    ticketId, userId, sessionId, fpHash, ipHash, 'reward_ad',
    t.expires_at.toISOString ? t.expires_at.toISOString() : String(t.expires_at)
  );
  if (!constantTimeCompare(t.signature, expectedSig)) {
    return { ok: false, reason: 'ticket_sig_invalid' };
  }

  // state: يجب CLAIM_ALLOWED (أو grace للـ soft expiry)
  if (t.state !== 'CLAIM_ALLOWED') {
    // soft grace: إذا في نطاق الـ grace والـ state WATCHING → قبول
    if (isInGrace && t.state === 'WATCHING') {
      // لا penalty — هذا soft expiry مقبول
    } else {
      return { ok: false, reason: `ticket_wrong_state:${t.state}` };
    }
  }

  // استهلاك atomically
  const consumed = await sql(
    `UPDATE ad_tickets
     SET is_consumed=TRUE, state='CLAIMED', claimed_at=NOW()
     WHERE ticket_id=$1 AND is_consumed=FALSE
     RETURNING id`,
    [ticketId]
  );
  if (!consumed.length) return { ok: false, reason: 'ticket_race_consumed' };

  return { ok: true, ticket: t, was_in_grace: isInGrace };
}


// ═══════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════
async function validateSession(sid, ipHash, fpHash) {
  if (!sid) return null;
  const r = await sql(
    `SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban, u.risk_score, u.ad_state
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

  // Fingerprint check — لكن بدون ban فوري (قد يتغير fp بعد reconnect)
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    // نسجل فقط، لا نبطل الجلسة فوراً
    await addRisk(session.user_id, 'session_fp_mismatch', ipHash, fpHash, 15);
    await writeAudit(session.user_id, sid, 'session_validate', 'fp_mismatch_soft', ipHash, fpHash, false, {
      reason: 'fingerprint_changed_soft',
    });
    // نكمل — لا نبطل الجلسة فوراً (قد يكون reconnect بعد network change)
  }

  await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`, [sid]);
  return session;
}

async function createSessionRow(userId, fpHash, ipHash) {
  const id       = genRawNonce(32);
  const nonceSeed = genRawNonce(32); // server-side فقط — لا يُرسل للعميل
  const exp      = new Date(Date.now() + CFG.SESSION_TTL_MS).toISOString();
  await sql(
    `INSERT INTO sessions(id, user_id, fingerprint_hash, ip_hash, nonce_seed, request_counter, expires_at)
     VALUES($1,$2,$3,$4,$5,0,$6)`,
    [id, userId, fpHash, ipHash, nonceSeed, exp]
  );
  return id;
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


// ═══════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleCreateSession(body, ipHash, fpHash, fpData) {
  const initData = body?.data?.initData || '';
  const tgResult = verifyTg(initData);
  if (!tgResult.ok && !IS_DEV) {
    return { ok: false, error: 'invalid_init_data', status: 401 };
  }

  const tgUser = tgResult.data?.id
    ? tgResult.data
    : { id: 99999999, first_name: 'Dev', language_code: 'ar' };
  if (!tgUser.id) return { ok: false, error: 'no_user_id', status: 401 };

  const trustScore = computeDeviceTrustScore(fpData);
  if (trustScore < CFG.DEVICE_TRUST.MIN_TRUSTED && !IS_DEV) {
    await writeAudit(null, null, 'create_session', 'bot_detected', ipHash, hashFp(fpData), false, {
      trust_score: trustScore, ua: (fpData?.user_agent || '').slice(0, 80),
    });
    if (trustScore <= 10) {
      return { ok: false, error: 'access_denied', status: 403 };
    }
  }

  let referrerId = null;
  try {
    const sp = new URLSearchParams(initData).get('start_param') || '';
    const m  = sp.match(/^ref_(\d+)$/);
    if (m) {
      const rr = await sql(`SELECT id FROM users WHERE tg_id=$1`, [parseInt(m[1])]);
      if (rr.length) referrerId = rr[0].id;
    }
  } catch (_) {}

  const user = await upsertUser(tgUser, ipHash, fpHash);
  if (user.is_banned) return { ok: false, is_banned: true, status: 403 };

  await sql(`UPDATE users SET device_trust_score=$1 WHERE id=$2`, [trustScore, user.id]);

  const isNew = (Date.now() - new Date(user.created_at).getTime()) < 5000;
  if (isNew && referrerId && referrerId !== user.id) {
    try {
      await sql(
        `INSERT INTO referrals(referrer_id,referred_id,points_given) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [referrerId, user.id, CFG.POINTS_PER_REFERRAL]
      );
      await sql(
        `UPDATE users SET points=points+$1,xp=xp+$1,total_referrals=total_referrals+1,earned_from_refs=earned_from_refs+$1,updated_at=NOW() WHERE id=$2`,
        [CFG.POINTS_PER_REFERRAL, referrerId]
      );
      await sql(`UPDATE users SET referrer_id=$1 WHERE id=$2`, [referrerId, user.id]);
      await syncLevel(referrerId);
    } catch (_) {}
  }

  await checkMultiAccount(user.id, ipHash, fpHash);

  const freshUser = (await sql(`SELECT * FROM users WHERE id=$1`, [user.id]))[0];
  if (freshUser.is_banned) return { ok: false, is_banned: true, status: 403 };

  const sessionId = await createSessionRow(freshUser.id, fpHash, ipHash);
  await syncLevel(freshUser.id);
  const finalUser = (await sql(`SELECT * FROM users WHERE id=$1`, [freshUser.id]))[0];

  // جلب request_counter الأولي للعميل
  const sessRow = (await sql(`SELECT request_counter FROM sessions WHERE id=$1`, [sessionId]))[0];

  await writeAudit(finalUser.id, sessionId, 'create_session', 'ok', ipHash, fpHash, false, {
    tg_id: tgUser.id, trust_score: trustScore,
  });

  return {
    ok: true,
    _sid: sessionId,
    // نُرسل counter الأولي للعميل ليبدأ منه (لكن ليس seed)
    initial_counter: parseInt(sessRow?.request_counter) || 0,
    user: {
      points:           parseInt(finalUser.points) || 0,
      level:            parseInt(finalUser.level) || 1,
      xp:               parseInt(finalUser.xp) || 0,
      tg_verified:      finalUser.tg_verified,
      streak_day:       finalUser.streak_day,
      last_gift_date:   finalUser.last_gift_date,
      total_referrals:  finalUser.total_referrals,
      earned_from_refs: parseInt(finalUser.earned_from_refs) || 0,
      ads_watched_total: parseInt(finalUser.ads_watched_total) || 0,
    },
  };
}


async function handleLoad(userId) {
  const [u, adLog, tasks, completedT] = await Promise.all([
    sql(`SELECT * FROM users WHERE id=$1`, [userId]),
    sql(`SELECT count, points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]),
    sql(`SELECT task_type, completed FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE`, [userId]),
    sql(`SELECT task_key FROM completed_tasks WHERE user_id=$1`, [userId]),
  ]);
  const user = u[0];
  const watchedToday = parseInt(adLog[0]?.count) || 0;
  return {
    ok: true,
    user: {
      points:           parseInt(user.points) || 0,
      level:            parseInt(user.level) || 1,
      xp:               parseInt(user.xp) || 0,
      tg_verified:      user.tg_verified,
      is_shadow_banned: user.is_shadow_banned,
      streak_day:       user.streak_day,
      last_gift_date:   user.last_gift_date,
      total_referrals:  user.total_referrals,
      earned_from_refs: parseInt(user.earned_from_refs) || 0,
      ads_watched_total: parseInt(user.ads_watched_total) || 0,
      ad_state:         user.ad_state,
    },
    ads: {
      watchedToday,
      remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watchedToday),
      earnedToday:  parseInt(adLog[0]?.points_earned) || 0,
      daily_limit:  CFG.ADS_DAILY_LIMIT,
      cooldown_ms:  CFG.AD_COOLDOWN_MS,
      all_done:     watchedToday >= CFG.ADS_DAILY_LIMIT,
    },
    tasks:           tasks.map(t => ({ type: t.task_type, done: t.completed })),
    completed_tasks: completedT.map(t => t.task_key),
  };
}

async function handleGetState(userId) {
  const [u, adLog] = await Promise.all([
    sql(`SELECT ad_state, ad_last_reward FROM users WHERE id=$1`, [userId]),
    sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]),
  ]);
  const user = u[0];
  const watchedToday = parseInt(adLog[0]?.count) || 0;
  const cooldown = user?.ad_last_reward
    ? Math.max(0, CFG.AD_COOLDOWN_MS - (Date.now() - new Date(user.ad_last_reward).getTime()))
    : 0;

  // جلب الـ ticket النشط إن وجد (مع soft grace)
  const ticket = (await sql(
    `SELECT ticket_id, state, expires_at, soft_expires_at FROM ad_tickets
     WHERE user_id=$1 AND is_consumed=FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  ))[0];

  return {
    ok: true,
    ad_state:      user?.ad_state || 'IDLE',
    watchedToday,
    remaining:     Math.max(0, CFG.ADS_DAILY_LIMIT - watchedToday),
    cooldown_ms:   cooldown,
    all_done:      watchedToday >= CFG.ADS_DAILY_LIMIT,
    ticket: ticket ? {
      ticket_id:   ticket.ticket_id,
      state:       ticket.state,
      expires_at:  ticket.expires_at,
      is_soft_expired: ticket.soft_expires_at
        ? Date.now() > new Date(ticket.soft_expires_at).getTime()
        : false,
    } : null,
  };
}


// ── start_ad_session ──────────────────────────────────────────────
async function handleStartAdSession(userId, sessionId, ipHash, fpHash, requestId) {
  const cached = await checkIdempotency(requestId, userId);
  if (cached) return cached; // idempotent retry — نفس النتيجة

  // Daily limit
  const adR = await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const watchedToday = parseInt(adR[0]?.count) || 0;
  if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached', watched: watchedToday };
  }

  // Cooldown
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS - elapsed };
    }
  }

  // State Machine — مع grace للحالات المتعددة
  const userState = (await sql(`SELECT ad_state FROM users WHERE id=$1`, [userId]))[0];
  const currentState = userState?.ad_state || 'IDLE';

  if (!['IDLE','EXPIRED','CLAIMED','START_AD'].includes(currentState)) {
    // في حالة WATCHING أو CLAIM_ALLOWED — قد يكون reconnect
    // نسمح بـ recovery بدل الرفض المباشر
    if (['WATCHING','CLAIM_ALLOWED'].includes(currentState)) {
      // نفحص هل هناك ticket حي
      const liveTicket = (await sql(
        `SELECT ticket_id, state FROM ad_tickets
         WHERE user_id=$1 AND is_consumed=FALSE
           AND expires_at > NOW() - INTERVAL '${Math.floor(CFG.AD_TICKET_SOFT_GRACE_MS/1000)} seconds'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      ))[0];

      if (liveTicket) {
        // أعد الـ ticket الحالي مع معلومات الاسترداد
        await writeAudit(userId, sessionId, 'start_ad_session', 'reconnect_recovery', ipHash, fpHash, false, {
          request_id: requestId, current_state: currentState, ticket: liveTicket.ticket_id.slice(0,8),
        });
        const result = {
          ok: true,
          ticket_id: liveTicket.ticket_id,
          expires_in_ms: CFG.AD_TICKET_TTL_MS,
          is_recovery: true,
          current_state: currentState,
        };
        await saveIdempotency(requestId, userId, 'start_ad_session', result);
        return result;
      }
    }

    // parallel abuse حقيقي — حالة لم تكتمل ولا ticket حي
    await addRisk(userId, 'parallel_start_ad', ipHash, fpHash, 10);
    await writeAudit(userId, sessionId, 'start_ad_session', 'parallel_blocked', ipHash, fpHash, true, {
      request_id: requestId, current_state: currentState,
    });
    return { ok: false, error: 'session_busy', current_state: currentState };
  }

  // State transition: → START_AD
  const trans = await transitionAdState(userId, currentState, 'START_AD', sessionId, ipHash, fpHash, requestId);
  if (!trans.ok) {
    // grace: إذا كانت الحالة already START_AD
    if (!trans.isGrace) {
      return { ok: false, error: 'state_conflict', reason: trans.reason };
    }
  }

  const { ticket_id, reused, refreshed } = await issueAdTicket(userId, sessionId, fpHash, ipHash);
  await sql(`UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`, [sessionId]);

  await writeAudit(userId, sessionId, 'start_ad_session', 'ok', ipHash, fpHash, false, {
    request_id: requestId,
    ticket_id: ticket_id.slice(0, 8) + '...',
    reused, refreshed,
    is_grace: trans.isGrace,
  });

  const result = {
    ok: true,
    ticket_id,
    expires_in_ms: CFG.AD_TICKET_TTL_MS,
    soft_expires_in_ms: CFG.AD_TICKET_TTL_MS - CFG.AD_TICKET_SOFT_GRACE_MS,
    // AdsGram resilience config
    ad_load_timeout_ms:  CFG.AD_LOAD_TIMEOUT_MS,
    ad_load_max_retries: CFG.AD_LOAD_MAX_RETRIES,
  };
  await saveIdempotency(requestId, userId, 'start_ad_session', result);
  return result;
}


// ── mark_ad_watched ───────────────────────────────────────────────
async function handleMarkAdWatched(userId, sessionId, ipHash, fpHash, body, requestId) {
  const cached = await checkIdempotency(requestId, userId);
  if (cached) return cached;

  const ticketId        = body?.data?.ticket_id   || '';
  const clientStartedAt = parseInt(body?.data?.ad_started_at) || 0;

  if (!ticketId) {
    await addRisk(userId, 'mark_watched_no_ticket', ipHash, fpHash, 10);
    return { ok: false, error: 'missing_ticket' };
  }

  const ticketRows = await sql(
    `SELECT * FROM ad_tickets WHERE ticket_id=$1 AND user_id=$2`,
    [ticketId, userId]
  );
  if (!ticketRows.length) {
    await addRisk(userId, 'invalid_ticket_mark_watched', ipHash, fpHash, 15);
    return { ok: false, error: 'ticket_not_found' };
  }
  const t = ticketRows[0];

  if (t.is_consumed) return { ok: false, error: 'ticket_consumed' };

  // Soft expiry check
  const now       = Date.now();
  const hardExpiry = new Date(t.expires_at).getTime();
  const softExpiry = t.soft_expires_at ? new Date(t.soft_expires_at).getTime() : hardExpiry;

  if (now > hardExpiry + CFG.AD_TICKET_SOFT_GRACE_MS) {
    // Ticket منتهي كلياً — لكن نسمح بـ refresh
    return {
      ok: false,
      error: 'ticket_expired',
      can_refresh: true,
      refresh_message: 'ticket_expired_please_restart',
    };
  }

  // توقيع الـ ticket
  const expectedSig = signTicket(
    ticketId, userId, sessionId, fpHash, ipHash, 'reward_ad',
    t.expires_at.toISOString ? t.expires_at.toISOString() : String(t.expires_at)
  );
  if (!constantTimeCompare(t.signature, expectedSig)) {
    await addRisk(userId, 'ticket_sig_tampered', ipHash, fpHash, 30);
    return { ok: false, error: 'ticket_invalid' };
  }

  // Server-side timing check — مع mobile grace
  const sessRow = (await sql(`SELECT ad_started_at FROM sessions WHERE id=$1`, [sessionId]))[0];
  if (sessRow?.ad_started_at) {
    const serverElapsed = Date.now() - new Date(sessRow.ad_started_at).getTime();
    const minWithGrace  = CFG.AD_MIN_DURATION_MS - CFG.RATE_MOBILE_GRACE_MS; // grace للموبايل
    if (serverElapsed < minWithGrace) {
      await addRisk(userId, 'ad_too_fast_server', ipHash, fpHash, 15);
      await writeAudit(userId, sessionId, 'mark_ad_watched', 'timing_invalid', ipHash, fpHash, false, {
        request_id: requestId, elapsed_ms: serverElapsed, min_ms: minWithGrace,
      });
      return { ok: false, error: 'ad_duration_invalid', min_ms: CFG.AD_MIN_DURATION_MS };
    }
  }

  // تحويل الـ state: → CLAIM_ALLOWED
  await sql(
    `UPDATE ad_tickets SET state='CLAIM_ALLOWED', watched_at=NOW() WHERE ticket_id=$1`,
    [ticketId]
  );
  await transitionAdState(userId, 'START_AD', 'CLAIM_ALLOWED', sessionId, ipHash, fpHash, requestId);

  await writeAudit(userId, sessionId, 'mark_ad_watched', 'ok', ipHash, fpHash, false, {
    request_id: requestId, ticket_id: ticketId.slice(0, 8) + '...',
  });

  const result = { ok: true, ticket_id };
  await saveIdempotency(requestId, userId, 'mark_ad_watched', result);
  return result;
}


// ── reward_ad — Full Atomic + Soft Lock + Tolerant ────────────────
async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, requestId) {
  const cached = await checkIdempotency(requestId, userId);
  if (cached) return cached;

  const ticketId = body?.data?.ticket_id || '';

  // Soft Lock — wait + retry
  const lockAcquired = await tryAcquireLock(userId);
  if (!lockAcquired) {
    // بعد retry لم يُحصل على lock → collision حقيقي
    await addRisk(userId, 'reward_lock_collision', ipHash, fpHash, 10);
    await writeAudit(userId, sessionId, 'reward_ad', 'lock_collision', ipHash, fpHash, true, {
      request_id: requestId,
    });
    return { ok: false, error: 'concurrent_request', wait_ms: 2000 };
  }

  try {
    // Daily limit
    const adR = await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
    const watchedToday = parseInt(adR[0]?.count) || 0;
    if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
      return { ok: false, error: 'daily_limit_reached' };
    }

    // Cooldown
    const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
    if (coolRow?.ad_last_reward) {
      const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
      if (elapsed < CFG.AD_COOLDOWN_MS) {
        return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS - elapsed };
      }
    }

    // Replay detection — نافذة أصغر (25s) لتقليل false positives
    const recentReward = await sql(
      `SELECT id FROM audit_log
       WHERE user_id=$1 AND action='reward_ad' AND status='ok'
         AND created_at > NOW() - INTERVAL '25 seconds'
       LIMIT 1`,
      [userId]
    );
    if (recentReward.length) {
      // replay قريب جداً — قد يكون double-tap، لكن لا نُعطي risk
      return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS };
    }

    // Shadow ban
    const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
    if (uR[0]?.is_shadow_banned) {
      await writeAudit(userId, sessionId, 'reward_ad', 'shadow', ipHash, fpHash, false, { request_id: requestId });
      const pts = parseInt((await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0]?.points) || 0;
      const result = {
        ok: true,
        remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watchedToday),
        watchedToday, earnedToday: watchedToday * CFG.POINTS_PER_AD,
        points: pts, all_done: watchedToday >= CFG.ADS_DAILY_LIMIT,
      };
      await saveIdempotency(requestId, userId, 'reward_ad', result);
      return result;
    }

    // Consume ticket — مع soft grace
    let ticketConsumed = false;
    if (ticketId) {
      const consumeResult = await consumeAdTicket(ticketId, userId, sessionId, fpHash, ipHash);
      if (!consumeResult.ok) {
        // فحص هل هو خطأ abuse حقيقي أم مجرد soft expiry
        const isRealAbuse = ['ticket_sig_invalid','ticket_fp_mismatch',
                             'ticket_ip_mismatch','ticket_user_mismatch'].includes(consumeResult.reason);
        if (isRealAbuse) {
          await addRisk(userId, `ticket_invalid_${consumeResult.reason}`, ipHash, fpHash, 25);
        }
        // soft expiry — اقترح refresh
        if (consumeResult.reason === 'ticket_expired') {
          return {
            ok: false,
            error: 'ticket_expired',
            can_refresh: true,
            // العميل يعيد start_ad_session تلقائياً
          };
        }
        await writeAudit(userId, sessionId, 'reward_ad', 'ticket_failed', ipHash, fpHash, false, {
          request_id: requestId, reason: consumeResult.reason,
        });
        return { ok: false, error: 'ticket_invalid', detail: consumeResult.reason };
      }
      ticketConsumed = true;
    } else {
      // بدون ticket — رفض (الـ ticket إلزامي الآن)
      return { ok: false, error: 'missing_ticket' };
    }

    // إضافة النقاط atomically
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
           ad_state='IDLE',
           updated_at=NOW()
       WHERE id=$2`,
      [CFG.POINTS_PER_AD, userId]
    );

    await syncLevel(userId);
    if (watched >= 10) await upsertTask(userId, 'ads_10');
    if (watched >= 25) await upsertTask(userId, 'ads_25');

    await writeAudit(userId, sessionId, 'reward_ad', 'ok', ipHash, fpHash, false, {
      request_id: requestId, watched, points_earned: CFG.POINTS_PER_AD,
      ticket_used: ticketConsumed,
    });

    const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
    const result = {
      ok:           true,
      remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
      watchedToday: watched,
      earnedToday:  parseInt(lr[0].points_earned) || 0,
      points:       parseInt(ur[0]?.points) || 0,
      all_done:     watched >= CFG.ADS_DAILY_LIMIT,
    };

    await saveIdempotency(requestId, userId, 'reward_ad', result);
    return result;

  } finally {
    await releaseLock(userId);
  }
}


// ── claim_adsgram_task ────────────────────────────────────────────
async function handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash) {
  const sessRow = (await sql(
    `SELECT adsgram_task_started_at FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  ))[0];

  if (sessRow?.adsgram_task_started_at) {
    const elapsed = Date.now() - new Date(sessRow.adsgram_task_started_at).getTime();
    if (elapsed < CFG.ADSGRAM_TASK_MIN_WATCH_MS) {
      await addRisk(userId, 'adsgram_task_too_fast', ipHash, fpHash, 15);
      return { ok: false, error: 'task_too_fast' };
    }
  }

  const recent = await sql(
    `SELECT completed_at FROM completed_tasks
     WHERE user_id=$1 AND task_key='adsgram_task_daily'
     ORDER BY completed_at DESC LIMIT 1`,
    [userId]
  );
  if (recent.length) {
    const elapsed = Date.now() - new Date(recent[0].completed_at).getTime();
    if (elapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      return { ok: false, error: 'already_claimed_today', wait_ms: CFG.ADSGRAM_TASK_COOLDOWN_MS - elapsed };
    }
  }

  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
    return { ok: true, points: parseInt(ur[0]?.points) || 0, earned: CFG.ADSGRAM_TASK_POINTS };
  }

  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [CFG.ADSGRAM_TASK_POINTS, userId]
  );
  await sql(
    `INSERT INTO completed_tasks(user_id, task_key, completed_at)
     VALUES($1, 'adsgram_task_daily', NOW())`,
    [userId]
  );
  await sql(`UPDATE sessions SET adsgram_task_started_at=NULL WHERE id=$1`, [sessionId]);
  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, false, {
    points: CFG.ADSGRAM_TASK_POINTS,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return { ok: true, points: parseInt(ur[0]?.points) || 0, earned: CFG.ADSGRAM_TASK_POINTS };
}


// ── claim_gift ────────────────────────────────────────────────────
async function handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_gift');
  if (result !== 'ok' && result !== 'replay_grace') {
    return { ok: false, error: result };
  }

  const r = await sql(`SELECT last_gift_date, streak_day FROM users WHERE id=$1`, [userId]);
  const u = r[0];
  const today = new Date().toISOString().slice(0, 10);
  const last  = u.last_gift_date ? String(u.last_gift_date).slice(0, 10) : '';
  if (last === today) return { ok: false, error: 'already_claimed_today' };
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const newStreak = last === yesterday ? (parseInt(u.streak_day) || 0) + 1 : 1;
  const reward    = giftReward(newStreak);
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, streak_day=$2, last_gift_date=$3::date, updated_at=NOW() WHERE id=$4`,
    [reward, newStreak, today, userId]
  );
  await syncLevel(userId);
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'claim_gift', 'ok', ipHash, fpHash, false, { reward, streak: newStreak });
  return { ok: true, reward, streak_day: newStreak, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}


// ── verify_tg_task ────────────────────────────────────────────────
async function handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_tg_task');
  if (result !== 'ok' && result !== 'replay_grace') {
    return { ok: false, error: result };
  }

  const r = await sql(`SELECT tg_verified FROM users WHERE id=$1`, [userId]);
  if (r[0]?.tg_verified) return { ok: false, error: 'already_verified' };
  await sql(
    `UPDATE users SET tg_verified=TRUE, points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2 AND tg_verified=FALSE`,
    [CFG.POINTS_PER_TG_TASK, userId]
  );
  await syncLevel(userId);
  await upsertTask(userId, 'tg_join');
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_tg_task', 'ok', ipHash, fpHash, false, { reward: CFG.POINTS_PER_TG_TASK });
  return { ok: true, reward: CFG.POINTS_PER_TG_TASK, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}


// ── submit_withdraw ───────────────────────────────────────────────
async function handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'submit_withdraw');
  if (result !== 'ok') return { ok: false, error: result };

  const address = (body?.data?.address || '').trim();
  if (!isValidTon(address)) return { ok: false, error: 'invalid_address' };

  const u = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  const pts = parseInt(u.points) || 0;
  if (parseInt(u.level) < CFG.WITHDRAW_MIN_LEVEL) return { ok: false, error: 'level_too_low', required: CFG.WITHDRAW_MIN_LEVEL };
  if (pts < CFG.WITHDRAW_MIN_PTS) return { ok: false, error: 'insufficient_balance', required: CFG.WITHDRAW_MIN_PTS, have: pts };

  const ton = parseFloat((pts / CFG.PTS_PER_TON).toFixed(6));
  await sql(`UPDATE users SET points=points-$1, updated_at=NOW() WHERE id=$2`, [pts, userId]);
  const wr = await sql(
    `INSERT INTO withdrawals(user_id, pts, ton_amount, address, method, status) VALUES($1,$2,$3,$4,'ton','pending') RETURNING id`,
    [userId, pts, ton, address]
  );
  const nb = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, false, { pts, ton });
  return {
    ok: true,
    withdraw_id: wr[0].id,
    pts_deducted: pts,
    ton_amount: ton,
    new_balance: parseInt(nb?.points) || 0,
    status: 'pending',
  };
}


async function handleGetReferrals(userId) {
  const r  = (await sql(`SELECT total_referrals, earned_from_refs, tg_id FROM users WHERE id=$1`, [userId]))[0];
  const rR = await sql(
    `SELECT u.tg_first_name, u.tg_username, u.created_at
     FROM referrals ref
     JOIN users u ON u.id=ref.referred_id
     WHERE ref.referrer_id=$1
     ORDER BY ref.created_at DESC LIMIT 20`,
    [userId]
  );
  return {
    ok: true,
    total_referrals:  r.total_referrals,
    earned_from_refs: parseInt(r.earned_from_refs) || 0,
    pts_per_referral: CFG.POINTS_PER_REFERRAL,
    referral_list: rR.map(x => ({
      name: x.tg_first_name || x.tg_username || 'مستخدم',
      ts: new Date(x.created_at).getTime(),
    })),
    tg_id: r.tg_id,
  };
}


// ── track_ad_event — AdsGram Resilience Layer ─────────────────────
async function handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash) {
  const allowed = new Set([
    'ad_requested', 'ad_loaded', 'ad_started',
    'ad_failed',    'ad_completed', 'reward_granted',
    'ad_timeout',   'ad_retry',    'ad_sdk_error',
    'suspicious_activity',
  ]);
  const event = body?.data?.event || '';
  if (!allowed.has(event)) return { ok: false, error: 'unknown_event' };

  if (event === 'ad_started') {
    await sql(`UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`, [sessionId]);
  }
  if (event === 'ad_started' && body?.data?.meta?.type === 'adsgram_task') {
    await sql(`UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`, [sessionId]);
  }
  // AdsGram timeout — cleanup stale WATCHING state
  if (event === 'ad_timeout' || event === 'ad_sdk_error') {
    await sql(
      `UPDATE users SET ad_state='IDLE' WHERE id=$1 AND ad_state='WATCHING'`,
      [userId]
    );
    // cleanup stale ticket
    await sql(
      `UPDATE ad_tickets SET state='EXPIRED' WHERE user_id=$1 AND state='START_AD' AND is_consumed=FALSE`,
      [userId]
    );
  }
  // ad_retry — لا risk
  if (event === 'ad_retry') {
    // سجّل فقط — لا penalty
    await writeAudit(userId, sessionId, 'ad_retry', 'tracked', ipHash, fpHash, false, {
      meta: body?.data?.meta || {}, is_grace: true,
    });
    return { ok: true };
  }
  if (event === 'suspicious_activity') {
    const reason = String(body?.data?.reason || 'client_report').slice(0, 50);
    await addRisk(userId, `client_suspicious_${reason}`, ipHash, fpHash, 10);
  }

  await writeAudit(userId, sessionId, event, 'tracked', ipHash, fpHash, false, {
    meta: body?.data?.meta || {},
  });
  return { ok: true };
}


// ── refresh_ticket — Ticket Refresh Endpoint ──────────────────────
// يُستدعى عندما ينتهي الـ ticket في soft grace window
async function handleRefreshTicket(userId, sessionId, ipHash, fpHash, body, requestId) {
  const cached = await checkIdempotency(requestId, userId);
  if (cached) return cached;

  const oldTicketId = body?.data?.ticket_id || '';

  // فحص الـ ticket القديم
  const oldTicket = oldTicketId ? (await sql(
    `SELECT * FROM ad_tickets WHERE ticket_id=$1 AND user_id=$2`,
    [oldTicketId, userId]
  ))[0] : null;

  // يُسمح بـ refresh فقط إذا:
  // 1. الـ ticket القديم منتهي في soft grace (أو غير موجود)
  // 2. الـ state مناسب
  if (oldTicket && oldTicket.is_consumed) {
    return { ok: false, error: 'ticket_already_consumed_cannot_refresh' };
  }

  const adR = await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  if ((parseInt(adR[0]?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  // إصدار ticket جديد + reset state
  await sql(`UPDATE users SET ad_state='IDLE' WHERE id=$1`, [userId]);
  // إلغاء الـ ticket القديم إن وجد
  if (oldTicket) {
    await sql(`UPDATE ad_tickets SET state='EXPIRED', is_consumed=TRUE WHERE ticket_id=$1`, [oldTicketId]);
  }

  const { ticket_id } = await issueAdTicket(userId, sessionId, fpHash, ipHash);
  await sql(`UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`, [sessionId]);
  await transitionAdState(userId, 'IDLE', 'START_AD', sessionId, ipHash, fpHash, requestId);

  await writeAudit(userId, sessionId, 'refresh_ticket', 'ok', ipHash, fpHash, false, {
    request_id: requestId,
    old_ticket: oldTicketId ? oldTicketId.slice(0, 8) : null,
    new_ticket: ticket_id.slice(0, 8),
    is_grace: true,
  });

  const result = {
    ok: true,
    ticket_id,
    expires_in_ms: CFG.AD_TICKET_TTL_MS,
    soft_expires_in_ms: CFG.AD_TICKET_TTL_MS - CFG.AD_TICKET_SOFT_GRACE_MS,
    is_refresh: true,
  };
  await saveIdempotency(requestId, userId, 'refresh_ticket', result);
  return result;
}


// ── Adsgram S2S Callback ──────────────────────────────────────────
async function handleAdsgramCallback(req, res) {
  res.setHeader('Content-Type', 'text/plain');

  const rawUrl = req.url || '';
  const qStart = rawUrl.indexOf('?');
  const query  = qStart >= 0 ? new URLSearchParams(rawUrl.slice(qStart + 1)) : new URLSearchParams();
  const rawId  = query.get('userId') || query.get('userid') || query.get('user_id') || '';

  const tgId = parseInt(rawId, 10);
  if (!tgId || isNaN(tgId) || tgId <= 0) {
    res.status(400).end('invalid_user');
    return;
  }

  res.status(200).end('ok');

  try {
    const ipHash = hashIp(getIp(req));
    const userRows = await sql(`SELECT id, points, is_shadow_banned FROM users WHERE tg_id=$1`, [tgId]);
    if (!userRows.length) {
      await writeAudit(0, 'adsgram_cb', 'adsgram_callback', 'user_not_found', ipHash, null, false, { tg_id: tgId });
      return;
    }
    const user   = userRows[0];
    const userId = user.id;

    if (user.is_shadow_banned) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'shadow_banned', ipHash, null, false, {});
      return;
    }

    const adLog = (await sql(
      `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
      [userId]
    ))[0];
    if ((parseInt(adLog?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'daily_limit', ipHash, null, false, {});
      return;
    }

    const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
    if (coolRow?.ad_last_reward) {
      const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
      if (elapsed < CFG.AD_COOLDOWN_MS) {
        await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'cooldown', ipHash, null, false, { elapsed_ms: elapsed });
        return;
      }
    }

    const recentCb = await sql(
      `SELECT id FROM audit_log
       WHERE user_id=$1 AND action='adsgram_callback' AND status='ok'
         AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [userId]
    );
    if (recentCb.length) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'replay', ipHash, null, false, {});
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

    await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ok', ipHash, null, false, {
      tg_id: tgId, points_earned: CFG.POINTS_PER_AD,
    });

    console.info('[Adsgram CB] ✅ Reward — userId:', userId, 'tgId:', tgId);
  } catch (err) {
    console.error('[Adsgram CB] Error:', err.message);
  }
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
    await sql(`UPDATE users SET is_banned=FALSE, ban_reason=NULL, risk_score=0 WHERE tg_id=$1`, [tgId]);
    return { ok: true };
  }
  if (action === 'stats') {
    const r = (await sql(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER(WHERE created_at > NOW() - INTERVAL '1 day') AS new_today,
        SUM(points) AS total_points,
        COUNT(*) FILTER(WHERE is_banned) AS banned_users
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
  if (action === 'lock_stats') {
    const rows = await sql(
      `SELECT action, COUNT(*) FILTER(WHERE lock_collision=TRUE) AS collisions,
              COUNT(*) FILTER(WHERE is_grace=TRUE) AS grace_count,
              COUNT(*) AS total
       FROM audit_log
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY action ORDER BY collisions DESC`
    );
    return { ok: true, lock_stats: rows };
  }
  if (action === 'risk_stats') {
    const rows = await sql(
      `SELECT event_type, COUNT(*) AS count, SUM(score_delta) AS total_score
       FROM risk_events
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY event_type ORDER BY count DESC LIMIT 50`
    );
    return { ok: true, risk_stats: rows };
  }
  return { ok: false, error: 'unknown_admin_action' };
}


// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  if (req.method === 'GET' && (req.url || '').includes('adsgram-reward')) {
    return handleAdsgramCallback(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers['origin'] || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Init-Data, X-Fingerprint, X-Admin-Secret, X-Session-ID, ' +
    'X-Request-ID, X-Req-Sig, X-Req-Ts, X-Req-Counter'
    // لاحظ: أزلنا X-Nonce من الـ headers العامة — الـ nonce الآن implicit
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'method_not_allowed' });

  let body = req.body;
  let rawBody = '';
  if (typeof body === 'string') {
    rawBody = body;
    try { body = JSON.parse(body); } catch (_) { return res.status(400).json({ error: 'invalid_json' }); }
  } else {
    try { rawBody = JSON.stringify(body); } catch (_) { rawBody = ''; }
  }
  if (!body || typeof body !== 'object') body = {};

  const type = body?.type || '';
  if (!type) return res.status(400).json({ error: 'missing_type' });

  const cookieHeader = req.headers['cookie'] || '';
  const sidMatch     = cookieHeader.match(/(?:^|;)\s*sid=([^;]+)/);
  const sessionId    = (sidMatch ? decodeURIComponent(sidMatch[1]) : '') || req.headers['x-session-id'] || '';

  const fpRaw    = req.headers['x-fingerprint']  || '{}';
  const rawNonce = req.headers['x-nonce']        || ''; // للعمليات التي لا تزال تستخدم legacy nonce
  const adminKey = req.headers['x-admin-secret'] || '';
  const requestId = req.headers['x-request-id']  || '';

  const ipHash = hashIp(getIp(req));
  let fpData = {};
  try { fpData = JSON.parse(fpRaw); } catch (_) {}
  const fpHash = hashFp(fpData);

  // ── Smart Rate Limiting — منفصل read/write مع burst ──────────────
  const READ_OPS  = new Set(['load', 'get_state', 'get_referrals']);
  const WRITE_OPS = new Set([
    'reward_ad', 'claim_gift', 'verify_tg_task', 'submit_withdraw',
    'start_ad_session', 'mark_ad_watched', 'track_ad_event',
    'claim_adsgram_task', 'refresh_ticket',
  ]);
  const isRead  = READ_OPS.has(type);
  const isWrite = WRITE_OPS.has(type);

  if (isRead) {
    if (!slidingWindowRateLimit(`ip_r_${ipHash}`, CFG.RATE_READ_MAX_IP, CFG.RATE_READ_WINDOW_MS, CFG.RATE_BURST_EXTRA)) {
      return res.status(429).json({ ok: false, error: 'rate_limited', retry_after_ms: 5000 });
    }
  } else if (isWrite) {
    if (!slidingWindowRateLimit(`ip_w_${ipHash}`, CFG.RATE_WRITE_MAX_IP, CFG.RATE_WRITE_WINDOW_MS, CFG.RATE_BURST_EXTRA)) {
      return res.status(429).json({ ok: false, error: 'rate_limited', retry_after_ms: 10000 });
    }
  }

  try {
    // ── Admin ─────────────────────────────────────────────────────
    if (type === 'admin') {
      if (adminKey !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.status(200).json(await handleAdmin(body?.action, body));
    }

    // ── Create Session ────────────────────────────────────────────
    if (type === 'create_session') {
      const result = await handleCreateSession(body, ipHash, fpHash, fpData);
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

    // ── Session validation ────────────────────────────────────────
    if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });

    const session = await validateSession(sessionId, ipHash, fpHash);
    if (!session)  return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
    if (session.is_banned || session.cluster_ban) {
      return res.status(403).json({ ok: false, is_banned: true });
    }

    const userId = session.user_id;

    // ── Per-user rate limit ───────────────────────────────────────
    if (isRead) {
      if (!slidingWindowRateLimit(`u_r_${userId}`, CFG.RATE_READ_MAX_USER, CFG.RATE_READ_WINDOW_MS)) {
        return res.status(429).json({ ok: false, error: 'rate_limited', retry_after_ms: 5000 });
      }
    } else if (isWrite) {
      if (!slidingWindowRateLimit(`u_w_${userId}`, CFG.RATE_WRITE_MAX_USER, CFG.RATE_WRITE_WINDOW_MS, CFG.RATE_BURST_EXTRA)) {
        return res.status(429).json({ ok: false, error: 'rate_limited', retry_after_ms: 10000 });
      }
    }

    // ── Implicit Nonce Verification (العمليات الحساسة) ────────────
    const IMPLICIT_NONCE_OPS = new Set([
      'reward_ad', 'start_ad_session', 'mark_ad_watched', 'refresh_ticket',
    ]);
    if (IMPLICIT_NONCE_OPS.has(type)) {
      const nonceCheck = await verifyImplicitNonce(req, session, rawBody, requestId, userId, sessionId);
      if (!nonceCheck.ok && !nonceCheck.skipped) {
        // sig_mismatch بعد grace = تسجيل risk فقط إذا كان abuse حقيقي
        if (nonceCheck.isRealAbuse) {
          await addRisk(userId, 'sig_mismatch_real', ipHash, fpHash, 20);
        }
        return res.status(401).json({ ok: false, error: 'invalid_signature', reason: nonceCheck.reason });
      }

      // إذا كان idempotent replay — أعد النتيجة المحفوظة مباشرة
      if (nonceCheck.isIdempotent) {
        const cached = await checkIdempotency(requestId, userId);
        if (cached) return res.status(200).json(cached);
      }

      // تسجيل request_id بعد النجاح (يتم بعد العملية)
      if (!nonceCheck.isGrace && !nonceCheck.skipped) {
        await incrementSessionCounter(sessionId, userId);
        await recordUsedRequestId(
          requestId, sessionId, userId,
          nonceCheck.counter, session.nonce_seed || '', type
        );
      }
    }

    let result;
    switch (type) {
      case 'load':
        result = await handleLoad(userId);
        break;

      case 'get_state':
        result = await handleGetState(userId);
        break;

      case 'start_ad_session':
        result = await handleStartAdSession(userId, sessionId, ipHash, fpHash, requestId);
        break;

      case 'mark_ad_watched':
        result = await handleMarkAdWatched(userId, sessionId, ipHash, fpHash, body, requestId);
        break;

      case 'reward_ad':
        result = await handleRewardAd(userId, sessionId, ipHash, fpHash, body, requestId);
        break;

      case 'refresh_ticket':
        result = await handleRefreshTicket(userId, sessionId, ipHash, fpHash, body, requestId);
        break;

      case 'claim_gift':
        result = await handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash);
        break;

      case 'verify_tg_task':
        result = await handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash);
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

      case 'claim_adsgram_task':
        result = await handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash);
        break;

      default:
        result = { ok: false, error: 'unknown_action' };
    }

    // Shadow ban: نُرجع ok:true للعمليات الفاشلة
    if (session.is_shadow_banned && isWrite && !result.ok) {
      result = { ok: true };
    }

    return res.status(200).json(result);

  } catch (e) {
    console.error(`[${type}]`, e.message);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      ...(IS_DEV && { detail: e.message }),
    });
  }
};
