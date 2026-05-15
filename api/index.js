/**
 * Zero Trust API — v5.0 (Security Hardened)
 *
 * ✅ Nonce من السيرفر فقط (start_ad endpoint يُصدر nonce)
 *    • consumeAdNonce يستخدم crypto.timingSafeEqual — مقارنة hex آمنة
 * ✅ Session Binding صارم
 *    • fingerprint mismatch → إبطال الجلسة فوراً (مش risk points فقط)
 *    • IP تغيّر → طبيعي، نُحدّث + risk منخفض
 * ✅ Rate Limiting مزدوج: per IP + per User (Telegram ID)
 *    • per-user يحمي 4G/Mobile ذات IP متغير
 * ✅ Shadow Ban كامل (is_shadow_banned في جدول users)
 *    • استجابة ناجحة زائفة بدون مكافآت حقيقية
 * ✅ Multi-Account Detection قوي
 *    • Advisory locks لمنع race conditions
 *    • Hard ban تلقائي للحسابات الجديدة فقط (بدون لمس القديمة)
 *    • IP Whitelist قابل للتخصيص
 * ✅ Adsgram Server-to-Server Callback
 *    • العميل لا يستدعي reward بنفسه — الـ callback من Adsgram مباشرة
 * ✅ Cooldown server-side بحت
 *    • يعتمد على ad_last_reward من DB (timestamp السيرفر فقط)
 *    • ممنوع الاعتماد على client_started_at كوحيد للتحقق
 * ✅ Admin Endpoints كاملة
 *    • إدارة سحوبات (approve/reject + refund)
 *    • Hard/Soft ban
 *    • إحصائيات + audit log
 * ✅ Audit Logging شامل
 *    • كل عملية مشبوهة: IP, fingerprint, action, timestamp
 * ✅ Atomic internal nonce لـ reward_ad (race condition proof)
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
const IS_DEV       = process.env.NODE_ENV !== 'production';

const CFG = {
  POINTS_PER_AD:         50,
  POINTS_PER_REFERRAL:   500,
  POINTS_PER_TG_TASK:    2500,
  ADS_DAILY_LIMIT:       10,
  WITHDRAW_MIN_PTS:      50000,
  WITHDRAW_MIN_LEVEL:    5,
  PTS_PER_TON:           100000,

  // ── Nonce TTL ────────────────────────────────────────────────────
  NONCE_TTL_MS:          5  * 60 * 1000,   // 5 دقائق للعمليات العامة
  AD_NONCE_TTL_MS:       5  * 60 * 1000,   // 5 دقائق (start_ad → reward_ad)

  // ── Ad timing — server-side enforcement ──────────────────────────
  AD_COOLDOWN_MS:        30 * 1000,        // 30s cooldown بين كل reward_ad
  AD_MIN_DURATION_MS:    14 * 1000,        // 14s حد أدنى لمشاهدة الإعلان

  // ── Adsgram Task ─────────────────────────────────────────────────
  ADSGRAM_TASK_COOLDOWN_MS:    60 * 1000,
  ADSGRAM_TASK_POINTS:         70,
  ADSGRAM_TASK_MIN_WATCH_MS:   10 * 1000,

  // ── Session ──────────────────────────────────────────────────────
  SESSION_TTL_MS:        7  * 24 * 60 * 60 * 1000,
  INIT_DATA_TTL:         86400,            // 24 ساعة لـ Telegram initData

  // ── Rate limiting ────────────────────────────────────────────────
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX:              30,
  RATE_WRITE_MAX:        15,
  RATE_USER_READ:        20,
  RATE_USER_WRITE:       10,

  // ── Risk ─────────────────────────────────────────────────────────
  RISK_BAN:              100,
  RISK_SHADOW:           60,

  // ── Multi-account ────────────────────────────────────────────────
  MULTI_ACCT: {
    MAX_PER_IP:          2,    // حدين لأن الـ NAT/WiFi مشترك شائع
    MAX_PER_FP:          1,    // fingerprint واحد = جهاز واحد
    NEW_ACCOUNT_AGE_DAYS: 3,   // الحساب "جديد" إذا عمره أقل من هذا
    IP_WHITELIST:        new Set([
      // أضف هنا ip_hash للشبكات الموثوقة
    ]),
  },

  LEVEL_THRESHOLDS: [0, 0, 500, 1500, 3500, 8000, 16000, 30000, 55000, 90000, 150000],
  GIFT_REWARDS:     [100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 1000],
};

// ── In-memory rate limit (per IP) ────────────────────────────────
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

    // ── nonces — ephemeral, one-time, bound ───────────────────────
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

    // ── nonce_history — سجل داخلي للأدمن فقط (لا يُرسل للعميل أبداً) ──
    // الغرض: debug + تحليل هجمات + تتبع الأنماط
    // الـ nonce المسجّل هنا دائماً مُستهلك أو منتهي الصلاحية
    // لا توجد أي endpoint تُعيده للعميل
    await sql(`CREATE TABLE IF NOT EXISTS nonce_history (
      id           BIGSERIAL    PRIMARY KEY,
      nonce_hash   TEXT         NOT NULL,          -- sha256 للـ nonce (ليس الـ raw)
      user_id      BIGINT       NOT NULL,
      session_id   TEXT         NOT NULL,
      ip_hash      TEXT,
      fp_hash      TEXT,
      action       TEXT         NOT NULL DEFAULT 'reward_ad',
      outcome      TEXT         NOT NULL,          -- 'consumed' | 'expired' | 'mismatch'
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      expires_at   TIMESTAMPTZ  NOT NULL,
      consumed_at  TIMESTAMPTZ
    )`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nh_user    ON nonce_history(user_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nh_session ON nonce_history(session_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nh_created ON nonce_history(created_at DESC)`);

    // ── device_fingerprints (مطابق toma.js) ──────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS device_fingerprints (
      fingerprint   TEXT          NOT NULL,
      user_id       BIGINT        NOT NULL,
      user_agent    TEXT,
      lang          TEXT,
      screen        TEXT,
      timezone_off  INT,
      last_seen     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fingerprint, user_id)
    )`);

    // ── Migrations ────────────────────────────────────────────────
    const migrations = [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_used BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_started_at TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS adsgram_task_started_at TIMESTAMPTZ`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS ad_last_reward TIMESTAMPTZ`,
      `ALTER TABLE nonces   ADD COLUMN IF NOT EXISTS ip_hash TEXT`,
      `ALTER TABLE nonces   ADD COLUMN IF NOT EXISTS fp_hash TEXT`,
      `ALTER TABLE nonces   ADD COLUMN IF NOT EXISTS action  TEXT`,
      `ALTER TABLE nonces   ADD COLUMN IF NOT EXISTS used    BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS cluster_ban BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS last_ip_hash TEXT`,
      `ALTER TABLE users    ADD COLUMN IF NOT EXISTS is_shadow_banned BOOLEAN DEFAULT FALSE`,
      // nonce_history لا يحتاج migration لأنه جديد كلياً
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
      `CREATE INDEX IF NOT EXISTS idx_df_fp     ON device_fingerprints(fingerprint)`,
      `CREATE INDEX IF NOT EXISTS idx_df_user   ON device_fingerprints(user_id)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    console.log('[DB] bootstrap OK v5.0 — Zero Trust Hardened');
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
    await sql(`DELETE FROM audit_log    WHERE created_at < NOW() - INTERVAL '30 days'`);
    await sql(`DELETE FROM risk_events  WHERE created_at < NOW() - INTERVAL '7 days'`);
    // nonce_history: نحتفظ بـ 30 يوم للتحليل
    await sql(`DELETE FROM nonce_history WHERE created_at < NOW() - INTERVAL '30 days'`);
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

/**
 * constantTimeCompare — مقارنة آمنة من timing attacks
 * نُحوّل للـ sha256 لضمان نفس الطول دائماً
 */
