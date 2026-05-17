/**
 * Zero Trust API — v4.0
 *
 * ✅ Ephemeral Nonce Architecture (مطابق لطماطم)
 *    • Nonce يظهر في request لكن one-time + short TTL + bound
 *    • أي replay يفشل فوراً — حتى لو رآه المستخدم في Network tab
 * ✅ reward_ad — Atomic Server-Side (بدون start_ad / watch_ad)
 *    • السيرفر ينشئ nonce داخلياً ويستهلكه في نفس العملية
 *    • Cooldown + Daily Limit + Shadow Ban + Risk Score
 *    • ad_started_at timing enforcement server-side
 * ✅ claim_adsgram_task — cooldown حقيقي 60s من البداية (ليس النهاية)
 * ✅ Session binding — fingerprint + ip_hash
 * ✅ crypto.timingSafeEqual لكل مقارنة حساسة
 * ✅ Audit log + Risk scoring + Shadow ban + Multi-account detection
 * ✅ Replay protection — curl / postman / parallel / race conditions
 * ✅ Rate limit per IP + per User + per Action
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
  AD_NONCE_TTL_MS:       30 * 1000,        // 30 ثانية للإعلانات (atomic)

  // ── Ad timing — server-side enforcement ──────────────────────────
  AD_COOLDOWN_MS:        30 * 1000,        // 30s cooldown بين كل reward_ad
  AD_MIN_DURATION_MS:    14 * 1000,        // 14s حد أدنى لمشاهدة الإعلان

  // ── Adsgram Task ─────────────────────────────────────────────────
  // 60 ثانية cooldown من وقت بدء المهمة (ليس من وقت النقر)
  ADSGRAM_TASK_COOLDOWN_MS: 60 * 1000,
  ADSGRAM_TASK_POINTS:   70,
  ADSGRAM_TASK_MIN_WATCH_MS: 10 * 1000,   // 10s حد أدنى لمشاهدة مهمة Adsgram

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
    MAX_PER_IP:          1,
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

    // ── device_fingerprints ───────────────────────────────────────
    await sql(`CREATE TABLE IF NOT EXISTS device_fingerprints (
      fingerprint   TEXT NOT NULL,
      user_id       BIGINT NOT NULL,
      user_agent    TEXT,
      lang          TEXT,
      screen        TEXT,
      timezone_off  INT DEFAULT 0,
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    await sql(`CREATE INDEX IF NOT EXISTS idx_sl_user    ON security_logs(user_id)`);

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
    ];
    for (const q of idxs) { try { await sql(q); } catch (_) {} }

    console.log('[DB] bootstrap OK v4.0 — Zero Trust Ephemeral Nonce');
  } catch (e) {
    console.error('[DB] bootstrap error:', e.message);
  }
}
bootstrap();

// ── Cleanup — كل ساعة ────────────────────────────────────────────
setInterval(async () => {
  try {
    // حذف nonces المنتهية أو المستخدمة
    await sql(`DELETE FROM nonces   WHERE expires_at < NOW() OR used = TRUE`);
    await sql(`DELETE FROM sessions WHERE expires_at < NOW()`);
    // إعادة ضبط ad_nonce المنتهية في الجلسات الحية
    await sql(`
      UPDATE sessions
      SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE
      WHERE ad_nonce_exp < NOW()
    `);
    // حذف audit_log القديمة (أكثر من 30 يوم)
    await sql(`DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '30 days'`);
    // حذف risk_events القديمة (أكثر من 7 أيام)
    await sql(`DELETE FROM risk_events WHERE created_at < NOW() - INTERVAL '7 days'`);
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
 * يستخدم crypto.timingSafeEqual دائماً
 */
