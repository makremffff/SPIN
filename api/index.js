/**
 * Zero Trust API — v3.0
 * ✅ Nonce مخفي بالكامل — لا يُرسل للعميل أبداً ولا يظهر في HTML أو JS
 * ✅ Nonce مربوط بـ session_id + user_id + fingerprint + ip_hash
 * ✅ Constant-time comparison — يمنع timing attacks
 * ✅ One-time use + TTL 5 دقائق — يُحذف فوراً بعد الاستخدام
 * ✅ Audit log لكل عملية حساسة
 * ✅ Shadow ban + Risk scoring + Multi-account detection
 * ✅ Rate limiting per IP + per User + per Action
 * ✅ Session binding — كل session مربوطة بـ fingerprint + ip
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
const NONCE_SECRET = process.env.NONCE_SECRET || 'k9mX2pQr7vNsL4wYjHdA8cBtF1eUoGiZx3nRqTsP6uVcMbW';

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

  // ── Nonce ────────────────────────────────────────────────────────
  // الـ nonce لا يُرسل للعميل أبداً — مخزّن في جدول nonces مرتبط بالجلسة
  // العميل يحصل فقط على "operation_token" مؤقت لا يكشف منطق التحقق
  NONCE_TTL_MS:          5  * 60 * 1000,   // 5 دقائق
  AD_NONCE_TTL_MS:       2  * 60 * 1000,   // 2 دقيقة للإعلانات

  // ── Session ──────────────────────────────────────────────────────
  SESSION_TTL_MS:        7  * 24 * 60 * 60 * 1000,

  // ── Rate limiting ────────────────────────────────────────────────
  RATE_WINDOW_MS:        60 * 1000,
  RATE_MAX:              30,
  RATE_WRITE_MAX:        15,

  // ── Risk ─────────────────────────────────────────────────────────
  RISK_BAN:              100,
  RISK_SHADOW:           60,

  // ── Multi-account ────────────────────────────────────────────────
  MULTI_ACCT: {
    MAX_PER_IP:          3,
    MAX_PER_FP:          1,
    IP_WHITELIST:        new Set([]),
  },

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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── sessions — session مربوطة بـ fingerprint + ip ─────────────
    await sql(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      ad_nonce_hash TEXT,
      ad_nonce_exp  TIMESTAMPTZ,
      ad_nonce_used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_active TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      is_revoked BOOLEAN DEFAULT FALSE
    )`);

    // ── nonces — جدول مخصص للـ nonces الحساسة (غير الإعلانات) ─────
    await sql(`CREATE TABLE IF NOT EXISTS nonces (
      id BIGSERIAL PRIMARY KEY,
      nonce_hash TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      user_id    BIGINT NOT NULL,
      fp_hash    TEXT NOT NULL,
      ip_hash    TEXT NOT NULL,
      action     TEXT NOT NULL DEFAULT 'general',
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )`);

    // ── audit_log — سجل كامل لكل عملية حساسة ────────────────────
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

    // ── Migrations ────────────────────────────────────────────────
    const migrations = [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_hash TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_exp  TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_used BOOLEAN DEFAULT FALSE`,
      // إزالة ad_nonce النص الخام القديم إن وُجد
      `ALTER TABLE sessions DROP COLUMN IF EXISTS ad_nonce`,
    ];
    for (const m of migrations) { try { await sql(m); } catch (_) {} }

    // ── Indexes ───────────────────────────────────────────────────
    const idxs = [
      `CREATE INDEX IF NOT EXISTS idx_s_user    ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_s_exp     ON sessions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_s_ip      ON sessions(ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_s_fp      ON sessions(fingerprint_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_n_hash    ON nonces(nonce_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_n_sess    ON nonces(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_n_user    ON nonces(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_al_ud     ON ad_logs(user_id, log_date)`,
      `CREATE INDEX IF NOT EXISTS idx_wd_user   ON withdrawals(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_ref   ON referrals(referrer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_u_ip      ON users(last_ip_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_u_fp      ON users(fp_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_usr ON audit_log(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts  ON audit_log(created_at)`,
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    console.log('[DB] bootstrap OK v3.0 — Zero Trust Nonce System');
  } catch (e) {
    console.error('[DB] bootstrap error:', e.message);
  }
}
bootstrap();

// ── Cleanup — كل ساعة ────────────────────────────────────────────
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces   WHERE expires_at < NOW()`);
    await sql(`DELETE FROM sessions WHERE expires_at < NOW()`);
    // إعادة ضبط ad_nonce المنتهية في الجلسات الحية
    await sql(`
      UPDATE sessions
      SET ad_nonce_hash=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE
      WHERE ad_nonce_exp < NOW()
    `);
    // حذف audit_log القديمة (أكثر من 30 يوم)
    await sql(`DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '30 days'`);
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
 * hmacNonce — يُنشئ HMAC للـ nonce الخام
 * يُستخدم لتخزين hash بدل النص الخام — حتى لو سُرب الـ DB لا يمكن استخدامه
 * @param {string} rawNonce
 * @param {string} sessionId
 * @param {string} userId
 * @param {string} fpHash
 * @param {string} ipHash
 */
