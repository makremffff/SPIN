// ================================================================
//  الربح العربي — API Backend v1.0 (Zero Trust Architecture)
//  💀 "اعتبر كل عميل مخترقاً حتى يثبت العكس"
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session management (fingerprint bound)
//  ✅ Session-based ad nonce (server-generated, client cannot forge)
//  ✅ Rate limiting (per user, sliding window)
//  ✅ Risk scoring + Shadow ban
//  ✅ Multi-account detection (IP + fingerprint)
//  ✅ Audit logging
//  ✅ Server-side time only
//
//  العملة: نقاط (coins) — 50 نقطة/إعلان — حد يومي 10 إعلانات
//  السحب: الحد الأدنى 50,000 نقطة — 100,000 نقطة = 1 TON
// ================================================================

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

// ── SQL executor ──────────────────────────────────────────────
const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ── Constants ─────────────────────────────────────────────────
const INIT_DATA_TTL  = 3600;     // 1 ساعة صلاحية initData
const SESSION_TTL    = 86400;    // 24 ساعة جلسة
const RATE_WINDOW    = 5000;     // 5 ثوانٍ نافذة
const RATE_LIMIT     = 15;       // حد الطلبات لكل نافذة
const RISK_SUSPICIOUS = 41;
const RISK_BAN        = 71;
const NONCE_TTL       = 300;     // 5 دقائق صلاحية nonce

// ── إعداد الإعلانات ───────────────────────────────────────────
const AD_COINS_PER_AD   = 50;    // نقاط لكل إعلان واحد
const AD_DAILY_MAX      = 10;    // حد يومي للإعلانات
const AD_DAILY_COINS    = AD_COINS_PER_AD * AD_DAILY_MAX; // 500 نقطة/يوم

// ── إعداد السحب ──────────────────────────────────────────────
const WITHDRAW_MIN_COINS  = 50000;   // الحد الأدنى للسحب
const COINS_PER_TON       = 100000;  // 100,000 نقطة = 1 TON

// ── إعداد الهدية اليومية ─────────────────────────────────────
const GIFT_REWARDS = [100, 150, 200, 250, 300, 400, 750]; // اليوم 1–7

// ── إعداد الإحالة ────────────────────────────────────────────
const REFERRAL_COINS = 500; // نقاط لكل إحالة ناجحة

// ── Multi-Account Detection ───────────────────────────────────
const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_IP          : 2,
  MAX_ACCOUNTS_PER_FINGERPRINT : 1,
  IP_WHITELIST                 : new Set([]),
  NEW_ACCOUNT_AGE_DAYS         : 3,
};

