// ================================================================
//  TON Spin — API Backend v3.0
//  ✅ جدول واحد: players (كل الأعمدة هنا)
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session تُنشأ في السيرفر تلقائياً (حتى لو ما جاء create_session)
//  ✅ Session management مرن — لا يلغي عند تغيير IP/fingerprint
//  ✅ Nonce system (فقط للعمليات المالية)
//  ✅ Rate limiting مناسب لـ Mini App
//  ✅ Shadow ban system
//  ✅ Server-side spin logic
//  ✅ Full audit logging
//  ✅ Channel verification مع server-side polling كل 3 ثوانٍ
//  ✅ Auto session refresh + session مخفية عن المستخدم
//
//  ═══════════════════════════════════════════════════════════════
//  🔧 للتحكم في التحقق من القنوات — غيّر هذا المتغير:
//
//     const CHECK_CHANNELS = true;   // ✅ يتحقق من القنوات (افتراضي)
//     const CHECK_CHANNELS = false;  // ⛔ يتخطى التحقق من القنوات
//
//  ═══════════════════════════════════════════════════════════════
//
//  env vars مطلوبة:
//    DATABASE_URL  — Neon/Supabase Postgres connection string
//    BOT_TOKEN     — Telegram Bot token
//    ADMIN_KEY     — مفتاح Admin endpoints
//    IP_SALT       — ملح تشفير IP (اختياري)
// ================================================================

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

// ═══════════════════════════════════════════════════════════════
//  🔧 تحكم في التحقق من القنوات
//     true  = يتحقق من انضمام المستخدم للقنوات
//     false = يتخطى التحقق تماماً (للاختبار أو التعطيل)
// ═══════════════════════════════════════════════════════════════
const CHECK_CHANNELS = true;

// أسماء القنوات تُجلب من جدول cha ديناميكياً
async function getRequiredChannels() {
  try {
    const rows = await sql(`SELECT username FROM cha ORDER BY id ASC`);
    return rows.map(r => r.username);
  } catch (e) {
    console.warn('[getRequiredChannels]', e.message);
    return [];
  }
}

async function sql(query, params = []) {
  const db = neon(DATABASE_URL);
  return await db(query, params);
}

// ── Constants ─────────────────────────────────────────────────────
const INIT_DATA_TTL      = 86400;  // 24 ساعة
const RATE_WINDOW        = 10000;  // 10 ثوانٍ
const RATE_LIMIT         = 30;     // 30 طلب / 10 ثوانٍ
const RISK_BAN           = 85;
const NONCE_TTL          = 300;
const SESSION_REFRESH    = 3600;
const CHANNEL_CACHE_TTL  = 3;      // 3 ثوانٍ — polling كل 3 ثوانٍ

// ── Spin Prizes ───────────────────────────────────────────────────
const SPIN_PRIZES = [
  { id: 'common_1', label: '0.1 TON', type: 'ton',   amount: 0.10, rarity: 'common',  weight: 49   },
  { id: 'common_2', label: '0.1 TON', type: 'ton',   amount: 0.10, rarity: 'common',  weight: 49   },
  { id: 'rare',     label: '0.5 TON', type: 'ton',   amount: 0.50, rarity: 'rare',    weight: 0.0  },
  { id: 'super',    label: '1 TON',   type: 'ton',   amount: 1.00, rarity: 'super',   weight: 0.00 },
  { id: 'jackpot',  label: '3 TON',   type: 'ton',   amount: 3.00, rarity: 'jackpot', weight: 0.00 },
  { id: 'retry',    label: 'Try Again', type: 'retry', amount: 0,  rarity: 'retry',   weight: 2    },
];

const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_FINGERPRINT: 2,
  IP_WHITELIST: new Set([]),
  NEW_ACCOUNT_AGE_DAYS: 1,
};

// ── In-memory channel membership cache (3 ثوانٍ) ─────────────────
// key: `${tid}:${channel}` → { result, ts }
const channelCache = new Map();

// ── In-memory session cache (يمنع مشكلة session missed) ──────────
// key: sessionId → { tid, expiresAt, lastUsed }
const sessionMemCache = new Map();