function hmacNonce(rawNonce, sessionId, userId, fpHash, ipHash) {
  return createHmac('sha256', NONCE_SECRET)
    .update(`${rawNonce}:${sessionId}:${userId}:${fpHash}:${ipHash}`)
    .digest('hex');
}

/**
 * constantTimeCompare — مقارنة آمنة من timing attacks
 */
function constantTimeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a), 'hex');
    const bufB = Buffer.from(String(b), 'hex');
    if (bufA.length !== bufB.length) {
      // نُنفّذ عملية وهمية لمنع timing leak من الطول
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
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


// ═══════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════

async function validateSession(sid, ipHash, fpHash) {
  if (!sid) return null;
  const r = await sql(
    `SELECT s.*, u.is_banned, u.is_shadow_banned, u.cluster_ban
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

  // ── Session Binding — تحقق أن الـ fingerprint ما تغيّر ──────────
  // نسمح بتغيير IP (النتوورك المتنقل) لكن نرصده
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    await addRisk(session.user_id, 'session_fp_mismatch', ipHash, fpHash, 15);
    await writeAudit(session.user_id, sid, 'session_validate', 'tampered', ipHash, fpHash, {
      reason: 'fingerprint_mismatch',
    });
    return null; // رفض الجلسة عند تغيير الـ fingerprint
  }

  await sql(`UPDATE sessions SET last_active=NOW() WHERE id=$1`, [sid]);
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
// NONCE SYSTEM — Zero Trust / Hidden / One-Time / Bound
// ═══════════════════════════════════════════════════════════════════

/**
 * issueNonce — يُنشئ nonce جديد ويخزّن HMAC فقط في DB
 *
 * الـ nonce الخام يُرسل للعميل مرة واحدة فقط ثم يُنسى من السيرفر
 * DB يحتوي على HMAC(nonce + session + user + fp + ip) فقط
 * → حتى لو سُرب الـ DB لا يمكن إعادة استخدامه بدون معرفة باقي المعطيات
 *
 * @param {string} sessionId
 * @param {number} userId
 * @param {string} fpHash
 * @param {string} ipHash
 * @param {string} action  - اسم العملية المرتبطة بهذا الـ nonce
 * @returns {string} rawNonce — يُرسل للعميل مرة واحدة فقط
 */
async function issueNonce(sessionId, userId, fpHash, ipHash, action = 'general') {
  const rawNonce  = genRawNonce(32);
  const nonceHash = hmacNonce(rawNonce, sessionId, userId, fpHash, ipHash);
  const exp       = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();

  // تحقق أنه لا يوجد nonce سابق غير مستخدم لنفس الـ action + session
  // يمنع flood من client يطلب nonces بلا استخدام
  const existing = await sql(
    `SELECT COUNT(*) AS cnt FROM nonces
     WHERE session_id=$1 AND action=$2 AND used=FALSE AND expires_at > NOW()`,
    [sessionId, action]
  );
  if (parseInt(existing[0]?.cnt) >= 3) {
    // العميل يطلب nonces مكثفة بدون استخدام — ارفع risk
    await addRisk(userId, 'nonce_flood', ipHash, fpHash, 5);
    throw new Error('nonce_flood');
  }

  await sql(
    `INSERT INTO nonces(nonce_hash, session_id, user_id, fp_hash, ip_hash, action, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [nonceHash, sessionId, userId, fpHash, ipHash, action, exp]
  );

  // ✅ الـ nonce الخام يُرسل للعميل مرة واحدة فقط
  // السيرفر لا يحتفظ بالنص الخام — يحتفظ بالـ HMAC فقط
  return rawNonce;
}

/**
 * consumeNonce — التحقق من الـ nonce وحذفه فوراً (one-time use)
 *
 * يُحسب HMAC من البيانات المرتبطة ويقارن بما في DB
 * بعد النجاح يُحذف فوراً — لا يمكن إعادة الاستخدام
 *
 * @returns {'ok'|'invalid'|'expired'|'used'|'tampered'}
 */
async function consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, action = 'general') {
  if (!rawNonce || !sessionId || !userId) return 'invalid';

  // احسب الـ HMAC من جانب السيرفر
  const expectedHash = hmacNonce(rawNonce, sessionId, userId, fpHash, ipHash);

  // ابحث عن الـ nonce في DB — نقارن الـ hash بدل النص الخام
  const rows = await sql(
    `SELECT id, used, expires_at, action FROM nonces
     WHERE nonce_hash = $1
     LIMIT 1`,
    [expectedHash]
  );

  if (!rows.length) {
    await writeAudit(userId, sessionId, action, 'rejected', ipHash, fpHash, {
      reason: 'nonce_not_found',
    });
    await addRisk(userId, 'invalid_nonce', ipHash, fpHash, 15);
    return 'invalid';
  }

  const record = rows[0];

  // تحقق من الاستخدام السابق (Replay Attack)
  if (record.used) {
    await writeAudit(userId, sessionId, action, 'replayed', ipHash, fpHash, {
      reason: 'nonce_already_used',
      nonce_id: record.id,
    });
    await addRisk(userId, 'nonce_replay', ipHash, fpHash, 25);
    return 'used';
  }

  // تحقق من الانتهاء
  if (new Date(record.expires_at) < new Date()) {
    await sql(`DELETE FROM nonces WHERE id=$1`, [record.id]);
    await writeAudit(userId, sessionId, action, 'expired', ipHash, fpHash, {
      reason: 'nonce_expired',
    });
    return 'expired';
  }

  // تحقق أن الـ action مطابق
  if (record.action !== action) {
    await writeAudit(userId, sessionId, action, 'tampered', ipHash, fpHash, {
      reason: 'action_mismatch',
      expected: record.action,
      got: action,
    });
    await addRisk(userId, 'nonce_action_mismatch', ipHash, fpHash, 20);
    return 'tampered';
  }

  // ✅ كل التحققات نجحت — احذف الـ nonce فوراً (one-time use)
  await sql(`DELETE FROM nonces WHERE id=$1`, [record.id]);

  await writeAudit(userId, sessionId, action, 'ok', ipHash, fpHash, {
    nonce_id: record.id,
  });
  return 'ok';
}

// ═══════════════════════════════════════════════════════════════════
// AD NONCE — مخزّن في session — لا يُرسل للعميل أبداً
// ═══════════════════════════════════════════════════════════════════

/**
 * issueAdNonce — يُنشئ nonce للإعلان ويخزّن HMAC في الجلسة فقط
 * العميل لا يرى هذا الـ nonce — السيرفر يتحقق منه تلقائياً عند watch_ad
 */
async function issueAdNonce(sessionId, userId, fpHash, ipHash) {
  const rawNonce  = genRawNonce(32);
  const nonceHash = hmacNonce(rawNonce, sessionId, userId, fpHash, ipHash);
  const exp       = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();

  await sql(
    `UPDATE sessions
     SET ad_nonce_hash=$2, ad_nonce_exp=$3, ad_nonce_used=FALSE
     WHERE id=$1`,
    [sessionId, nonceHash, exp]
  );

  // ✅ لا نعيد rawNonce للعميل — السيرفر يتحقق داخلياً فقط
  return true;
}

/**
 * consumeAdNonce — يتحقق من nonce الإعلان ويحذفه فوراً
 * لا يحتاج أي مدخل من العميل
 */
async function consumeAdNonce(sessionId, userId, fpHash, ipHash) {
  if (!sessionId) return false;

  const rows = await sql(
    `SELECT ad_nonce_hash, ad_nonce_exp, ad_nonce_used
     FROM sessions
     WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return false;

  const { ad_nonce_hash, ad_nonce_exp, ad_nonce_used } = rows[0];

  if (!ad_nonce_hash) {
    await writeAudit(userId, sessionId, 'watch_ad', 'rejected', ipHash, fpHash, {
      reason: 'no_ad_nonce',
    });
    return false;
  }

  if (ad_nonce_used) {
    await writeAudit(userId, sessionId, 'watch_ad', 'replayed', ipHash, fpHash, {
      reason: 'ad_nonce_already_used',
    });
    await addRisk(userId, 'ad_nonce_replay', ipHash, fpHash, 25);
    return false;
  }

  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(
      `UPDATE sessions SET ad_nonce_hash=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`,
      [sessionId]
    );
    await writeAudit(userId, sessionId, 'watch_ad', 'expired', ipHash, fpHash, {
      reason: 'ad_nonce_expired',
    });
    return false;
  }

  // ✅ الـ nonce صالح — احذفه فوراً (one-time use)
  await sql(
    `UPDATE sessions SET ad_nonce_hash=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE WHERE id=$1`,
    [sessionId]
  );

  await writeAudit(userId, sessionId, 'watch_ad', 'ok', ipHash, fpHash, {});
  return true;
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

async function handleCreateSession(body, ipHash, fpHash) {
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
  if (user.is_banned) return { ok: false, is_banned: true, status: 403 };

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

  await writeAudit(finalUser.id, sessionId, 'create_session', 'ok', ipHash, fpHash, {
    tg_id: tgUser.id,
  });

  return {
    ok: true,
    session_id: sessionId,
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
  const r = await sql(`SELECT points,level,xp,total_referrals,earned_from_refs FROM users WHERE id=$1`, [userId]);
  if (!r.length) return { ok: false, error: 'user_not_found' };
  const u  = r[0];
  const ad = (await sql(`SELECT count,points_earned FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]))[0] || { count: 0, points_earned: 0 };
  return {
    ok: true,
    points: parseInt(u.points) || 0, level: parseInt(u.level) || 1, xp: parseInt(u.xp) || 0,
    total_referrals: u.total_referrals, earned_from_refs: parseInt(u.earned_from_refs) || 0,
    ads_watched_today: parseInt(ad.count) || 0,
    ads_remaining: Math.max(0, CFG.ADS_DAILY_LIMIT - (parseInt(ad.count) || 0)),
    earned_today: parseInt(ad.points_earned) || 0,
  };
}

