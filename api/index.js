// ================================================================
//  TON Spin — API Backend v2.1 (FIXED)
//  ✅ جدول واحد: players (كل الأعمدة هنا)
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session management (مرن — لا يلغي عند تغيير IP/fingerprint)
//  ✅ Nonce system (فقط للعمليات المالية)
//  ✅ Rate limiting (مناسب لـ Mini App)
//  ✅ Shadow ban system
//  ✅ Server-side spin logic
//  ✅ Full audit logging
//  ✅ Channel verification مع caching
//  ✅ Auto session refresh
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

async function sql(query, params = []) {
  const db = neon(DATABASE_URL);
  return await db(query, params);
}

// ── Constants ─────────────────────────────────────────────────────
const INIT_DATA_TTL   = 86400;  // 24 ساعة (كان 1 ساعة — سبّب انتهاء initData)
const RATE_WINDOW     = 10000;  // 10 ثوانٍ
const RATE_LIMIT      = 30;     // 30 طلب / 10 ثوانٍ (كان 15/5s — صارم جداً)
const RISK_BAN        = 85;     // رفعنا العتبة (كان 71)
const NONCE_TTL       = 300;
const SESSION_REFRESH = 3600;   // تجديد الجلسة كل ساعة
const CHANNEL_CACHE_TTL = 120;  // cache نتيجة القناة لمدة دقيقتين

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
  // رفعنا الحد — مستخدم واحد قد يستخدم نفس الشبكة مع أفراد عائلته
  MAX_ACCOUNTS_PER_IP:          3,
  MAX_ACCOUNTS_PER_FINGERPRINT: 2,
  IP_WHITELIST: new Set([]),
  NEW_ACCOUNT_AGE_DAYS: 1,  // تقليل الفترة لتجنب الحظر الزائد
};

// ── In-memory channel membership cache ───────────────────────────
const channelCache = new Map(); // key: `${tid}:${channel}` → { result, ts }

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

    // ✅ FIX: رفعنا TTL لـ 24 ساعة (كان ساعة واحدة — سبّب انتهاء صلاحية initData)
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

