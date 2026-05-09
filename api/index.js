// ================================================================
//  TON Spin — API Backend v1.0 (Zero Trust Architecture)
//  💀 "اعتبر كل عميل مخترقاً حتى يثبت العكس"
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session management (IP + fingerprint bound)
//  ✅ Nonce system (replay attack prevention)
//  ✅ Rate limiting (per user, sliding window)
//  ✅ Behavior analysis (bot detection)
//  ✅ Risk scoring (0-100)
//  ✅ Shadow ban system
//  ✅ Multi-account detection (IP + fingerprint)
//  ✅ Server-side time only
//  ✅ Full audit logging
// ================================================================

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;   // مطلوب لتحقق Telegram + كشف عضوية القناة
const TG_CHANNEL   = process.env.TG_CHANNEL || 'YourChannelUsername'; // يوزرنيم القناة بدون @

// ── SQL executor ─────────────────────────────────────────────────
const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ── Constants ────────────────────────────────────────────────────
const INIT_DATA_TTL   = 3600;   // 1 hour — صلاحية initData
const SESSION_TTL     = 86400;  // 24 hours
const RATE_WINDOW     = 5000;   // 5 seconds
const RATE_LIMIT      = 10;     // max requests per window
const RISK_SUSPICIOUS = 41;
const RISK_BAN        = 71;
const NONCE_TTL       = 300;    // 5 min nonce validity
const AD_NONCE_TTL    = 300;    // 5 min ad nonce validity

// ── Ads config — السيرفر هو المرجع الوحيد لعدد الإعلانات اليومية ──
const AD_DAILY_MAX = 10; // أقصى عدد إعلانات يومية لكل مستخدم

// ── Multi-Account Detection ───────────────────────────────────────
const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_IP          : 2,
  MAX_ACCOUNTS_PER_FINGERPRINT : 1,
  IP_WHITELIST                 : new Set([]),
  NEW_ACCOUNT_AGE_DAYS         : 3,
};

