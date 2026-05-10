// ================================================================
//  🔐 SECURE BACKEND — Zero Trust Architecture v1.0
//  مبني على تحليل النظام الأصلي (Tomato Farm v3.0)
//  متوافق مع المشروع الجديد (index.html)
//
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session management (IP + fingerprint bound)
//  ✅ Session-based Nonce system (replay attack prevention)
//  ✅ Rate limiting (per user, sliding window)
//  ✅ Multi-account detection (IP + Fingerprint)
//  ✅ Shadow ban + Hard ban system
//  ✅ Anti-automation heuristics
//  ✅ Server-side time only — client time never trusted
//  ✅ Server-side reward calculation — client values never trusted
//  ✅ Full audit logging
//  ✅ Daily limit enforcement via security_logs
//  ✅ Referral system (server-side only)
//  ✅ Daily gift (server-side only)
//  ✅ Ad reward with nonce lifecycle
// ================================================================

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

// ── DB executor ──────────────────────────────────────────────────
const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ================================================================
//  CONSTANTS — جميع القيم الحساسة هنا فقط، لا في frontend
// ================================================================
const INIT_DATA_TTL   = 3600;    // 1 ساعة — صلاحية initData
const SESSION_TTL     = 86400;   // 24 ساعة — صلاحية الجلسة
const NONCE_TTL       = 300;     // 5 دقائق — صلاحية nonce الإعلان
const RATE_WINDOW     = 5000;    // 5 ثواني — نافذة rate limit
const RATE_LIMIT      = 15;      // max requests per window
const RISK_SUSPICIOUS = 41;
const RISK_BAN        = 71;

// ── نقاط المكافآت — السيرفر يحددها، لا العميل أبداً ──
const REWARDS = {
  // مكافأة مشاهدة إعلان واحد
  AD_WATCH:          50,          // نقطة لكل إعلان
  AD_DAILY_LIMIT:    10,          // حد يومي: عدد الإعلانات
  // مكافأة مهمة القناة
  CHANNEL_TASK:      2500,        // نقطة
  // مكافأة الإحالة
  REFERRAL_REWARD:   500,         // نقطة لكل إحالة ناجحة
  // مكافأة الهدية اليومية
  DAILY_GIFT:        200,         // نقطة (تتضاعف كل يوم متتالي)
  DAILY_GIFT_CAP:    2000,        // الحد الأقصى للتضاعف
  // المهام اليومية
  DAILY_TASK_ADS10:  1000,        // إتمام 10 إعلانات
  DAILY_TASK_ADS25:  2200,        // إتمام 25 إعلاناً
  DAILY_TASK_INVITE3: 3000,       // دعوة 3 أصدقاء
};

// ── Multi-Account Config ──────────────────────────────────────────
const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_IP:          2,
  MAX_ACCOUNTS_PER_FINGERPRINT: 1,
  NEW_ACCOUNT_AGE_DAYS:         3,
  IP_WHITELIST: new Set([
    // أضف ip_hash للشبكات الموثوقة
  ]),
};