// ── Bootstrap: إنشاء جميع الجداول ────────────────────────────
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {

    // ── جدول المستخدمين ──
    await sql(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id         BIGINT        PRIMARY KEY,
        username            TEXT,
        coins               BIGINT        NOT NULL DEFAULT 0,
        coins_earned_today  BIGINT        NOT NULL DEFAULT 0,
        ads_today           INT           NOT NULL DEFAULT 0,
        today_date          TEXT          NOT NULL DEFAULT '',
        total_ads_watched   INT           NOT NULL DEFAULT 0,
        referral_by         BIGINT,
        referral_friends    INT           NOT NULL DEFAULT 0,
        referral_coins      BIGINT        NOT NULL DEFAULT 0,
        referral_rewarded   BOOLEAN       NOT NULL DEFAULT FALSE,
        gift_day            INT           NOT NULL DEFAULT 1,
        gift_last_claimed   DATE,
        gift_streak         INT           NOT NULL DEFAULT 0,
        wd_history          JSONB         NOT NULL DEFAULT '[]',
        shadow_banned       BOOLEAN       NOT NULL DEFAULT FALSE,
        is_hard_banned      BOOLEAN       NOT NULL DEFAULT FALSE,
        risk_score          INT           NOT NULL DEFAULT 0,
        photo_url           TEXT,
        ad_last_reward      TIMESTAMPTZ,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    // ── جدول الجلسات ──
    await sql(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT        PRIMARY KEY,
        telegram_id  BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        ip_hash      TEXT        NOT NULL,
        fingerprint  TEXT        NOT NULL,
        ad_nonce     TEXT,
        ad_nonce_exp TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        is_valid     BOOLEAN     NOT NULL DEFAULT TRUE
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_s_telegram    ON sessions(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_s_expires     ON sessions(expires_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_s_ip_hash     ON sessions(ip_hash)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_s_fingerprint ON sessions(fingerprint)`);

    // ── جدول Nonce (منع إعادة الإرسال) ──
    await sql(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce        TEXT        PRIMARY KEY,
        telegram_id  BIGINT      NOT NULL,
        used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_exp ON nonces(expires_at)`);

    // ── جدول Rate Limiting ──
    await sql(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        telegram_id   BIGINT NOT NULL,
        window_start  BIGINT NOT NULL,
        request_count INT    NOT NULL DEFAULT 1,
        PRIMARY KEY (telegram_id, window_start)
      )
    `);

    // ── جدول Audit Log ──
    await sql(`
      CREATE TABLE IF NOT EXISTS security_logs (
        id          BIGSERIAL   PRIMARY KEY,
        telegram_id BIGINT,
        ip_hash     TEXT,
        fingerprint TEXT,
        action      TEXT        NOT NULL,
        risk_score  INT         NOT NULL DEFAULT 0,
        verdict     TEXT        NOT NULL DEFAULT 'allow',
        detail      JSONB       NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_tg      ON security_logs(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_created ON security_logs(created_at DESC)`);

    // ── جدول بصمات الأجهزة ──
    await sql(`
      CREATE TABLE IF NOT EXISTS device_fingerprints (
        fingerprint  TEXT        NOT NULL,
        telegram_id  BIGINT      NOT NULL,
        user_agent   TEXT,
        lang         TEXT,
        screen       TEXT,
        timezone_off INT,
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fingerprint, telegram_id)
      )
    `);

    // ── جدول المهام ──
    await sql(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT        PRIMARY KEY,
        icon        TEXT        NOT NULL DEFAULT '⭐',
        name        TEXT        NOT NULL,
        reward      BIGINT      NOT NULL DEFAULT 0,
        task_type   TEXT        NOT NULL DEFAULT 'url',
        url         TEXT,
        channel     TEXT,
        description TEXT        NOT NULL DEFAULT '',
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
        sort_order  INT         NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active, sort_order)`);

    // ── جدول إنجازات المهام ──
    await sql(`
      CREATE TABLE IF NOT EXISTS user_tasks (
        telegram_id  BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        task_id      TEXT        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        completed    BOOLEAN     NOT NULL DEFAULT FALSE,
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (telegram_id, task_id)
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ut_telegram ON user_tasks(telegram_id)`);

    // ── Seed default task (قناة Telegram) ──
    const existing = await sql(`SELECT COUNT(*) AS cnt FROM tasks`);
    if (parseInt(existing[0]?.cnt || 0) === 0) {
      await sql(`
        INSERT INTO tasks (id, icon, name, reward, task_type, url, channel, description, sort_order)
        VALUES
          ('tg_channel', '📢', 'انضم لقناة الربح العربي', 2500, 'channel', NULL, 'RebhApp_channel', 'اشترك في القناة لفتح مكافأة 2,500 نقطة', 1)
        ON CONFLICT (id) DO NOTHING
      `);
    }

    // ── Migrations: أضف الكولومات الناقصة إن لم تكن موجودة ──
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS coins               BIGINT        NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS coins_earned_today  BIGINT        NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS ads_today           INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS today_date          TEXT          NOT NULL DEFAULT ''`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS total_ads_watched   INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_friends    INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_coins      BIGINT        NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded   BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_day            INT           NOT NULL DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_last_claimed   DATE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_streak         INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS wd_history          JSONB         NOT NULL DEFAULT '[]'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_banned       BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_hard_banned      BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score          INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url           TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS ad_last_reward      TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce         TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_exp     TIMESTAMPTZ`,
    ];
    for (const m of migrations) {
      try { await sql(m); } catch (_) {}
    }

    console.log('[DB] Bootstrap OK — الربح العربي v1.0 Zero Trust');
  } catch (e) {
    console.error('[DB] Bootstrap failed:', e.message);
  }
}
bootstrap();

// ================================================================
//  SECURITY LAYER — Zero Trust Core
// ================================================================

// ── تحقق من Telegram initData (HMAC-SHA256) ──
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params   = new URLSearchParams(initData);
    const hash     = params.get('hash');
    const authDate = parseInt(params.get('auth_date') || '0');
    if (!hash || !authDate) return null;

    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > INIT_DATA_TTL) return null;

    params.delete('hash');
    const checkArr = [];
    params.forEach((v, k) => checkArr.push(`${k}=${v}`));
    checkArr.sort();
    const checkStr = checkArr.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected  = crypto.createHmac('sha256', secretKey).update(checkStr).digest('hex');
    if (expected !== hash) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

// ── Hash IP ──
function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256')
    .update(ip + (process.env.IP_SALT || 'arabic_earn_salt'))
    .digest('hex').slice(0, 32);
}

// ── بناء Fingerprint من بيانات الطلب ──
function buildFingerprint(fpData, ipHash) {
  const clientFp = fpData.fp || '';
  const ua       = (fpData.user_agent || '').slice(0, 200);
  const lang     = fpData.lang        || '';
  const screen   = fpData.screen      || '';
  const tz       = String(fpData.tz_offset || 0);
  const tzName   = fpData.tz_name     || '';
  const cores    = String(fpData.hw_cores  || 0);
  const mem      = String(fpData.hw_mem    || 0);
  const touch    = String(fpData.touch_pts || 0);
  const canvas   = (fpData.canvas_sig || '').slice(0, 40);
  const webgl    = (fpData.webgl_sig  || '').slice(0, 60);
  const audio    = (fpData.audio_sig  || '').slice(0, 40);

  const raw = clientFp
    ? [clientFp, ipHash, ua, lang, tz, tzName, cores, mem].join('|')
    : [ua, lang, screen, tz, tzName, cores, mem, touch, canvas, webgl, audio, ipHash].join('|');

  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

// ── إصدار Ad Nonce داخل الجلسة (server-generated) ──
async function issueAdNonce(sessionId) {
  const nonce  = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + NONCE_TTL * 1000).toISOString();
  await sql(
    `UPDATE sessions SET ad_nonce = $2, ad_nonce_exp = $3 WHERE session_id = $1`,
    [sessionId, nonce, expiry]
  );
  return nonce;
}