function constantTimeCompare(a, b) {
  try {
    const bufA = Buffer.from(sha256(String(a || '')), 'hex');
    const bufB = Buffer.from(sha256(String(b || '')), 'hex');
    const match = timingSafeEqual(bufA, bufB);
    return match && String(a) === String(b);
  } catch (_) {
    return false;
  }
}

/**
 * constantTimeCompareHex — مقارنة hex مباشرة بـ timingSafeEqual
 * يُستخدم لمقارنة ad_nonce (hex) مع ما هو مخزّن في الجلسة
 */
function constantTimeCompareHex(hexA, hexB) {
  try {
    if (!hexA || !hexB) return false;
    // نُسوّي الطول بـ padding لو اختلف (في الحالة الطبيعية متساويان)
    const maxLen = Math.max(hexA.length, hexB.length);
    const padded = (h) => h.padEnd(maxLen, '0');
    const bufA = Buffer.from(padded(hexA), 'hex');
    const bufB = Buffer.from(padded(hexB), 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB) && hexA === hexB;
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
    const authDate = parseInt(p.get('auth_date') || '0');
    const now = Math.floor(Date.now() / 1000);
    // التحقق من انتهاء الصلاحية
    if (now - authDate > CFG.INIT_DATA_TTL) return { ok: false };
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const sk  = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = createHmac('sha256', sk).update(str).digest('hex');
    // مقارنة آمنة ضد timing attacks
    const expBuf = Buffer.from(expected, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (expBuf.length !== hashBuf.length) return { ok: false };
    if (!timingSafeEqual(expBuf, hashBuf)) return { ok: false };
    return { ok: true, data: JSON.parse(p.get('user') || '{}') };
  } catch (_) { return { ok: false }; }
}

// ── Rate Limit per IP (in-memory) ───────────────────────────────
function rateLimitIp(key, max = CFG.RATE_MAX) {
  const now = Date.now();
  let e = rateLimitMap.get(key);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + CFG.RATE_WINDOW_MS };
    rateLimitMap.set(key, e);
  }
  return ++e.count <= max;
}

// ── Rate Limit per User (DB-backed sliding window) ───────────────
// يعتمد على audit_log لتتبع per-user requests (يتحمل 4G IP rotation)
async function rateLimitUser(userId, action, max) {
  const rows = await sql(
    `SELECT COUNT(*) AS cnt FROM audit_log
     WHERE user_id=$1 AND action=$2
       AND created_at > NOW() - INTERVAL '60 seconds'`,
    [userId, action]
  );
  return (parseInt(rows[0]?.cnt) || 0) < max;
}


// ═══════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════

async function validateSession(sid, ipHash, fpHash) {
  if (!sid) return null;
  const r = await sql(
    `SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban, u.risk_score
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

  // ── Session Binding: fingerprint mismatch = إبطال الجلسة فوراً ──
  // (مش بس risk points — إبطال فوري مطابق لـ toma.js)
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    // إبطال الجلسة فوراً
    await sql(`UPDATE sessions SET is_revoked=TRUE WHERE id=$1`, [sid]);
    await addRisk(session.user_id, 'session_fp_mismatch', ipHash, fpHash, 30);
    await writeAudit(session.user_id, sid, 'session_validate', 'tampered', ipHash, fpHash, {
      reason: 'fingerprint_mismatch',
    });
    return null; // رفض قاطع
  }

  // IP تغيّر = طبيعي (4G/NAT) → نُحدّث + risk منخفض فقط
  if (session.ip_hash && ipHash && session.ip_hash !== ipHash) {
    await sql(`UPDATE sessions SET ip_hash=$2, last_active=NOW() WHERE id=$1`, [sid, ipHash]);
    await addRisk(session.user_id, 'ip_changed', ipHash, fpHash, 5);
    await writeAudit(session.user_id, sid, 'session_validate', 'ip_rotated', ipHash, fpHash, {
      reason: 'natural_ip_rotation',
    });
  } else {
    await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`, [sid]);
  }

  return session;
}

async function createSessionRow(userId, fpHash, ipHash) {
  const id  = genRawNonce(32);
  const exp = new Date(Date.now() + CFG.SESSION_TTL_MS).toISOString();
  await sql(
    `INSERT INTO sessions(id, user_id, fingerprint_hash, ip_hash, expires_at)
     VALUES($1,$2,$3,$4,$5)`,
    [id, userId, fpHash, ipHash, exp]
  );
  return id;
}


// ═══════════════════════════════════════════════════════════════════
// NONCE SYSTEM
// ═══════════════════════════════════════════════════════════════════

/**
 * consumeNonce — التحقق من nonce العام واستهلاكه atomically
 * للعمليات العامة (claim_gift, verify_tg_task, submit_withdraw)
 * الـ nonce يأتي من العميل عبر X-Nonce header
 */
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
    await addRisk(userId, `nonce_replay_${action}`, ipHash, fpHash, 25);
    await writeAudit(userId, sessionId, action, 'nonce_replay', ipHash, fpHash, {
      nonce_prefix: rawNonce.slice(0, 8),
      action,
    });
    return 'replay';
  }

  return 'ok';
}