// ================================================================
//  BOOTSTRAP
// ================================================================
async function bootstrap() {
  try {
    await sql(`
      CREATE TABLE IF NOT EXISTS players (
        telegram_id       BIGINT        PRIMARY KEY,
        username          TEXT,
        first_name        TEXT,
        photo_url         TEXT,
        balance           NUMERIC(18,6) NOT NULL DEFAULT 0,
        spins             INT           NOT NULL DEFAULT 0,
        total_spins       INT           NOT NULL DEFAULT 0,
        referral_by       BIGINT,
        referral_friends  INT           NOT NULL DEFAULT 0,
        referral_rewarded BOOLEAN       NOT NULL DEFAULT FALSE,
        wd_history        JSONB         NOT NULL DEFAULT '[]',
        shadow_banned     BOOLEAN       NOT NULL DEFAULT FALSE,
        is_hard_banned    BOOLEAN       NOT NULL DEFAULT FALSE,
        risk_score        INT           NOT NULL DEFAULT 0,
        channels_ok       BOOLEAN       NOT NULL DEFAULT FALSE,
        channels_checked_at TIMESTAMPTZ,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    await sql(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT        PRIMARY KEY,
        telegram_id  BIGINT      NOT NULL REFERENCES players(telegram_id) ON DELETE CASCADE,
        ip_hash      TEXT        NOT NULL,
        fingerprint  TEXT        NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_valid     BOOLEAN     NOT NULL DEFAULT TRUE
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_telegram    ON sessions(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON sessions(expires_at)`);

    await sql(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce        TEXT        PRIMARY KEY,
        telegram_id  BIGINT      NOT NULL,
        used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at)`);

    await sql(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        telegram_id   BIGINT NOT NULL,
        window_start  BIGINT NOT NULL,
        request_count INT    NOT NULL DEFAULT 1,
        PRIMARY KEY (telegram_id, window_start)
      )
    `);

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
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_telegram ON security_logs(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_created  ON security_logs(created_at DESC)`);

    await sql(`
      CREATE TABLE IF NOT EXISTS cha (
        id         SERIAL      PRIMARY KEY,
        username   TEXT        NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await sql(`
      CREATE TABLE IF NOT EXISTS device_fingerprints (
        fingerprint  TEXT        NOT NULL,
        telegram_id  BIGINT      NOT NULL,
        user_agent   TEXT,
        lang         TEXT,
        timezone_off INT,
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fingerprint, telegram_id)
      )
    `);

    await sql(`
      CREATE TABLE IF NOT EXISTS spin_logs (
        id           BIGSERIAL   PRIMARY KEY,
        telegram_id  BIGINT      NOT NULL REFERENCES players(telegram_id) ON DELETE CASCADE,
        prize_id     TEXT        NOT NULL,
        prize_label  TEXT        NOT NULL,
        prize_type   TEXT        NOT NULL,
        prize_amount NUMERIC(18,6) NOT NULL DEFAULT 0,
        rarity       TEXT        NOT NULL,
        spun_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_spin_logs_telegram ON spin_logs(telegram_id)`);

    // migrations
    const migrations = [
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS first_name TEXT`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS is_hard_banned BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS channels_ok BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE players ADD COLUMN IF NOT EXISTS channels_checked_at TIMESTAMPTZ`,
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ];
    for (const m of migrations) {
      try { await sql(m); } catch (_) {}
    }

    console.log('[DB] Bootstrap OK');
  } catch (e) {
    console.error('[DB] Bootstrap failed:', e.message);
  }
}
bootstrap();

// ================================================================
//  SECURITY HELPERS
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

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected  = crypto.createHmac('sha256', secretKey).update(checkArr.join('\n')).digest('hex');

    if (expected !== hash) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch { return null; }
}

function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'spin_salt')).digest('hex').slice(0, 32);
}