// ── استهلاك Ad Nonce (one-time use) ──
async function consumeAdNonce(sessionId, clientNonce) {
  if (!clientNonce || !sessionId) return false;
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp FROM sessions
     WHERE session_id = $1 AND is_valid = TRUE`,
    [sessionId]
  );
  if (!rows.length) return false;
  const { ad_nonce, ad_nonce_exp } = rows[0];
  if (!ad_nonce) return false;
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
    return false;
  }
  try {
    const expected = Buffer.from(ad_nonce,    'hex');
    const received = Buffer.from(clientNonce, 'hex');
    const match = expected.length === received.length &&
                  crypto.timingSafeEqual(expected, received);
    if (!match) return false;
  } catch {
    return false;
  }
  await sql(`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
  return true;
}

// ── تنظيف دوري (كل ساعة) ──
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces      WHERE expires_at  < NOW()`);
    await sql(`DELETE FROM rate_limits WHERE window_start < $1`, [Date.now() - RATE_WINDOW * 10]);
    console.log('[CLEANUP] nonces & rate_limits cleaned');
  } catch (e) {
    console.warn('[CLEANUP] error:', e.message);
  }
}, 60 * 60 * 1000);

// ── فحص Nonce العام (للعمليات غير الإعلانات) ──
async function checkNonce(tid, nonce) {
  if (!nonce) return false;
  const existing = await sql(`SELECT 1 FROM nonces WHERE nonce = $1`, [nonce]);
  if (existing.length) return false;
  await sql(
    `INSERT INTO nonces (nonce, telegram_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [nonce, tid]
  );
  return true;
}

// ── Rate Limiting ──
async function checkRateLimit(tid) {
  const window = Math.floor(Date.now() / RATE_WINDOW) * RATE_WINDOW;
  const rows = await sql(
    `INSERT INTO rate_limits (telegram_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (telegram_id, window_start)
     DO UPDATE SET request_count = rate_limits.request_count + 1
     RETURNING request_count`,
    [tid, window]
  );
  return (rows[0]?.request_count || 0) <= RATE_LIMIT;
}

// ── حساب Risk Score ──
async function calcRiskScore(tid, ipHash, fingerprint) {
  let score = 0;
  const fp = await sql(
    `SELECT fingerprint FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`,
    [tid]
  );
  if (fp.length && fp[0].fingerprint !== fingerprint) score += 25;
  const ip = await sql(
    `SELECT ip_hash FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`,
    [tid]
  );
  if (ip.length && ip[0].ip_hash !== ipHash) score += 15;
  const failures = await sql(
    `SELECT COUNT(*) AS c FROM security_logs
     WHERE telegram_id = $1 AND verdict = 'deny' AND created_at > NOW() - INTERVAL '1 minute'`,
    [tid]
  );
  score += Math.min(30, parseInt(failures[0]?.c || 0) * 10);
  return Math.min(100, score);
}