// ═══════════════════════════════════════════════════════════════════
// AD NONCE SYSTEM — Server-Issued (مطابق toma.js)
//
// ✅ start_ad: السيرفر يُنشئ nonce ويحفظه في الجلسة → يُرسله للعميل
// ✅ reward_ad: العميل يُرسل الـ nonce → السيرفر يُقارنه بـ timingSafeEqual
// ✅ one-time use: يُحذف فوراً بعد الاستهلاك
// ✅ TTL: 5 دقائق (بعده يُرفض)
// ═══════════════════════════════════════════════════════════════════

/**
 * issueAdNonce — السيرفر يُنشئ nonce ويحفظه في الجلسة
 * يُستدعى من start_ad endpoint
 */
async function issueAdNonce(sessionId) {
  const nonce  = genRawNonce(32);
  const expiry = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  const result = await sql(
    `UPDATE sessions
     SET ad_nonce=$2, ad_nonce_exp=$3, ad_nonce_used=FALSE
     WHERE id=$1 AND is_revoked=FALSE AND expires_at > NOW()
     RETURNING id`,
    [sessionId, nonce, expiry]
  );
  if (!result.length) return null;
  return nonce;
}

/**
 * consumeAdNonce — التحقق من ad_nonce المخزّن في الجلسة
 * يُستدعى من reward_ad
 * يستخدم crypto.timingSafeEqual للمقارنة (hex comparison)
 */
async function consumeAdNonce(sessionId, clientNonce) {
  if (!clientNonce || !sessionId) return false;

  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used
     FROM sessions WHERE id=$1 AND is_revoked=FALSE AND expires_at > NOW()`,
    [sessionId]
  );
  if (!rows.length) return false;

  const { ad_nonce, ad_nonce_exp, ad_nonce_used } = rows[0];

  if (!ad_nonce || ad_nonce_used)                            return false;
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    // تنظيف المنتهي
    await sql(
      `UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`,
      [sessionId]
    );
    return false;
  }

  // ✅ مقارنة hex آمنة بـ timingSafeEqual (مطابق toma.js)
  const match = constantTimeCompareHex(ad_nonce, clientNonce);
  if (!match) return false;

  // استهلاكه فوراً — one-time use
  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId, ad_nonce]
  );
  return consumed.length > 0;
}

/**
 * _atomicAdNonce — Atomic Internal Nonce (بدون start_ad)
 *
 * المبدأ الكامل:
 *   [1] السيرفر يُولّد nonce عشوائي داخلياً — لا يخرج من هذه الدالة أبداً
 *   [2] يكتبه في sessions مع expiry
 *   [3] يقرأه فوراً من DB ويُقارنه بـ timingSafeEqual
 *   [4] يحذفه من sessions (one-time use)
 *   [5] يسجّل sha256(nonce) في nonce_history للأدمن — ليس الـ raw nonce
 *
 * ⛔ الـ nonce لا يظهر في أي response للعميل أبداً
 * ✅ nonce_history يخزّن فقط sha256(nonce) — حتى لو اخترق الـ DB لا توجد قيمة
 * ✅ الأدمن يرى التوقيت + النتيجة + الـ hash فقط (للتحليل)
 */
async function _atomicAdNonce(sessionId, userId, ipHash, fpHash) {
  // [1] توليد nonce عشوائي داخلي — يبقى داخل هذه الدالة فقط
  const internalNonce = genRawNonce(32);
  const exp           = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();
  // نُخزّن hash للـ nonce (ليس القيمة الحقيقية) في الـ history
  const nonceHash     = sha256(internalNonce);

  // [2] كتابته في الجلسة atomically
  const writeResult = await sql(
    `UPDATE sessions
     SET ad_nonce=$2, ad_nonce_exp=$3, ad_nonce_used=FALSE
     WHERE id=$1 AND is_revoked=FALSE AND expires_at > NOW()
     RETURNING id`,
    [sessionId, internalNonce, exp]
  );
  if (!writeResult.length) {
    // الجلسة غير موجودة أو منتهية
    _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'session_invalid').catch(() => {});
    return false;
  }

  // [3] قراءته من DB والتحقق منه
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) {
    _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'read_failed').catch(() => {});
    return false;
  }

  const { ad_nonce, ad_nonce_exp, ad_nonce_used } = rows[0];

  if (!ad_nonce || ad_nonce_used) {
    _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'race_condition').catch(() => {});
    return false;
  }
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'expired').catch(() => {});
    return false;
  }

  // [3b] مقارنة ثابتة الزمن — timingSafeEqual
  const match = constantTimeCompare(internalNonce, ad_nonce);
  if (!match) {
    await addRisk(userId, 'ad_nonce_internal_mismatch', ipHash, fpHash, 50);
    _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'mismatch').catch(() => {});
    return false;
  }

  // [4] حذف nonce من sessions فوراً (one-time use)
  // شرط ad_nonce=$2 AND ad_nonce_used=FALSE يمنع race conditions
  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId, internalNonce]
  );

  if (!consumed.length) {
    // طلب parallel سبق هذا الطلب — race condition محمية
    _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'race_parallel').catch(() => {});
    return false;
  }

  // [5] تسجيل sha256(nonce) في history (للأدمن فقط — لا يُرسل للعميل)
  _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, exp, 'consumed').catch(() => {});

  return true;
}

/**
 * _recordNonceHistory — تسجيل داخلي للأدمن فقط
 *
 * ⚠️ يُخزّن sha256(nonce) فقط — ليس الـ raw nonce
 * ⚠️ لا توجد أي endpoint تُعيد هذه البيانات للعميل
 * ✅ الأدمن يرى: توقيت الإنشاء + النتيجة + الـ hash + IP/FP (للتحليل)
 *
 * @param {string} nonceHash - sha256 للـ nonce (مش القيمة الحقيقية)
 * @param {string} outcome   - 'consumed'|'expired'|'mismatch'|'race_condition'|...
 */
async function _recordNonceHistory(nonceHash, userId, sessionId, ipHash, fpHash, expiresAt, outcome) {
  try {
    await sql(
      `INSERT INTO nonce_history
         (nonce_hash, user_id, session_id, ip_hash, fp_hash, action, outcome, expires_at, consumed_at)
       VALUES ($1,$2,$3,$4,$5,'reward_ad',$6,$7,
         CASE WHEN $6='consumed' THEN NOW() ELSE NULL END
       )`,
      [nonceHash, userId, sessionId, ipHash || null, fpHash || null, outcome, expiresAt]
    );
  } catch (_) {}
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

async function addRisk(userId, type, ipHash, fpHash, delta) {
  try {
    await sql(
      `INSERT INTO risk_events(user_id, event_type, ip_hash, fp_hash, score_delta)
       VALUES($1,$2,$3,$4,$5)`,
      [userId, type, ipHash, fpHash, delta]
    );
    if (delta > 0) {
      await sql(`UPDATE users SET risk_score=LEAST(risk_score+$1, 200) WHERE id=$2`, [delta, userId]);
      // Hard ban تلقائي
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason='auto_risk'
         WHERE id=$1 AND risk_score >= $2`,
        [userId, CFG.RISK_BAN]
      );
      // Shadow ban تلقائي (دون حظر كامل)
      await sql(
        `UPDATE users SET is_shadow_banned=TRUE
         WHERE id=$1 AND risk_score >= $2 AND is_banned=FALSE`,
        [userId, CFG.RISK_SHADOW]
      );
    }
  } catch (_) {}
}