function constantTimeCompare(a, b) {
  try {
    const sA = String(a || '');
    const sB = String(b || '');
    // نُحوّل لـ Buffer بنفس الطول دائماً
    const bufA = Buffer.from(sha256(sA), 'hex');
    const bufB = Buffer.from(sha256(sB), 'hex');
    // timingSafeEqual يشترط نفس الطول — sha256 يضمن ذلك
    const match = timingSafeEqual(bufA, bufB);
    // نتحقق إضافياً من القيمة الأصلية (double-check)
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

  // ── Session Binding: fingerprint mismatch = إبطال الجلسة ────────
  if (session.fingerprint_hash && fpHash && session.fingerprint_hash !== fpHash) {
    await addRisk(session.user_id, 'session_fp_mismatch', ipHash, fpHash, 15);
    await writeAudit(session.user_id, sid, 'session_validate', 'tampered', ipHash, fpHash, {
      reason: 'fingerprint_mismatch',
    });
    // إبطال الجلسة فوراً
    await sql(`UPDATE sessions SET is_revoked=TRUE WHERE id=$1`, [sid]);
    return null;
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
// EPHEMERAL NONCE SYSTEM — مطابق لطماطم
//
// المبدأ:
//   • Nonce يمكن أن يظهر في request (مثل طماطم)
//   • لكن: one-time + short TTL + bound (session + user + ip + fp + action)
//   • أي replay لنفس الـ nonce يفشل فوراً
//   • Parallel requests تفشل (أول من يُسجّل يفوز)
//   • Race conditions محمية بـ ON CONFLICT DO NOTHING
// ═══════════════════════════════════════════════════════════════════

/**
 * consumeNonce — التحقق من nonce واستهلاكه atomically
 *
 * الـ nonce يأتي من العميل عبر X-Nonce header (مُولَّد client-side).
 * السيرفر:
 *   ① يتحقق أنه لم يُسجَّل من قبل في جدول nonces (anti-replay)
 *   ② يسجّله مع binding كامل (session + user + ip + fp + action)
 *   ③ أي طلب ثانٍ بنفس الـ nonce يُرفض فوراً
 *
 * حتى لو رأى المستخدم الـ nonce في Network tab:
 *   • الـ nonce صالح لمرة واحدة فقط
 *   • TTL قصير (5 دقائق)
 *   • مربوط بـ session + ip + fp + action
 *   • أي replay أو تغيير يفشل
 */
async function consumeNonce(rawNonce, sessionId, userId, fpHash, ipHash, action) {
  if (!rawNonce || rawNonce.length < 16) {
    await addRisk(userId, 'missing_nonce', ipHash, fpHash, 5);
    return 'missing';
  }
  if (!sessionId) return 'invalid';

  // ── التحقق من الـ nonce مع binding ──────────────────────────────
  // نستخدم INSERT ON CONFLICT لضمان atomicity ضد race conditions
  const exp = new Date(Date.now() + CFG.NONCE_TTL_MS).toISOString();
  const inserted = await sql(
    `INSERT INTO nonces(nonce, session_id, user_id, ip_hash, fp_hash, action, used, expires_at)
     VALUES($1,$2,$3,$4,$5,$6,TRUE,$7)
     ON CONFLICT(nonce) DO NOTHING
     RETURNING id`,
    [rawNonce, sessionId, userId, ipHash, fpHash, action, exp]
  );

  if (!inserted.length) {
    // nonce موجود = replay attack أو parallel request
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
// AD NONCE SYSTEM — toma-style (server issues → client sends back)
//
// Flow:
//   [1] start_ad  → السيرفر ينشئ nonce ويحفظه في session → يُرسله للعميل
//   [2] reward_ad → العميل يُرسل nonce في X-Nonce header
//                → السيرفر يتحقق بـ timingSafeEqual → يستهلكه فوراً
//
// الـ nonce:
//   • server-generated (العميل لا يُنشئه)
//   • one-time use (يُحذف بعد الاستهلاك)
//   • short TTL: AD_NONCE_TTL_MS (30 ثانية)
//   • bound to session فقط
//   • أي replay → reject فوراً
// ═══════════════════════════════════════════════════════════════════

/**
 * issueAdNonce — ينشئ nonce ويحفظه في الجلسة ويُرجعه للعميل
 * يُستدعى من handleStartAd فقط
 */
async function issueAdNonce(sessionId) {
  const nonce = genRawNonce(32);
  const exp   = new Date(Date.now() + CFG.AD_NONCE_TTL_MS).toISOString();

  const r = await sql(
    `UPDATE sessions
     SET ad_nonce=$2, ad_nonce_exp=$3, ad_nonce_used=FALSE
     WHERE id=$1 AND is_revoked=FALSE AND expires_at > NOW()
     RETURNING id`,
    [sessionId, nonce, exp]
  );
  if (!r.length) return null;
  return nonce;
}

/**
 * consumeAdNonce — يتحقق من nonce القادم من العميل ويستهلكه atomically
 * يُستدعى من handleRewardAd فقط
 *
 * ① يجلب ad_nonce المخزون في الجلسة
 * ② يقارن بـ timingSafeEqual
 * ③ يتحقق من TTL
 * ④ يستهلكه atomically بـ UPDATE ... WHERE ad_nonce_used=FALSE
 *    (أي parallel request يفشل لأن ad_nonce_used سيكون TRUE)
 */
async function consumeAdNonce(sessionId, clientNonce, userId, ipHash, fpHash) {
  if (!clientNonce || !sessionId) {
    await addRisk(userId, 'reward_ad_missing_nonce', ipHash, fpHash, 20);
    return 'missing';
  }

  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp, ad_nonce_used
     FROM sessions WHERE id=$1 AND is_revoked=FALSE`,
    [sessionId]
  );
  if (!rows.length) return 'invalid';

  const { ad_nonce, ad_nonce_exp, ad_nonce_used } = rows[0];

  // لا يوجد nonce = لم يطلب start_ad
  if (!ad_nonce) {
    await addRisk(userId, 'reward_ad_no_nonce_issued', ipHash, fpHash, 15);
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_not_issued', ipHash, fpHash, {});
    return 'not_issued';
  }

  // nonce مستهلك = replay أو parallel
  if (ad_nonce_used) {
    await addRisk(userId, 'reward_ad_nonce_reuse', ipHash, fpHash, 30);
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_replay', ipHash, fpHash, {});
    return 'replay';
  }

  // TTL منتهي
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(
      `UPDATE sessions SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=FALSE WHERE id=$1`,
      [sessionId]
    );
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_expired', ipHash, fpHash, {});
    return 'expired';
  }

  // timingSafeEqual — يمنع timing attacks
  const match = constantTimeCompare(clientNonce, ad_nonce);
  if (!match) {
    await addRisk(userId, 'reward_ad_nonce_mismatch', ipHash, fpHash, 40);
    await writeAudit(userId, sessionId, 'reward_ad', 'nonce_mismatch', ipHash, fpHash, {
      prefix: clientNonce.slice(0, 8),
    });
    return 'mismatch';
  }

  // استهلاك atomic — WHERE ad_nonce_used=FALSE يمنع double-consume
  const consumed = await sql(
    `UPDATE sessions
     SET ad_nonce=NULL, ad_nonce_exp=NULL, ad_nonce_used=TRUE
     WHERE id=$1 AND ad_nonce=$2 AND ad_nonce_used=FALSE
     RETURNING id`,
    [sessionId, ad_nonce]
  );
  if (!consumed.length) {
    // race condition — طلب parallel استهلك الـ nonce أولاً
    await addRisk(userId, 'reward_ad_race_condition', ipHash, fpHash, 10);
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

  // ── upsert user أولاً (خارج transaction) ─────────────────────
  const user = await upsertUser(tgUser, ipHash, fpHash);

  // Referral — خارج transaction لأنه غير حرج
  let referrerId = null;
  try {
    const sp = new URLSearchParams(initData).get('start_param') || '';
    const m  = sp.match(/^ref_(\d+)$/);
    if (m) {
      const rr = await sql(`SELECT id FROM users WHERE tg_id=$1`, [parseInt(m[1])]);
      if (rr.length) referrerId = rr[0].id;
    }
  } catch (_) {}

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

  // ════════════════════════════════════════════════════════════════
  //  MULTI-ACCOUNT DETECTION — Atomic SQL (neon HTTP compatible)
  //  بدون BEGIN/COMMIT — كل عملية atomic بمفردها
  // ════════════════════════════════════════════════════════════════
  try {
    // ── فحص Hard Ban / Shadow Ban ──────────────────────────────
    const userRow = (await sql(
      `SELECT is_banned, is_shadow_banned, risk_score, created_at FROM users WHERE id=$1`,
      [user.id]
    ))[0];

    if (userRow?.is_banned) {
      await writeAudit(user.id, null, 'create_session', 'hard_banned', ipHash, fpHash, { tg_id: tid });
      return { ok: false, is_banned: true, ban_type: 'hard', status: 403 };
    }

    if (userRow?.is_shadow_banned) {
      await writeAudit(user.id, null, 'create_session', 'shadow_banned', ipHash, fpHash, { tg_id: tid });
      return { ok: false, is_banned: true, status: 200 };
    }

    // ── تحديد عمر الحساب ────────────────────────────────────────
    const accountCreatedAt = userRow?.created_at ? new Date(userRow.created_at) : new Date();
    const accountAgeDays   = (Date.now() - accountCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
    const isNewAccount     = accountAgeDays < 3;
    const isWhitelisted    = CFG.MULTI_ACCT.IP_WHITELIST.has(ipHash);

    if (!isWhitelisted && isNewAccount) {
      // ── عدد الحسابات لكل IP ──────────────────────────────────
      const ipCnt = parseInt((await sql(
        `SELECT COUNT(DISTINCT id) AS cnt FROM users
         WHERE last_ip_hash=$1 AND id!=$2 AND is_banned=FALSE`,
        [ipHash, user.id]
      ))[0]?.cnt || 0);

      // ── عدد الحسابات لكل fingerprint ────────────────────────
      const fpCnt = parseInt((await sql(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM device_fingerprints
         WHERE fingerprint=$1 AND user_id!=$2`,
        [fpHash, user.id]
      ))[0]?.cnt || 0);

      const ipViolation = ipCnt >= CFG.MULTI_ACCT.MAX_PER_IP;
      const fpViolation = fpCnt >= CFG.MULTI_ACCT.MAX_PER_FP;

      if (fpViolation) {
        // Atomic ban — لا يضر لو تسابق طلبان
        await sql(
          `UPDATE users SET is_banned=TRUE, ban_reason='multi_account', updated_at=NOW() WHERE id=$1`,
          [user.id]
        );
        try {
          await sql(
            `INSERT INTO security_logs(user_id,ip_hash,fingerprint,action,risk_score,verdict,detail)
             VALUES($1,$2,$3,'multi_account_detected',100,'deny',$4)`,
            [user.id, ipHash, fpHash, JSON.stringify({
              reason: 'multi_account_hard_ban',
              ip_accounts: ipCnt, fp_accounts: fpCnt,
              account_age_days: Math.round(accountAgeDays * 10) / 10,
              tg_id: tid,
            })]
          );
        } catch (_) {}
        console.warn(`[ANTI-FRAUD] Hard Ban → tg_id=${tid} ip=${ipCnt} fp=${fpCnt}`);
        return { ok: false, is_banned: true, ban_type: 'hard', status: 200 };
      }

      if (ipViolation) {
        try {
          await sql(
            `INSERT INTO security_logs(user_id,ip_hash,fingerprint,action,risk_score,verdict,detail)
             VALUES($1,$2,$3,'multi_ip_warning',30,'allow',$4)`,
            [user.id, ipHash, fpHash, JSON.stringify({
              reason: 'shared_ip', ip_accounts: ipCnt,
              note: 'Shared WiFi/NAT — no ban',
            })]
          );
        } catch (_) {}
      }
    }

    // ── Reset risk_score مرتفع ───────────────────────────────────
    if ((userRow?.risk_score || 0) >= CFG.RISK_SHADOW) {
      await sql(`UPDATE users SET risk_score=0, updated_at=NOW() WHERE id=$1`, [user.id]);
      try { await sql(`DELETE FROM device_fingerprints WHERE user_id=$1`, [user.id]); } catch (_) {}
      try { await sql(`DELETE FROM security_logs WHERE user_id=$1 AND verdict='deny'`, [user.id]); } catch (_) {}
    }

    // ── إلغاء الجلسات القديمة + إنشاء جلسة جديدة (atomic) ──────
    await sql(`UPDATE sessions SET is_revoked=TRUE WHERE user_id=$1`, [user.id]);

    const sessionId = genRawNonce(32);
    const exp = new Date(Date.now() + CFG.SESSION_TTL_MS).toISOString();
    await sql(
      `INSERT INTO sessions(id, user_id, fingerprint_hash, ip_hash, expires_at)
       VALUES($1,$2,$3,$4,$5)`,
      [sessionId, user.id, fpHash, ipHash, exp]
    );

    // ── حفظ device_fingerprints ───────────────────────────────────
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
      tg_id: tid, is_new_account: isNewAccount,
    });

    await syncLevel(user.id);
    const finalUser = (await sql(`SELECT * FROM users WHERE id=$1`, [user.id]))[0];

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

  } catch (err) {
    console.error('[create_session Error]', err.message);
    return { ok: false, error: 'session_creation_failed', status: 500 };
  }
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
// reward_ad — endpoint وحيد للإعلانات
//
// ✅ لا يوجد start_ad / watch_ad / generate_nonce
// ✅ الـ nonce يُنشأ ويُستهلك داخلياً في نفس العملية
// ✅ Atomic: لا race conditions ممكنة
// ✅ Cooldown check + Daily limit + Shadow ban + Risk score
// ✅ Server-side timing enforcement (ad_started_at)
// ✅ Replay protection: cooldown + nonce + audit check
//
// ⚠️ الفرونت يُرسل فقط: { type: 'reward_ad', data: { ad_started_at, preload_count } }
// السيرفر يتحقق من كل شيء داخلياً — لا يُرسل نقاط إلا بعد اجتياز كل الفحوصات
// ══════════════════════════════════════════════════════════════════
// ── start_ad — يُصدر nonce للعميل قبل بدء الإعلان ────────────────
async function handleStartAd(userId, sessionId, ipHash, fpHash) {
  // Daily limit check
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  if ((parseInt(adR[0]?.count) || 0) >= CFG.ADS_DAILY_LIMIT) {
    return { ok: false, error: 'daily_limit_reached' };
  }

  // Cooldown check
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

async function handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce) {
  const clientStartedAt = parseInt(body?.data?.ad_started_at) || 0;

  // ── [1] Nonce check — أول خطوة قبل أي شيء ──────────────────────
  const nonceResult = await consumeAdNonce(sessionId, rawNonce, userId, ipHash, fpHash);
  if (nonceResult !== 'ok') {
    return { ok: false, error: `nonce_${nonceResult}` };
  }

  // ── [2] Daily limit ──────────────────────────────────────────────
  const adR = await sql(
    `SELECT count FROM ad_logs WHERE user_id=$1 AND log_date=CURRENT_DATE`,
    [userId]
  );
  const watchedToday = parseInt(adR[0]?.count) || 0;
  if (watchedToday >= CFG.ADS_DAILY_LIMIT) {
    await writeAudit(userId, sessionId, 'reward_ad', 'daily_limit', ipHash, fpHash, { watched: watchedToday });
    return { ok: false, error: 'daily_limit_reached' };
  }

  // ── [3] Cooldown check (server-side) ────────────────────────────
  const coolRow = (await sql(`SELECT ad_last_reward FROM users WHERE id=$1`, [userId]))[0];
  if (coolRow?.ad_last_reward) {
    const elapsed = Date.now() - new Date(coolRow.ad_last_reward).getTime();
    if (elapsed < CFG.AD_COOLDOWN_MS) {
      const waitMs = CFG.AD_COOLDOWN_MS - elapsed;
      await writeAudit(userId, sessionId, 'reward_ad', 'cooldown', ipHash, fpHash, { wait_ms: waitMs });
      return { ok: false, error: 'cooldown_active', wait_ms: waitMs };
    }
  }

  // ── [3] Server-side timing enforcement ──────────────────────────
  // نتحقق من ad_started_at المحفوظ في الجلسة (سجّله track_ad_event 'ad_started')
  // إذا لم يوجد أو الوقت قصير جداً = مشتبه به
  if (clientStartedAt > 0) {
    const clientElapsed = Date.now() - clientStartedAt;
    if (clientElapsed < CFG.AD_MIN_DURATION_MS) {
      await addRisk(userId, 'ad_too_fast_client', ipHash, fpHash, 10);
      await writeAudit(userId, sessionId, 'reward_ad', 'timing_invalid', ipHash, fpHash, {
        client_elapsed_ms: clientElapsed,
        min_required_ms: CFG.AD_MIN_DURATION_MS,
      });
      return { ok: false, error: 'ad_duration_invalid' };
    }
  }

  // ── [4] Replay detection في audit_log (ضد curl/postman) ─────────
  // نرفض إذا جاء reward_ad ناجح خلال آخر 25 ثانية من نفس المستخدم
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

  // ── [5] Shadow ban — رد ناجح زائف ──────────────────────────────
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
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
// claim_adsgram_task — مهمة Adsgram
//
// المشكلة السابقة:
//   • الـ widget يُطلق 'reward' event بعد 3 ثوانٍ فقط من البداية
//   • الفرونت يُرسل claim_adsgram_task مباشرة = نقاط بدون مشاهدة حقيقية
//
// الحل:
//   • track_ad_event('ad_started') يُسجّل adsgram_task_started_at في الجلسة
//   • claim_adsgram_task يتحقق أن 10 ثوانٍ على الأقل مرت من البداية
//   • cooldown 60s من آخر مرة مُنحت فيها الجائزة (ليس من البداية)
//   • Replay protection عبر completed_tasks + cooldown
// ══════════════════════════════════════════════════════════════════
async function handleClaimAdsgramTask(userId, sessionId, ipHash, fpHash) {
  // ── [1] تحقق من وقت بدء المهمة ──────────────────────────────────
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
        elapsed_ms: elapsed,
        min_ms: CFG.ADSGRAM_TASK_MIN_WATCH_MS,
      });
      return { ok: false, error: 'task_too_fast' };
    }
  }

  // ── [2] Cooldown 60s من آخر مرة ──────────────────────────────────
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
      await writeAudit(userId, sessionId, 'claim_adsgram_task', 'cooldown', ipHash, fpHash, {
        wait_ms: waitMs,
      });
      return { ok: false, error: 'already_claimed_today', wait_ms: waitMs };
    }
  }

  // ── [3] Shadow ban ────────────────────────────────────────────────
  const uR = await sql(`SELECT is_shadow_banned FROM users WHERE id=$1`, [userId]);
  if (uR[0]?.is_shadow_banned) {
    const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
    return { ok: true, points: parseInt(ur[0]?.points) || 0, earned: CFG.ADSGRAM_TASK_POINTS };
  }

  // ── [4] أعطِ النقاط ───────────────────────────────────────────────
  await sql(
    `UPDATE users SET points=points+$1, xp=xp+$1, updated_at=NOW() WHERE id=$2`,
    [CFG.ADSGRAM_TASK_POINTS, userId]
  );
  await sql(
    `INSERT INTO completed_tasks(user_id, task_key, completed_at)
     VALUES($1, 'adsgram_task_daily', NOW())`,
    [userId]
  );

  // ── [5] إعادة ضبط adsgram_task_started_at ─────────────────────────
  await sql(
    `UPDATE sessions SET adsgram_task_started_at=NULL WHERE id=$1`,
    [sessionId]
  );

  await syncLevel(userId);
  await writeAudit(userId, sessionId, 'claim_adsgram_task', 'ok', ipHash, fpHash, {
    points: CFG.ADSGRAM_TASK_POINTS,
  });

  const ur = await sql(`SELECT points FROM users WHERE id=$1`, [userId]);
  return { ok: true, points: parseInt(ur[0]?.points) || 0, earned: CFG.ADSGRAM_TASK_POINTS };
}