function buildFingerprint(fpData) {
  const ua   = (fpData.user_agent || '').slice(0, 200);
  const lang = fpData.lang || '';
  if (fpData.fp) {
    return crypto.createHash('sha256').update(fpData.fp + '|' + lang).digest('hex').slice(0, 40);
  }
  return crypto.createHash('sha256').update(ua + '|' + lang).digest('hex').slice(0, 40);
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

async function checkNonce(tid, nonce) {
  if (!nonce) return false;
  try {
    await sql(`DELETE FROM nonces WHERE expires_at < NOW()`);
    const existing = await sql(`SELECT 1 FROM nonces WHERE nonce = $1`, [nonce]);
    if (existing.length) return false;
    await sql(`INSERT INTO nonces (nonce, telegram_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [nonce, tid]);
    return true;
  } catch (e) {
    console.error('[checkNonce]', e.message);
    return false;
  }
}

async function checkRateLimit(tid) {
  const window = Math.floor(Date.now() / RATE_WINDOW) * RATE_WINDOW;
  try {
    await sql(`DELETE FROM rate_limits WHERE window_start < $1`, [window - RATE_WINDOW * 10]);
    const rows = await sql(
      `INSERT INTO rate_limits (telegram_id, window_start, request_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (telegram_id, window_start)
       DO UPDATE SET request_count = rate_limits.request_count + 1
       RETURNING request_count`,
      [tid, window]
    );
    return (rows[0]?.request_count || 0) <= RATE_LIMIT;
  } catch {
    return true;
  }
}

async function auditLog(tid, ipHash, fingerprint, action, riskScore, verdict, detail = {}) {
  try {
    await sql(
      `INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tid, ipHash, fingerprint, action, riskScore, verdict, JSON.stringify(detail)]
    );
  } catch (_) {}
}

async function updateUserRisk(tid, delta) {
  try {
    await sql(
      `UPDATE players SET risk_score = LEAST(100, GREATEST(0, risk_score + $2)), updated_at = NOW()
       WHERE telegram_id = $1`,
      [tid, delta]
    );
    await sql(
      `UPDATE players SET shadow_banned = TRUE WHERE telegram_id = $1 AND risk_score >= $2`,
      [tid, RISK_BAN]
    );
  } catch (_) {}
}

function serverWeightedSpin() {
  const total = SPIN_PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const prize of SPIN_PRIZES) {
    r -= prize.weight;
    if (r <= 0) return prize;
  }
  return SPIN_PRIZES[0];
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint, X-Admin-Key');
}

async function fetchTelegramPhoto(telegramId) {
  if (!BOT_TOKEN) return null;
  try {
    const r1  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUserProfilePhotos?user_id=${telegramId}&limit=1`);
    const d1  = await r1.json();
    if (!d1.ok || !d1.result.total_count) return null;
    const fileId = d1.result.photos[0][0].file_id;
    const r2  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const d2  = await r2.json();
    if (!d2.ok) return null;
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d2.result.file_path}`;
  } catch (e) {
    console.warn('[fetchPhoto]', e.message);
    return null;
  }
}

// ================================================================
//  CHANNEL MEMBERSHIP — polling كل 3 ثوانٍ
//  يُستدعى من السيرفر مباشرة بدون انتظار المستخدم
// ================================================================

/**
 * يتحقق من عضوية مستخدم في قناة واحدة مع caching بـ 3 ثوانٍ
 */