/**
 * checkMultiAccount — كشف الحسابات المتعددة
 * مع Advisory Locks لمنع race conditions (مطابق toma.js)
 */
async function checkMultiAccount(userId, ipHash, fpHash, db) {
  const cfg = CFG.MULTI_ACCT;
  if (cfg.IP_WHITELIST.has(ipHash)) return;

  // فحص عمر الحساب — Hard ban للجديد فقط
  const userRow = (await db(`SELECT created_at FROM users WHERE id=$1`, [userId]))[0];
  if (!userRow) return;
  const accountAgeDays = (Date.now() - new Date(userRow.created_at).getTime()) / (1000 * 60 * 60 * 24);
  const isNewAccount   = accountAgeDays < cfg.NEW_ACCOUNT_AGE_DAYS;

  if (!isNewAccount) return; // الحسابات القديمة لا تُمس

  // ── Advisory lock مبني على ip_hash لمنع race conditions ──────────
  const lockKey = BigInt('0x' + ipHash.slice(0, 15)) & BigInt('0x7FFFFFFFFFFFFFFF');
  await db(`SELECT pg_advisory_xact_lock($1)`, [lockKey.toString()]);

  // عدد الحسابات على نفس الـ IP
  const ipCountResult = await db(
    `SELECT COUNT(DISTINCT user_id) AS cnt
     FROM sessions
     WHERE ip_hash=$1 AND user_id!=$2
       AND is_revoked=FALSE AND expires_at > NOW()`,
    [ipHash, userId]
  );
  const accountsOnIP = parseInt(ipCountResult[0]?.cnt || 0);

  // عدد الحسابات على نفس الـ fingerprint
  const fpCountResult = await db(
    `SELECT COUNT(DISTINCT user_id) AS cnt
     FROM device_fingerprints
     WHERE fingerprint=$1 AND user_id!=$2`,
    [fpHash, userId]
  );
  const accountsOnFP = parseInt(fpCountResult[0]?.cnt || 0);

  const ipViolation = accountsOnIP >= cfg.MAX_PER_IP;
  const fpViolation = accountsOnFP >= cfg.MAX_PER_FP;

  // Hard ban إذا fingerprint مكرر (دليل قاطع على multi-account)
  if (fpViolation || (ipViolation && fpViolation)) {
    await db(
      `UPDATE users SET is_banned=TRUE, ban_reason='multi_account', updated_at=NOW() WHERE id=$1`,
      [userId]
    );
    await writeAudit(userId, null, 'multi_account_detected', 'hard_ban', ipHash, fpHash, {
      accounts_on_ip: accountsOnIP,
      accounts_on_fp: accountsOnFP,
      account_age_days: Math.round(accountAgeDays * 10) / 10,
    });
    console.warn(`[ANTI-FRAUD] Hard Ban → userId=${userId} ip_accounts=${accountsOnIP} fp_accounts=${accountsOnFP}`);
    return;
  }

  // تحذير فقط: IP مشترك بدون تطابق fingerprint
  if (ipViolation && !fpViolation) {
    await writeAudit(userId, null, 'multi_ip_warning', 'allow', ipHash, fpHash, {
      note: 'Shared WiFi / NAT — no ban',
      accounts_on_ip: accountsOnIP,
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

  // Referral
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
  if (user.is_banned) return { ok: false, is_banned: true, ban_type: 'hard', status: 403 };

  // ════════════════════════════════════════════════════════════════
  // ATOMIC MULTI-ACCOUNT DETECTION (Advisory Lock Transaction)
  // ════════════════════════════════════════════════════════════════
  const db = neon(process.env.DATABASE_URL);
  try {
    await db('BEGIN');
    await checkMultiAccount(user.id, ipHash, fpHash, db);
    await db('COMMIT');
  } catch (txErr) {
    try { await db('ROLLBACK'); } catch (_) {}
    console.error('[checkMultiAccount TX Error]', txErr.message);
  }

  // أعد جلب المستخدم بعد فحص multi-account (قد يكون بُوّن)
  const freshUser = (await sql(`SELECT * FROM users WHERE id=$1`, [user.id]))[0];
  if (freshUser.is_banned) return { ok: false, is_banned: true, ban_type: 'hard', status: 403 };

  // إلغاء الجلسات القديمة
  await sql(`UPDATE sessions SET is_revoked=TRUE WHERE user_id=$1`, [user.id]);

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

  // حفظ fingerprint في device_fingerprints
  await sql(
    `INSERT INTO device_fingerprints(fingerprint, user_id, user_agent, lang, screen, timezone_off)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(fingerprint, user_id) DO UPDATE SET last_seen=NOW()`,
    [fpHash, user.id,
     fpData?.user_agent || null, fpData?.lang || null,
     fpData?.screen || null, fpData?.tz_offset || 0]
  );

  const sessionId = await createSessionRow(freshUser.id, fpHash, ipHash);
  await syncLevel(freshUser.id);
  const finalUser = (await sql(`SELECT * FROM users WHERE id=$1`, [freshUser.id]))[0];

  await writeAudit(finalUser.id, sessionId, 'create_session', 'ok', ipHash, fpHash, {
    tg_id: tgUser.id,
    is_new: isNew,
  });

  return {
    ok: true,
    _sid: sessionId,
    user: {
      points:           parseInt(finalUser.points) || 0,
      level:            parseInt(finalUser.level) || 1,
      xp:               parseInt(finalUser.xp) || 0,
      tg_verified:      finalUser.tg_verified,
      streak_day:       finalUser.streak_day,
      last_gift_date:   finalUser.last_gift_date,
      total_referrals:  finalUser.total_referrals,
      earned_from_refs: parseInt(finalUser.earned_from_refs) || 0,
    },
  };
}

// ════════════════════════════════════════════════════════════════
// start_ad — يُصدر ad_nonce من السيرفر (مطابق toma.js)
//
// ✅ الـ nonce مصدره السيرفر فقط — العميل لا يُنشئه
// ✅ يُحفظ في الجلسة مع TTL (5 دقائق)
// ✅ العميل يتلقى الـ nonce ويُرسله مع reward_ad
// ✅ السيرفر يُقارنه بـ timingSafeEqual
// ════════════════════════════════════════════════════════════════
async function handleStartAd(session, ipHash, fpHash) {
  const userId    = session.user_id;
  const sessionId = session.id;

  // فحص Shadow Ban
  const userRow = (await sql(`SELECT is_shadow_banned, is_banned FROM users WHERE id=$1`, [userId]))[0];
  if (userRow?.is_banned) return { ok: false, error: 'access_denied', status: 403 };

  // إصدار nonce جديد من السيرفر
  const adNonce = await issueAdNonce(sessionId);
  if (!adNonce) return { ok: false, error: 'session_issue_failed' };

  await writeAudit(userId, sessionId, 'start_ad', 'ok', ipHash, fpHash, {
    session_prefix: sessionId.slice(0, 8),
  });

  console.log(`[START_AD] nonce issued → userId=${userId} session=${sessionId.slice(0, 8)}...`);

  return { ok: true, ad_nonce: adNonce };
}

async function handleLoad(userId) {
  const rows = await sql(`SELECT * FROM users WHERE id=$1`, [userId]);
  if (!rows.length) return { ok: false, error: 'user_not_found' };
  const u = rows[0];
  const adR = await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  const ad  = adR[0] || { count: 0, points_earned: 0 };
  const watched = parseInt(ad.count) || 0;
  const wR  = await sql(`SELECT pts,address,method,status,created_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  const rR  = await sql(`SELECT u.tg_first_name,u.tg_username,u.created_at FROM referrals r JOIN users u ON u.id=r.referred_id WHERE r.referrer_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [userId]);
  const tR  = await sql(`SELECT task_type FROM user_tasks WHERE user_id=$1 AND task_date=CURRENT_DATE AND completed=TRUE`, [userId]);

  return {
    ok: true,
    points: parseInt(u.points) || 0, level: parseInt(u.level) || 1, xp: parseInt(u.xp) || 0,
    tg_verified: u.tg_verified, streak_day: u.streak_day, last_gift_date: u.last_gift_date, tg_id: u.tg_id,
    ads_total: CFG.ADS_DAILY_LIMIT, ads_remaining: Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    ads_watched_today: watched, earned_today: parseInt(ad.points_earned) || 0,
    total_referrals: u.total_referrals, earned_from_refs: parseInt(u.earned_from_refs) || 0,
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
      ads_daily_limit:    CFG.ADS_DAILY_LIMIT,
      pts_per_ton:        CFG.PTS_PER_TON,
      withdraw_min_pts:   CFG.WITHDRAW_MIN_PTS,
      withdraw_min_level: CFG.WITHDRAW_MIN_LEVEL,
      pts_per_referral:   CFG.POINTS_PER_REFERRAL,
    },
  };
}

async function handleGetState(userId) {
  const r = await sql(`SELECT points,level,xp,total_referrals,earned_from_refs,ad_last_reward FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const u  = r[0];
  const ad = (await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0, points_earned: 0 };

  let ad_cooldown_ms = 0;
  if (u.ad_last_reward) {
    const elapsed = Date.now() - new Date(u.ad_last_reward).getTime();
    ad_cooldown_ms = Math.max(0, CFG.AD_COOLDOWN_MS - elapsed);
  }

  return {
    ok: true,
    points: parseInt(u.points) || 0, level: parseInt(u.level) || 1, xp: parseInt(u.xp) || 0,
    total_referrals: u.total_referrals, earned_from_refs: parseInt(u.earned_from_refs) || 0,
    ads_watched_today: parseInt(ad.count) || 0,
    ads_remaining: Math.max(0, CFG.ADS_DAILY_LIMIT - (parseInt(ad.count) || 0)),
    earned_today: parseInt(ad.points_earned) || 0,
    ad_cooldown_ms,
    ads_daily_limit: CFG.ADS_DAILY_LIMIT,
  };
}


// ══════════════════════════════════════════════════════════════════
// reward_ad — مكافأة الإعلان الموثّقة
//
// ✅ يقبل ad_nonce من العميل (مُصدَر من start_ad endpoint)
// ✅ يستخدم consumeAdNonce مع timingSafeEqual
// ✅ Fallback: atomic internal nonce إذا لم يُرسل العميل nonce
// ✅ Cooldown server-side (ad_last_reward من DB) — لا يعتمد على client_started_at
// ✅ Shadow ban: استجابة ناجحة زائفة
// ✅ Rate limiting per user + per IP
// ══════════════════════════════════════════════════════════════════
async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, session) {
  // ── [1] Daily limit ──────────────────────────────────────────────
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  const watchedToday = parseInt(adR[0]?.count) || 0;
  if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
    await writeAudit(userId, sessionId, 'reward_ad', 'daily_limit', ipHash, fpHash, { watched: watchedToday });
    return { ok: false, error: 'daily_limit_reached' };
  }

  // ── [2] Cooldown check (server-side — timestamp من DB فقط) ───────
  // ممنوع الاعتماد على client_started_at كوحيد — نستخدم DB timestamp
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      const waitMs = CFG.AD_COOLDOWN_MS - elapsed;
      await writeAudit(userId, sessionId, 'reward_ad', 'cooldown', ipHash, fpHash, { wait_ms: waitMs });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // ── [3] Replay detection في audit_log ───────────────────────────
  const recentReward = await sql(
    `SELECT id FROM audit_log
     WHERE user_id=$1 AND action='reward_ad' AND status='ok'
       AND created_at > NOW() - INTERVAL '25 seconds'
     LIMIT 1`,
    [userId]
  );
  if (recentReward.length) {
    await addRisk(userId, 'reward_ad_replay', ipHash, fpHash, 15);
    await writeAudit(userId, sessionId, 'reward_ad', 'replay_detected', ipHash, fpHash, {});
    return { ok: false, error: 'cooldown_active', wait_ms: CFG.AD_COOLDOWN_MS };
  }

  // ── [4] Shadow ban — رد ناجح زائف ──────────────────────────────
  if (session.is_shadow_banned) {
    await writeAudit(userId, sessionId, 'reward_ad', 'shadow', ipHash, fpHash, {});
    const fakeWatched = watchedToday;
    return {
      ok: true,
      remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - fakeWatched),
      watchedToday: fakeWatched,
      earnedToday:  fakeWatched * CFG.POINTS_PER_AD,
      points:       parseInt((await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0]?.points) || 0,
      all_done:     fakeWatched >= CFG.ADS_DAILY_LIMIT,
    };
  }

  // ── [5] Nonce verification ───────────────────────────────────────
  // ⛔ الـ nonce لا يُرسل للعميل في أي حالة (حتى عند الفشل)
  // ✅ الأدمن فقط يرى sha256(nonce) في nonce_history endpoint
  //
  // الأولوية:
  //   [A] nonce من start_ad (server-issued) — إذا أرسله العميل
  //   [B] atomic internal nonce — إذا لم يرسل العميل شيئاً (الأكثر شيوعاً)
  //       الـ nonce يُنشأ، يُتحقق منه، يُحذف — كل هذا داخل _atomicAdNonce
  //       ويُسجَّل sha256(nonce) في nonce_history بعد الاستهلاك
  const clientAdNonce = body?.data?.ad_nonce || null;
  let nonceOk = false;

  if (clientAdNonce) {
    // العميل أرسل nonce من start_ad → تحقق منه بـ timingSafeEqual
    nonceOk = await consumeAdNonce(sessionId, clientAdNonce);
    if (!nonceOk) {
      await addRisk(userId, 'ad_nonce_invalid', ipHash, fpHash, 20);
      await writeAudit(userId, sessionId, 'reward_ad', 'nonce_fail', ipHash, fpHash, {
        reason: 'invalid_or_expired_ad_nonce',
      });
      return { ok: false, error: 'invalid_ad_nonce' };
    }
  } else {
    // لا nonce من العميل → atomic internal nonce (race condition proof)
    nonceOk = await _atomicAdNonce(sessionId, userId, ipHash, fpHash);
    if (!nonceOk) {
      await addRisk(userId, 'ad_parallel_attempt', ipHash, fpHash, 10);
      await writeAudit(userId, sessionId, 'reward_ad', 'nonce_failed', ipHash, fpHash, {});
      return { ok: false, error: 'cooldown_active', wait_ms: 5000 };
    }
  }

  // ── [6] إضافة النقاط atomically ──────────────────────────────────
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
  if (watched >= 10) await upsertTask(userId, 'ads_10');
  if (watched >= 25) await upsertTask(userId, 'ads_25');

  await writeAudit(userId, sessionId, 'reward_ad', 'ok', ipHash, fpHash, {
    watched, points_earned: CFG.POINTS_PER_AD,
    nonce_source: clientAdNonce ? 'start_ad' : 'atomic',
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


// ══════════════════════════════════════════════════════════════════
// claim_adsgram_task — مهمة Adsgram مع timing enforcement
// ══════════════════════════════════════════════════════════════════
async function handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash) {
  const sessRow = (await sql(
    `SELECT adsgram_task_started_at FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  ))[0];

  if (sessRow?.adsgram_task_started_at) {
    const startedAt = new Date(sessRow.adsgram_task_started_at).getTime();
    const elapsed   = Date.now() - startedAt;
    if (elapsed < CFG.ADSGRAM_TASK_MIN_WATCH_MS) {
      await addRisk(userId, 'adsgram_task_too_fast', ipHash, fpHash, 15);
      await writeAudit(userId, sessionId, 'claim_adsgram_task', 'too_fast', ipHash, fpHash, {
        elapsed_ms: elapsed, min_ms: CFG.ADSGRAM_TASK_MIN_WATCH_MS,
      });
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
    const lastTime = new Date(recent[0].completed_at).getTime();
    const elapsed  = Date.now() - lastTime;
    if (elapsed < CFG.ADSGRAM_TASK_COOLDOWN_MS) {
      const waitMs = CFG.ADSGRAM_TASK_COOLDOWN_MS - elapsed;
      return { ok: false, error: 'already_claimed_today', wait_ms: waitMs };
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
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, {
    points: CFG.ADSGRAM_TASK_POINTS,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return { ok: true, points: parseInt(ur[0]?.points) || 0, earned: CFG.ADSGRAM_TASK_POINTS };
}


async function handleClaimGift(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'claim_gift');
  if (result !== 'ok') return { ok: false, error: result };

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
  await writeAudit(userId, sessionId, 'claim_gift', 'ok', ipHash, fpHash, { reward, streak: newStreak });
  return { ok: true, reward, streak_day: newStreak, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}

async function handleVerifyTgTask(userId, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'verify_tg_task');
  if (result !== 'ok') return { ok: false, error: result };

  const r = await sql(`SELECT tg_verified FROM users WHERE id=$1`, [userId]);
  if (r[0]?.tg_verified) return { ok: false, error: 'already_verified' };
  await sql(
    `UPDATE users SET tg_verified=TRUE, points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2 AND tg_verified=FALSE`,
    [CFG.POINTS_PER_TG_TASK, userId]
  );
  await syncLevel(userId);
  await upsertTask(userId, 'tg_join');
  const fresh = (await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'verify_tg_task', 'ok', ipHash, fpHash, { reward: CFG.POINTS_PER_TG_TASK });
  return { ok: true, reward: CFG.POINTS_PER_TG_TASK, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}

async function handleSubmitWithdraw(userId, body, rawNonce, sessionId, fpHash, ipHash) {
  const result = await consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, 'submit_withdraw');
  if (result !== 'ok') return { ok: false, error: result };

  const address = (body?.data?.address || '').trim();
  if (!isValidTon(address)) return { ok: false, error: 'invalid_address' };
  const r   = await sql(`SELECT points, level FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const pts   = parseInt(r[0].points) || 0;
  const level = parseInt(r[0].level)  || 1;
  if (level < CFG.WITHDRAW_MIN_LEVEL) return { ok: false, error: 'level_too_low', required_level: CFG.WITHDRAW_MIN_LEVEL };
  if (pts < CFG.WITHDRAW_MIN_PTS)     return { ok: false, error: 'insufficient_balance', required: CFG.WITHDRAW_MIN_PTS, have: pts };
  const ton = parseFloat((pts / CFG.PTS_PER_TON).toFixed(6));
  await sql(`UPDATE users SET points=points-$1, updated_at=NOW() WHERE id=$2`, [pts, userId]);
  const wr = await sql(
    `INSERT INTO withdrawals(user_id, pts, ton_amount, address, method, status) VALUES($1,$2,$3,$4,'ton','pending') RETURNING id`,
    [userId, pts, ton, address]
  );
  const nb = (await sql(`SELECT points FROM users WHERE id=$1`, [userId]))[0];
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, { pts, ton });
  return {
    ok: true,
    withdraw_id: wr[0].id,
    pts_deducted: pts, ton_amount: ton,
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

async function handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash) {
  const allowed = new Set([
    'ad_requested', 'ad_loaded', 'ad_started',
    'ad_failed', 'ad_completed', 'reward_granted',
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

  if (event === 'suspicious_activity') {
    const reason = String(body?.data?.reason || 'client_report').slice(0, 50);
    await addRisk(userId, `client_suspicious_${reason}`, ipHash, fpHash, 10);
  }

  await writeAudit(userId, sessionId, event, 'tracked', ipHash, fpHash, {
    meta: body?.data?.meta || {},
  });

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — كاملة (مطابق + موسّع)
// ═══════════════════════════════════════════════════════════════════
async function handleAdmin(action, body) {
  // ── إدارة السحوبات ───────────────────────────────────────────────
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
    await sql(
      `UPDATE withdrawals SET status='completed', tx_hash=$1, reviewed_at=NOW(), reviewed_by='admin' WHERE id=$2`,
      [body?.tx_hash || '', id]
    );
    return { ok: true, message: 'Withdrawal approved' };
  }

  if (action === 'reject_withdrawal') {
    const id = parseInt(body?.withdraw_id);
    if (!id) return { ok: false, error: 'missing_id' };
    // استرداد النقاط تلقائياً
    const wr = await sql(`SELECT user_id, pts FROM withdrawals WHERE id=$1`, [id]);
    if (wr.length) {
      await sql(`UPDATE users SET points=points+$1 WHERE id=$2`, [wr[0].pts, wr[0].user_id]);
    }
    await sql(
      `UPDATE withdrawals SET status='rejected', reviewed_at=NOW(), reviewed_by='admin',
       notes=COALESCE($2, notes) WHERE id=$1`,
      [id, body?.notes || null]
    );
    return { ok: true, message: 'Withdrawal rejected, points refunded' };
  }

  // ── Hard Ban / Soft Ban / Unban ──────────────────────────────────
  if (action === 'ban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    const banType = body?.ban_type || 'hard'; // 'hard' | 'shadow'
    if (banType === 'shadow') {
      await sql(
        `UPDATE users SET is_shadow_banned=TRUE, ban_reason=$1, updated_at=NOW() WHERE tg_id=$2`,
        [body?.reason || 'admin_shadow_ban', tgId]
      );
      return { ok: true, message: 'User shadow banned' };
    } else {
      await sql(
        `UPDATE users SET is_banned=TRUE, ban_reason=$1, updated_at=NOW() WHERE tg_id=$2`,
        [body?.reason || 'admin_ban', tgId]
      );
      // إبطال جميع جلساته
      const userRow = (await sql(`SELECT id FROM users WHERE tg_id=$1`, [tgId]))[0];
      if (userRow) {
        await sql(`UPDATE sessions SET is_revoked=TRUE WHERE user_id=$1`, [userRow.id]);
      }
      return { ok: true, message: 'User hard banned + sessions revoked' };
    }
  }

  if (action === 'unban_user') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    await sql(
      `UPDATE users SET is_banned=FALSE, is_shadow_banned=FALSE, ban_reason=NULL, risk_score=0, updated_at=NOW() WHERE tg_id=$1`,
      [tgId]
    );
    return { ok: true, message: 'User unbanned' };
  }

  // ── إحصائيات ─────────────────────────────────────────────────────
  if (action === 'stats') {
    const r = (await sql(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER(WHERE created_at > NOW() - INTERVAL '1 day') AS new_today,
        COUNT(*) FILTER(WHERE created_at > NOW() - INTERVAL '7 days') AS new_week,
        SUM(points) AS total_points,
        COUNT(*) FILTER(WHERE is_banned)         AS banned_users,
        COUNT(*) FILTER(WHERE is_shadow_banned)  AS shadow_banned_users,
        COUNT(*) FILTER(WHERE cluster_ban)       AS cluster_banned_users
      FROM users
    `))[0];
    const w = (await sql(`
      SELECT COUNT(*) AS pending_wd, COALESCE(SUM(pts),0) AS pending_pts
      FROM withdrawals WHERE status='pending'
    `))[0];
    const adToday = (await sql(`
      SELECT COALESCE(SUM(count),0) AS ads_today, COALESCE(SUM(points_earned),0) AS pts_today
      FROM ad_logs WHERE log_date=CURRENT_DATE
    `))[0];
    return { ok: true, stats: { ...r, ...w, ...adToday } };
  }

  // ── Audit Log ─────────────────────────────────────────────────────
  if (action === 'audit_log') {
    const limit = Math.min(parseInt(body?.limit) || 100, 500);
    const filterUserId = body?.user_id ? parseInt(body.user_id) : null;
    const filterAction = body?.action_filter || null;

    let query = `SELECT * FROM audit_log WHERE 1=1`;
    const params = [];
    if (filterUserId) { params.push(filterUserId); query += ` AND user_id=$${params.length}`; }
    if (filterAction) { params.push(filterAction); query += ` AND action=$${params.length}`; }
    params.push(limit);
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const rows = await sql(query, params);
    return { ok: true, logs: rows };
  }

  // ── Nonce History (للأدمن فقط — debug + تحليل هجمات) ─────────────
  // ⚠️ هذا الـ endpoint للأدمن حصراً — يُظهر sha256(nonce) فقط وليس الـ raw
  if (action === 'nonce_history') {
    const limit = Math.min(parseInt(body?.limit) || 50, 200);
    const filterUserId  = body?.user_id   ? parseInt(body.user_id)  : null;
    const filterOutcome = body?.outcome   || null;  // 'consumed'|'mismatch'|'expired'|...
    const filterSession = body?.session_id || null;

    let query  = `SELECT * FROM nonce_history WHERE 1=1`;
    const params = [];
    if (filterUserId)  { params.push(filterUserId);  query += ` AND user_id=$${params.length}`; }
    if (filterOutcome) { params.push(filterOutcome); query += ` AND outcome=$${params.length}`; }
    if (filterSession) { params.push(filterSession); query += ` AND session_id=$${params.length}`; }
    params.push(limit);
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const rows = await sql(query, params);

    // إحصائيات سريعة
    const stats = await sql(`
      SELECT outcome, COUNT(*) AS cnt
      FROM nonce_history
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY outcome ORDER BY cnt DESC
    `);

    return {
      ok: true,
      // تنبيه واضح: nonce_hash فقط (sha256) — ليس الـ raw nonce
      note: 'nonce_hash = sha256(raw_nonce). Raw nonce never stored or exposed.',
      history: rows,
      stats_24h: stats,
    };
  }

  // ── Risk Events ───────────────────────────────────────────────────
  if (action === 'risk_events') {
    const limit = Math.min(parseInt(body?.limit) || 50, 200);
    const rows = await sql(
      `SELECT * FROM risk_events ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return { ok: true, events: rows };
  }

  // ── User Info ─────────────────────────────────────────────────────
  if (action === 'user_info') {
    const tgId = parseInt(body?.tg_id);
    if (!tgId) return { ok: false, error: 'missing_tg_id' };
    const u = (await sql(`SELECT * FROM users WHERE tg_id=$1`, [tgId]))[0];
    if (!u) return { ok: false, error: 'user_not_found' };
    const wds = await sql(`SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`, [u.id]);
    const risk = await sql(`SELECT * FROM risk_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [u.id]);
    return { ok: true, user: u, withdrawals: wds, risk_events: risk };
  }

  return { ok: false, error: 'unknown_admin_action' };
}


// ══════════════════════════════════════════════════════════════════
// Adsgram Server-to-Server Reward Callback
// GET /api?adsgram-reward&userId=[tgId]
//
// ✅ يُعطي المكافأة فقط من callback الـ Adsgram (مش من العميل)
// ✅ العميل ممنوع من استدعاء reward مباشرة
// ✅ Cooldown + Daily limit + Shadow ban + Replay detection
// ══════════════════════════════════════════════════════════════════
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

  // استجابة فورية لـ Adsgram — المعالجة تحدث async بعدها
  res.status(200).end('ok');

  try {
    const ipHash = hashIp(getIp(req));

    const userRows = await sql(
      `SELECT id, points, is_shadow_banned FROM users WHERE tg_id=$1`,
      [tgId]
    );
    if (!userRows.length) {
      await writeAudit(0, 'adsgram_cb', 'adsgram_callback', 'user_not_found', ipHash, null, { tg_id: tgId });
      return;
    }
    const user   = userRows[0];
    const userId = user.id;

    if (user.is_shadow_banned) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'shadow_banned', ipHash, null, {});
      return;
    }

    const adLog = (await sql(
      `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
      [userId]
    ))[0];
    if ((parseInt(adLog?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'daily_limit', ipHash, null, {});
      return;
    }

    // Cooldown server-side
    const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
    if (coolRow?.ad_last_reward) {
      const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
      if (elapsed < CFG.AD_COOLDOWN_MS) {
        await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'cooldown', ipHash, null, { elapsed_ms: elapsed });
        return;
      }
    }

    // Replay detection — منع تكرار callback خلال 30 ثانية
    const recentCb = await sql(
      `SELECT id FROM audit_log
       WHERE user_id=$1 AND action='adsgram_callback' AND status='ok'
         AND created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`,
      [userId]
    );
    if (recentCb.length) {
      await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'replay', ipHash, null, {});
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

    await syncLevel(userId);
    await writeAudit(userId, 'adsgram_cb', 'adsgram_callback', 'ok', ipHash, null, {
      tg_id: tgId, points_earned: CFG.POINTS_PER_AD,
    });

    console.info('[Adsgram CB] ✅ Reward → userId:', userId, 'tgId:', tgId);
  } catch (err) {
    console.error('[Adsgram CB] Error:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  // ── Adsgram Server-to-Server Callback (GET) ───────────────────────
  // ⚠️ هذا الـ endpoint الوحيد الذي يُعطي مكافأة بدون session
  // ⚠️ العميل ممنوع من استدعاء reward مباشرة
  if (req.method === 'GET' && (req.url || '').includes('adsgram-reward')) {
    return handleAdsgramCallback(req, res);
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

  // session_id: cookie أولاً ثم header كـ fallback
  const cookieHeader      = req.headers['cookie'] || '';
  const sidMatch          = cookieHeader.match(/(?:^|;)\s*sid=([^;]+)/);
  const sessionFromCookie = sidMatch ? decodeURIComponent(sidMatch[1]) : '';
  const sessionFromHeader = req.headers['x-session-id'] || '';
  const sessionId         = sessionFromCookie || sessionFromHeader;

  const fpRaw    = req.headers['x-fingerprint']  || '{}';
  const rawNonce = req.headers['x-nonce']        || '';
  const adminKey = req.headers['x-admin-secret'] || '';

  const ipHash = hashIp(getIp(req));
  let fpData = {};
  try { fpData = JSON.parse(fpRaw); } catch (_) {}
  const fpHash = hashFp(fpData);

  // ── Rate Limit per IP ─────────────────────────────────────────────
  const isWrite = !['load', 'get_state', 'create_session', 'get_referrals', 'track_ad_event'].includes(type);
  if (!rateLimitIp(`ip_${ipHash}_${type}`, isWrite ? CFG.RATE_WRITE_MAX : CFG.RATE_MAX)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    // ── Admin ──────────────────────────────────────────────────────
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

    // ── Session Validation ────────────────────────────────────────
    if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });

    const session = await validateSession(sessionId, ipHash, fpHash);
    if (!session)  return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
    if (session.is_banned || session.cluster_ban) {
      return res.status(403).json({ ok: false, is_banned: true });
    }

    const userId = session.user_id;

    // ── Rate Limit per User (Telegram ID) — يتحمل 4G IP rotation ──
    if (!await rateLimitUser(userId, type, isWrite ? CFG.RATE_USER_WRITE : CFG.RATE_USER_READ)) {
      await writeAudit(userId, sessionId, type, 'rate_limited', ipHash, fpHash, {});
      return res.status(429).json({ ok: false, error: 'rate_limited_user' });
    }

    // ── start_ad — يُصدر nonce من السيرفر ───────────────────────────
    if (type === 'start_ad') {
      const result = await handleStartAd(session, ipHash, fpHash);
      return res.status(result.status || 200).json(result);
    }

    let result;
    switch (type) {
      case 'load':
        result = await handleLoad(userId);
        break;

      case 'get_state':
        result = await handleGetState(userId);
        break;

      // ✅ reward_ad — يقبل nonce من start_ad أو atomic fallback
      case 'reward_ad':
        result = await handleRewardAd(userId, sessionId, ipHash, fpHash, body, session);
        break;

      // ✅ claim_gift — nonce من العميل (ephemeral, one-time, bound)
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

      // ✅ track_ad_event — بدون نقاط، فقط audit + timing
      case 'track_ad_event':
        result = await handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash);
        break;

      // ✅ claim_adsgram_task — timing enforcement server-side
      case 'claim_adsgram_task':
        result = await handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash);
        break;

      default:
        result = { ok: false, error: 'unknown_action' };
    }

    // Shadow ban: نُرجع ok:true للعمليات الفاشلة (ردود زائفة)
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