// ── Audit Log ──
async function auditLog(tid, ipHash, fingerprint, action, riskScore, verdict, detail = {}) {
  try {
    await sql(
      `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tid, ipHash, fingerprint, action, riskScore, verdict, JSON.stringify(detail)]
    );
  } catch (_) {}
}

// ── تحديث Risk Score + Shadow ban ──
async function updateUserRisk(tid, delta) {
  await sql(
    `UPDATE users SET risk_score = LEAST(100, GREATEST(0, risk_score + $2)), updated_at = NOW()
     WHERE telegram_id = $1`,
    [tid, delta]
  );
  await sql(
    `UPDATE users SET shadow_banned = TRUE WHERE telegram_id = $1 AND risk_score >= $2`,
    [tid, RISK_BAN]
  );
}

// ================================================================
//  HELPERS
// ================================================================

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint, X-Telegram-Init-Data');
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ── تحقق من عضوية قناة Telegram ──
async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${channelUsername}&user_id=${telegramId}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.ok) return false;
    return ['member', 'administrator', 'creator'].includes(data.result?.status);
  } catch (e) {
    console.warn('[verifyChannel] error:', e.message);
    return false;
  }
}

// ── إعادة ضبط عداد الإعلانات اليومي ──
async function resetDailyIfNeeded(tid, user) {
  const today = todayUTC();
  if (user.today_date !== today) {
    await sql(
      `UPDATE users SET
         today_date         = $2,
         ads_today          = 0,
         coins_earned_today = 0,
         updated_at         = NOW()
       WHERE telegram_id = $1`,
      [tid, today]
    );
    return { ...user, today_date: today, ads_today: 0, coins_earned_today: 0 };
  }
  return user;
}

// ================================================================
//  MAIN HANDLER
// ================================================================
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ── استخراج headers الأمان ──
  // index.html يرسل X-Telegram-Init-Data (وبعض الطلبات X-Init-Data)
  const initData  = req.headers['x-telegram-init-data'] || req.headers['x-init-data'] || '';
  const sessionId = req.headers['x-session-id']  || '';
  const nonce     = req.headers['x-nonce']        || '';
  const fpHeader  = req.headers['x-fingerprint']  || '{}';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // index.html يرسل { type, data } — نقبل كلاهما: type و action
  const action = body?.action || body?.type;
  const data   = body?.data   || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // ── معلومات الشبكة ──
  const rawIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const ipHash     = hashIP(rawIP);

  let fpData = {};
  try { fpData = JSON.parse(fpHeader); } catch (_) {}
  const fingerprint = buildFingerprint(fpData, ipHash);

  // ================================================================
  //  CREATE SESSION — يُستدعى عند أول تحميل
  //  يقبل initData من header أو من body.data.initData
  // ================================================================
  if (action === 'create_session') {
    const rawInitData = initData || data.initData || '';
    const tgUser = verifyTelegramInitData(rawInitData);
    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });
    }

    const tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    // إنشاء/تحديث المستخدم
    await sql(
      `INSERT INTO users (telegram_id, username, photo_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username  = $2,
             photo_url = COALESCE($3, users.photo_url),
             updated_at = NOW()`,
      [tid, tgUser.username || tgUser.first_name || null, tgUser.photo_url || null]
    );

    // ── Multi-Account Detection (atomic) ──
    const db = neon(DATABASE_URL);
    try {
      await db('BEGIN');
      const lockKey = BigInt('0x' + ipHash.slice(0, 15)) & BigInt('0x7FFFFFFFFFFFFFFF');
      await db(`SELECT pg_advisory_xact_lock($1)`, [lockKey.toString()]);

      const banCheck = await db(
        `SELECT shadow_banned, is_hard_banned, risk_score, created_at FROM users WHERE telegram_id = $1`,
        [tid]
      );
      const userRow = banCheck[0];

      if (userRow?.is_hard_banned) {
        await db('ROLLBACK');
        await auditLog(tid, ipHash, fingerprint, 'create_session_hard_banned', 100, 'deny', { reason: 'hard_banned' });
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
      }

      if (userRow?.shadow_banned) {
        await db('ROLLBACK');
        await auditLog(tid, ipHash, fingerprint, 'create_session_shadow_banned', userRow.risk_score, 'deny', { reason: 'shadow_banned' });
        return res.status(200).json({ ok: false, is_banned: true });
      }

      const accountCreatedAt = userRow?.created_at ? new Date(userRow.created_at) : new Date();
      const accountAgeDays   = (Date.now() - accountCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
      const isNewAccount     = accountAgeDays < MULTI_ACCT.NEW_ACCOUNT_AGE_DAYS;
      const isWhitelisted    = MULTI_ACCT.IP_WHITELIST.has(ipHash);

      if (!isWhitelisted && isNewAccount) {
        const ipCount  = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM sessions
           WHERE ip_hash = $1 AND telegram_id != $2 AND is_valid = TRUE AND expires_at > NOW()`,
          [ipHash, tid]
        );
        const fpCount  = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM device_fingerprints
           WHERE fingerprint = $1 AND telegram_id != $2`,
          [fingerprint, tid]
        );
        const activeAccountsOnIP   = parseInt(ipCount[0]?.cnt || 0);
        const accountsOnFingerprint = parseInt(fpCount[0]?.cnt || 0);
        const ipViolation = activeAccountsOnIP    >= MULTI_ACCT.MAX_ACCOUNTS_PER_IP;
        const fpViolation = accountsOnFingerprint >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;
        const shouldBan   = fpViolation; // Fingerprint مطابق = ban قاطع

        if (shouldBan) {
          await db(`UPDATE users SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          await db(
            `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
             VALUES ($1, $2, $3, 'multi_account_detected', 100, 'deny', $4)`,
            [tid, ipHash, fingerprint, JSON.stringify({
              reason: 'multi_account_hard_ban',
              ip_accounts_count: activeAccountsOnIP,
              fp_accounts_count: accountsOnFingerprint,
              ip_violation: ipViolation,
              fp_violation: fpViolation,
              account_age_days: Math.round(accountAgeDays * 10) / 10,
            })]
          );
          await db('COMMIT');
          console.warn(`[ANTI-FRAUD] Hard Ban → tg_id=${tid} fp_accounts=${accountsOnFingerprint}`);
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      // Reset risk_score خفيف إذا كان مرتفعاً
      if (userRow?.risk_score >= RISK_SUSPICIOUS) {
        await db(`UPDATE users SET risk_score = 0, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
        await db(`DELETE FROM device_fingerprints WHERE telegram_id = $1`, [tid]);
        await db(`DELETE FROM security_logs WHERE telegram_id = $1 AND verdict = 'deny'`, [tid]);
      }

      // إلغاء الجلسات القديمة وإنشاء جديدة
      await db(`UPDATE sessions SET is_valid = FALSE WHERE telegram_id = $1`, [tid]);
      const sid = generateSessionId();
      await db(
        `INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')`,
        [sid, tid, ipHash, fingerprint]
      );

      // تسجيل fingerprint
      await db(
        `INSERT INTO device_fingerprints (fingerprint, telegram_id, user_agent, lang, timezone_off, last_seen)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
        [fingerprint, tid, (fpData.user_agent || '').slice(0, 200), fpData.lang || '', fpData.tz_offset || 0]
      );

      await db('COMMIT');

      console.log(`[SESSION] Created → tid=${tid} sid=${sid.slice(0,8)}...`);
      return res.status(200).json({ ok: true, session_id: sid, telegram_id: tid });

    } catch (txErr) {
      try { await db('ROLLBACK'); } catch (_) {}
      console.error('[create_session TX Error]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ================================================================
  //  START_AD — إصدار Nonce للإعلان (server-generated only)
  //  لا يمكن للعميل توليد nonce — يجب طلبه من هنا أولاً
  // ================================================================
  if (action === 'start_ad') {
    if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

    const sess = await sql(
      `SELECT session_id, telegram_id FROM sessions
       WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!sess.length) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });

    const startTid = parseInt(sess[0].telegram_id);
    const startUser = await sql(`SELECT shadow_banned, is_hard_banned FROM users WHERE telegram_id = $1`, [startTid]);
    if (startUser[0]?.is_hard_banned) return res.status(200).json({ ok: false, error: 'access_denied' });

    // فحص هل بلغ الحد اليومي
    let u = await sql(`SELECT ads_today, today_date FROM users WHERE telegram_id = $1`, [startTid]);
    u = u[0];
    if (u.today_date === todayUTC() && u.ads_today >= AD_DAILY_MAX) {
      return res.status(200).json({ ok: false, error: 'daily_limit', message: 'لقد شاهدت جميع إعلانات اليوم' });
    }

    const adNonce = await issueAdNonce(sessionId);
    await auditLog(startTid, ipHash, fingerprint, 'start_ad', 0, 'allow', { session_id: sessionId.slice(0, 8) + '...' });
    console.log(`[START_AD] nonce issued → tid=${startTid}`);
    return res.status(200).json({ ok: true, ad_nonce: adNonce });
  }

  // ── من هنا: جميع الإجراءات تتطلب جلسة صالحة ──
  if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

  const sessionRows = await sql(
    `SELECT * FROM sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
    [sessionId]
  );
  if (!sessionRows.length) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });

  const session = sessionRows[0];
  const tid     = parseInt(session.telegram_id);

  // تحقق من Fingerprint
  if (session.fingerprint !== fingerprint) {
    await sql(`UPDATE sessions SET is_valid = FALSE WHERE session_id = $1`, [sessionId]);
    await updateUserRisk(tid, 30);
    await auditLog(tid, ipHash, fingerprint, action, 30, 'deny', { reason: 'fingerprint_mismatch' });
    return res.status(401).json({ ok: false, error: 'Session mismatch — please re-authenticate' });
  }

  // تغيّر IP فقط = طبيعي
  if (session.ip_hash !== ipHash) {
    await sql(`UPDATE sessions SET ip_hash = $2 WHERE session_id = $1`, [sessionId, ipHash]);
    await updateUserRisk(tid, 5);
    await auditLog(tid, ipHash, fingerprint, action, 5, 'allow', { reason: 'ip_changed' });
  }

  // Rate Limiting
  const withinLimit = await checkRateLimit(tid);
  if (!withinLimit) {
    await updateUserRisk(tid, 5);
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // Nonce Check (للعمليات العامة فقط — ليس الإعلانات)
  const skipNonce = ['load', 'get_state', 'watch_ad', 'start_ad', 'get_tasks', 'verify_tg_membership'];
  if (!skipNonce.includes(action)) {
    const nonceValid = await checkNonce(tid, nonce);
    if (!nonceValid) {
      await updateUserRisk(tid, 20);
      await auditLog(tid, ipHash, fingerprint, action, 20, 'deny', { reason: 'nonce_replay' });
      return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
    }
  }

  const riskScore = await calcRiskScore(tid, ipHash, fingerprint);
  const userRisk  = await sql(`SELECT risk_score, shadow_banned FROM users WHERE telegram_id = $1`, [tid]);
  const isShadowBanned = userRisk[0]?.shadow_banned || false;

  await auditLog(tid, ipHash, fingerprint, action, riskScore, isShadowBanned ? 'shadow' : 'allow', {});

  try {

    // ══════════════════════════════════════════════════════════
    //  LOAD — تحميل بيانات المستخدم
    // ══════════════════════════════════════════════════════════
    if (action === 'load') {
      const username   = data.username   || null;
      const referralBy = data.referral_by ? parseInt(data.referral_by) : null;
      const validRef   = referralBy && !isNaN(referralBy) && referralBy !== tid ? referralBy : null;

      let rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);

      if (!rows.length) {
        rows = await sql(
          `INSERT INTO users (telegram_id, username, referral_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (telegram_id) DO UPDATE
             SET username    = EXCLUDED.username,
                 referral_by = COALESCE(users.referral_by, EXCLUDED.referral_by),
                 updated_at  = NOW()
           RETURNING *`,
          [tid, username, validRef]
        );
      } else {
        // حفظ referral_by إذا لم يكن مسجلاً
        if (validRef && !rows[0].referral_by) {
          await sql(
            `UPDATE users SET referral_by = $2, updated_at = NOW()
             WHERE telegram_id = $1 AND referral_by IS NULL`,
            [tid, validRef]
          );
          rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
        }
      }

      let u = rows[0];

      // معالجة الإحالة: إذا عنده مُحيل ولم يُحتسب
      if (u.referral_by && !u.referral_rewarded) {
        const refExists = await sql(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [u.referral_by]);
        if (refExists.length) {
          await sql(
            `UPDATE users SET
               referral_friends = referral_friends + 1,
               referral_coins   = referral_coins + $2,
               coins            = coins + $2,
               updated_at       = NOW()
             WHERE telegram_id = $1`,
            [u.referral_by, REFERRAL_COINS]
          );
        }
        await sql(`UPDATE users SET referral_rewarded = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
        rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
        u = rows[0];
      }

      // إعادة ضبط العداد اليومي
      u = await resetDailyIfNeeded(tid, u);
      rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      u = rows[0];

      // عدد المهام المكتملة
      const tasksDone = await sql(
        `SELECT COUNT(*) AS cnt FROM user_tasks WHERE telegram_id = $1 AND completed = TRUE`,
        [tid]
      );

      return res.status(200).json({
        ok: true,
        user: {
          ...u,
          tasks_done: parseInt(tasksDone[0]?.cnt || 0),
        },
        config: {
          ad_coins_per_ad : AD_COINS_PER_AD,
          ad_daily_max    : AD_DAILY_MAX,
          withdraw_min    : WITHDRAW_MIN_COINS,
          coins_per_ton   : COINS_PER_TON,
          referral_coins  : REFERRAL_COINS,
        }
      });
    }

    // ══════════════════════════════════════════════════════════
    //  GET_STATE — polling خفيف
    // ══════════════════════════════════════════════════════════
    if (action === 'get_state') {
      let rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
      let u = rows[0];
      u = await resetDailyIfNeeded(tid, u);
      rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      u = rows[0];
      return res.status(200).json({ ok: true, user: u });
    }

    // ══════════════════════════════════════════════════════════
    //  WATCH_AD — مكافأة مشاهدة الإعلان (Zero-Trust)
    //  ✅ يتحقق من session-based ad_nonce المولود من السيرفر
    //  ✅ one-time use: يُحذف بعد أول استخدام ناجح
    //  ✅ لا يقبل nonce من العميل مباشرة
    //  ✅ يحسب الحد اليومي من security_logs
    // ══════════════════════════════════════════════════════════
    if (action === 'watch_ad') {
      const { ad_nonce: clientAdNonce } = data;

      // ── التحقق من session-based nonce ──
      const nonceValid = await consumeAdNonce(sessionId, clientAdNonce);
      if (!nonceValid) {
        await updateUserRisk(tid, 20);
        await auditLog(tid, ipHash, fingerprint, 'watch_ad_nonce_fail', 20, 'deny',
          { reason: 'invalid_or_missing_ad_nonce' });
        return res.status(400).json({ ok: false, error: 'Invalid or missing ad nonce' });
      }

      // ── Cooldown: 3 ثوانٍ بين كل reward ──
      const cooldownRows = await sql(`SELECT ad_last_reward FROM users WHERE telegram_id = $1`, [tid]);
      const lastReward   = cooldownRows[0]?.ad_last_reward;
      if (lastReward) {
        const elapsedMs = Date.now() - new Date(lastReward).getTime();
        if (elapsedMs < 3000) {
          await auditLog(tid, ipHash, fingerprint, 'watch_ad_cooldown', 5, 'deny',
            { reason: 'cooldown_active', elapsed_ms: elapsedMs });
          return res.status(429).json({ ok: false, error: 'Please wait before claiming another reward' });
        }
      }

      // ── فحص الحد اليومي من security_logs ──
      const usageRows = await sql(
        `SELECT COUNT(*) AS cnt FROM security_logs
         WHERE telegram_id = $1
           AND action = 'watch_ad'
           AND verdict = 'allow'
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [tid]
      );
      const watchedToday = parseInt(usageRows[0]?.cnt || 0);

      if (watchedToday >= AD_DAILY_MAX) {
        await auditLog(tid, ipHash, fingerprint, 'watch_ad', 5, 'deny',
          { reason: 'daily_limit', watched: watchedToday, limit: AD_DAILY_MAX });
        return res.status(200).json({
          ok: false,
          error: 'daily_limit',
          remaining: 0,
          watchedToday,
          earnedToday: watchedToday * AD_COINS_PER_AD
        });
      }

      // ── Shadow ban: رد ناجح زائف ──
      if (isShadowBanned) {
        await auditLog(tid, ipHash, fingerprint, 'watch_ad', 0, 'shadow',
          { reason: 'shadow_ban_suppressed', amount: AD_COINS_PER_AD });
        const fakeRows = await sql(`SELECT coins, ads_today FROM users WHERE telegram_id = $1`, [tid]);
        const fakeAds  = (fakeRows[0]?.ads_today || 0) + 1;
        return res.status(200).json({
          ok: true,
          coins: parseInt(fakeRows[0]?.coins || 0),
          remaining: Math.max(0, AD_DAILY_MAX - fakeAds),
          watchedToday: fakeAds,
          earnedToday: fakeAds * AD_COINS_PER_AD
        });
      }

      // ── تطبيق المكافأة ──
      const today    = todayUTC();
      const updated  = await sql(
        `UPDATE users SET
           coins               = coins + $2,
           ads_today           = ads_today + 1,
           coins_earned_today  = coins_earned_today + $2,
           total_ads_watched   = total_ads_watched + 1,
           today_date          = $3,
           ad_last_reward      = NOW(),
           updated_at          = NOW()
         WHERE telegram_id = $1
         RETURNING coins, ads_today, coins_earned_today, total_ads_watched`,
        [tid, AD_COINS_PER_AD, today]
      );

      const u = updated[0];
      const newWatchedToday = parseInt(u.ads_today);
      const newRemaining    = Math.max(0, AD_DAILY_MAX - newWatchedToday);
      const newEarnedToday  = parseInt(u.coins_earned_today);

      // ── Audit log كامل ──
      await auditLog(tid, ipHash, fingerprint, 'watch_ad', 0, 'allow', {
        amount        : AD_COINS_PER_AD,
        new_coins     : parseInt(u.coins),
        watched_today : newWatchedToday,
        earned_today  : newEarnedToday,
      });

      console.log(`[WATCH_AD] tid=${tid} +${AD_COINS_PER_AD} coins → total=${u.coins} today=${newWatchedToday}/${AD_DAILY_MAX}`);

      return res.status(200).json({
        ok           : true,
        coins        : parseInt(u.coins),
        remaining    : newRemaining,
        watchedToday : newWatchedToday,
        earnedToday  : newEarnedToday,
        totalWatched : parseInt(u.total_ads_watched),
      });
    }

    // ══════════════════════════════════════════════════════════
    //  CLAIM_GIFT — الهدية اليومية
    // ══════════════════════════════════════════════════════════
    if (action === 'claim_gift') {
      const rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
      const u = rows[0];

      const todayDate = new Date().toISOString().slice(0, 10);

      // هل طالب اليوم بالفعل؟
      if (u.gift_last_claimed && u.gift_last_claimed.toString().slice(0, 10) === todayDate) {
        return res.status(200).json({ ok: false, error: 'already_claimed', message: 'تم استلام هديتك اليوم بالفعل' });
      }

      // حساب اليوم في الـ streak
      const lastClaimed = u.gift_last_claimed ? new Date(u.gift_last_claimed) : null;
      const yesterday   = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const isConsecutive = lastClaimed && lastClaimed.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10);

      let newStreak  = isConsecutive ? (parseInt(u.gift_streak) || 0) + 1 : 1;
      let newGiftDay = Math.min(newStreak, GIFT_REWARDS.length);
      const reward   = GIFT_REWARDS[newGiftDay - 1];

      if (isShadowBanned) {
        return res.status(200).json({
          ok: true,
          reward,
          day: newGiftDay,
          coins: parseInt(u.coins),
          streak: newStreak
        });
      }

      const updatedGift = await sql(
        `UPDATE users SET
           coins             = coins + $2,
           gift_day          = $3,
           gift_last_claimed = $4,
           gift_streak       = $5,
           updated_at        = NOW()
         WHERE telegram_id = $1
         RETURNING coins, gift_day, gift_streak`,
        [tid, reward, newGiftDay, todayDate, newStreak]
      );

      await auditLog(tid, ipHash, fingerprint, 'claim_gift', 0, 'allow',
        { reward, day: newGiftDay, streak: newStreak, coins: parseInt(updatedGift[0]?.coins || 0) });

      console.log(`[GIFT] tid=${tid} day=${newGiftDay} +${reward} coins`);

      return res.status(200).json({
        ok     : true,
        reward,
        day    : newGiftDay,
        coins  : parseInt(updatedGift[0]?.coins || 0),
        streak : newStreak,
      });
    }

    // ══════════════════════════════════════════════════════════
    //  SUBMIT_WITHDRAW — طلب سحب TON
    // ══════════════════════════════════════════════════════════
    if (action === 'submit_withdraw') {
      const address = (data.address || '').trim();
      const pts     = parseInt(data.pts) || 0;

      // تحقق من العنوان
      if (!address || (!address.startsWith('EQ') && !address.startsWith('UQ') && !address.startsWith('0:')) || address.length < 48) {
        return res.status(400).json({ ok: false, error: 'invalid_address', message: 'عنوان محفظة TON غير صالح' });
      }

      const rows = await sql(`SELECT coins FROM users WHERE telegram_id = $1`, [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const currentCoins = parseInt(rows[0]?.coins || 0);

      if (currentCoins < WITHDRAW_MIN_COINS) {
        return res.status(200).json({
          ok: false,
          error: 'insufficient_balance',
          message: `تحتاج على الأقل ${WITHDRAW_MIN_COINS.toLocaleString()} نقطة للسحب`,
          current: currentCoins,
          required: WITHDRAW_MIN_COINS
        });
      }

      if (isShadowBanned) {
        return res.status(200).json({ ok: true, message: 'تم استلام طلب السحب وسيتم معالجته' });
      }

      const tonAmount = currentCoins / COINS_PER_TON;
      const dateStr   = new Date().toISOString();

      const historyEntry = {
        address,
        pts        : currentCoins,
        ton        : parseFloat(tonAmount.toFixed(4)),
        date       : dateStr,
        status     : 'pending',
        created_at : dateStr,
      };

      // تصفير الرصيد + حفظ في التاريخ
      await sql(
        `UPDATE users SET
           wd_history  = wd_history || $2::jsonb,
           coins       = 0,
           updated_at  = NOW()
         WHERE telegram_id = $1`,
        [tid, JSON.stringify(historyEntry)]
      );

      await auditLog(tid, ipHash, fingerprint, 'submit_withdraw', 0, 'allow', {
        address: address.slice(0, 10) + '...',
        pts: currentCoins,
        ton: tonAmount,
      });

      console.log(`[WITHDRAW] tid=${tid} pts=${currentCoins} ton=${tonAmount.toFixed(4)} addr=${address.slice(0, 10)}...`);

      return res.status(200).json({
        ok         : true,
        message    : 'تم استلام طلب السحب وسيتم معالجته',
        pts        : currentCoins,
        ton        : parseFloat(tonAmount.toFixed(4)),
        date       : dateStr,
      });
    }

    // ══════════════════════════════════════════════════════════
    //  GET_TASKS — جلب المهام مع حالة المستخدم
    // ══════════════════════════════════════════════════════════
    if (action === 'get_tasks') {
      const tasks = await sql(
        `SELECT t.*,
                ut.completed,
                ut.completed_at
         FROM tasks t
         LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.telegram_id = $1
         WHERE t.is_active = TRUE
         ORDER BY t.sort_order ASC, t.created_at ASC`,
        [tid]
      );
      return res.status(200).json({ ok: true, tasks });
    }

    // ══════════════════════════════════════════════════════════
    //  VERIFY_TG_MEMBERSHIP — التحقق من الانضمام للقناة
    // ══════════════════════════════════════════════════════════
    if (action === 'verify_tg_membership') {
      const taskId = data.task_id || 'tg_channel';

      // جلب المهمة
      const taskRows = await sql(`SELECT * FROM tasks WHERE id = $1 AND is_active = TRUE`, [taskId]);
      if (!taskRows.length) return res.status(404).json({ ok: false, error: 'Task not found' });
      const task = taskRows[0];

      // هل مكتملة مسبقاً؟
      const existing = await sql(
        `SELECT completed FROM user_tasks WHERE telegram_id = $1 AND task_id = $2`,
        [tid, taskId]
      );
      if (existing.length && existing[0].completed) {
        return res.status(200).json({ ok: false, error: 'already_completed' });
      }

      // تحقق من العضوية
      const isMember = await verifyChannelMembership(tid, task.channel);
      if (!isMember) {
        return res.status(200).json({ ok: false, error: 'not_member', message: 'انضم للقناة أولاً ثم حاول مجدداً' });
      }

      if (isShadowBanned) return res.status(200).json({ ok: true });

      // إعطاء المكافأة
      const reward = parseInt(task.reward) || 0;
      await sql(
        `INSERT INTO user_tasks (telegram_id, task_id, completed, completed_at)
         VALUES ($1, $2, TRUE, NOW())
         ON CONFLICT (telegram_id, task_id) DO UPDATE SET completed = TRUE, completed_at = NOW()`,
        [tid, taskId]
      );

      let newCoins = 0;
      if (reward > 0) {
        const updatedCoins = await sql(
          `UPDATE users SET coins = coins + $2, updated_at = NOW()
           WHERE telegram_id = $1 RETURNING coins`,
          [tid, reward]
        );
        newCoins = parseInt(updatedCoins[0]?.coins || 0);
      } else {
        const cur = await sql(`SELECT coins FROM users WHERE telegram_id = $1`, [tid]);
        newCoins = parseInt(cur[0]?.coins || 0);
      }

      await auditLog(tid, ipHash, fingerprint, 'verify_tg_membership', 0, 'allow',
        { task_id: taskId, reward, new_coins: newCoins });

      console.log(`[TASK] tid=${tid} task=${taskId} +${reward} coins`);
      return res.status(200).json({ ok: true, reward, coins: newCoins });
    }

    // ══════════════════════════════════════════════════════════
    //  TRACK_COPY_LINK — تتبع نسخ رابط الإحالة (fire-and-forget)
    // ══════════════════════════════════════════════════════════
    if (action === 'track_copy_link') {
      await auditLog(tid, ipHash, fingerprint, 'copy_referral_link', 0, 'allow', { tid });
      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════
    //  UPDATE_WITHDRAWAL — Admin endpoint
    //  تحديث حالة طلب السحب: pending → completed | rejected
    // ══════════════════════════════════════════════════════════
    if (action === 'update_withdrawal') {
      const { target_tid, date, status: newStatus } = data;
      const adminKey = req.headers['x-admin-key'] || '';

      if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ ok: false, error: 'Unauthorized' });
      }

      const allowedStatuses = ['completed', 'approved', 'rejected'];
      if (!allowedStatuses.includes(newStatus)) {
        return res.status(400).json({ ok: false, error: 'Invalid status' });
      }

      const targetId = parseInt(target_tid);
      if (isNaN(targetId)) return res.status(400).json({ ok: false, error: 'Invalid target_tid' });

      const rows = await sql(`SELECT wd_history FROM users WHERE telegram_id = $1`, [targetId]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const history = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      let updated = false;

      const updatedHistory = history.map(entry => {
        if (entry.status === 'pending') {
          if (date && entry.date === date) {
            updated = true;
            return { ...entry, status: newStatus, updated_at: new Date().toISOString() };
          } else if (!date && !updated) {
            updated = true;
            return { ...entry, status: newStatus, updated_at: new Date().toISOString() };
          }
        }
        return entry;
      });

      if (!updated) return res.status(404).json({ ok: false, error: 'No matching pending withdrawal found' });

      await sql(
        `UPDATE users SET wd_history = $2, updated_at = NOW() WHERE telegram_id = $1`,
        [targetId, JSON.stringify(updatedHistory)]
      );

      console.log(`[WITHDRAW] Status updated: user=${targetId} status=${newStatus}`);
      return res.status(200).json({ ok: true, message: `Withdrawal marked as ${newStatus}` });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action', action });

  } catch (err) {
    console.error('[API Error]', action || 'unknown', err.message, err.stack);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: 'حدث خطأ غير متوقع، يرجى المحاولة مجدداً.',
      ...(process.env.NODE_ENV !== 'production' && { detail: err.message })
    });
  }
};
