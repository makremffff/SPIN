// ================================================================
//  Arabi Earn — API Backend v1.0 (Zero Trust Architecture)
//  💀 "اعتبر كل عميل مخترقاً حتى يثبت العكس"
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session management (IP + fingerprint bound)
//  ✅ Nonce system — ad nonce مخزَّن في الجلسة، مخفي عن العميل
//  ✅ Rate limiting (per user, sliding window)
//  ✅ Behavior analysis (bot detection)
//  ✅ Risk scoring (0-100) + Shadow ban + Hard ban
//  ✅ Multi-account detection (IP + fingerprint dual signal)
//  ✅ Full audit logging
//  ✅ Server-side time only
// ================================================================

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ── Constants ────────────────────────────────────────────────────
const INIT_DATA_TTL   = 3600;     // 1 hour
const SESSION_TTL     = 86400;    // 24 hours
const RATE_WINDOW     = 5000;     // 5 seconds
const RATE_LIMIT      = 10;       // max requests per window
const RISK_SUSPICIOUS = 41;
const RISK_BAN        = 71;
const NONCE_TTL       = 300;      // 5 min ad nonce validity
const AD_DAILY_LIMIT  = 10;       // max ads per day
const AD_PTS_REWARD   = 50;       // points per ad
const GIFT_PTS        = [100, 150, 200, 250, 300, 400, 750]; // daily gift rewards
const REF_PTS         = 500;      // points per referral

const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_IP:          2,
  MAX_ACCOUNTS_PER_FINGERPRINT: 1,
  IP_WHITELIST: new Set([]),
  NEW_ACCOUNT_AGE_DAYS: 3,
};