// ================================================================
//  DATABASE BOOTSTRAP
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
        first_name        TEXT,
        photo_url         TEXT,
        points            BIGINT        NOT NULL DEFAULT 0,
        usdt_balance      NUMERIC(18,6) NOT NULL DEFAULT 0,
        total_earned      BIGINT        NOT NULL DEFAULT 0,
        ads_today         INT           NOT NULL DEFAULT 0,
        ads_today_date    TEXT          NOT NULL DEFAULT '',
        daily_task_ads10  BOOLEAN       NOT NULL DEFAULT FALSE,
        daily_task_ads25  BOOLEAN       NOT NULL DEFAULT FALSE,
        daily_task_inv3   BOOLEAN       NOT NULL DEFAULT FALSE,
        daily_tasks_date  TEXT          NOT NULL DEFAULT '',
        channel_joined    BOOLEAN       NOT NULL DEFAULT FALSE,
        channel_task_done BOOLEAN       NOT NULL DEFAULT FALSE,
        referral_by       BIGINT,
        referral_count    INT           NOT NULL DEFAULT 0,
        referral_points   BIGINT        NOT NULL DEFAULT 0,
        referral_rewarded BOOLEAN       NOT NULL DEFAULT FALSE,
        daily_gift_streak INT           NOT NULL DEFAULT 0,
        daily_gift_date   TEXT          NOT NULL DEFAULT '',
        wd_history        JSONB         NOT NULL DEFAULT '[]',
        shadow_banned     BOOLEAN       NOT NULL DEFAULT FALSE,
        is_hard_banned    BOOLEAN       NOT NULL DEFAULT FALSE,
        risk_score        INT           NOT NULL DEFAULT 0,
        ad_last_reward    TIMESTAMPTZ,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    // ── جدول الجلسات ──
    await sql(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id    TEXT        PRIMARY KEY,
        telegram_id   BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        ip_hash       TEXT        NOT NULL,
        fingerprint   TEXT        NOT NULL,
        ad_nonce      TEXT,
        ad_nonce_exp  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        is_valid      BOOLEAN     NOT NULL DEFAULT TRUE
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_tid    ON sessions(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_exp    ON sessions(expires_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_ip     ON sessions(ip_hash)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_fp     ON sessions(fingerprint)`);

    // ── جدول Nonce (منع إعادة الإرسال للعمليات العامة) ──
    await sql(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce         TEXT        PRIMARY KEY,
        telegram_id   BIGINT      NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
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

    // ── جدول بصمات الأجهزة ──
    await sql(`
      CREATE TABLE IF NOT EXISTS device_fingerprints (
        fingerprint   TEXT        NOT NULL,
        telegram_id   BIGINT      NOT NULL,
        user_agent    TEXT,
        lang          TEXT,
        last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fingerprint, telegram_id)
      )
    `);

    // ── جدول سجلات الأمان ──
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
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_tid     ON security_logs(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_created ON security_logs(created_at DESC)`);

    // ── Migrations ──
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS ad_last_reward TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce TEXT`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`,
    ];
    for (const m of migrations) {
      try { await sql(m); } catch (_) {}
    }

    console.log('[DB] Bootstrap OK — Zero Trust v1.0');
  } catch (e) {
    console.error('[DB] Bootstrap failed:', e.message);
  }
}
bootstrap();