// ================================================================
//  BOOTSTRAP — إنشاء كل الجداول مرة واحدة
// ================================================================
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    // ── جدول المستخدمين ──
    await sql(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id       BIGINT        PRIMARY KEY,
        username          TEXT,
        photo_url         TEXT,
        points            BIGINT        NOT NULL DEFAULT 0,
        ads_watched_today INT           NOT NULL DEFAULT 0,
        last_ad_date      TEXT          NOT NULL DEFAULT '',
        ad_last_reward    TIMESTAMPTZ,
        daily_gift_day    INT           NOT NULL DEFAULT 1,
        daily_gift_claimed BOOLEAN      NOT NULL DEFAULT FALSE,
        last_gift_date    TEXT          NOT NULL DEFAULT '',
        referral_by       BIGINT,
        referral_friends  INT           NOT NULL DEFAULT 0,
        referral_rewarded BOOLEAN       NOT NULL DEFAULT FALSE,
        tg_task_done      BOOLEAN       NOT NULL DEFAULT FALSE,
        wd_history        JSONB         NOT NULL DEFAULT '[]',
        shadow_banned     BOOLEAN       NOT NULL DEFAULT FALSE,
        is_hard_banned    BOOLEAN       NOT NULL DEFAULT FALSE,
        risk_score        INT           NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    // ── جدول الجلسات ──
    await sql(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id      TEXT          PRIMARY KEY,
        telegram_id     BIGINT        NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        ip_hash         TEXT          NOT NULL,
        fingerprint     TEXT          NOT NULL,
        ad_nonce        TEXT,
        ad_nonce_exp    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        is_valid        BOOLEAN       NOT NULL DEFAULT TRUE
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ses_tg  ON sessions(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ses_exp ON sessions(expires_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ses_ip  ON sessions(ip_hash)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ses_fp  ON sessions(fingerprint)`);

    // ── جدول Nonces ──
    await sql(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce         TEXT          PRIMARY KEY,
        telegram_id   BIGINT        NOT NULL,
        used_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_exp ON nonces(expires_at)`);

    // ── جدول Rate Limiting ──
    await sql(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        telegram_id   BIGINT  NOT NULL,
        window_start  BIGINT  NOT NULL,
        request_count INT     NOT NULL DEFAULT 1,
        PRIMARY KEY (telegram_id, window_start)
      )
    `);

    // ── جدول سجل الأمان ──
    await sql(`
      CREATE TABLE IF NOT EXISTS security_logs (
        id            BIGSERIAL   PRIMARY KEY,
        telegram_id   BIGINT,
        ip_hash       TEXT,
        fingerprint   TEXT,
        action        TEXT        NOT NULL,
        risk_score    INT         NOT NULL DEFAULT 0,
        verdict       TEXT        NOT NULL DEFAULT 'allow',
        detail        JSONB       NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_tg  ON security_logs(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_at  ON security_logs(created_at DESC)`);

    // ── جدول بصمات الأجهزة ──
    await sql(`
      CREATE TABLE IF NOT EXISTS device_fingerprints (
        fingerprint   TEXT        NOT NULL,
        telegram_id   BIGINT      NOT NULL,
        user_agent    TEXT,
        lang          TEXT,
        screen        TEXT,
        timezone_off  INT,
        last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fingerprint, telegram_id)
      )
    `);

    console.log('[DB] Bootstrap OK — Zero Trust v1.0 (TON Spin)');
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

// ── Hash IP (لا نخزّن الـ IP الحقيقي أبداً) ──
function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256')
    .update(ip + (process.env.IP_SALT || 'tonspin_salt'))
    .digest('hex').slice(0, 32);
}

// ── بناء fingerprint من بيانات الجهاز ──
function buildFingerprint(fpData, ipHash) {
  const clientFp = fpData.fp || '';
  const ua       = (fpData.user_agent || '').slice(0, 200);
  const lang     = fpData.lang        || '';
  const screen   = fpData.screen      || '';
  const tz       = String(fpData.tz_offset  || 0);
  const tzName   = fpData.tz_name     || '';
  const cores    = String(fpData.hw_cores   || 0);
  const mem      = String(fpData.hw_mem     || 0);
  const canvas   = (fpData.canvas_sig || '').slice(0, 40);
  const webgl    = (fpData.webgl_sig  || '').slice(0, 60);

  const raw = clientFp
    ? [clientFp, ipHash, ua, lang, tz, tzName, cores, mem].join('|')
    : [ua, lang, screen, tz, tzName, cores, mem, canvas, webgl, ipHash].join('|');

  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

// ── إصدار Ad Nonce داخل الجلسة ──
async function issueAdNonce(sessionId) {
  const nonce  = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + AD_NONCE_TTL * 1000).toISOString();
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

  let expected, received;
  try {
    expected = Buffer.from(ad_nonce,    'hex');
    received = Buffer.from(clientNonce, 'hex');
  } catch {
    return false;
  }

  const match = expected.length === received.length &&
                crypto.timingSafeEqual(expected, received);

  // احذف النonce فوراً بعد التحقق (ناجح أو فاشل)
  await sql(`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
  return match;
}

// ── تنظيف دوري ──
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces      WHERE expires_at < NOW()`);
    await sql(`DELETE FROM rate_limits WHERE window_start < $1`, [Date.now() - RATE_WINDOW * 10]);
    console.log('[CLEANUP] nonces & rate_limits cleaned');
  } catch (e) {
    console.warn('[CLEANUP] error:', e.message);
  }
}, 60 * 60 * 1000);

// ── Rate Limiting (sliding window) ──
async function checkRateLimit(tid) {
  const window = Math.floor(Date.now() / RATE_WINDOW) * RATE_WINDOW;
  const rows   = await sql(
    `INSERT INTO rate_limits (telegram_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (telegram_id, window_start)
     DO UPDATE SET request_count = rate_limits.request_count + 1
     RETURNING request_count`,
    [tid, window]
  );
  return (rows[0]?.request_count || 0) <= RATE_LIMIT;
}

// ── Nonce check للعمليات العامة ──
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

// ── Risk Score ──
async function calcRiskScore(tid, ipHash, fingerprint) {
  let score = 0;

  const fp = await sql(
    `SELECT fingerprint FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`, [tid]
  );
  if (fp.length && fp[0].fingerprint !== fingerprint) score += 25;

  const ip = await sql(
    `SELECT ip_hash FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`, [tid]
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

// ── تحديث Risk Score للمستخدم ──
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

// ── التحقق من عضوية القناة عبر Telegram Bot API ──
async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;
  try {
    const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${channelUsername}&user_id=${telegramId}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.ok) return false;
    const status = data.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch (e) {
    console.warn('[verifyChannel] error:', e.message);
    return false;
  }
}

// ── اليوم الحالي UTC ──
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ── CORS headers ──
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint');
}

// ── توليد Session ID آمن ──
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ================================================================
//  MAIN HANDLER
// ================================================================
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ── استخراج headers الأمان ──
  const initData  = req.headers['x-init-data']  || '';
  const sessionId = req.headers['x-session-id'] || '';
  const nonce     = req.headers['x-nonce']       || '';
  const fpHeader  = req.headers['x-fingerprint'] || '{}';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // المشروع الجديد يرسل { type, data } — نوحّد مع نظام action
  const action = body?.action || body?.type;
  const data   = body?.data || {};

  if (!action) return res.status(400).json({ error: 'Missing action' });

  // ── معلومات الشبكة ──
  const rawIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const ipHash     = hashIP(rawIP);
  let fpData = {};
  try { fpData = JSON.parse(fpHeader); } catch (_) {}
  const fingerprint = buildFingerprint(fpData, ipHash);

  // ================================================================
  //  CREATE SESSION — يحتاج initData فقط
  // ================================================================
  if (action === 'create_session') {
    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });
    }

    const tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    // إنشاء/تحديث المستخدم
    await sql(
      `INSERT INTO users (telegram_id, username, photo_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = $2, photo_url = COALESCE($3, users.photo_url), updated_at = NOW()`,
      [tid, tgUser.username || tgUser.first_name || null, tgUser.photo_url || null]
    );

    // Transaction مع advisory lock
    const db = neon(DATABASE_URL);
    try {
      await db('BEGIN');

      const lockKey = BigInt('0x' + ipHash.slice(0, 15)) & BigInt('0x7FFFFFFFFFFFFFFF');
      await db(`SELECT pg_advisory_xact_lock($1)`, [lockKey.toString()]);

      // فحص Ban
      const banCheck = await db(
        `SELECT shadow_banned, is_hard_banned, risk_score, created_at FROM users WHERE telegram_id = $1`,
        [tid]
      );
      const userRow = banCheck[0];

      if (userRow?.is_hard_banned) {
        await db('ROLLBACK');
        await auditLog(tid, ipHash, fingerprint, 'create_session_hard_banned', 100, 'deny', {});
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
      }

      if (userRow?.shadow_banned) {
        await db('ROLLBACK');
        return res.status(200).json({ ok: false, is_banned: true });
      }

      // فحص Multi-Account (فقط للحسابات الجديدة)
      const accountAgeDays = userRow?.created_at
        ? (Date.now() - new Date(userRow.created_at).getTime()) / 86400000
        : 0;
      const isNewAccount   = accountAgeDays < MULTI_ACCT.NEW_ACCOUNT_AGE_DAYS;
      const isWhitelisted  = MULTI_ACCT.IP_WHITELIST.has(ipHash);

      if (!isWhitelisted && isNewAccount) {
        const ipCount = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM sessions
           WHERE ip_hash = $1 AND telegram_id != $2 AND is_valid = TRUE AND expires_at > NOW()`,
          [ipHash, tid]
        );
        const fpCount = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM device_fingerprints
           WHERE fingerprint = $1 AND telegram_id != $2`,
          [fingerprint, tid]
        );

        const ipViolation = parseInt(ipCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_IP;
        const fpViolation = parseInt(fpCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;

        if (fpViolation || (ipViolation && fpViolation)) {
          await db(`UPDATE users SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          await db(
            `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
             VALUES ($1, $2, $3, 'multi_account_detected', 100, 'deny', $4)`,
            [tid, ipHash, fingerprint, JSON.stringify({ ip_violation: ipViolation, fp_violation: fpViolation })]
          );
          await db('COMMIT');
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      // إلغاء الجلسات القديمة
      await db(`UPDATE sessions SET is_valid = FALSE WHERE telegram_id = $1`, [tid]);

      const sid = generateSessionId();
      await db(
        `INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint)
         VALUES ($1, $2, $3, $4)`,
        [sid, tid, ipHash, fingerprint]
      );

      await db(
        `INSERT INTO device_fingerprints (fingerprint, telegram_id, user_agent, lang, screen, timezone_off)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
        [fingerprint, tid, fpData.user_agent || null, fpData.lang || null, fpData.screen || null, fpData.tz_offset || 0]
      );

      await db('COMMIT');

      await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow', { tid });
      return res.status(200).json({ ok: true, session_id: sid });

    } catch (txErr) {
      try { await db('ROLLBACK'); } catch (_) {}
      console.error('[create_session TX]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ================================================================
  //  START_AD — إصدار Nonce للإعلان
  // ================================================================
  if (action === 'start_ad') {
    if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

    const rows = await sql(
      `SELECT session_id, telegram_id FROM sessions
       WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });

    const startTid = parseInt(rows[0].telegram_id);
    const userRow  = await sql(
      `SELECT shadow_banned, is_hard_banned FROM users WHERE telegram_id = $1`, [startTid]
    );
    if (userRow[0]?.is_hard_banned) return res.status(200).json({ ok: false, error: 'access_denied' });

    const adNonce = await issueAdNonce(sessionId);
    await auditLog(startTid, ipHash, fingerprint, 'start_ad', 0, 'allow', {});

    return res.status(200).json({ ok: true, ad_nonce: adNonce });
  }

  // ================================================================
  //  كل الأكشنات التالية تحتاج session صالحة
  // ================================================================
  if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

  const sessionRows = await sql(
    `SELECT * FROM sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
    [sessionId]
  );
  if (!sessionRows.length) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }

  const session = sessionRows[0];
  const tid     = parseInt(session.telegram_id);

  // فحص fingerprint — الجهاز تغيّر = خطر
  if (session.fingerprint !== fingerprint) {
    await sql(`UPDATE sessions SET is_valid = FALSE WHERE session_id = $1`, [sessionId]);
    await updateUserRisk(tid, 30);
    await auditLog(tid, ipHash, fingerprint, action, 30, 'deny', { reason: 'fingerprint_mismatch' });
    return res.status(401).json({ ok: false, error: 'Session mismatch — please re-authenticate' });
  }

  // IP تغيّر — طبيعي، نُحدّث برفق
  if (session.ip_hash !== ipHash) {
    await sql(`UPDATE sessions SET ip_hash = $2 WHERE session_id = $1`, [sessionId, ipHash]);
    await updateUserRisk(tid, 5);
  }

  // Rate Limiting
  const withinLimit = await checkRateLimit(tid);
  if (!withinLimit) {
    await updateUserRisk(tid, 5);
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // Nonce (للعمليات المهمة — ليس get/ad)
  const noNonceActions = ['get_state', 'load', 'watch_ad', 'start_ad', 'verify_tg_membership', 'track_copy_link'];
  if (!noNonceActions.includes(action)) {
    const nonceValid = await checkNonce(tid, nonce);
    if (!nonceValid) {
      await updateUserRisk(tid, 20);
      await auditLog(tid, ipHash, fingerprint, action, 20, 'deny', { reason: 'nonce_replay' });
      return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
    }
  }

  // Risk Score + Shadow Ban check
  const riskScore = await calcRiskScore(tid, ipHash, fingerprint);
  const userState = await sql(`SELECT risk_score, shadow_banned, is_hard_banned FROM users WHERE telegram_id = $1`, [tid]);
  const isShadowBanned = userState[0]?.shadow_banned || false;

  await auditLog(tid, ipHash, fingerprint, action, riskScore, isShadowBanned ? 'shadow' : 'allow', {});

  try {

    // ══════════════════════════════════════════════════════════════
    //  LOAD — جلب بيانات المستخدم
    // ══════════════════════════════════════════════════════════════
    if (action === 'load' || action === 'get_state') {
      const today    = todayUTC();
      const refBy    = data.referral_by ? parseInt(data.referral_by) : null;
      const validRef = refBy && !isNaN(refBy) && refBy !== tid ? refBy : null;

      // إنشاء المستخدم إن لم يكن موجوداً
      await sql(
        `INSERT INTO users (telegram_id, username, referral_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) DO UPDATE
           SET username    = EXCLUDED.username,
               referral_by = COALESCE(users.referral_by, EXCLUDED.referral_by),
               updated_at  = NOW()`,
        [tid, data.username || null, validRef]
      );

      // إعادة تعيين عداد الإعلانات اليومي
      await sql(
        `UPDATE users
         SET ads_watched_today = 0, last_ad_date = $2, updated_at = NOW()
         WHERE telegram_id = $1 AND last_ad_date != $2`,
        [tid, today]
      );

      // إعادة تعيين daily gift إذا كان يوم جديد
      await sql(
        `UPDATE users
         SET daily_gift_claimed = FALSE, updated_at = NOW()
         WHERE telegram_id = $1 AND last_gift_date != $2`,
        [tid, today]
      );

      // معالجة الإحالة (مرة واحدة فقط)
      const u = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      if (u[0]?.referral_by && !u[0]?.referral_rewarded) {
        const refExists = await sql(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [u[0].referral_by]);
        if (refExists.length) {
          await sql(
            `UPDATE users SET referral_friends = referral_friends + 1, updated_at = NOW()
             WHERE telegram_id = $1`,
            [u[0].referral_by]
          );
        }
        await sql(`UPDATE users SET referral_rewarded = TRUE WHERE telegram_id = $1`, [tid]);
      }

      const user = (await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]))[0];
      const remainingAds = Math.max(0, AD_DAILY_MAX - (user.ads_watched_today || 0));

      return res.status(200).json({
        ok: true,
        user: {
          ...user,
          remaining_ads: remainingAds,
        }
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  WATCH_AD — مشاهدة إعلان
    //  ✅ يتحقق من session-based ad_nonce
    //  ✅ يحسب العداد اليومي server-side فقط
    //  ✅ shadow ban → رد ناجح زائف
    // ══════════════════════════════════════════════════════════════
    if (action === 'watch_ad') {
      const { ad_nonce: clientAdNonce } = data;

      // التحقق من النonce
      const nonceValid = await consumeAdNonce(sessionId, clientAdNonce);
      if (!nonceValid) {
        await updateUserRisk(tid, 20);
        await auditLog(tid, ipHash, fingerprint, 'watch_ad_nonce_fail', 20, 'deny',
          { reason: 'invalid_ad_nonce' });
        return res.status(400).json({ ok: false, error: 'Invalid or missing ad nonce' });
      }

      // Cooldown: 3 ثواني بين كل إعلان
      const cdRows = await sql(`SELECT ad_last_reward FROM users WHERE telegram_id = $1`, [tid]);
      const lastReward = cdRows[0]?.ad_last_reward;
      if (lastReward) {
        const elapsedMs = Date.now() - new Date(lastReward).getTime();
        if (elapsedMs < 3000) {
          return res.status(429).json({ ok: false, error: 'Please wait before watching another ad' });
        }
      }

      const today = todayUTC();

      // جلب الحالة الحالية
      const uRows = await sql(
        `SELECT ads_watched_today, last_ad_date FROM users WHERE telegram_id = $1`, [tid]
      );
      const currentWatched = uRows[0]?.last_ad_date === today
        ? (uRows[0]?.ads_watched_today || 0) : 0;

      if (currentWatched >= AD_DAILY_MAX) {
        return res.status(200).json({
          ok: false,
          error: 'Daily ad limit reached',
          remaining: 0,
          watchedToday: currentWatched,
        });
      }

      // Shadow ban → رد ناجح زائف
      if (isShadowBanned) {
        return res.status(200).json({
          ok: true,
          remaining:    Math.max(0, AD_DAILY_MAX - currentWatched - 1),
          watchedToday: currentWatched + 1,
          earnedToday:  (currentWatched + 1) * 50,
        });
      }

      // تطبيق المكافأة
      const newWatched = currentWatched + 1;
      await sql(
        `UPDATE users
         SET ads_watched_today = $2,
             last_ad_date      = $3,
             ad_last_reward    = NOW(),
             updated_at        = NOW()
         WHERE telegram_id = $1`,
        [tid, newWatched, today]
      );

      await auditLog(tid, ipHash, fingerprint, 'watch_ad', 0, 'allow',
        { watched: newWatched, remaining: AD_DAILY_MAX - newWatched });

      console.log(`[AD] tid=${tid} watched=${newWatched}/${AD_DAILY_MAX}`);

      return res.status(200).json({
        ok: true,
        remaining:    AD_DAILY_MAX - newWatched,
        watchedToday: newWatched,
        earnedToday:  newWatched * 50,
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  VERIFY_TG_MEMBERSHIP — تحقق عضوية القناة
    // ══════════════════════════════════════════════════════════════
    if (action === 'verify_tg_membership') {
      // تحقق حقيقي عبر Telegram Bot API
      const isMember = await verifyChannelMembership(tid, TG_CHANNEL);

      if (!isMember) {
        return res.status(200).json({ ok: false, error: 'not_member' });
      }

      // shadow ban → رد ناجح زائف
      if (isShadowBanned) return res.status(200).json({ ok: true });

      // منع التكرار
      const alreadyDone = await sql(`SELECT tg_task_done FROM users WHERE telegram_id = $1`, [tid]);
      if (alreadyDone[0]?.tg_task_done) {
        return res.status(200).json({ ok: true, already_done: true });
      }

      // إضافة المكافأة (2500 نقطة)
      const TASK_REWARD = 2500;
      await sql(
        `UPDATE users
         SET tg_task_done = TRUE,
             points       = points + $2,
             updated_at   = NOW()
         WHERE telegram_id = $1`,
        [tid, TASK_REWARD]
      );

      const updated = await sql(`SELECT points FROM users WHERE telegram_id = $1`, [tid]);
      await auditLog(tid, ipHash, fingerprint, 'verify_tg_membership', 0, 'allow',
        { reward: TASK_REWARD, new_points: updated[0]?.points });

      console.log(`[TASK] tg_membership verified tid=${tid} +${TASK_REWARD}pts`);
      return res.status(200).json({ ok: true, reward: TASK_REWARD, points: updated[0]?.points });
    }

    // ══════════════════════════════════════════════════════════════
    //  CLAIM_GIFT — هدية يومية
    // ══════════════════════════════════════════════════════════════
    if (action === 'claim_gift') {
      const today = todayUTC();

      const uRows = await sql(
        `SELECT daily_gift_day, daily_gift_claimed, last_gift_date FROM users WHERE telegram_id = $1`, [tid]
      );
      if (!uRows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const u = uRows[0];

      // تحقق: هل استلم اليوم فعلاً؟
      if (u.daily_gift_claimed && u.last_gift_date === today) {
        return res.status(200).json({ ok: false, error: 'already_claimed' });
      }

      const GIFT_REWARDS = [100, 150, 200, 250, 300, 400, 750];
      const dayIndex     = Math.min((u.daily_gift_day || 1) - 1, GIFT_REWARDS.length - 1);
      const pts          = GIFT_REWARDS[dayIndex];

      // shadow ban → رد ناجح زائف
      if (isShadowBanned) return res.status(200).json({ ok: true, pts });

      const nextDay = Math.min((u.daily_gift_day || 1) + 1, 7);
      await sql(
        `UPDATE users
         SET points             = points + $2,
             daily_gift_claimed = TRUE,
             last_gift_date     = $3,
             daily_gift_day     = $4,
             updated_at         = NOW()
         WHERE telegram_id = $1`,
        [tid, pts, today, nextDay]
      );

      const updated = await sql(`SELECT points FROM users WHERE telegram_id = $1`, [tid]);
      await auditLog(tid, ipHash, fingerprint, 'claim_gift', 0, 'allow', { pts, day: u.daily_gift_day });

      console.log(`[GIFT] tid=${tid} day=${u.daily_gift_day} +${pts}pts`);
      return res.status(200).json({ ok: true, pts, points: updated[0]?.points });
    }

    // ══════════════════════════════════════════════════════════════
    //  SUBMIT_WITHDRAW — طلب سحب
    // ══════════════════════════════════════════════════════════════
    if (action === 'submit_withdraw') {
      const { address, pts } = data;
      const amount = parseInt(pts);

      if (!address || typeof address !== 'string')
        return res.status(400).json({ ok: false, error: 'Missing address' });

      const addr = address.trim();
      if ((!addr.startsWith('EQ') && !addr.startsWith('UQ') && !addr.startsWith('0:')) || addr.length < 48)
        return res.status(400).json({ ok: false, error: 'Invalid TON address' });

      if (isNaN(amount) || amount <= 0)
        return res.status(400).json({ ok: false, error: 'Invalid amount' });

      // shadow ban → رفض
      if (isShadowBanned) return res.status(403).json({ ok: false, error: 'Account under review' });

      const uRows = await sql(`SELECT points, wd_history FROM users WHERE telegram_id = $1`, [tid]);
      if (!uRows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const currentPoints = parseInt(uRows[0]?.points || 0);
      if (currentPoints < amount)
        return res.status(400).json({ ok: false, error: 'insufficient_balance' });

      const entry   = { address: addr, pts: amount, date: new Date().toISOString(), status: 'pending' };
      const history = Array.isArray(uRows[0].wd_history) ? uRows[0].wd_history : [];
      history.unshift(entry);
      if (history.length > 50) history.splice(50);

      await sql(
        `UPDATE users SET points = points - $2, wd_history = $3, updated_at = NOW() WHERE telegram_id = $1`,
        [tid, amount, JSON.stringify(history)]
      );

      await auditLog(tid, ipHash, fingerprint, 'submit_withdraw', 0, 'allow', { address: addr, pts: amount });
      console.log(`[WITHDRAW] tid=${tid} pts=${amount} addr=${addr.slice(0, 10)}...`);

      return res.status(200).json({ ok: true, entry });
    }

    // ══════════════════════════════════════════════════════════════
    //  TRACK_COPY_LINK — تتبع نسخ رابط الإحالة (fire-and-forget)
    // ══════════════════════════════════════════════════════════════
    if (action === 'track_copy_link') {
      await auditLog(tid, ipHash, fingerprint, 'copy_referral_link', 0, 'allow', {});
      return res.status(200).json({ ok: true });
    }

    // ══════════════════════════════════════════════════════════════
    //  UPDATE_WITHDRAWAL — Admin endpoint
    // ══════════════════════════════════════════════════════════════
    if (action === 'update_withdrawal') {
      const adminKey = req.headers['x-admin-key'] || '';
      if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
        return res.status(403).json({ ok: false, error: 'Unauthorized' });

      const { target_tid, date, status: newStatus } = data;
      const allowedStatuses = ['completed', 'approved', 'rejected'];
      if (!allowedStatuses.includes(newStatus))
        return res.status(400).json({ ok: false, error: 'Invalid status' });

      const targetId = parseInt(target_tid);
      if (isNaN(targetId)) return res.status(400).json({ ok: false, error: 'Invalid target_tid' });

      const rows = await sql(`SELECT wd_history FROM users WHERE telegram_id = $1`, [targetId]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const history = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      let updated   = false;

      const updatedHistory = history.map(entry => {
        if (entry.status === 'pending' && !updated) {
          if (!date || entry.date === date) {
            updated = true;
            return { ...entry, status: newStatus, updated_at: new Date().toISOString() };
          }
        }
        return entry;
      });

      if (!updated) return res.status(404).json({ ok: false, error: 'No pending withdrawal found' });

      await sql(
        `UPDATE users SET wd_history = $2, updated_at = NOW() WHERE telegram_id = $1`,
        [targetId, JSON.stringify(updatedHistory)]
      );

      return res.status(200).json({ ok: true, message: `Withdrawal marked as ${newStatus}` });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action', action });

  } catch (err) {
    console.error('[API Error]', action, err.message);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      ...(process.env.NODE_ENV !== 'production' && { detail: err.message })
    });
  }
};