// ✅ FIX: بنّاء fingerprint مبسّط — يعتمد على user_agent + lang فقط
// (إزالة IP من المعادلة لأن الـ IP يتغير في Mobile Networks)
function buildFingerprint(fpData) {
  const ua   = (fpData.user_agent || '').slice(0, 200);
  const lang = fpData.lang || '';
  // نستخدم clientFp إذا موجود (أكثر دقة)
  if (fpData.fp) {
    return crypto.createHash('sha256').update(fpData.fp + '|' + lang).digest('hex').slice(0, 40);
  }
  return crypto.createHash('sha256').update(ua + '|' + lang).digest('hex').slice(0, 40);
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ✅ FIX: Nonce فقط للعمليات المالية (spin + withdraw)
// إزالته من verify_channel و get_user
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
    return true; // في حالة خطأ، نسمح بالطلب
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

// ✅ FIX: verifyChannelMembership مع caching لتجنب الطلبات المتكررة على Telegram API
async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;

  // فحص الـ cache أولاً
  const cacheKey = `${telegramId}:${channelUsername}`;
  const cached   = channelCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHANNEL_CACHE_TTL * 1000) {
    return cached.result;
  }

  try {
    // ✅ FIX: إزالة @ من البداية إذا كانت موجودة لتجنب مشكلة @@ مزدوجة
    const cleanUsername = channelUsername.replace(/^@/, '');
    const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${cleanUsername}&user_id=${telegramId}`;
    const r    = await fetch(url);
    const data = await r.json();

    if (!data.ok) {
      // ✅ FIX: تفصيل رسالة الخطأ لتشخيص مشاكل البوت
      console.warn(`[verifyChannel] Telegram API error for @${cleanUsername}:`, data.description);
      // لو كان الخطأ "bot is not a member" → false
      // لو كان "user not found" → false
      // لا نعتبره success في أي حالة خطأ
      channelCache.set(cacheKey, { result: false, ts: Date.now() });
      return false;
    }

    const status   = data.result?.status;
    const isMember = ['member', 'administrator', 'creator'].includes(status);

    // حفظ النتيجة في الـ cache
    channelCache.set(cacheKey, { result: isMember, ts: Date.now() });

    return isMember;
  } catch (e) {
    console.warn('[verifyChannel]', e.message);
    return false;
  }
}

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

  // ✅ FIX: fingerprint لا يعتمد على IP (يتغير في شبكات الموبايل)
  const fingerprint = buildFingerprint(fpData);

  // ════════════════════════════════════════════════════════════════
  //  CREATE_SESSION
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

    // جلب صورة البروفايل (في الخلفية — لا تعطّل إنشاء الجلسة)
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

      // ✅ FIX: Multi-account — فقط حظر إذا تطابق fingerprint مع حساب آخر (IP وحده لا يكفي)
      const accountAgeDays = playerRow?.created_at
        ? (Date.now() - new Date(playerRow.created_at).getTime()) / 86400000
        : 0;
      const isNewAccount  = accountAgeDays < MULTI_ACCT.NEW_ACCOUNT_AGE_DAYS;
      const isWhitelisted = MULTI_ACCT.IP_WHITELIST.has(ipHash);

      if (!isWhitelisted && isNewAccount) {
        // ✅ FIX: يحظر فقط إذا تطابق الـ fingerprint (وليس IP فقط)
        const fpCount = await sql(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM device_fingerprints
           WHERE fingerprint = $1 AND telegram_id != $2`,
          [fingerprint, tid]
        );
        const fpViolation = parseInt(fpCount[0]?.cnt || 0) >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;

        if (fpViolation) {
          await sql(`UPDATE players SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      // ✅ FIX: لا نلغي الجلسات القديمة — نتركها تنتهي تلقائياً
      // هذا يسمح باستخدام التطبيق على عدة أجهزة
      const existingSession = await sql(
        `SELECT session_id, expires_at FROM sessions
         WHERE telegram_id = $1 AND is_valid = TRUE AND expires_at > NOW()
         ORDER BY last_used_at DESC LIMIT 1`,
        [tid]
      );

      let sid;
      if (existingSession.length) {
        // ✅ جدّد الجلسة الموجودة بدل إنشاء جديدة
        sid = existingSession[0].session_id;
        await sql(
          `UPDATE sessions SET
             ip_hash      = $2,
             fingerprint  = $3,
             last_used_at = NOW(),
             expires_at   = NOW() + INTERVAL '7 days'
           WHERE session_id = $1`,
          [sid, ipHash, fingerprint]
        );
      } else {
        // إنشاء جلسة جديدة
        sid = generateSessionId();
        await sql(
          `INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint) VALUES ($1, $2, $3, $4)`,
          [sid, tid, ipHash, fingerprint]
        );
      }

      await sql(
        `INSERT INTO device_fingerprints (fingerprint, telegram_id, user_agent, lang, timezone_off)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (fingerprint, telegram_id) DO UPDATE SET last_seen = NOW()`,
        [fingerprint, tid, fpData.user_agent || null, fpData.lang || null, fpData.tz_offset || 0]
      );

      await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow', { is_new: isNewAccount });
      return res.status(200).json({ ok: true, session_id: sid });

    } catch (txErr) {
      console.error('[create_session]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ── Session validation ──
  if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

  const sessionRows = await sql(
    `SELECT * FROM sessions WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
    [sessionId]
  );
  if (!sessionRows.length)
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });

  const session = sessionRows[0];
  const tid     = parseInt(session.telegram_id);

  // ✅ FIX: لا نلغي الجلسة عند تغيير الـ fingerprint أو IP
  // فقط نحدّث البيانات وننبّه في الـ logs
  const fpChanged = session.fingerprint !== fingerprint;
  const ipChanged = session.ip_hash     !== ipHash;

  if (fpChanged || ipChanged) {
    // تحديث بدون إلغاء
    await sql(
      `UPDATE sessions SET
         fingerprint  = $2,
         ip_hash      = $3,
         last_used_at = NOW()
       WHERE session_id = $1`,
      [sessionId, fingerprint, ipHash]
    );
    if (fpChanged) {
      console.log(`[Session] FP changed for tid=${tid} — updated (not revoked)`);
    }
  } else {
    // ✅ Auto-refresh: تجديد last_used_at لكل طلب
    await sql(`UPDATE sessions SET last_used_at = NOW() WHERE session_id = $1`, [sessionId]);
  }

  const withinLimit = await checkRateLimit(tid);
  if (!withinLimit) {
    await auditLog(tid, ipHash, fingerprint, action, 5, 'rate_limit', {});
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // ✅ FIX: Nonce فقط للعمليات المالية (spin + withdraw)
  // إزالته من: verify_channel, get_user, get_history, get_referrals
  const nonceRequiredActions = ['do_spin', 'withdraw'];
  if (nonceRequiredActions.includes(action)) {
    const nonceValid = await checkNonce(tid, nonce);
    if (!nonceValid) {
      await updateUserRisk(tid, 5); // تقليل الـ risk penalty
      await auditLog(tid, ipHash, fingerprint, action, 5, 'deny', { reason: 'nonce_replay' });
      return res.status(400).json({ ok: false, error: 'Nonce already used or missing' });
    }
  }

  // فحص الحظر
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

      if (u.referral_by && !u.referral_rewarded) {
        const refExists = await sql(`SELECT telegram_id FROM players WHERE telegram_id = $1`, [u.referral_by]);
        if (refExists.length) {
          await sql(
            `UPDATE players SET referral_friends = referral_friends + 1, spins = spins + 1, updated_at = NOW()
             WHERE telegram_id = $1`,
            [u.referral_by]
          );
        }
        await sql(`UPDATE players SET referral_rewarded = TRUE WHERE telegram_id = $1`, [tid]);
        rows = await sql(`SELECT * FROM players WHERE telegram_id = $1`, [tid]);
      }

      const realFriends = await sql(
        `SELECT COUNT(*) AS cnt FROM players WHERE referral_by = $1 AND referral_rewarded = TRUE`,
        [tid]
      );

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
      });
    }

    // ══════════════════════════════════════════════════════════════
    //  DO_SPIN
    // ══════════════════════════════════════════════════════════════
    if (action === 'do_spin') {
      const rows = await sql(`SELECT balance, spins, shadow_banned FROM players WHERE telegram_id = $1`, [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'Player not found' });

      const player = rows[0];
      if (parseInt(player.spins) <= 0)
        return res.status(400).json({ ok: false, error: 'no_spins', message: 'No spins available' });

      // ✅ النتيجة دائماً من السيرفر
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
      const referrals = await sql(
        `SELECT telegram_id AS id,
                COALESCE(first_name, username, 'User') AS name,
                photo_url  AS photo,
                created_at AS joined,
                CASE WHEN referral_rewarded THEN 'verified' ELSE 'pending' END AS status,
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
    //  VERIFY_CHANNEL
    // ══════════════════════════════════════════════════════════════
    if (action === 'verify_channel') {
      const { channel_username } = data;
      if (!channel_username)
        return res.status(400).json({ ok: false, error: 'Missing channel_username' });

      // ✅ FIX: لا nonce مطلوب هنا — عملية قراءة فقط
      const isMember = await verifyChannelMembership(tid, channel_username);
      return res.status(200).json({ ok: true, joined: isMember });
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