async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;

  const cacheKey = `${telegramId}:${channelUsername}`;
  const cached   = channelCache.get(cacheKey);
  // cache لمدة 3 ثوانٍ فقط — polling كل 3 ثوانٍ
  if (cached && Date.now() - cached.ts < CHANNEL_CACHE_TTL * 1000) {
    return cached.result;
  }

  try {
    const cleanUsername = channelUsername.replace(/^@/, '');
    const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${cleanUsername}&user_id=${telegramId}`;
    const r    = await fetch(url);
    const data = await r.json();

    if (!data.ok) {
      console.warn(`[verifyChannel] Telegram API error for @${cleanUsername}:`, data.description);
      channelCache.set(cacheKey, { result: false, ts: Date.now() });
      return false;
    }

    const status   = data.result?.status;
    const isMember = ['member', 'administrator', 'creator'].includes(status);
    channelCache.set(cacheKey, { result: isMember, ts: Date.now() });
    return isMember;
  } catch (e) {
    console.warn('[verifyChannel]', e.message);
    return false;
  }
}

/**
 * يتحقق من انضمام المستخدم لجميع القنوات المطلوبة
 * إذا CHECK_CHANNELS = false → يرجع true مباشرة
 */
async function checkAllChannels(telegramId) {
  // ════ مفتاح التحكم ════
  if (!CHECK_CHANNELS) return true;

  const channels = await getRequiredChannels();
  if (!channels.length) return true;

  const results = await Promise.all(
    channels.map(ch => verifyChannelMembership(telegramId, ch))
  );
  return results.every(r => r === true);
}

/**
 * يُحدّث حالة القنوات في قاعدة البيانات للمستخدم
 * يُستدعى كل 3 ثوانٍ من action=poll_channels في الـ frontend
 */
async function refreshChannelStatus(telegramId) {
  const allJoined = await checkAllChannels(telegramId);
  try {
    await sql(
      `UPDATE players SET channels_ok = $2, channels_checked_at = NOW(), updated_at = NOW()
       WHERE telegram_id = $1`,
      [telegramId, allJoined]
    );
  } catch (e) {
    console.error('[refreshChannelStatus]', e.message);
  }
  return allJoined;
}

// ================================================================
//  SESSION HELPER — يُنشئ أو يُجدّد الجلسة من السيرفر مباشرة
//  هذا يمنع مشكلة "session missed" لأن الجلسة تُنشأ حتى لو
//  فشل create_session في الـ frontend
// ================================================================

async function getOrCreateSession(tid, ipHash, fingerprint) {
  // فحص الـ memory cache أولاً (سريع)
  for (const [sid, info] of sessionMemCache.entries()) {
    if (info.tid === tid && info.expiresAt > Date.now()) {
      // تحديث last used
      info.lastUsed = Date.now();
      return sid;
    }
  }

  // فحص قاعدة البيانات
  try {
    const existing = await sql(
      `SELECT session_id, expires_at FROM sessions
       WHERE telegram_id = $1 AND is_valid = TRUE AND expires_at > NOW()
       ORDER BY last_used_at DESC LIMIT 1`,
      [tid]
    );

    if (existing.length) {
      const sid = existing[0].session_id;
      // تحديث بيانات الجلسة
      await sql(
        `UPDATE sessions SET
           ip_hash      = $2,
           fingerprint  = $3,
           last_used_at = NOW(),
           expires_at   = NOW() + INTERVAL '7 days'
         WHERE session_id = $1`,
        [sid, ipHash, fingerprint]
      );
      // حفظ في memory cache
      sessionMemCache.set(sid, {
        tid,
        expiresAt: Date.now() + 7 * 86400 * 1000,
        lastUsed:  Date.now()
      });
      return sid;
    }

    // إنشاء جلسة جديدة
    const sid = generateSessionId();
    await sql(
      `INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint)
       VALUES ($1, $2, $3, $4)`,
      [sid, tid, ipHash, fingerprint]
    );
    sessionMemCache.set(sid, {
      tid,
      expiresAt: Date.now() + 7 * 86400 * 1000,
      lastUsed:  Date.now()
    });
    console.log(`[Session] Auto-created session for tid=${tid}`);
    return sid;
  } catch (e) {
    console.error('[getOrCreateSession]', e.message);
    return null;
  }
}

// تنظيف memory cache كل 10 دقائق
setInterval(() => {
  const now = Date.now();
  for (const [sid, info] of sessionMemCache.entries()) {
    if (info.expiresAt < now) sessionMemCache.delete(sid);
  }
}, 600000);

// ================================================================
//  MAIN HANDLER
// ================================================================
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const initData  = req.headers['x-init-data']  || '';
  const sessionId = req.headers['x-session-id'] || '';
  const nonce     = req.headers['x-nonce']       || '';
  const fpHeader  = req.headers['x-fingerprint'] || '{}';

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
  const fingerprint = buildFingerprint(fpData);

  // ════════════════════════════════════════════════════════════════
  //  CREATE_SESSION
  //  الجلسة تُنشأ هنا أو تلقائياً في getOrCreateSession
  // ════════════════════════════════════════════════════════════════
  if (action === 'create_session') {
    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser)
      return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });

    const tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    // upsert player
    await sql(
      `INSERT INTO players (telegram_id, username, first_name, photo_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username   = COALESCE($2, players.username),
             first_name = COALESCE($3, players.first_name),
             photo_url  = COALESCE($4, players.photo_url),
             updated_at = NOW()`,
      [tid, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
    );

    // جلب صورة البروفايل في الخلفية
    (async () => {
      try {
        const existing = await sql(`SELECT photo_url FROM players WHERE telegram_id = $1`, [tid]);
        if (!existing[0]?.photo_url) {
          const photoUrl = await fetchTelegramPhoto(tid);
          if (photoUrl) {
            await sql(`UPDATE players SET photo_url = $2, updated_at = NOW() WHERE telegram_id = $1`, [tid, photoUrl]);
          }
        }
      } catch (_) {}
    })();

    try {
      const banCheck  = await sql(`SELECT shadow_banned, is_hard_banned, risk_score, created_at FROM players WHERE telegram_id = $1`, [tid]);
      const playerRow = banCheck[0];

      if (playerRow?.is_hard_banned)
        return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
      if (playerRow?.shadow_banned)
        return res.status(200).json({ ok: false, is_banned: true });

      // ✅ FIX 1: الحظر يُطبّق على الكل بغض النظر عن عمر الحساب
      const isWhitelisted = MULTI_ACCT.IP_WHITELIST.has(ipHash);
      const accountAgeDays = playerRow?.created_at
        ? (Date.now() - new Date(playerRow.created_at).getTime()) / 86400000
        : 0;

      if (!isWhitelisted) {
        const fpCount = await sql(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM device_fingerprints
           WHERE fingerprint = $1 AND telegram_id != $2`,
          [fingerprint, tid]
        );
        const fpViolation = parseInt(fpCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;

        if (fpViolation) {
          // حظر الحساب الجديد (الأصغر telegram_id هو الأقدم — نحافظ عليه)
          await sql(`UPDATE players SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          await auditLog(tid, ipHash, fingerprint, 'create_session', 50, 'ban', {
            reason: 'multi_account',
            fp: fingerprint,
            account_age_days: accountAgeDays,
          });
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      // استخدام getOrCreateSession لضمان إنشاء الجلسة حتى لو حدث خطأ سابق
      const sid = await getOrCreateSession(tid, ipHash, fingerprint);
      if (!sid) {
        return res.status(500).json({ ok: false, error: 'Session creation failed' });
      }

      await sql(
        `INSERT INTO device_fingerprints (fingerprint, telegram_id, user_agent, lang, timezone_off)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
        [fingerprint, tid, fpData.user_agent || null, fpData.lang || null, fpData.tz_offset || 0]
      );

      await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow', { account_age_days: accountAgeDays });
      return res.status(200).json({ ok: true, session_id: sid });

    } catch (txErr) {
      console.error('[create_session]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ── Session validation ──────────────────────────────────────────
  // إذا لم يكن هناك session_id → نحاول استخراج المستخدم من initData
  // ومن ثم نُنشئ جلسة تلقائياً (يمنع session missed)
  let tid;
  let sessionValid = false;

  if (sessionId) {
    // فحص memory cache أولاً
    const memCached = sessionMemCache.get(sessionId);
    if (memCached && memCached.expiresAt > Date.now()) {
      tid = memCached.tid;
      sessionValid = true;
      memCached.lastUsed = Date.now();
    } else {
      // فحص قاعدة البيانات
      const sessionRows = await sql(
        `SELECT * FROM sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
        [sessionId]
      );
      if (sessionRows.length) {
        const session = sessionRows[0];
        tid = parseInt(session.telegram_id);
        sessionValid = true;

        // حفظ في memory cache
        sessionMemCache.set(sessionId, {
          tid,
          expiresAt: new Date(session.expires_at).getTime(),
          lastUsed:  Date.now()
        });

        // تحديث last_used_at
        const fpChanged = session.fingerprint !== fingerprint;
        const ipChanged = session.ip_hash     !== ipHash;
        if (fpChanged || ipChanged) {
          await sql(
            `UPDATE sessions SET fingerprint = $2, ip_hash = $3, last_used_at = NOW()
             WHERE session_id = $1`,
            [sessionId, fingerprint, ipHash]
          );
        } else {
          await sql(`UPDATE sessions SET last_used_at = NOW() WHERE session_id = $1`, [sessionId]);
        }
      }
    }
  }

  // إذا لم تكن الجلسة صالحة وكان هناك initData → أنشئ جلسة تلقائياً
  if (!sessionValid && initData) {
    const tgUser = verifyTelegramInitData(initData);
    if (tgUser) {
      const autoTid = parseInt(tgUser.id);
      if (!isNaN(autoTid)) {
        // upsert player
        try {
          await sql(
            `INSERT INTO players (telegram_id, username, first_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW()`,
            [autoTid, tgUser.username || null, tgUser.first_name || null]
          );
          const autoSid = await getOrCreateSession(autoTid, ipHash, fingerprint);
          if (autoSid) {
            tid = autoTid;
            sessionValid = true;
            // أعد الـ session_id للـ client
            res.setHeader('X-New-Session-Id', autoSid);
            console.log(`[Session] Auto-session created from initData for tid=${autoTid}`);
          }
        } catch (e) {
          console.error('[AutoSession]', e.message);
        }
      }
    }
  }

  if (!sessionValid) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }

  const withinLimit = await checkRateLimit(tid);
  if (!withinLimit) {
    await auditLog(tid, ipHash, fingerprint, action, 5, 'rate_limit', {});
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // Nonce فقط للعمليات المالية
  const nonceRequiredActions = ['do_spin', 'withdraw'];
  if (nonceRequiredActions.includes(action)) {
    const nonceValid = await checkNonce(tid, nonce);
    if (!nonceValid) {
      await updateUserRisk(tid, 5);
      await auditLog(tid, ipHash, fingerprint, action, 5, 'deny', { reason: 'nonce_replay' });
      return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
    }
  }

  const playerRiskRows = await sql(`SELECT risk_score, shadow_banned FROM players WHERE telegram_id = $1`, [tid]);
  const isShadowBanned = playerRiskRows[0]?.shadow_banned || false;

  await auditLog(tid, ipHash, fingerprint, action, playerRiskRows[0]?.risk_score || 0, isShadowBanned ? 'shadow' : 'allow', {});

  try {

    // ══════════════════════════════════════════════════════════════
    //  GET_USER
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_user') {
      const referralBy = data.referral_by ? parseInt(data.referral_by) : null;
      const validRef   = referralBy && !isNaN(referralBy) && referralBy !== tid ? referralBy : null;

      let rows = await sql(`SELECT * FROM players WHERE telegram_id = $1`, [tid]);

      if (!rows.length) {
        rows = await sql(
          `INSERT INTO players (telegram_id, username, first_name, referral_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (telegram_id) DO UPDATE SET updated_at = NOW()
           RETURNING *`,
          [tid, data.username || null, data.first_name || null, validRef]
        );
      } else if (validRef && !rows[0].referral_by) {
        await sql(
          `UPDATE players SET referral_by = $2, updated_at = NOW()
           WHERE telegram_id = $1 AND referral_by IS NULL`,
          [tid, validRef]
        );
        rows = await sql(`SELECT * FROM players WHERE telegram_id = $1`, [tid]);
      }

      const u = rows[0];

      // ✅ FIX 2 & 3: الإحالة تُعتبر verified فقط إذا انضم المُحال للقنوات
      // والـ spin يُعطى فقط كل 5 إحالات موثّقة (وليس عند كل إحالة)
      if (u.referral_by && !u.referral_rewarded) {
        const refExists = await sql(`SELECT telegram_id FROM players WHERE telegram_id = $1`, [u.referral_by]);
        if (refExists.length) {

          // تحقق من انضمام المُحال للقنوات قبل اعتباره verified
          let isChannelMember = true;
          if (CHECK_CHANNELS) {
            isChannelMember = await checkAllChannels(tid);
          }

          if (isChannelMember) {
            // زِد عداد الإحالات للمُحيل
            await sql(
              `UPDATE players
               SET referral_friends = referral_friends + 1, updated_at = NOW()
               WHERE telegram_id = $1`,
              [u.referral_by]
            );

            // جلب العدد الجديد
            const refRow = await sql(
              `SELECT referral_friends FROM players WHERE telegram_id = $1`,
              [u.referral_by]
            );
            const totalFriends = parseInt(refRow[0]?.referral_friends || 0);

            // spin واحد كل 5 إحالات موثّقة
            if (totalFriends % 5 === 0) {
              await sql(
                `UPDATE players SET spins = spins + 1, updated_at = NOW() WHERE telegram_id = $1`,
                [u.referral_by]
              );
              console.log(`[Referral] tid=${u.referral_by} earned +1 spin at ${totalFriends} referrals`);
            }

            // وضع علامة verified على المُحال
            await sql(`UPDATE players SET referral_rewarded = TRUE WHERE telegram_id = $1`, [tid]);
            rows = await sql(`SELECT * FROM players WHERE telegram_id = $1`, [tid]);
          }
          // إذا لم ينضم للقنوات بعد → referral_rewarded تبقى false → يُعيد المحاولة في المرة القادمة
        }
      }

      const realFriends = await sql(
        `SELECT COUNT(*) AS cnt FROM players WHERE referral_by = $1 AND referral_rewarded = TRUE`,
        [tid]
      );

      // ── فحص حالة القنوات ──
      // إذا CHECK_CHANNELS = false → channels_ok = true دائماً
      let channelsOk = true;
      if (CHECK_CHANNELS) {
        // نُحدّث حالة القنوات في الخلفية
        channelsOk = await refreshChannelStatus(tid);
      }

      const player = rows[0];
      return res.status(200).json({
        ok: true,
        balance:          parseFloat(player.balance      || 0),
        spins:            parseInt(player.spins          || 0),
        total_spins:      parseInt(player.total_spins    || 0),
        wd_history:       Array.isArray(player.wd_history) ? player.wd_history : [],
        referral_friends: parseInt(realFriends[0]?.cnt  || 0),
        username:         player.username,
        first_name:       player.first_name,
        photo_url:        player.photo_url,
        channels_ok:      channelsOk,
        check_channels:   CHECK_CHANNELS,
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  POLL_CHANNELS — يتحقق كل 3 ثوانٍ من انضمام المستخدم
    //  الـ frontend يستدعي هذا بـ setInterval كل 3 ثوانٍ
    // ══════════════════════════════════════════════════════════════
    if (action === 'poll_channels') {
      const dynamicChannels = await getRequiredChannels();

      // إذا CHECK_CHANNELS = false → المستخدم منضم دائماً
      if (!CHECK_CHANNELS) {
        return res.status(200).json({
          ok:          true,
          channels_ok: true,
          check_channels: false,
          channels:    dynamicChannels.map(ch => ({ channel: ch, joined: true })),
        });
      }

      // التحقق من كل قناة بشكل مفصّل
      const channelResults = await Promise.all(
        dynamicChannels.map(async (ch) => ({
          channel: ch,
          joined:  await verifyChannelMembership(tid, ch),
        }))
      );

      const allJoined = channelResults.every(r => r.joined);

      // تحديث قاعدة البيانات
      try {
        await sql(
          `UPDATE players SET channels_ok = $2, channels_checked_at = NOW(), updated_at = NOW()
           WHERE telegram_id = $1`,
          [tid, allJoined]
        );
      } catch (e) {
        console.error('[poll_channels] DB update failed:', e.message);
      }

      return res.status(200).json({
        ok:          true,
        channels_ok: allJoined,
        check_channels: true,
        channels:    channelResults,
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  GET_CHANNELS — يُرجع قائمة القنوات من جدول cha
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_channels') {
      const channels = await getRequiredChannels();
      return res.status(200).json({ ok: true, channels });
    }

    // ══════════════════════════════════════════════════════════════
    //  VERIFY_CHANNEL — التحقق من قناة واحدة بعينها
    // ══════════════════════════════════════════════════════════════
    if (action === 'verify_channel') {
      const { channel_username } = data;
      if (!channel_username)
        return res.status(400).json({ ok: false, error: 'Missing channel_username' });

      if (!CHECK_CHANNELS) {
        return res.status(200).json({ ok: true, joined: true });
      }

      const isMember = await verifyChannelMembership(tid, channel_username);
      return res.status(200).json({ ok: true, joined: isMember });
    }

    // ══════════════════════════════════════════════════════════════
    //  DO_SPIN
    // ══════════════════════════════════════════════════════════════
    if (action === 'do_spin') {
      // ── التحقق من القنوات قبل السماح بالسبين ──
      if (CHECK_CHANNELS) {
        const channelsOk = await checkAllChannels(tid);
        if (!channelsOk) {
          return res.status(403).json({
            ok: false,
            error: 'channels_required',
            message: 'يجب الانضمام للقنوات المطلوبة أولاً',
          });
        }
      }

      const rows = await sql(`SELECT balance, spins, shadow_banned FROM players WHERE telegram_id = $1`, [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Player not found' });

      const player = rows[0];
      if (parseInt(player.spins) <= 0)
        return res.status(400).json({ ok: false, error: 'no_spins', message: 'No spins available' });

      const prize = serverWeightedSpin();

      if (isShadowBanned) {
        await sql(`UPDATE players SET spins = spins - 1, total_spins = total_spins + 1, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
        return res.status(200).json({
          ok:      true,
          prize:   { id: prize.id, label: prize.label, type: prize.type, amount: prize.amount, rarity: prize.rarity },
          balance: parseFloat(player.balance || 0),
          spins:   Math.max(0, parseInt(player.spins) - 1),
        });
      }

      const actualReward = prize.type === 'ton' ? prize.amount : 0;
      await sql(
        `UPDATE players SET spins = spins - 1, total_spins = total_spins + 1, balance = balance + $2, updated_at = NOW()
         WHERE telegram_id = $1`,
        [tid, actualReward]
      );

      await sql(
        `INSERT INTO spin_logs (telegram_id, prize_id, prize_label, prize_type, prize_amount, rarity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tid, prize.id, prize.label, prize.type, prize.amount, prize.rarity]
      );

      const updated = await sql(`SELECT balance, spins FROM players WHERE telegram_id = $1`, [tid]);
      return res.status(200).json({
        ok:      true,
        prize:   { id: prize.id, label: prize.label, type: prize.type, amount: prize.amount, rarity: prize.rarity },
        balance: parseFloat(updated[0]?.balance || 0),
        spins:   parseInt(updated[0]?.spins    || 0),
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  WITHDRAW
    // ══════════════════════════════════════════════════════════════
    if (action === 'withdraw') {
      const { address, amount } = data;
      const amt = parseFloat(amount);

      if (!address)               return res.status(400).json({ ok: false, error: 'Missing address' });
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });
      if (amt < 0.1)              return res.status(400).json({ ok: false, error: 'Minimum 0.1 TON' });
      if (!address.match(/^(EQ|UQ|kQ)/)) return res.status(400).json({ ok: false, error: 'Invalid TON address format' });
      if (isShadowBanned) return res.status(403).json({ ok: false, error: 'Account under review' });

      const rows = await sql(`SELECT balance, wd_history FROM players WHERE telegram_id = $1`, [tid]);
      if (!rows.length)                       return res.status(404).json({ ok: false, error: 'Player not found' });
      if (parseFloat(rows[0].balance) < amt)  return res.status(400).json({ ok: false, error: 'Insufficient balance' });

      const now     = new Date().toISOString();
      const entry   = { address, amount: amt, date: now, status: 'pending' };
      const history = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      history.unshift(entry);
      if (history.length > 50) history.splice(50);

      await sql(
        `UPDATE players SET balance = balance - $2, wd_history = $3, updated_at = NOW() WHERE telegram_id = $1`,
        [tid, amt, JSON.stringify(history)]
      );

      console.log(`[WITHDRAW] tid=${tid} amount=${amt} address=${address.slice(0, 8)}...`);
      return res.status(200).json({ ok: true, entry });
    }

    // ══════════════════════════════════════════════════════════════
    //  GET_HISTORY
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_history') {
      const rows = await sql(`SELECT wd_history FROM players WHERE telegram_id = $1`, [tid]);
      const history = Array.isArray(rows[0]?.wd_history) ? rows[0].wd_history : [];
      return res.status(200).json({ ok: true, history });
    }

    // ══════════════════════════════════════════════════════════════
    //  GET_REFERRALS
    // ══════════════════════════════════════════════════════════════
    if (action === 'get_referrals') {
      // ✅ FIX 3: verified = انضم للقنوات (referral_rewarded=TRUE)
      // pending = لم ينضم للقنوات بعد أو لم يُوثَّق
      const referrals = await sql(
        `SELECT telegram_id AS id,
                COALESCE(first_name, username, 'User') AS name,
                photo_url   AS photo,
                created_at  AS joined,
                CASE
                  WHEN referral_rewarded = TRUE THEN 'verified'
                  ELSE 'pending'
                END AS status,
                0.0 AS earn
         FROM players
         WHERE referral_by = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [tid]
      );
      return res.status(200).json({ ok: true, referrals });
    }

    // ══════════════════════════════════════════════════════════════
    //  ADMIN: UPDATE_WITHDRAWAL
    // ══════════════════════════════════════════════════════════════
    if (action === 'update_withdrawal') {
      const adminKey = req.headers['x-admin-key'] || '';
      if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY)
        return res.status(403).json({ ok: false, error: 'Unauthorized' });

      const { target_tid, date, status: newStatus } = data;
      const allowed = ['completed', 'approved', 'rejected'];
      if (!allowed.includes(newStatus)) return res.status(400).json({ ok: false, error: 'Invalid status' });

      const targetId = parseInt(target_tid);
      if (isNaN(targetId)) return res.status(400).json({ ok: false, error: 'Invalid target_tid' });

      const rows = await sql(`SELECT wd_history FROM players WHERE telegram_id = $1`, [targetId]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Player not found' });

      let updated = false;
      const history = (Array.isArray(rows[0].wd_history) ? rows[0].wd_history : []).map(entry => {
        if (entry.status === 'pending' && !updated) {
          updated = true;
          return { ...entry, status: newStatus, updated_at: new Date().toISOString() };
        }
        return entry;
      });

      if (!updated) return res.status(404).json({ ok: false, error: 'No pending withdrawal found' });

      await sql(`UPDATE players SET wd_history = $2, updated_at = NOW() WHERE telegram_id = $1`, [targetId, JSON.stringify(history)]);
      return res.status(200).json({ ok: true, message: `Withdrawal marked as ${newStatus}` });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action', action });

  } catch (err) {
    console.error('[API Error]', action, err.message);
    return res.status(500).json({
      ok: false, error: 'internal_server_error',
      message: 'An unexpected error occurred.',
      ...(process.env.NODE_ENV !== 'production' && { detail: err.message })
    });
  }
};