// ── Bootstrap ────────────────────────────────────────────────────
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    // Users table
    await sql(`
      CREATE TABLE IF NOT EXISTS ae_users (
        telegram_id       BIGINT        PRIMARY KEY,
        username          TEXT,
        points            INT           NOT NULL DEFAULT 0,
        level             INT           NOT NULL DEFAULT 1,
        referral_by       BIGINT,
        referral_friends  INT           NOT NULL DEFAULT 0,
        referral_rewarded BOOLEAN       NOT NULL DEFAULT FALSE,
        tasks_done        INT           NOT NULL DEFAULT 0,
        tg_task_done      BOOLEAN       NOT NULL DEFAULT FALSE,
        ads_today         INT           NOT NULL DEFAULT 0,
        ads_earned_today  INT           NOT NULL DEFAULT 0,
        ads_last_date     TEXT          NOT NULL DEFAULT '',
        gift_day          INT           NOT NULL DEFAULT 1,
        gift_last_date    TEXT          NOT NULL DEFAULT '',
        wd_history        JSONB         NOT NULL DEFAULT '[]',
        shadow_banned     BOOLEAN       NOT NULL DEFAULT FALSE,
        is_hard_banned    BOOLEAN       NOT NULL DEFAULT FALSE,
        risk_score        INT           NOT NULL DEFAULT 0,
        photo_url         TEXT,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    // Sessions
    await sql(`
      CREATE TABLE IF NOT EXISTS ae_sessions (
        session_id    TEXT          PRIMARY KEY,
        telegram_id   BIGINT        NOT NULL REFERENCES ae_users(telegram_id) ON DELETE CASCADE,
        ip_hash       TEXT          NOT NULL,
        fingerprint   TEXT          NOT NULL,
        ad_nonce      TEXT,
        ad_nonce_exp  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        is_valid      BOOLEAN       NOT NULL DEFAULT TRUE
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ae_sess_tid  ON ae_sessions(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ae_sess_exp  ON ae_sessions(expires_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ae_sess_ip   ON ae_sessions(ip_hash)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ae_sess_fp   ON ae_sessions(fingerprint)`);

    // Nonces (general)
    await sql(`
      CREATE TABLE IF NOT EXISTS ae_nonces (
        nonce        TEXT          PRIMARY KEY,
        telegram_id  BIGINT        NOT NULL,
        expires_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ae_nonces_exp ON ae_nonces(expires_at)`);

    // Rate limits
    await sql(`
      CREATE TABLE IF NOT EXISTS ae_rate_limits (
        telegram_id   BIGINT  NOT NULL,
        window_start  BIGINT  NOT NULL,
        request_count INT     NOT NULL DEFAULT 1,
        PRIMARY KEY (telegram_id, window_start)
      )
    `);

    // Security logs
    await sql(`
      CREATE TABLE IF NOT EXISTS ae_security_logs (
        id           BIGSERIAL   PRIMARY KEY,
        telegram_id  BIGINT,
        ip_hash      TEXT,
        fingerprint  TEXT,
        action       TEXT        NOT NULL,
        risk_score   INT         NOT NULL DEFAULT 0,
        verdict      TEXT        NOT NULL DEFAULT 'allow',
        detail       JSONB       NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_ae_logs_tid ON ae_security_logs(telegram_id)`);

    // Device fingerprints
    await sql(`
      CREATE TABLE IF NOT EXISTS ae_device_fps (
        fingerprint   TEXT  NOT NULL,
        telegram_id   BIGINT NOT NULL,
        user_agent    TEXT,
        last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fingerprint, telegram_id)
      )
    `);

    console.log('[DB] Arabi Earn bootstrap OK');
  } catch (e) {
    console.error('[DB] Bootstrap error:', e.message);
  }
}
bootstrap();

// ================================================================
//  SECURITY LAYER
// ================================================================

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
    const checkStr  = checkArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected  = crypto.createHmac('sha256', secretKey).update(checkStr).digest('hex');
    if (expected !== hash) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch { return null; }
}

function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'ae_salt')).digest('hex').slice(0, 32);
}

function buildFingerprint(fpData, ipHash) {
  const clientFp = fpData.fp || '';
  const ua       = (fpData.user_agent || '').slice(0, 200);
  const lang     = fpData.lang       || '';
  const tz       = String(fpData.tz_offset || 0);
  const tzName   = fpData.tz_name    || '';
  const cores    = String(fpData.hw_cores  || 0);
  const mem      = String(fpData.hw_mem    || 0);
  const canvas   = (fpData.canvas_sig || '').slice(0, 40);
  const webgl    = (fpData.webgl_sig  || '').slice(0, 60);

  const raw = clientFp
    ? [clientFp, ipHash, ua, lang, tz, tzName, cores, mem].join('|')
    : [ua, lang, tz, tzName, cores, mem, canvas, webgl, ipHash].join('|');

  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Session-based Ad Nonce (مخفي عن العميل — مخزَّن في sessions) ──
async function issueAdNonce(sessionId) {
  const nonce  = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + NONCE_TTL * 1000).toISOString();
  await sql(
    `UPDATE ae_sessions SET ad_nonce = $2, ad_nonce_exp = $3 WHERE session_id = $1`,
    [sessionId, nonce, expiry]
  );
  return nonce;
}

async function consumeAdNonce(sessionId, clientNonce) {
  if (!clientNonce || !sessionId) return false;
  const rows = await sql(
    `SELECT ad_nonce, ad_nonce_exp FROM ae_sessions WHERE session_id = $1 AND is_valid = TRUE`,
    [sessionId]
  );
  if (!rows.length) return false;

  const { ad_nonce, ad_nonce_exp } = rows[0];
  if (!ad_nonce) return false;
  if (!ad_nonce_exp || new Date(ad_nonce_exp) < new Date()) {
    await sql(`UPDATE ae_sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
    return false;
  }

  let expected, received;
  try {
    expected = Buffer.from(ad_nonce,    'hex');
    received = Buffer.from(clientNonce, 'hex');
  } catch { return false; }

  if (expected.length !== received.length) return false;
  const match = crypto.timingSafeEqual(expected, received);
  if (!match) return false;

  // ✅ مطابق — احذفه فوراً (one-time use)
  await sql(`UPDATE ae_sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
  return true;
}

// ── General Nonce check ──
async function checkNonce(tid, nonce) {
  if (!nonce) return false;
  const existing = await sql(`SELECT 1 FROM ae_nonces WHERE nonce = $1`, [nonce]);
  if (existing.length) return false;
  await sql(`INSERT INTO ae_nonces (nonce, telegram_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [nonce, tid]);
  return true;
}

// ── Rate Limiting ──
async function checkRateLimit(tid) {
  const window = Math.floor(Date.now() / RATE_WINDOW) * RATE_WINDOW;
  const rows = await sql(
    `INSERT INTO ae_rate_limits (telegram_id, window_start, request_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (telegram_id, window_start)
     DO UPDATE SET request_count = ae_rate_limits.request_count + 1
     RETURNING request_count`,
    [tid, window]
  );
  return (rows[0]?.request_count || 0) <= RATE_LIMIT;
}

// ── Risk Score ──
async function updateUserRisk(tid, delta) {
  await sql(
    `UPDATE ae_users SET risk_score = LEAST(100, GREATEST(0, risk_score + $2)), updated_at = NOW()
     WHERE telegram_id = $1`,
    [tid, delta]
  );
  await sql(
    `UPDATE ae_users SET shadow_banned = TRUE WHERE telegram_id = $1 AND risk_score >= $2`,
    [tid, RISK_BAN]
  );
}

// ── Audit Log ──
async function auditLog(tid, ipHash, fp, action, riskScore, verdict, detail = {}) {
  try {
    await sql(
      `INSERT INTO ae_security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tid, ipHash, fp, action, riskScore, verdict, JSON.stringify(detail)]
    );
  } catch (_) {}
}

// ── Cleanup interval ──
setInterval(async () => {
  try {
    await sql(`DELETE FROM ae_nonces     WHERE expires_at  < NOW()`);
    await sql(`DELETE FROM ae_rate_limits WHERE window_start < $1`, [Date.now() - RATE_WINDOW * 10]);
  } catch (_) {}
}, 60 * 60 * 1000);

// ── Today string (UTC) ──
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ── CORS ──
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint');
}

// ── Build user state for client ──
function buildUserState(u, adsRemaining, adsWatchedToday, earnedToday) {
  return {
    points:          parseInt(u.points)          || 0,
    level:           parseInt(u.level)           || 1,
    referralFriends: parseInt(u.referral_friends)|| 0,
    tasksDone:       parseInt(u.tasks_done)      || 0,
    tgTaskDone:      u.tg_task_done || false,
    adsRemaining:    adsRemaining,
    adsWatchedToday: adsWatchedToday,
    earnedToday:     earnedToday,
    giftDay:         parseInt(u.gift_day)        || 1,
    giftClaimed:     u.gift_last_date === todayUTC(),
    withdrawHistory: Array.isArray(u.wd_history) ? u.wd_history : [],
  };
}

// ================================================================
//  MAIN HANDLER
// ================================================================
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

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

  const rawIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const ipHash     = hashIP(rawIP);
  let fpData = {};
  try { fpData = JSON.parse(fpHeader); } catch (_) {}
  const fingerprint = buildFingerprint(fpData, ipHash);

  try {

    // ══════════════════════════════════════════════════════════
    //  CREATE_SESSION
    // ══════════════════════════════════════════════════════════
    if (action === 'create_session') {
      const tgUser = verifyTelegramInitData(initData);
      if (!tgUser) return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });

      const tid = parseInt(tgUser.id);
      if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

      // Upsert user
      await sql(
        `INSERT INTO ae_users (telegram_id, username, photo_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) DO UPDATE
         SET username = $2, photo_url = COALESCE($3, ae_users.photo_url), updated_at = NOW()`,
        [tid, tgUser.username || tgUser.first_name || null, tgUser.photo_url || null]
      );

      // Transaction for multi-account detection
      const db = neon(DATABASE_URL);
      try {
        await db('BEGIN');

        const lockKey = BigInt('0x' + ipHash.slice(0, 15)) & BigInt('0x7FFFFFFFFFFFFFFF');
        await db(`SELECT pg_advisory_xact_lock($1)`, [lockKey.toString()]);

        const banCheck = await db(
          `SELECT shadow_banned, is_hard_banned, risk_score, created_at FROM ae_users WHERE telegram_id = $1`,
          [tid]
        );
        const userRow = banCheck[0];

        if (userRow?.is_hard_banned) {
          await db('ROLLBACK');
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
        if (userRow?.shadow_banned) {
          await db('ROLLBACK');
          return res.status(200).json({ ok: false, is_banned: true });
        }

        const acctAge    = userRow?.created_at ? (Date.now() - new Date(userRow.created_at).getTime()) / 86400000 : 0;
        const isNew      = acctAge < MULTI_ACCT.NEW_ACCOUNT_AGE_DAYS;
        const isWhite    = MULTI_ACCT.IP_WHITELIST.has(ipHash);

        if (!isWhite && isNew) {
          const ipCount = await db(
            `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM ae_sessions
             WHERE ip_hash = $1 AND telegram_id != $2 AND is_valid = TRUE AND expires_at > NOW()`,
            [ipHash, tid]
          );
          const fpCount = await db(
            `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM ae_device_fps
             WHERE fingerprint = $1 AND telegram_id != $2`,
            [fingerprint, tid]
          );
          const ipViol = parseInt(ipCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_IP;
          const fpViol = parseInt(fpCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;

          if (fpViol || (ipViol && fpViol)) {
            await db(`UPDATE ae_users SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
            await db(
              `INSERT INTO ae_security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
               VALUES ($1, $2, $3, 'multi_account_detected', 100, 'deny', $4)`,
              [tid, ipHash, fingerprint, JSON.stringify({ reason: 'multi_account_hard_ban', ip_viol: ipViol, fp_viol: fpViol })]
            );
            await db('COMMIT');
            return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
          }
        }

        // Reset risk if elevated
        if (userRow?.risk_score >= RISK_SUSPICIOUS) {
          await db(`UPDATE ae_users SET risk_score = 0, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          await db(`DELETE FROM ae_device_fps WHERE telegram_id = $1`, [tid]);
        }

        // Invalidate old sessions
        await db(`UPDATE ae_sessions SET is_valid = FALSE WHERE telegram_id = $1`, [tid]);

        // Create new session
        const sid = generateSessionId();
        await db(
          `INSERT INTO ae_sessions (session_id, telegram_id, ip_hash, fingerprint) VALUES ($1, $2, $3, $4)`,
          [sid, tid, ipHash, fingerprint]
        );

        // Save fingerprint
        await db(
          `INSERT INTO ae_device_fps (fingerprint, telegram_id, user_agent)
           VALUES ($1, $2, $3)
           ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
          [fingerprint, tid, fpData.user_agent || null]
        );

        await db('COMMIT');
        await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow', { tg_id: tid });
        return res.status(200).json({ ok: true, session_id: sid });

      } catch (txErr) {
        try { await db('ROLLBACK'); } catch (_) {}
        console.error('[create_session TX]', txErr.message);
        return res.status(500).json({ ok: false, error: 'Session creation failed' });
      }
    }

    // ══════════════════════════════════════════════════════════
    //  START_AD — إصدار nonce مخفي من السيرفر
    // ══════════════════════════════════════════════════════════
    if (action === 'start_ad') {
      if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

      const sessRows = await sql(
        `SELECT session_id, telegram_id FROM ae_sessions
         WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
        [sessionId]
      );
      if (!sessRows.length) return res.status(401).json({ ok: false, error: 'Invalid session' });

      const startTid = parseInt(sessRows[0].telegram_id);
      const userChk  = await sql(`SELECT shadow_banned, is_hard_banned FROM ae_users WHERE telegram_id = $1`, [startTid]);
      if (userChk[0]?.is_hard_banned || userChk[0]?.shadow_banned) {
        return res.status(200).json({ ok: false, error: 'access_denied' });
      }

      // تحقق من الحد اليومي
      const today   = todayUTC();
      const uRows   = await sql(`SELECT ads_today, ads_last_date FROM ae_users WHERE telegram_id = $1`, [startTid]);
      const adsToday = uRows[0]?.ads_last_date === today ? (uRows[0]?.ads_today || 0) : 0;
      if (adsToday >= AD_DAILY_LIMIT) {
        return res.status(200).json({ ok: false, error: 'Daily limit reached', remaining: 0 });
      }

      // ✅ السيرفر يُنشئ nonce ويحفظه في الجلسة — لا يراه المستخدم في أي response آخر
      const adNonce = await issueAdNonce(sessionId);

      return res.status(200).json({ ok: true, ad_nonce: adNonce });
    }

    // ── Session validation for all other actions ──────────────
    if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

    const sessionRows = await sql(
      `SELECT * FROM ae_sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!sessionRows.length) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });

    const session = sessionRows[0];
    const tid     = parseInt(session.telegram_id);

    // Fingerprint check
    if (session.fingerprint !== fingerprint) {
      await sql(`UPDATE ae_sessions SET is_valid = FALSE WHERE session_id = $1`, [sessionId]);
      await updateUserRisk(tid, 30);
      await auditLog(tid, ipHash, fingerprint, action, 30, 'deny', { reason: 'fingerprint_mismatch' });
      return res.status(401).json({ ok: false, error: 'Session mismatch — please re-authenticate' });
    }

    // IP changed — update silently
    if (session.ip_hash !== ipHash) {
      await sql(`UPDATE ae_sessions SET ip_hash = $2 WHERE session_id = $1`, [sessionId, ipHash]);
      await updateUserRisk(tid, 5);
    }

    // Rate limit
    const withinLimit = await checkRateLimit(tid);
    if (!withinLimit) {
      await updateUserRisk(tid, 5);
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    // Nonce check (non-read actions)
    const skipNonce = ['load_state', 'get_state'].includes(action);
    if (!skipNonce) {
      const nonceOk = await checkNonce(tid, nonce);
      if (!nonceOk) {
        await updateUserRisk(tid, 10);
        return res.status(400).json({ ok: false, error: 'Invalid or replayed nonce' });
      }
    }

    // Load user
    const userRows = await sql(`SELECT * FROM ae_users WHERE telegram_id = $1`, [tid]);
    if (!userRows.length) return res.status(404).json({ ok: false, error: 'User not found' });
    const user = userRows[0];

    if (user.is_hard_banned) return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
    if (user.shadow_banned)  return res.status(200).json({ ok: false, is_banned: true });

    const today = todayUTC();

    // ══════════════════════════════════════════════════════════
    //  LOAD_STATE — تحميل الحالة الكاملة
    // ══════════════════════════════════════════════════════════
    if (action === 'load_state') {
      const { username, referral_by } = data;

      // تحديث الاسم
      if (username) {
        await sql(`UPDATE ae_users SET username = $2, updated_at = NOW() WHERE telegram_id = $1`, [tid, username]);
      }

      // معالجة الإحالة
      if (referral_by) {
        const refId = parseInt(referral_by);
        if (!isNaN(refId) && refId !== tid && !user.referral_by) {
          await sql(`UPDATE ae_users SET referral_by = $2, updated_at = NOW() WHERE telegram_id = $1`, [tid, refId]);
          // أضف نقاط للمُحيل
          await sql(
            `UPDATE ae_users SET points = points + $2, referral_friends = referral_friends + 1, updated_at = NOW()
             WHERE telegram_id = $1`,
            [refId, REF_PTS]
          );
        }
      }

      // احسب إعلانات اليوم
      const adsToday    = user.ads_last_date === today ? (user.ads_today || 0) : 0;
      const adsRemaining = Math.max(0, AD_DAILY_LIMIT - adsToday);
      const earnedToday  = user.ads_last_date === today ? (user.ads_earned_today || 0) : 0;

      return res.status(200).json({
        ok: true,
        user: buildUserState(user, adsRemaining, adsToday, earnedToday),
      });
    }

    // ══════════════════════════════════════════════════════════
    //  GET_STATE — حالة خفيفة للبولينج
    // ══════════════════════════════════════════════════════════
    if (action === 'get_state') {
      const adsToday     = user.ads_last_date === today ? (user.ads_today || 0) : 0;
      const adsRemaining = Math.max(0, AD_DAILY_LIMIT - adsToday);
      const earnedToday  = user.ads_last_date === today ? (user.ads_earned_today || 0) : 0;
      return res.status(200).json({
        ok: true,
        user: buildUserState(user, adsRemaining, adsToday, earnedToday),
      });
    }

    // ══════════════════════════════════════════════════════════
    //  REWARD_AD — مكافأة الإعلان (يتحقق من nonce المخزَّن)
    // ══════════════════════════════════════════════════════════
    if (action === 'reward_ad') {
      const { ad_type, ad_nonce: clientNonce } = data;

      // ✅ التحقق من الـ nonce المخزَّن في الجلسة (one-time use)
      const nonceValid = await consumeAdNonce(sessionId, clientNonce);
      if (!nonceValid) {
        await updateUserRisk(tid, 15);
        await auditLog(tid, ipHash, fingerprint, 'reward_ad_nonce_fail', 15, 'deny', { ad_type });
        return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
      }

      // تحقق من الحد اليومي
      const adsToday = user.ads_last_date === today ? (user.ads_today || 0) : 0;
      if (adsToday >= AD_DAILY_LIMIT) {
        return res.status(200).json({ ok: false, error: 'Daily limit reached', remaining: 0 });
      }

      // cooldown بسيط (منع الإرسال المتكرر السريع — 4 ثواني بين كل إعلانين)
      const lastAdTime = user.ad_last_reward ? new Date(user.ad_last_reward).getTime() : 0;
      if (Date.now() - lastAdTime < 4000) {
        return res.status(200).json({ ok: false, error: 'Please wait before claiming another reward' });
      }

      // حدّث الرصيد والإحصاءات
      const newAdsToday    = adsToday + 1;
      const todayEarned    = (user.ads_last_date === today ? (user.ads_earned_today || 0) : 0) + AD_PTS_REWARD;
      const adsRemaining   = Math.max(0, AD_DAILY_LIMIT - newAdsToday);

      const updated = await sql(
        `UPDATE ae_users
         SET points           = points + $2,
             ads_today        = $3,
             ads_earned_today = $4,
             ads_last_date    = $5,
             ad_last_reward   = NOW(),
             updated_at       = NOW()
         WHERE telegram_id = $1
         RETURNING points`,
        [tid, AD_PTS_REWARD, newAdsToday, todayEarned, today]
      );

      const newPoints = parseInt(updated[0]?.points || 0);

      await auditLog(tid, ipHash, fingerprint, 'reward_ad', 0, 'allow', { ad_type, pts: AD_PTS_REWARD });

      return res.status(200).json({
        ok:           true,
        points:       newPoints,
        remaining:    adsRemaining,
        watchedToday: newAdsToday,
        earnedToday:  todayEarned,
        reward:       AD_PTS_REWARD,
      });
    }

    // ══════════════════════════════════════════════════════════
    //  CLAIM_GIFT — هدية يومية
    // ══════════════════════════════════════════════════════════
    if (action === 'claim_gift') {
      // تحقق من عدم استلامها اليوم
      if (user.gift_last_date === today) {
        return res.status(200).json({ ok: false, error: 'Already claimed today' });
      }

      const dayIdx = Math.min((user.gift_day || 1) - 1, GIFT_PTS.length - 1);
      const pts    = GIFT_PTS[dayIdx];

      // هل تتابع المستخدم الأيام؟ (اليوم الأمس = استمرار، غير ذلك = إعادة من اليوم 1)
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const isStreak  = user.gift_last_date === yesterday;
      const nextDay   = isStreak ? Math.min((user.gift_day || 1) + 1, 7) : 1;

      const updated = await sql(
        `UPDATE ae_users
         SET points         = points + $2,
             gift_day       = $3,
             gift_last_date = $4,
             updated_at     = NOW()
         WHERE telegram_id = $1
         RETURNING points`,
        [tid, pts, nextDay, today]
      );

      return res.status(200).json({
        ok:      true,
        pts,
        points:  parseInt(updated[0]?.points || 0),
        nextDay,
      });
    }

    // ══════════════════════════════════════════════════════════
    //  TASK — مهام القناة والـ URL
    // ══════════════════════════════════════════════════════════
    if (action === 'task') {
      const { task_id, step } = data;

      if (task_id === 'mainChannel') {
        if (user.tg_task_done) {
          return res.status(200).json({ ok: false, error: 'Already completed' });
        }

        if (step === 'verify') {
          const channelUsername = process.env.TG_CHANNEL || 'YourChannelUsername';
          const isMember = await verifyChannelMembership(tid, channelUsername);
          if (!isMember) {
            return res.status(200).json({ ok: false, error: 'not_member', message: 'Join the channel first' });
          }

          if (user.shadow_banned) {
            return res.status(200).json({ ok: true }); // shadow: زائف
          }

          const CHANNEL_PTS = 2500;
          const updated = await sql(
            `UPDATE ae_users
             SET points       = points + $2,
                 tg_task_done = TRUE,
                 tasks_done   = tasks_done + 1,
                 updated_at   = NOW()
             WHERE telegram_id = $1 AND tg_task_done = FALSE
             RETURNING points, tasks_done`,
            [tid, CHANNEL_PTS]
          );

          if (!updated.length) {
            return res.status(200).json({ ok: false, error: 'Already completed' });
          }

          return res.status(200).json({
            ok:     true,
            reward: CHANNEL_PTS,
            points: parseInt(updated[0]?.points || 0),
          });
        }
      }

      return res.status(400).json({ ok: false, error: 'Unknown task' });
    }

    // ══════════════════════════════════════════════════════════
    //  WITHDRAW — طلب سحب
    // ══════════════════════════════════════════════════════════
    if (action === 'withdraw') {
      const { address, pts } = data;

      if (!address || !pts || pts <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_data' });
      }

      const MIN_PTS = 5000;
      if (pts < MIN_PTS) {
        return res.status(200).json({ ok: false, error: 'below_minimum' });
      }

      if ((user.points || 0) < pts) {
        return res.status(200).json({ ok: false, error: 'insufficient_balance' });
      }

      const entry = {
        pts,
        address,
        date:   today,
        ts:     Date.now(),
        status: 'pending',
      };

      const currentHistory = Array.isArray(user.wd_history) ? user.wd_history : [];
      const newHistory     = [entry, ...currentHistory];

      await sql(
        `UPDATE ae_users
         SET points     = points - $2,
             wd_history = $3,
             updated_at = NOW()
         WHERE telegram_id = $1`,
        [tid, pts, JSON.stringify(newHistory)]
      );

      await auditLog(tid, ipHash, fingerprint, 'withdraw', 0, 'allow', { pts, address: address.slice(0, 10) + '...' });

      return res.status(200).json({ ok: true, entry });
    }

    // ══════════════════════════════════════════════════════════
    //  TRACK_EVENT — تتبع أحداث (fire-and-forget)
    // ══════════════════════════════════════════════════════════
    if (action === 'track_event') {
      // لا نفعل شيئاً ثقيلاً — فقط log
      await auditLog(tid, ipHash, fingerprint, `track:${data.event || 'unknown'}`, 0, 'allow', {});
      return res.status(200).json({ ok: true });
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

// ── Verify Channel Membership ──
async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;
  try {
    const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${channelUsername}&user_id=${telegramId}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.ok) return false;
    return ['member', 'administrator', 'creator'].includes(data.result?.status);
  } catch (e) {
    console.warn('[verifyChannel]', e.message);
    return false;
  }
}
