'use strict';

// ═══════════════════════════════════════════════════════
//  الربح عربي — Zero Trust Backend
//  Runtime  : Node.js Vercel Serverless
//  Database : Neon PostgreSQL (@neondatabase/serverless)
//  Auth     : Telegram initData + Session + Nonce + Fingerprint
// ═══════════════════════════════════════════════════════

const crypto    = require('crypto');
const { neon }  = require('@neondatabase/serverless');

// ── ENV ──────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_KEY    = process.env.ADMIN_KEY;

// ── Persistent SQL client ─────────────────────────────
const sql = neon(DATABASE_URL);

// ── CORS helper ───────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint, X-Telegram-Init-Data');
}

// ════════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════════
const INIT_DATA_TTL   = 3600;
const SESSION_TTL     = 86400;
const RATE_WINDOW     = 5000;
const RATE_LIMIT      = 10;
const RISK_SUSPICIOUS = 41;
const RISK_BAN        = 71;
const NONCE_TTL       = 300;

const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_IP          : 2,
  MAX_ACCOUNTS_PER_FINGERPRINT : 1,
  IP_WHITELIST                 : new Set([]),
  NEW_ACCOUNT_AGE_DAYS         : 3,
};

// ── App-specific config ───────────────────────────────
const AD_PTS_PER_WATCH    = 50;
const AD_DAILY_LIMIT      = 10;
const AD_BONUS_ALL_DONE   = 0;      // الـ 500 نقطة تأتي من 10×50 مباشرة
const REFERRAL_PTS        = 500;    // نقاط لكل إحالة (للمرجعية — لا يُستدعى من الـ frontend هنا)
const TG_TASK_PTS         = 2500;   // مكافأة الانضمام للقناة
const TON_MIN_PTS         = 50000;
const TON_MIN_LEVEL       = 5;
const PTS_PER_TON         = 100000;
const CHANNEL_USERNAME    = 'YourChannelUsername'; // ← غيّر هذا

// ════════════════════════════════════════════════════════
//  BOOTSTRAP — إنشاء الجداول عند الحاجة
// ════════════════════════════════════════════════════════
let bootstrapped = false;