// ── تنظيف دوري كل ساعة ──────────────────────────────────────────
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces      WHERE expires_at  < NOW()`);
    await sql(`DELETE FROM rate_limits WHERE window_start < $1`, [Date.now() - RATE_WINDOW * 10]);
    await sql(`DELETE FROM sessions    WHERE expires_at  < NOW() AND is_valid = FALSE`);
    console.log('[CLEANUP] Periodic cleanup done');
  } catch (e) {
    console.warn('[CLEANUP] error:', e.message);
  }
}, 60 * 60 * 1000);

// ================================================================
//  SECURITY CORE — Zero Trust Engine
// ================================================================

// ── Telegram initData verification (HMAC-SHA256) ──
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

// ── Hash IP — لا نخزن IP الحقيقي أبداً ──
function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'zt_salt_v1')).digest('hex').slice(0, 32);
}

// ── Device Fingerprint builder ──
function buildFingerprint(fpData, ipHash) {
  const clientFp = fpData.fp || '';
  const ua       = (fpData.user_agent || '').slice(0, 200);
  const lang     = fpData.lang || '';
  const tz       = String(fpData.tz_offset || 0);
  const tzName   = fpData.tz_name || '';
  const cores    = String(fpData.hw_cores || 0);
  const mem      = String(fpData.hw_mem || 0);

  const raw = clientFp
    ? [clientFp, ipHash, ua, lang, tz, tzName, cores, mem].join('|')
    : [ua, lang, fpData.screen || '', tz, tzName, cores, mem,
       fpData.touch_pts || 0, fpData.canvas_sig || '', fpData.webgl_sig || '',
       fpData.audio_sig || '', fpData.dpr || '', fpData.color_depth || 0, ipHash].join('|');

  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

// ── Session-based Ad Nonce — السيرفر يُنشئه فقط ──
async function issueAdNonce(sessionId) {
  const nonce  = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + NONCE_TTL * 1000).toISOString();
  await sql(
    `UPDATE sessions SET ad_nonce = $2, ad_nonce_exp = $3 WHERE session_id = $1`,
    [sessionId, nonce, expiry]
  );
  return nonce;
}

// ── Consume Ad Nonce — one-time use ──
async function consumeAdNonce(sessionId, clientNonce) {
  if (!clientNonce || !sessionId) return false;
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp FROM sessions WHERE session_id = $1 AND is_valid = TRUE`,
    [sessionId]
  );
  if (!rows.length) return false;

  const { ad_nonce, ad_nonce_exp } = rows[0];
  if (!ad_nonce) return false;
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
    return false;
  }

  let match = false;
  try {
    const expected = Buffer.from(ad_nonce,    'hex');
    const received = Buffer.from(clientNonce, 'hex');
    match = expected.length === received.length && crypto.timingSafeEqual(expected, received);
  } catch { match = false; }

  if (!match) return false;

  // ✅ حذف فوري بعد الاستخدام — one-time
  await sql(`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
  return true;
}

// ── General Nonce (للعمليات الأخرى) ──
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

// ── Rate Limiting (sliding window) ──
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

// ── Risk Score Calculation ──
async function calcRiskScore(tid, ipHash, fingerprint) {
  let score = 0;
  const fp = await sql(
    `SELECT fingerprint FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`,
    [tid]
  );
  if (fp.length && fp[0].fingerprint !== fingerprint) score += 25;

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

// ── Update User Risk ──
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

// ── Session ID generator ──
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Today's UTC date string ──
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

// ================================================================
//  MAIN HANDLER
// ================================================================
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Security Headers ──
  const initData  = req.headers['x-init-data']   || '';
  const sessionId = req.headers['x-session-id']  || '';
  const nonce     = req.headers['x-nonce']        || '';
  const fpHeader  = req.headers['x-fingerprint']  || '{}';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { action, data = {} } = body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // ── Network info ──
  const rawIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                     || req.socket?.remoteAddress || '';
  const ipHash     = hashIP(rawIP);
  let fpData = {};
  try { fpData = JSON.parse(fpHeader); } catch (_) {}
  const fingerprint = buildFingerprint(fpData, ipHash);

  // ================================================================
  //  ACTION: create_session — يُستدعى أول مرة فقط مع initData
  // ================================================================
  if (action === 'create_session') {
    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });
    }

    const tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    // إنشاء/تحديث المستخدم أولاً
    await sql(
      `INSERT INTO users (telegram_id, username, first_name, photo_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username = COALESCE($2, users.username),
             first_name = COALESCE($3, users.first_name),
             updated_at = NOW()`,
      [tid, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
    );

    // ── ATOMIC Multi-Account Detection ──
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
        await auditLog(tid, ipHash, fingerprint, 'create_session', 100, 'deny', { reason: 'hard_banned' });
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
      }
      if (userRow?.shadow_banned) {
        await db('ROLLBACK');
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'shadow' });
      }

      // حساب عمر الحساب
      const accountAge = userRow?.created_at
        ? (Date.now() - new Date(userRow.created_at).getTime()) / (86400000)
        : 0;
      const isNewAccount   = accountAge < MULTI_ACCT.NEW_ACCOUNT_AGE_DAYS;
      const isWhitelisted  = MULTI_ACCT.IP_WHITELIST.has(ipHash);

      if (!isWhitelisted && isNewAccount) {
        // IP: عدد الحسابات المختلفة
        const ipCount = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM sessions
           WHERE ip_hash = $1 AND telegram_id != $2 AND is_valid = TRUE AND expires_at > NOW()`,
          [ipHash, tid]
        );
        const accountsOnIP = parseInt(ipCount[0]?.cnt || 0);

        // Fingerprint: أقوى من IP — يمثل الجهاز الفعلي
        const fpCount = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM device_fingerprints
           WHERE fingerprint = $1 AND telegram_id != $2`,
          [fingerprint, tid]
        );
        const accountsOnFP = parseInt(fpCount[0]?.cnt || 0);

        const ipVio = accountsOnIP >= MULTI_ACCT.MAX_ACCOUNTS_PER_IP;
        const fpVio = accountsOnFP >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;

        // Ban إذا: fingerprint مكرر وحده (أقوى دليل) أو كلاهما معاً
        if (fpVio || (ipVio && fpVio)) {
          await db(
            `UPDATE users SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`,
            [tid]
          );
          await db(
            `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
             VALUES ($1, $2, $3, 'multi_account_detected', 100, 'deny', $4)`,
            [tid, ipHash, fingerprint, JSON.stringify({
              reason: 'multi_account_hard_ban',
              ip_accounts: accountsOnIP, fp_accounts: accountsOnFP,
              is_new: isNewAccount,
            })]
          );
          await db('COMMIT');
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      // إلغاء الجلسات القديمة + إنشاء جلسة جديدة
      await db(`UPDATE sessions SET is_valid = FALSE WHERE telegram_id = $1`, [tid]);

      const sid = generateSessionId();
      await db(
        `INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint)
         VALUES ($1, $2, $3, $4)`,
        [sid, tid, ipHash, fingerprint]
      );

      // حفظ بصمة الجهاز
      await db(
        `INSERT INTO device_fingerprints (fingerprint, telegram_id, user_agent, lang)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
        [fingerprint, tid, fpData.user_agent || null, fpData.lang || null]
      );

      await db('COMMIT');

      await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow', { tg_id: tid });
      return res.status(200).json({ ok: true, session_id: sid });

    } catch (txErr) {
      try { await db('ROLLBACK'); } catch (_) {}
      console.error('[create_session TX Error]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ================================================================
  //  ACTION: start_ad — إصدار Nonce (السيرفر فقط يُنشئه)
  // ================================================================
  if (action === 'start_ad') {
    if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

    const sess = await sql(
      `SELECT session_id, telegram_id FROM sessions
       WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!sess.length) return res.status(401).json({ ok: false, error: 'Invalid session' });

    const tid = parseInt(sess[0].telegram_id);
    const userBan = await sql(`SELECT is_hard_banned FROM users WHERE telegram_id = $1`, [tid]);
    if (userBan[0]?.is_hard_banned) return res.status(200).json({ ok: false, error: 'access_denied' });

    const adNonce = await issueAdNonce(sessionId);
    await auditLog(tid, ipHash, fingerprint, 'start_ad', 0, 'allow', {});

    return res.status(200).json({ ok: true, ad_nonce: adNonce });
  }

  // ================================================================
  //  SESSION VALIDATION — كل الـ actions التالية تحتاج session صالحة
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

  // تحقق fingerprint — رفض قاطع إذا اختلف الجهاز
  if (session.fingerprint !== fingerprint) {
    await sql(`UPDATE sessions SET is_valid = FALSE WHERE session_id = $1`, [sessionId]);
    await updateUserRisk(tid, 30);
    await auditLog(tid, ipHash, fingerprint, action, 30, 'deny', { reason: 'fingerprint_mismatch' });
    return res.status(401).json({ ok: false, error: 'Session mismatch — re-authenticate' });
  }

  // IP تغيّر — طبيعي (NAT/4G) — نقبله بـ risk منخفض
  if (session.ip_hash !== ipHash) {
    await sql(`UPDATE sessions SET ip_hash = $2 WHERE session_id = $1`, [sessionId, ipHash]);
    await updateUserRisk(tid, 5);
  }

  // ── Rate Limiting ──
  const withinLimit = await checkRateLimit(tid);
  if (!withinLimit) {
    await updateUserRisk(tid, 5);
    return res.status(429).json({ ok: false, error: 'Too many requests — slow down' });
  }

  // ── Nonce للعمليات العامة (ليس الإعلانات) ──
  const skipNonce = ['get_state', 'load', 'reward_ad', 'start_ad'].includes(action);
  if (!skipNonce) {
    const nonceValid = await checkNonce(tid, nonce);
    if (!nonceValid) {
      await updateUserRisk(tid, 20);
      await auditLog(tid, ipHash, fingerprint, action, 20, 'deny', { reason: 'nonce_replay' });
      return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
    }
  }

  // ── Risk + Shadow Ban status ──
  const riskScore  = await calcRiskScore(tid, ipHash, fingerprint);
  const userStatus = await sql(`SELECT risk_score, shadow_banned FROM users WHERE telegram_id = $1`, [tid]);
  const isShadowBanned = userStatus[0]?.shadow_banned || false;

  await auditLog(tid, ipHash, fingerprint, action, riskScore, isShadowBanned ? 'shadow' : 'allow', {});

  try {
    // ============================================================
    //  LOAD — تحميل بيانات المستخدم
    // ============================================================
    if (action === 'load') {
      const refBy = data.referral_by ? parseInt(data.referral_by) : null;
      const validRef = refBy && !isNaN(refBy) && refBy !== tid ? refBy : null;

      let rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);

      if (!rows.length) {
        rows = await sql(
          `INSERT INTO users (telegram_id, referral_by)
           VALUES ($1, $2)
           ON CONFLICT (telegram_id) DO UPDATE
             SET referral_by = COALESCE(users.referral_by, EXCLUDED.referral_by)
           RETURNING *`,
          [tid, validRef]
        );
      } else if (validRef && !rows[0].referral_by) {
        await sql(
          `UPDATE users SET referral_by = $2 WHERE telegram_id = $1 AND referral_by IS NULL`,
          [tid, validRef]
        );
        rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      }

      const user = rows[0];

      // معالجة إحالة (مرة واحدة فقط)
      if (user.referral_by && !user.referral_rewarded) {
        const refExists = await sql(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [user.referral_by]);
        if (refExists.length) {
          await sql(
            `UPDATE users
             SET referral_count  = referral_count + 1,
                 referral_points = referral_points + $2,
                 points          = points + $2,
                 total_earned    = total_earned + $2,
                 updated_at      = NOW()
             WHERE telegram_id = $1`,
            [user.referral_by, REWARDS.REFERRAL_REWARD]
          );
        }
        await sql(`UPDATE users SET referral_rewarded = TRUE WHERE telegram_id = $1`, [tid]);
        rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      }

      // Reset يومي للإعلانات
      const today = todayUTC();
      if (rows[0].ads_today_date !== today) {
        await sql(
          `UPDATE users SET ads_today = 0, ads_today_date = $2, updated_at = NOW()
           WHERE telegram_id = $1`,
          [tid, today]
        );
        rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      }

      // Reset يومي للمهام اليومية
      if (rows[0].daily_tasks_date !== today) {
        await sql(
          `UPDATE users
           SET daily_task_ads10 = FALSE, daily_task_ads25 = FALSE, daily_task_inv3 = FALSE,
               daily_tasks_date = $2, updated_at = NOW()
           WHERE telegram_id = $1`,
          [tid, today]
        );
        rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      }

      const finalUser = rows[0];
      const realReferrals = await sql(
        `SELECT COUNT(*) AS cnt FROM users WHERE referral_by = $1 AND referral_rewarded = TRUE`,
        [tid]
      );

      return res.status(200).json({
        ok: true,
        user: sanitizeUser(finalUser, parseInt(realReferrals[0]?.cnt || 0))
      });
    }

    // ============================================================
    //  GET_STATE — polling خفيف
    // ============================================================
    if (action === 'get_state') {
      const rows = await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const user  = rows[0];
      const today = todayUTC();
      let needUpdate = false;

      if (user.ads_today_date !== today) {
        await sql(
          `UPDATE users SET ads_today = 0, ads_today_date = $2, updated_at = NOW() WHERE telegram_id = $1`,
          [tid, today]
        );
        needUpdate = true;
      }
      if (user.daily_tasks_date !== today) {
        await sql(
          `UPDATE users
           SET daily_task_ads10 = FALSE, daily_task_ads25 = FALSE, daily_task_inv3 = FALSE,
               daily_tasks_date = $2, updated_at = NOW()
           WHERE telegram_id = $1`,
          [tid, today]
        );
        needUpdate = true;
      }

      const finalRows = needUpdate
        ? await sql(`SELECT * FROM users WHERE telegram_id = $1`, [tid])
        : rows;

      const realReferrals = await sql(
        `SELECT COUNT(*) AS cnt FROM users WHERE referral_by = $1 AND referral_rewarded = TRUE`,
        [tid]
      );

      return res.status(200).json({
        ok: true,
        user: sanitizeUser(finalRows[0], parseInt(realReferrals[0]?.cnt || 0))
      });
    }

    // ============================================================
    //  REWARD_AD — مكافأة إعلان موثّقة (Zero-Trust Ad Reward)
    //  ✅ يتحقق من session + ad_nonce (مُنشأ من السيرفر عبر start_ad)
    //  ✅ one-time nonce — يُحذف فور الاستهلاك
    //  ✅ cooldown 3 ثواني بين كل مكافأة
    //  ✅ حد يومي صارم من security_logs
    //  ✅ السيرفر يحدد قيمة المكافأة — لا قيمة من العميل
    // ============================================================
    if (action === 'reward_ad') {
      const { ad_nonce: clientAdNonce } = data;

      // التحقق من session-based nonce
      const nonceValid = await consumeAdNonce(sessionId, clientAdNonce);
      if (!nonceValid) {
        await updateUserRisk(tid, 20);
        await auditLog(tid, ipHash, fingerprint, 'reward_ad_nonce_fail', 20, 'deny',
          { reason: 'invalid_ad_nonce' });
        return res.status(400).json({ ok: false, error: 'Invalid or missing ad nonce' });
      }

      // Cooldown: منع طلبات متوازية
      const cooldownRow = await sql(`SELECT ad_last_reward FROM users WHERE telegram_id = $1`, [tid]);
      if (cooldownRow[0]?.ad_last_reward) {
        const elapsed = Date.now() - new Date(cooldownRow[0].ad_last_reward).getTime();
        if (elapsed < 3000) {
          return res.status(429).json({ ok: false, error: 'Please wait before next reward' });
        }
      }

      // فحص الحد اليومي
      const usageRows = await sql(
        `SELECT COUNT(*) AS cnt FROM security_logs
         WHERE telegram_id = $1 AND action = 'reward_ad'
           AND verdict = 'allow' AND created_at >= NOW() - INTERVAL '24 hours'`,
        [tid]
      );
      const adsToday = parseInt(usageRows[0]?.cnt || 0);

      if (adsToday >= REWARDS.AD_DAILY_LIMIT) {
        await auditLog(tid, ipHash, fingerprint, 'reward_ad', 0, 'deny',
          { reason: 'daily_limit', count: adsToday });
        return res.status(200).json({ ok: false, error: 'Daily ad limit reached' });
      }

      // Shadow ban — رد ناجح زائف
      if (isShadowBanned) {
        const fakeRow = await sql(`SELECT points, ads_today FROM users WHERE telegram_id = $1`, [tid]);
        return res.status(200).json({
          ok: true,
          points:    parseInt(fakeRow[0]?.points || 0),
          ads_today: parseInt(fakeRow[0]?.ads_today || 0),
          reward:    REWARDS.AD_WATCH
        });
      }

      // ✅ تطبيق المكافأة — السيرفر يحدد القيمة
      await sql(
        `UPDATE users
         SET points        = points + $2,
             total_earned  = total_earned + $2,
             ads_today     = ads_today + 1,
             ads_today_date = $3,
             ad_last_reward = NOW(),
             updated_at    = NOW()
         WHERE telegram_id = $1`,
        [tid, REWARDS.AD_WATCH, todayUTC()]
      );

      // فحص المهام اليومية (إتمام تلقائي)
      await checkDailyAdTasks(tid, adsToday + 1);

      const updatedUser = await sql(
        `SELECT points, ads_today, daily_task_ads10, daily_task_ads25 FROM users WHERE telegram_id = $1`,
        [tid]
      );

      await auditLog(tid, ipHash, fingerprint, 'reward_ad', 0, 'allow',
        { reward: REWARDS.AD_WATCH, ads_total: adsToday + 1 });

      console.log(`[AD_REWARD] tid=${tid} +${REWARDS.AD_WATCH}pts | ads_today=${adsToday + 1}`);

      return res.status(200).json({
        ok:       true,
        reward:   REWARDS.AD_WATCH,
        points:   parseInt(updatedUser[0]?.points || 0),
        ads_today: parseInt(updatedUser[0]?.ads_today || 0),
        daily_task_ads10: updatedUser[0]?.daily_task_ads10,
        daily_task_ads25: updatedUser[0]?.daily_task_ads25,
      });
    }

    // ============================================================
    //  HANDLE_TASK — مهمة القناة (Telegram Channel)
    //  step: 'open' | 'verify'
    // ============================================================
    if (action === 'handle_task') {
      const { task_id, step } = data;
      if (!task_id || !step)
        return res.status(400).json({ ok: false, error: 'Missing task_id or step' });

      // المهمة المدعومة حالياً: القناة الرسمية
      if (task_id !== 'channel_main')
        return res.status(400).json({ ok: false, error: 'Unknown task_id' });

      const userRow = await sql(`SELECT channel_task_done FROM users WHERE telegram_id = $1`, [tid]);
      if (userRow[0]?.channel_task_done)
        return res.status(400).json({ ok: false, error: 'Task already completed' });

      if (step === 'open') {
        await sql(
          `UPDATE users SET channel_joined = TRUE, updated_at = NOW() WHERE telegram_id = $1`,
          [tid]
        );
        const channelUsername = process.env.MAIN_CHANNEL || 'your_channel';
        return res.status(200).json({ ok: true, url: `https://t.me/${channelUsername}` });
      }

      if (step === 'verify') {
        const channelUsername = process.env.MAIN_CHANNEL || 'your_channel';
        const isMember = await verifyChannelMembership(tid, channelUsername);
        if (!isMember) {
          return res.status(400).json({ ok: false, error: 'not_member',
            message: 'انضم للقناة أولاً ثم اضغط تحقق' });
        }

        if (isShadowBanned) return res.status(200).json({ ok: true });

        const updated = await sql(
          `UPDATE users
           SET channel_task_done = TRUE,
               points       = points + $2,
               total_earned = total_earned + $2,
               updated_at   = NOW()
           WHERE telegram_id = $1 RETURNING points`,
          [tid, REWARDS.CHANNEL_TASK]
        );

        await auditLog(tid, ipHash, fingerprint, 'channel_task_complete', 0, 'allow',
          { reward: REWARDS.CHANNEL_TASK });

        return res.status(200).json({
          ok:     true,
          reward: REWARDS.CHANNEL_TASK,
          points: parseInt(updated[0]?.points || 0)
        });
      }

      return res.status(400).json({ ok: false, error: 'Invalid step' });
    }

    // ============================================================
    //  DAILY_GIFT — الهدية اليومية مع تضاعف streak
    // ============================================================
    if (action === 'claim_daily_gift') {
      const userRow = await sql(
        `SELECT daily_gift_streak, daily_gift_date FROM users WHERE telegram_id = $1`,
        [tid]
      );
      if (!userRow.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const today     = todayUTC();
      const lastDate  = userRow[0].daily_gift_date || '';
      const streak    = userRow[0].daily_gift_streak || 0;

      if (lastDate === today) {
        return res.status(400).json({ ok: false, error: 'Already claimed today' });
      }

      // Streak: يوم متواصل؟ أم بدء من جديد؟
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const newStreak = lastDate === yesterday ? streak + 1 : 1;

      // المكافأة تتضاعف مع streak لكن بحد أقصى
      const reward = Math.min(REWARDS.DAILY_GIFT * newStreak, REWARDS.DAILY_GIFT_CAP);

      if (isShadowBanned) {
        return res.status(200).json({ ok: true, reward, streak: newStreak });
      }

      await sql(
        `UPDATE users
         SET points            = points + $2,
             total_earned      = total_earned + $2,
             daily_gift_streak = $3,
             daily_gift_date   = $4,
             updated_at        = NOW()
         WHERE telegram_id = $1`,
        [tid, reward, newStreak, today]
      );

      const updated = await sql(`SELECT points FROM users WHERE telegram_id = $1`, [tid]);

      await auditLog(tid, ipHash, fingerprint, 'daily_gift', 0, 'allow',
        { reward, streak: newStreak });

      return res.status(200).json({
        ok:     true,
        reward,
        streak: newStreak,
        points: parseInt(updated[0]?.points || 0)
      });
    }

    // ============================================================
    //  WITHDRAW — سحب رصيد
    // ============================================================
    if (action === 'withdraw') {
      const { account, amount_pts } = data;
      const pts = parseInt(amount_pts);

      if (!account || typeof account !== 'string')
        return res.status(400).json({ ok: false, error: 'Missing account' });
      if (isNaN(pts) || pts <= 0)
        return res.status(400).json({ ok: false, error: 'Invalid amount' });
      if (pts < 1000)
        return res.status(400).json({ ok: false, error: 'Minimum 1000 points' });

      // تحقق من صيغة عنوان TON
      if (!account.startsWith('UQ') && !account.startsWith('EQ'))
        return res.status(400).json({ ok: false, error: 'Invalid TON address' });

      if (isShadowBanned)
        return res.status(403).json({ ok: false, error: 'Account under review' });

      const userRow = await sql(`SELECT points, wd_history FROM users WHERE telegram_id = $1`, [tid]);
      if (!userRow.length) return res.status(404).json({ ok: false, error: 'User not found' });
      if (parseInt(userRow[0].points) < pts)
        return res.status(400).json({ ok: false, error: 'Insufficient points' });

      const entry = {
        account, amount_pts: pts,
        date: new Date().toISOString(),
        status: 'pending'
      };
      const history = Array.isArray(userRow[0].wd_history) ? userRow[0].wd_history : [];
      history.unshift(entry);
      if (history.length > 50) history.splice(50);

      await sql(
        `UPDATE users SET points = points - $2, wd_history = $3, updated_at = NOW()
         WHERE telegram_id = $1`,
        [tid, pts, JSON.stringify(history)]
      );

      await auditLog(tid, ipHash, fingerprint, 'withdraw', 0, 'allow',
        { account: account.slice(0, 10) + '...', amount_pts: pts });

      return res.status(200).json({ ok: true, entry });
    }

    // ============================================================
    //  ADMIN: update_withdrawal
    // ============================================================
    if (action === 'update_withdrawal') {
      const adminKey = req.headers['x-admin-key'] || '';
      if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ ok: false, error: 'Unauthorized' });
      }

      const { target_tid, date, status: newStatus } = data;
      const allowedStatuses = ['completed', 'approved', 'rejected'];
      if (!allowedStatuses.includes(newStatus))
        return res.status(400).json({ ok: false, error: 'Invalid status' });

      const targetId = parseInt(target_tid);
      if (isNaN(targetId)) return res.status(400).json({ ok: false, error: 'Invalid target_tid' });

      const rows = await sql(`SELECT wd_history FROM users WHERE telegram_id = $1`, [targetId]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const history = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      let updated = false;
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

    return res.status(400).json({ ok: false, error: 'Unknown action' });

  } catch (err) {
    console.error('[API Error]', action, err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

// ================================================================
//  HELPERS
// ================================================================

// فلترة بيانات المستخدم قبل إرسالها — لا نُرسل حقول حساسة
function sanitizeUser(user, realReferralCount) {
  return {
    telegram_id:       user.telegram_id,
    username:          user.username,
    first_name:        user.first_name,
    photo_url:         user.photo_url,
    points:            parseInt(user.points || 0),
    usdt_balance:      parseFloat(user.usdt_balance || 0),
    total_earned:      parseInt(user.total_earned || 0),
    ads_today:         parseInt(user.ads_today || 0),
    ads_limit:         REWARDS.AD_DAILY_LIMIT,
    ad_reward:         REWARDS.AD_WATCH,
    channel_task_done: user.channel_task_done || false,
    daily_task_ads10:  user.daily_task_ads10  || false,
    daily_task_ads25:  user.daily_task_ads25  || false,
    daily_task_inv3:   user.daily_task_inv3   || false,
    daily_gift_streak: parseInt(user.daily_gift_streak || 0),
    daily_gift_claimed: user.daily_gift_date === new Date().toISOString().slice(0, 10),
    referral_count:    realReferralCount,
    referral_points:   parseInt(user.referral_points || 0),
    wd_history:        Array.isArray(user.wd_history) ? user.wd_history.slice(0, 10) : [],
    // لا نُرسل: risk_score, shadow_banned, is_hard_banned, referral_by, ip_hash, fingerprint
  };
}

// فحص وإتمام المهام اليومية تلقائياً
async function checkDailyAdTasks(tid, adsCount) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const user = await sql(
      `SELECT daily_task_ads10, daily_task_ads25, daily_tasks_date FROM users WHERE telegram_id = $1`,
      [tid]
    );
    if (!user.length) return;

    const u = user[0];
    const updates = [];
    const params  = [tid];

    if (adsCount >= 10 && !u.daily_task_ads10) {
      updates.push(`daily_task_ads10 = TRUE`);
      // منح المكافأة
      await sql(
        `UPDATE users SET points = points + $2, total_earned = total_earned + $2 WHERE telegram_id = $1`,
        [tid, REWARDS.DAILY_TASK_ADS10]
      );
      console.log(`[DAILY_TASK] ads10 completed → tid=${tid} +${REWARDS.DAILY_TASK_ADS10}pts`);
    }
    if (adsCount >= 25 && !u.daily_task_ads25) {
      updates.push(`daily_task_ads25 = TRUE`);
      await sql(
        `UPDATE users SET points = points + $2, total_earned = total_earned + $2 WHERE telegram_id = $1`,
        [tid, REWARDS.DAILY_TASK_ADS25]
      );
      console.log(`[DAILY_TASK] ads25 completed → tid=${tid} +${REWARDS.DAILY_TASK_ADS25}pts`);
    }

    if (updates.length) {
      await sql(
        `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE telegram_id = $1`,
        [tid]
      );
    }
  } catch (e) {
    console.warn('[checkDailyAdTasks] error:', e.message);
  }
}

// التحقق من عضوية القناة عبر Telegram Bot API
async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${channelUsername}&user_id=${telegramId}`;
    const response = await fetch(url);
    const result   = await response.json();
    if (!result.ok) return false;
    return ['member', 'administrator', 'creator'].includes(result.result?.status);
  } catch (e) {
    console.warn('[verifyChannel] error:', e.message);
    return false;
  }
}