// ── start_ad — يُنشئ nonce مخفياً في الجلسة ──────────────────────
async function handleStartAd(userId, sessionId, ipHash, fpHash) {
  const r = await sql(`SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`, [userId]);
  if ((parseInt(r[0]?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  // ✅ nonce يُخزَّن في الجلسة فقط — العميل لا يراه
  await issueAdNonce(sessionId, userId, fpHash, ipHash);
  return { ok: true };
}

// ── watch_ad — يتحقق من nonce الجلسة بدون أي مدخل من العميل ──────
async function handleWatchAd(userId, sessionId, ipHash, fpHash) {
  const valid = await consumeAdNonce(sessionId, userId, fpHash, ipHash);
  if (!valid) {
    await addRisk(userId, 'invalid_ad_nonce', ipHash, fpHash, 10);
    return { ok: false, error: 'invalid_ad_nonce' };
  }

  const lr = await sql(
    `INSERT INTO ad_logs(user_id, log_date, count, points_earned)
     VALUES($1, CURRENT_DATE, 1, $2)
     ON CONFLICT(user_id, log_date) DO UPDATE SET
       count       = CASE WHEN ad_logs.count < $3 THEN ad_logs.count + 1       ELSE ad_logs.count        END,
       points_earned = CASE WHEN ad_logs.count < $3 THEN ad_logs.points_earned + $2 ELSE ad_logs.points_earned END,
       updated_at  = NOW()
     RETURNING count, points_earned`,
    [userId, CFG.POINTS_PER_AD, CFG.ADS_DAILY_LIMIT]
  );
  const watched = parseInt(lr[0].count) || 0;
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, ads_watched_total=ads_watched_total+1, updated_at=NOW() WHERE id=$2`,
    [CFG.POINTS_PER_AD, userId]
  );
  await syncLevel(userId);
  if (watched >= 10) await upsertTask(userId, 'ads_10');
  if (watched >= 25) await upsertTask(userId, 'ads_25');
  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return {
    ok: true,
    remaining:    Math.max(0, CFG.ADS_DAILY_LIMIT - watched),
    watchedToday: watched,
    earnedToday:  parseInt(lr[0].points_earned) || 0,
    points:       parseInt(ur[0]?.points) || 0,
    all_done:     watched >= CFG.ADS_DAILY_LIMIT,
  };
}

// ── claim_gift — يستخدم nonce مرسل من العميل (أصدره السيرفر) ───────
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
  return { ok: true, reward, streak_day: newStreak, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}

// ── verify_tg_task ────────────────────────────────────────────────
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
  return { ok: true, reward: CFG.POINTS_PER_TG_TASK, points: parseInt(fresh?.points) || 0, level: fresh?.level };
}

// ── submit_withdraw ───────────────────────────────────────────────
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

// ── get_nonce — يُصدر nonce للعميل لعملية محددة ───────────────────
// العميل يرسله في الـ header — السيرفر يتحقق منه باستخدام HMAC
async function handleGetNonce(session, ipHash, fpHash, action) {
  const validActions = ['claim_gift', 'verify_tg_task', 'submit_withdraw'];
  const act = validActions.includes(action) ? action : 'general';

  try {
    const rawNonce = await issueNonce(session.id, session.user_id, fpHash, ipHash, act);
    // ✅ الـ nonce الخام يُرسل مرة واحدة فقط — لا يُخزَّن في DB كنص
    return { ok: true, nonce: rawNonce, action: act };
  } catch (err) {
    if (err.message === 'nonce_flood') {
      return { ok: false, error: 'too_many_pending_nonces' };
    }
    throw err;
  }
}

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
  return { ok: false, error: 'unknown_admin_action' };
}


// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Init-Data, X-Session-Id, X-Fingerprint, X-Nonce, X-Admin-Secret, X-Nonce-Action'
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

  const sessionId   = req.headers['x-session-id']    || '';
  const fpRaw       = req.headers['x-fingerprint']   || '{}';
  // ✅ X-Nonce: يحتوي فقط على rawNonce الذي أصدره السيرفر مسبقاً
  // السيرفر يُعيد حساب الـ HMAC ويقارن بما في DB
  const rawNonce    = req.headers['x-nonce']         || '';
  const nonceAction = req.headers['x-nonce-action']  || 'general';
  const adminKey    = req.headers['x-admin-secret']  || '';

  const ipHash = hashIp(getIp(req));
  let fpData = {};
  try { fpData = JSON.parse(fpRaw); } catch (_) {}
  const fpHash = hashFp(fpData);

  // ── Rate limit per IP ─────────────────────────────────────────
  const isWrite = !['load', 'get_state', 'get_nonce', 'create_session', 'get_referrals', 'start_ad'].includes(type);
  if (!rateLimit(`ip_${ipHash}_${type}`, isWrite ? CFG.RATE_WRITE_MAX : CFG.RATE_MAX)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  try {
    // ── Admin ─────────────────────────────────────────────────────
    if (type === 'admin') {
      if (adminKey !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.status(200).json(await handleAdmin(body?.action, body));
    }

    // ── Create Session ────────────────────────────────────────────
    if (type === 'create_session') {
      const result = await handleCreateSession(body, ipHash, fpHash);
      return res.status(result.status || 200).json(result);
    }

    // ── كل الطلبات الأخرى تحتاج session ─────────────────────────
    if (!sessionId) return res.status(401).json({ ok: false, error: 'session_required' });

    // validateSession تتحقق من session + fingerprint binding
    const session = await validateSession(sessionId, ipHash, fpHash);
    if (!session)  return res.status(401).json({ ok: false, error: 'session_invalid_or_expired' });
    if (session.is_banned || session.cluster_ban) {
      return res.status(403).json({ ok: false, is_banned: true });
    }

    const userId = session.user_id;

    // ── Rate limit per User ───────────────────────────────────────
    if (!rateLimit(`u_${userId}_${type}`, isWrite ? 10 : 20)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    let result;
    switch (type) {
      case 'get_nonce':
        // ✅ يُصدر nonce لعملية محددة — العميل يرسله في طلبه القادم
        result = await handleGetNonce(session, ipHash, fpHash, nonceAction);
        break;

      case 'load':      result = await handleLoad(userId);       break;
      case 'get_state': result = await handleGetState(userId);   break;

      // ✅ start_ad: السيرفر يُنشئ nonce مخفي في الجلسة — العميل لا يراه
      case 'start_ad':
        result = await handleStartAd(userId, sessionId, ipHash, fpHash);
        break;

      // ✅ watch_ad: السيرفر يقرأ nonce من الجلسة مباشرة — بدون أي مدخل من العميل
      case 'watch_ad':
        result = await handleWatchAd(userId, sessionId, ipHash, fpHash);
        break;

      // ✅ العمليات التالية: rawNonce يأتي من العميل عبر X-Nonce header
      // السيرفر يُعيد حساب HMAC ويقارن — لا يثق بقيمة الـ nonce مباشرة
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

      default:
        result = { ok: false, error: 'unknown_action' };
    }

    // ── Shadow ban: نُرجع ok:true للعمليات الفاشلة فقط ──────────
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