async function bootstrap() {
  if (bootstrapped) return;

  // ── جدول المستخدمين ──
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id      BIGINT       PRIMARY KEY,
      username         TEXT,
      points           BIGINT       NOT NULL DEFAULT 0,
      level            INT          NOT NULL DEFAULT 1,
      referral_count   INT          NOT NULL DEFAULT 0,
      tg_task_done     BOOLEAN      NOT NULL DEFAULT FALSE,
      link_copies      INT          NOT NULL DEFAULT 0,
      shadow_banned    BOOLEAN      NOT NULL DEFAULT FALSE,
      is_hard_banned   BOOLEAN      NOT NULL DEFAULT FALSE,
      risk_score       INT          NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `;

  // ── جدول الإعلانات اليومية ──
  await sql`
    CREATE TABLE IF NOT EXISTS ad_watches (
      telegram_id    BIGINT   NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      watch_date     DATE     NOT NULL DEFAULT CURRENT_DATE,
      count          INT      NOT NULL DEFAULT 0,
      earned_pts     INT      NOT NULL DEFAULT 0,
      PRIMARY KEY (telegram_id, watch_date)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ad_watches_tid ON ad_watches(telegram_id)`;

  // ── جدول الهدايا اليومية ──
  await sql`
    CREATE TABLE IF NOT EXISTS daily_gifts (
      telegram_id    BIGINT   NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      gift_date      DATE     NOT NULL DEFAULT CURRENT_DATE,
      day_number     INT      NOT NULL DEFAULT 1,
      pts_claimed    INT      NOT NULL DEFAULT 0,
      claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (telegram_id, gift_date)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_daily_gifts_tid ON daily_gifts(telegram_id)`;

  // ── جدول طلبات السحب ──
  await sql`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id             BIGSERIAL    PRIMARY KEY,
      telegram_id    BIGINT       NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      address        TEXT         NOT NULL,
      pts_amount     BIGINT       NOT NULL,
      ton_amount     NUMERIC(18,6) NOT NULL,
      status         TEXT         NOT NULL DEFAULT 'pending',
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      processed_at   TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_withdrawals_tid    ON withdrawals(telegram_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)`;

  // ── جدول الجلسات ──
  await sql`
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
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_telegram    ON sessions(telegram_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON sessions(expires_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_ip_hash     ON sessions(ip_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_fingerprint ON sessions(fingerprint)`;

  // ── جدول Nonce ──
  await sql`
    CREATE TABLE IF NOT EXISTS nonces (
      nonce       TEXT        PRIMARY KEY,
      telegram_id BIGINT      NOT NULL,
      used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at)`;

  // ── جدول Rate Limiting ──
  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      telegram_id   BIGINT NOT NULL,
      window_start  BIGINT NOT NULL,
      request_count INT    NOT NULL DEFAULT 1,
      PRIMARY KEY (telegram_id, window_start)
    )
  `;

  // ── جدول Security Logs ──
  await sql`
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
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_logs_telegram ON security_logs(telegram_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_logs_created  ON security_logs(created_at DESC)`;

  // ── جدول Device Fingerprints ──
  await sql`
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
  `;

  bootstrapped = true;
}

// ════════════════════════════════════════════════════════
//  SECURITY FUNCTIONS — منسوخة حرفياً
// ════════════════════════════════════════════════════════

// ── 1. Telegram initData Verification ──
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

// ── 2. IP Hashing ──
function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256')
    .update(ip + (process.env.IP_SALT || 'zt_salt'))
    .digest('hex').slice(0, 32);
}

// ── 3. Device Fingerprint Builder ──
function buildFingerprint(fpData, ipHash) {
  const clientFp  = fpData.fp           || '';
  const ua        = (fpData.user_agent  || '').slice(0, 200);
  const lang      = fpData.lang         || '';
  const screen    = fpData.screen       || '';
  const tz        = String(fpData.tz_offset   || 0);
  const tzName    = fpData.tz_name      || '';
  const cores     = String(fpData.hw_cores    || 0);
  const mem       = String(fpData.hw_mem      || 0);
  const touch     = String(fpData.touch_pts   || 0);
  const canvas    = (fpData.canvas_sig  || '').slice(0, 40);
  const webgl     = (fpData.webgl_sig   || '').slice(0, 60);
  const audio     = (fpData.audio_sig   || '').slice(0, 40);
  const dpr       = fpData.dpr          || '';
  const colDepth  = String(fpData.color_depth || 0);
  const raw = clientFp
    ? [clientFp, ipHash, ua, lang, tz, tzName, cores, mem].join('|')
    : [ua, lang, screen, tz, tzName, cores, mem, touch, canvas, webgl, audio, dpr, colDepth, ipHash].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

// ── 4. Rate Limiting (sliding window) ──
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

// ── 5. General Nonce (replay prevention) ──
async function checkNonce(tid, nonce) {
  if (!nonce) return false;
  const existing = await sql(`SELECT 1 FROM nonces WHERE nonce = $1`, [nonce]);
  if (existing.length) return false;
  await sql(`INSERT INTO nonces (nonce, telegram_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [nonce, tid]);
  return true;
}

// ── 6. Ad Nonce — Session-based (one-time, server-issued) ──
async function issueAdNonce(sessionId) {
  const nonce  = crypto.randomBytes(32).toString('hex');
  const expiry = new Date(Date.now() + NONCE_TTL * 1000).toISOString();
  await sql(`UPDATE sessions SET ad_nonce = $2, ad_nonce_exp = $3 WHERE session_id = $1`, [sessionId, nonce, expiry]);
  return nonce;
}

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
  try {
    const expected = Buffer.from(ad_nonce,    'hex');
    const received = Buffer.from(clientNonce, 'hex');
    const match = expected.length === received.length && crypto.timingSafeEqual(expected, received);
    if (!match) return false;
  } catch { return false; }
  await sql(`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = $1`, [sessionId]);
  return true;
}

// ── 7. Risk Score Calculator ──
async function calcRiskScore(tid, ipHash, fingerprint) {
  let score = 0;
  const fp = await sql(`SELECT fingerprint FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`, [tid]);
  if (fp.length && fp[0].fingerprint !== fingerprint) score += 25;
  const ip = await sql(`SELECT ip_hash FROM sessions WHERE telegram_id = $1 AND is_valid = TRUE LIMIT 1`, [tid]);
  if (ip.length && ip[0].ip_hash !== ipHash) score += 15;
  const failures = await sql(
    `SELECT COUNT(*) AS c FROM security_logs
     WHERE telegram_id = $1 AND verdict = 'deny' AND created_at > NOW() - INTERVAL '1 minute'`,
    [tid]
  );
  score += Math.min(30, parseInt(failures[0]?.c || 0) * 10);
  return Math.min(100, score);
}

// ── 8. Auto Shadow Ban ──
async function updateUserRisk(tid, delta) {
  await sql(
    `UPDATE users SET risk_score = LEAST(100, GREATEST(0, risk_score + $2)), updated_at = NOW() WHERE telegram_id = $1`,
    [tid, delta]
  );
  await sql(
    `UPDATE users SET shadow_banned = TRUE WHERE telegram_id = $1 AND risk_score >= $2`,
    [tid, RISK_BAN]
  );
}

// ── 9. Audit Log ──
async function auditLog(tid, ipHash, fingerprint, action, riskScore, verdict, detail = {}) {
  try {
    await sql(
      `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tid, ipHash, fingerprint, action, riskScore, verdict, JSON.stringify(detail)]
    );
  } catch (_) {}
}

// ── 10. Session ID Generator ──
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ── 11. Periodic Cleanup (hourly) ──
setInterval(async () => {
  try {
    await sql(`DELETE FROM nonces WHERE expires_at < NOW()`);
    await sql(`DELETE FROM rate_limits WHERE window_start < $1`, [Date.now() - RATE_WINDOW * 10]);
    await sql(`DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day'`);
  } catch (e) { console.warn('[CLEANUP]', e.message); }
}, 60 * 60 * 1000);

// ── Helper: check Telegram channel membership via Bot API ──
async function checkChannelMembership(userId) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${userId}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (!json.ok) return false;
    const status = json.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

// ── Helper: recalculate user level from points ──
function calcLevel(points) {
  // كل 5000 نقطة = مستوى (بحد أقصى 100)
  return Math.min(100, Math.floor(points / 5000) + 1);
}

// ════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    await bootstrap();
  } catch (e) {
    console.error('[BOOTSTRAP]', e.message);
    return res.status(500).json({ error: 'DB init failed' });
  }

  // ── Security Headers ──
  // يدعم كلا الـ header (X-Init-Data من system prompt + X-Telegram-Init-Data من الـ HTML)
  const initData  = req.headers['x-init-data'] || req.headers['x-telegram-init-data'] || '';
  const sessionId = req.headers['x-session-id'] || '';
  const nonce     = req.headers['x-nonce']       || '';
  const fpHeader  = req.headers['x-fingerprint'] || '{}';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // ── يدعم كلا الصيغتين: { action, data } و { type, data } ──
  const action = body?.action || body?.type;
  const data   = body?.data || {};

  if (!action) return res.status(400).json({ error: 'Missing action' });

  const rawIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const ipHash     = hashIP(rawIP);
  let fpData = {};
  try { fpData = JSON.parse(fpHeader); } catch (_) {}
  const fingerprint = buildFingerprint(fpData, ipHash);

  // ════════════════════════════════════════════
  //  CREATE_SESSION — Telegram Auth + Multi-Account Check
  // ════════════════════════════════════════════
  if (action === 'create_session') {
    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser) return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });
    const tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    await sql(
      `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE SET username = $2, updated_at = NOW()`,
      [tid, tgUser.username || tgUser.first_name || null]
    );

    const db = neon(DATABASE_URL);
    try {
      await db('BEGIN');
      const lockKey = BigInt('0x' + ipHash.slice(0, 15)) & BigInt('0x7FFFFFFFFFFFFFFF');
      await db(`SELECT pg_advisory_xact_lock($1)`, [lockKey.toString()]);

      const banCheck = await db(`SELECT shadow_banned, is_hard_banned, risk_score, created_at FROM users WHERE telegram_id = $1`, [tid]);
      const userRow  = banCheck[0];

      if (userRow?.is_hard_banned) {
        await db('ROLLBACK');
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
      }
      if (userRow?.shadow_banned) {
        await db('ROLLBACK');
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'shadow' });
      }

      const accountAgeDays = (Date.now() - new Date(userRow?.created_at || Date.now()).getTime()) / 86400000;
      const isNewAccount   = accountAgeDays < MULTI_ACCT.NEW_ACCOUNT_AGE_DAYS;

      if (!MULTI_ACCT.IP_WHITELIST.has(ipHash) && isNewAccount) {
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
        const fpViolation  = parseInt(fpCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;

        if (fpViolation || (ipViolation && fpViolation)) {
          await db(`UPDATE users SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          await db(
            `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
             VALUES ($1, $2, $3, 'multi_account_detected', 100, 'deny', $4)`,
            [tid, ipHash, fingerprint, JSON.stringify({ ip_accounts: parseInt(ipCount[0]?.cnt), fp_accounts: parseInt(fpCount[0]?.cnt) })]
          );
          await db('COMMIT');
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      await db(`UPDATE sessions SET is_valid = FALSE WHERE telegram_id = $1`, [tid]);
      const sid = generateSessionId();
      await db(`INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint) VALUES ($1, $2, $3, $4)`, [sid, tid, ipHash, fingerprint]);
      await db(
        `INSERT INTO device_fingerprints (fingerprint, telegram_id, user_agent, lang, screen, timezone_off)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
        [fingerprint, tid, fpData.user_agent || null, fpData.lang || null, fpData.screen || null, fpData.tz_offset || 0]
      );
      await db('COMMIT');
      await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow', {});
      return res.status(200).json({ ok: true, session_id: sid });

    } catch (txErr) {
      try { await db('ROLLBACK'); } catch (_) {}
      console.error('[create_session TX]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ════════════════════════════════════════════
  //  START_AD — إصدار Ad Nonce
  // ════════════════════════════════════════════
  if (action === 'start_ad') {
    if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });
    const adSession = await sql(
      `SELECT session_id, telegram_id FROM sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!adSession.length) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
    const adTid  = parseInt(adSession[0].telegram_id);
    const adUser = await sql(`SELECT is_hard_banned FROM users WHERE telegram_id = $1`, [adTid]);
    if (adUser[0]?.is_hard_banned) return res.status(200).json({ ok: false, error: 'access_denied' });
    const adNonce = await issueAdNonce(sessionId);
    return res.status(200).json({ ok: true, ad_nonce: adNonce });
  }

  // ════════════════════════════════════════════
  //  SESSION GATE — كل action آخر يمر من هنا
  //  ملاحظة: إذا لم يكن هناك session_id (الـ HTML لا يرسله بعد)،
  //  نتحقق من initData مباشرةً كـ fallback آمن
  // ════════════════════════════════════════════

  let tid;
  let session = null;

  if (sessionId) {
    // المسار المعتاد: session موجود
    const sessionRows = await sql(
      `SELECT * FROM sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!sessionRows.length) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });

    session = sessionRows[0];
    tid     = parseInt(session.telegram_id);

    if (session.fingerprint !== fingerprint) {
      await sql(`UPDATE sessions SET is_valid = FALSE WHERE session_id = $1`, [sessionId]);
      await updateUserRisk(tid, 30);
      await auditLog(tid, ipHash, fingerprint, action, 30, 'deny', { reason: 'fingerprint_mismatch' });
      return res.status(401).json({ ok: false, error: 'Session mismatch — please re-authenticate' });
    }

    if (session.ip_hash !== ipHash) {
      await sql(`UPDATE sessions SET ip_hash = $2 WHERE session_id = $1`, [sessionId, ipHash]);
      await updateUserRisk(tid, 5);
      await auditLog(tid, ipHash, fingerprint, action, 5, 'allow', { reason: 'ip_changed' });
    }

  } else if (initData) {
    // Fallback: بدون session، نتحقق من initData (يُستخدم من الـ HTML الحالي)
    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser) return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });
    tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    // upsert المستخدم تلقائياً
    await sql(
      `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE SET username = $2, updated_at = NOW()`,
      [tid, tgUser.username || tgUser.first_name || null]
    );
  } else {
    return res.status(401).json({ ok: false, error: 'Missing session or auth data' });
  }

  // Rate Limit
  if (!(await checkRateLimit(tid))) {
    await updateUserRisk(tid, 5);
    await auditLog(tid, ipHash, fingerprint, action, 5, 'rate_limit', {});
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // Nonce — يُفرض فقط على العمليات التي تُعدّل البيانات
  // القراءة والـ fire-and-forget لا تحتاج nonce
  const NO_NONCE_ACTIONS = [
    'get_state', 'load', 'reward_ad',
    'get_balance', 'get_history', 'get_leaderboard',
    'track_copy_link', // fire-and-forget
  ];
  if (!NO_NONCE_ACTIONS.includes(action) && sessionId) {
    if (!(await checkNonce(tid, nonce))) {
      await updateUserRisk(tid, 20);
      await auditLog(tid, ipHash, fingerprint, action, 20, 'deny', { reason: 'nonce_replay' });
      return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
    }
  }

  // Risk + Shadow Ban
  const riskScore      = await calcRiskScore(tid, ipHash, fingerprint);
  const userRiskRows   = await sql(`SELECT risk_score, shadow_banned, is_hard_banned FROM users WHERE telegram_id = $1`, [tid]);
  const isShadowBanned = userRiskRows[0]?.shadow_banned || false;
  const isHardBanned   = userRiskRows[0]?.is_hard_banned || false;

  if (isHardBanned) return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });

  await auditLog(tid, ipHash, fingerprint, action, riskScore, isShadowBanned ? 'shadow' : 'allow', {});

  try {

    // ════════════════════════════════════════════
    //  watch_ad — مشاهدة إعلان وكسب النقاط
    // ════════════════════════════════════════════
    if (action === 'watch_ad') {
      // Shadow ban: يُعيد وهمياً وكأنه نجح
      if (isShadowBanned) {
        return res.status(200).json({ ok: true, remaining: 0, watchedToday: AD_DAILY_LIMIT, earnedToday: AD_DAILY_LIMIT * AD_PTS_PER_WATCH });
      }

      // تحقق من الحد اليومي أولاً
      const todayRows = await sql(
        `SELECT count, earned_pts FROM ad_watches WHERE telegram_id = $1 AND watch_date = CURRENT_DATE`,
        [tid]
      );
      const watchedToday = parseInt(todayRows[0]?.count || 0);
      const earnedToday  = parseInt(todayRows[0]?.earned_pts || 0);

      if (watchedToday >= AD_DAILY_LIMIT) {
        return res.status(200).json({
          ok:          true,
          remaining:   0,
          watchedToday,
          earnedToday,
          already_done: true,
        });
      }

      // سجّل المشاهدة وأضف النقاط — atomic
      const newCount    = watchedToday + 1;
      const newEarned   = earnedToday + AD_PTS_PER_WATCH;
      const remaining   = AD_DAILY_LIMIT - newCount;

      await sql(
        `INSERT INTO ad_watches (telegram_id, watch_date, count, earned_pts)
         VALUES ($1, CURRENT_DATE, 1, $2)
         ON CONFLICT (telegram_id, watch_date)
         DO UPDATE SET count = ad_watches.count + 1, earned_pts = ad_watches.earned_pts + $2`,
        [tid, AD_PTS_PER_WATCH]
      );

      // أضف النقاط للمستخدم وحدّث المستوى
      const updated = await sql(
        `UPDATE users SET points = points + $2, updated_at = NOW()
         WHERE telegram_id = $1
         RETURNING points`,
        [tid, AD_PTS_PER_WATCH]
      );
      const totalPoints = parseInt(updated[0]?.points || 0);
      const newLevel    = calcLevel(totalPoints);
      await sql(`UPDATE users SET level = $2 WHERE telegram_id = $1 AND level != $2`, [tid, newLevel]);

      return res.status(200).json({
        ok:          true,
        remaining,
        watchedToday: newCount,
        earnedToday:  newEarned,
        totalPoints,
        newLevel,
      });
    }

    // ════════════════════════════════════════════
    //  verify_tg_membership — التحقق من انضمام القناة
    // ════════════════════════════════════════════
    if (action === 'verify_tg_membership') {
      // تحقق هل أنجز المهمة من قبل
      const userRow = await sql(`SELECT tg_task_done, points FROM users WHERE telegram_id = $1`, [tid]);
      if (userRow[0]?.tg_task_done) {
        return res.status(200).json({ ok: true, already_done: true });
      }

      // Shadow ban: وهمي
      if (isShadowBanned) {
        return res.status(200).json({ ok: true });
      }

      // تحقق فعلي عبر Telegram Bot API
      const isMember = await checkChannelMembership(tid);
      if (!isMember) {
        return res.status(200).json({ ok: false, error: 'not_member' });
      }

      // أضف النقاط وعلّم المهمة منجزة
      const updRes = await sql(
        `UPDATE users
         SET tg_task_done = TRUE, points = points + $2, updated_at = NOW()
         WHERE telegram_id = $1 AND tg_task_done = FALSE
         RETURNING points`,
        [tid, TG_TASK_PTS]
      );

      if (!updRes.length) {
        // race condition: مستخدم آخر سبق — المهمة منجزة فعلاً
        return res.status(200).json({ ok: true, already_done: true });
      }

      const totalPoints = parseInt(updRes[0].points);
      const newLevel    = calcLevel(totalPoints);
      await sql(`UPDATE users SET level = $2 WHERE telegram_id = $1 AND level != $2`, [tid, newLevel]);

      return res.status(200).json({ ok: true, pts_awarded: TG_TASK_PTS, totalPoints, newLevel });
    }

    // ════════════════════════════════════════════
    //  submit_withdraw — طلب سحب TON
    // ════════════════════════════════════════════
    if (action === 'submit_withdraw') {
      if (isShadowBanned) {
        return res.status(200).json({ ok: true }); // وهمي
      }

      const address  = (data.address || '').trim();
      const ptsToWit = parseInt(data.pts || 0);

      // تحقق من صحة العنوان
      if (!address || (!address.startsWith('EQ') && !address.startsWith('UQ') && !address.startsWith('0:')) || address.length < 48) {
        return res.status(200).json({ ok: false, error: 'invalid_address' });
      }
      if (!ptsToWit || ptsToWit <= 0) {
        return res.status(200).json({ ok: false, error: 'invalid_amount' });
      }

      // تحقق من رصيد + مستوى المستخدم الحالي من الـ DB (لا نثق بالـ frontend)
      const userRow = await sql(
        `SELECT points, level FROM users WHERE telegram_id = $1`,
        [tid]
      );
      const userPoints = parseInt(userRow[0]?.points || 0);
      const userLevel  = parseInt(userRow[0]?.level  || 1);

      if (userLevel < TON_MIN_LEVEL) {
        return res.status(200).json({ ok: false, error: 'level_too_low', required_level: TON_MIN_LEVEL, current_level: userLevel });
      }
      if (userPoints < TON_MIN_PTS) {
        return res.status(200).json({ ok: false, error: 'insufficient_balance', balance: userPoints, required: TON_MIN_PTS });
      }

      // خصم النقاط وأنشئ طلب السحب — atomic
      const deducted = await sql(
        `UPDATE users SET points = points - $2, updated_at = NOW()
         WHERE telegram_id = $1 AND points >= $2
         RETURNING points`,
        [tid, userPoints]
      );
      if (!deducted.length) {
        return res.status(200).json({ ok: false, error: 'insufficient_balance' });
      }

      const tonAmount = parseFloat((userPoints / PTS_PER_TON).toFixed(6));
      await sql(
        `INSERT INTO withdrawals (telegram_id, address, pts_amount, ton_amount, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [tid, address, userPoints, tonAmount]
      );

      return res.status(200).json({
        ok:         true,
        pts_spent:  userPoints,
        ton_amount: tonAmount,
        address,
        status:     'pending',
      });
    }

    // ════════════════════════════════════════════
    //  claim_gift — المكافأة اليومية
    // ════════════════════════════════════════════
    if (action === 'claim_gift') {
      if (isShadowBanned) {
        return res.status(200).json({ ok: true }); // وهمي
      }

      const dayNum = parseInt(data.day || 1);
      const pts    = parseInt(data.pts || 0);

      if (!dayNum || !pts) {
        return res.status(200).json({ ok: false, error: 'invalid_params' });
      }

      // منع double-claim — atomic INSERT
      try {
        await sql(
          `INSERT INTO daily_gifts (telegram_id, gift_date, day_number, pts_claimed)
           VALUES ($1, CURRENT_DATE, $2, $3)`,
          [tid, dayNum, pts]
        );
      } catch (insertErr) {
        // PRIMARY KEY conflict = تم الاستلام سابقاً اليوم
        if (insertErr.code === '23505') {
          return res.status(200).json({ ok: false, error: 'already_claimed' });
        }
        throw insertErr;
      }

      // أضف النقاط
      const updRes = await sql(
        `UPDATE users SET points = points + $2, updated_at = NOW()
         WHERE telegram_id = $1
         RETURNING points`,
        [tid, pts]
      );
      const totalPoints = parseInt(updRes[0]?.points || 0);
      const newLevel    = calcLevel(totalPoints);
      await sql(`UPDATE users SET level = $2 WHERE telegram_id = $1 AND level != $2`, [tid, newLevel]);

      return res.status(200).json({
        ok:          true,
        pts_awarded: pts,
        totalPoints,
        newLevel,
        day:         dayNum,
      });
    }

    // ════════════════════════════════════════════
    //  track_copy_link — تتبع نسخ رابط الإحالة (fire-and-forget)
    // ════════════════════════════════════════════
    if (action === 'track_copy_link') {
      // لا يُسجَّل للـ shadow banned (صامت)
      if (!isShadowBanned) {
        await sql(
          `UPDATE users SET link_copies = link_copies + 1, updated_at = NOW() WHERE telegram_id = $1`,
          [tid]
        );
      }
      return res.status(200).json({ ok: true });
    }

    // ════════════════════════════════════════════
    //  get_state — تحميل حالة المستخدم الكاملة
    // ════════════════════════════════════════════
    if (action === 'get_state') {
      const userRow = await sql(
        `SELECT points, level, referral_count, tg_task_done FROM users WHERE telegram_id = $1`,
        [tid]
      );
      if (!userRow.length) return res.status(200).json({ ok: false, error: 'user_not_found' });

      const todayAds = await sql(
        `SELECT count, earned_pts FROM ad_watches WHERE telegram_id = $1 AND watch_date = CURRENT_DATE`,
        [tid]
      );
      const giftToday = await sql(
        `SELECT gift_date FROM daily_gifts WHERE telegram_id = $1 AND gift_date = CURRENT_DATE`,
        [tid]
      );

      return res.status(200).json({
        ok:            true,
        points:        parseInt(userRow[0].points),
        level:         userRow[0].level,
        referralCount: userRow[0].referral_count,
        tgTaskDone:    userRow[0].tg_task_done,
        adsToday:      parseInt(todayAds[0]?.count || 0),
        adsEarnedToday: parseInt(todayAds[0]?.earned_pts || 0),
        adsRemaining:  Math.max(0, AD_DAILY_LIMIT - parseInt(todayAds[0]?.count || 0)),
        giftClaimedToday: giftToday.length > 0,
      });
    }

    // ════════════════════════════════════════════
    //  get_history — سجل السحوبات
    // ════════════════════════════════════════════
    if (action === 'get_history') {
      const rows = await sql(
        `SELECT id, address, pts_amount, ton_amount, status, created_at
         FROM withdrawals WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [tid]
      );
      return res.status(200).json({ ok: true, history: rows });
    }

    // ════════════════════════════════════════════
    //  Unknown action
    // ════════════════════════════════════════════
    return res.status(400).json({ ok: false, error: 'Unknown action', action });

  } catch (err) {
    console.error('[API Error]', action, err.message);
    return res.status(500).json({ ok: false, error: 'internal_server_error' });
  }
};