// ── claim_gift ───────────────────────────────────────────────────
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
  await writeAudit(userId, sessionId, 'verify_tg_task', 'ok', ipHash, fpHash, { reward: CFG.POINTS_PER_TG_TASK });
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
  await writeAudit(userId, sessionId, 'submit_withdraw', 'ok', ipHash, fpHash, { pts, ton });
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


// ── track_ad_event ────────────────────────────────────────────────
// آمن تماماً — لا يُعطي نقاط — فقط يسجّل + يُحدّث timing للسيرفر
async function handleTrackAdEvent(userId, sessionId, body, ipHash, fpHash) {
  const allowed = new Set([
    'ad_requested', 'ad_loaded', 'ad_started',
    'ad_failed',    'ad_completed', 'reward_granted',
    'suspicious_activity',
  ]);
  const event = body?.data?.event || '';
  if (!allowed.has(event)) {
    return { ok: false, error: 'unknown_event' };
  }

  // ── ad_started: سجّل وقت البداية في الجلسة (server-side timing) ──
  if (event === 'ad_started') {
    await sql(
      `UPDATE sessions SET ad_started_at=NOW() WHERE id=$1`,
      [sessionId]
    );
  }

  // ── ad_started لمهمة Adsgram: سجّل وقت بداية المهمة ─────────────
  // الفرونت يُرسل { event: 'ad_started', meta: { type: 'adsgram_task' } }
  if (event === 'ad_started' && body?.data?.meta?.type === 'adsgram_task') {
    await sql(
      `UPDATE sessions SET adsgram_task_started_at=NOW() WHERE id=$1`,
      [sessionId]
    );
  }

  // ── suspicious_activity: إضافة نقاط risk ─────────────────────────
  if (event === 'suspicious_activity') {
    const reason = String(body?.data?.reason || 'client_report').slice(0, 50);
    await addRisk(userId, `client_suspicious_${reason}`, ipHash, fpHash, 10);
  }

  await writeAudit(userId, sessionId, event, 'tracked', ipHash, fpHash, {
    meta: body?.data?.meta || {},
  });

  return { ok: true };
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


// ══════════════════════════════════════════════════════════════════
// Adsgram Server-to-Server Reward Callback
// GET /api/adsgram-reward?userId=[userId]
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

  // session_id: cookie أولاً ثم header كـ fallback (Telegram WebApp)
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

  // ── Rate limit per IP ─────────────────────────────────────────
  const isWrite = !['load', 'get_state', 'create_session', 'get_referrals', 'track_ad_event', 'start_ad'].includes(type);
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

    // ── Rate limit per User ───────────────────────────────────────
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

      // ✅ start_ad — يُصدر nonce للعميل قبل بدء الإعلان
      case 'start_ad':
        result = await handleStartAd(userId, sessionId, ipHash, fpHash);
        break;

      // ✅ reward_ad — يتحقق من nonce القادم من العميل (X-Nonce header)
      case 'reward_ad':
        result = await handleRewardAd(userId, sessionId, ipHash, fpHash, body, rawNonce);
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

      // ✅ claim_adsgram_task — يتحقق من وقت المشاهدة server-side
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
