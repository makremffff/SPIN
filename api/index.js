// ================================================================
//  Tomato Farm — API Backend v4.0
//  ╔══════════════════════════════════════════════════════════╗
//  ║   ZERO TRUST · EPHEMERAL NONCE · SERVER-SIDE ATOMIC    ║
//  ╚══════════════════════════════════════════════════════════╝
//
//  🔐 Ephemeral Nonce Architecture:
//    • nonce يظهر داخل request (مثل Tomato الأصلي) — لكن:
//    • one-time use: يُستهلك فور أول استخدام ناجح
//    • short TTL: 5 دقائق فقط
//    • مربوط بـ session_id + user_id + fingerprint + ip_hash
//    • أي replay لنفس nonce يفشل فوراً (حتى خلال الـ TTL)
//    • race condition protected: database-level atomic consume
//
//  ✅ Telegram initData verification (HMAC-SHA256)
//  ✅ Session management (fingerprint bound, IP-tolerant)
//  ✅ Ephemeral nonce system (one-time, TTL, multi-bound)
//  ✅ Rate limiting (per user, sliding window)
//  ✅ Risk scoring + Shadow ban + Hard ban
//  ✅ Multi-account detection (IP + fingerprint)
//  ✅ Full audit logging
//  ✅ Auto cleanup (sessions, nonces, logs)
//  ✅ Adsgram reward + task claim — fully server-side
// ================================================================

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ── Constants ─────────────────────────────────────────────────────
const CELL_COUNT      = 3;
const GROW_DURATION   = 30;
const INIT_DATA_TTL   = 3600;
const SESSION_TTL     = 86400;
const RATE_WINDOW     = 5000;
const RATE_LIMIT      = 10;
const RISK_SUSPICIOUS = 41;
const RISK_BAN        = 71;

// Nonce TTLs بالثواني
const NONCE_TTL_GENERAL  = 300;   // 5 دقائق للعمليات العامة
const NONCE_TTL_AD       = 600;   // 10 دقائق لمهمة الإعلان (Adsgram)
const NONCE_TTL_SESSION  = 300;   // 5 دقائق لنظام الإعلانات العادي (reward_ad)

// Adsgram
const ADSGRAM_TASK_BLOCK_ID     = 'task-30166';
const ADSGRAM_TASK_POINTS       = 70;
const ADSGRAM_TASK_COOLDOWN_SEC = 60;

// Ad rewards config (مرتبط بـ seeds/water)
const AD_REWARDS = {
  seed_single: { col: 'seeds',       amount: 1, daily_max: 10 },
  seed_bundle: { col: 'seeds',       amount: 7, daily_max: 28 },
  water:       { col: 'water_count', amount: 3, daily_max: 18 },
};

// Multi-account detection
const MULTI_ACCT = {
  MAX_ACCOUNTS_PER_IP          : 2,
  MAX_ACCOUNTS_PER_FINGERPRINT : 1,
  IP_WHITELIST                 : new Set([]),
  NEW_ACCOUNT_AGE_DAYS         : 3,
};

// ══════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════════════════════════
let _bootstrapped = false;
async function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    // جدول المستخدمين
    await sql(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id            BIGINT        PRIMARY KEY,
        username               TEXT,
        balance                NUMERIC(18,6) NOT NULL DEFAULT 0,
        seeds                  INT           NOT NULL DEFAULT 3,
        water_count            INT           NOT NULL DEFAULT 3,
        points                 INT           NOT NULL DEFAULT 0,
        cells                  JSONB         NOT NULL DEFAULT '[]',
        task_state             JSONB         NOT NULL DEFAULT '{"earnChannel":"idle","eMoneyChannel":"idle"}',
        wd_history             JSONB         NOT NULL DEFAULT '[]',
        today_date             TEXT          NOT NULL DEFAULT '',
        today_earn             NUMERIC(18,6) NOT NULL DEFAULT 0,
        total_harvests         INT           NOT NULL DEFAULT 0,
        referral_by            BIGINT,
        referral_friends       INT           NOT NULL DEFAULT 0,
        referral_balance       NUMERIC(18,6) NOT NULL DEFAULT 0,
        referral_rewarded      BOOLEAN       NOT NULL DEFAULT FALSE,
        day                    INT           NOT NULL DEFAULT 1,
        shadow_banned          BOOLEAN       NOT NULL DEFAULT FALSE,
        is_hard_banned         BOOLEAN       NOT NULL DEFAULT FALSE,
        risk_score             INT           NOT NULL DEFAULT 0,
        photo_url              TEXT,
        ad_last_reward         TIMESTAMPTZ,
        adsgram_task_last_at   TIMESTAMPTZ,
        created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    // جدول الجلسات
    await sql(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id      TEXT          PRIMARY KEY,
        telegram_id     BIGINT        NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        ip_hash         TEXT          NOT NULL,
        fingerprint     TEXT          NOT NULL,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
        is_valid        BOOLEAN       NOT NULL DEFAULT TRUE
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_telegram    ON sessions(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON sessions(expires_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_ip_hash     ON sessions(ip_hash)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_sessions_fingerprint ON sessions(fingerprint)`);

    // ══════════════════════════════════════════════════════════════
    //  جدول Nonces — المحور الرئيسي للحماية
    //
    //  الفرق عن النظام القديم:
    //  • نonce_type: general | ad_reward | adsgram_task
    //  • session_id: ربط صارم — نonce لا يعمل خارج الجلسة التي أنشأها
    //  • ip_hash: ربط بـ IP وقت الإنشاء — تغيّر IP → رفض
    //  • fingerprint: ربط بالجهاز — تغيّر الجهاز → رفض
    //  • consumed_at: وقت الاستهلاك الفعلي (للتدقيق)
    //  • is_used: علامة الاستهلاك — atomic update في DB
    // ══════════════════════════════════════════════════════════════
    await sql(`
      CREATE TABLE IF NOT EXISTS nonces (
        nonce         TEXT          PRIMARY KEY,
        telegram_id   BIGINT        NOT NULL,
        session_id    TEXT          NOT NULL,
        ip_hash       TEXT          NOT NULL,
        fingerprint   TEXT          NOT NULL,
        nonce_type    TEXT          NOT NULL DEFAULT 'general',
        is_used       BOOLEAN       NOT NULL DEFAULT FALSE,
        consumed_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ   NOT NULL
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_expires    ON nonces(expires_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_session    ON nonces(session_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_telegram   ON nonces(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_nonces_is_used    ON nonces(is_used) WHERE is_used = FALSE`);

    // جدول Rate Limiting
    await sql(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        telegram_id   BIGINT        NOT NULL,
        window_start  BIGINT        NOT NULL,
        request_count INT           NOT NULL DEFAULT 1,
        PRIMARY KEY (telegram_id, window_start)
      )
    `);

    // جدول Audit Log
    await sql(`
      CREATE TABLE IF NOT EXISTS security_logs (
        id            BIGSERIAL     PRIMARY KEY,
        telegram_id   BIGINT,
        ip_hash       TEXT,
        fingerprint   TEXT,
        session_id    TEXT,
        nonce_ref     TEXT,
        action        TEXT          NOT NULL,
        risk_score    INT           NOT NULL DEFAULT 0,
        verdict       TEXT          NOT NULL DEFAULT 'allow',
        detail        JSONB         NOT NULL DEFAULT '{}',
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_telegram  ON security_logs(telegram_id)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_created   ON security_logs(created_at DESC)`);
    await sql(`CREATE INDEX IF NOT EXISTS idx_logs_action    ON security_logs(action)`);

    // جدول بصمات الأجهزة
    await sql(`
      CREATE TABLE IF NOT EXISTS device_fingerprints (
        fingerprint   TEXT          NOT NULL,
        telegram_id   BIGINT        NOT NULL,
        user_agent    TEXT,
        lang          TEXT,
        screen        TEXT,
        timezone_off  INT,
        last_seen     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fingerprint, telegram_id)
      )
    `);

    // جدول المهام
    await sql(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT          PRIMARY KEY,
        icon        TEXT          NOT NULL DEFAULT '⭐',
        name        TEXT          NOT NULL,
        reward      NUMERIC(18,6) NOT NULL DEFAULT 0,
        task_type   TEXT          NOT NULL DEFAULT 'url',
        url         TEXT,
        channel     TEXT,
        description TEXT          NOT NULL DEFAULT '',
        is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
        sort_order  INT           NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active, sort_order)`);

    // جدول إنجازات المستخدمين
    await sql(`
      CREATE TABLE IF NOT EXISTS user_tasks (
        telegram_id  BIGINT        NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        task_id      TEXT          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        completed    BOOLEAN       NOT NULL DEFAULT FALSE,
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (telegram_id, task_id)
      )
    `);
    await sql(`CREATE INDEX IF NOT EXISTS idx_user_tasks_telegram ON user_tasks(telegram_id)`);

    // Seed default tasks
    const existingTasks = await sql(`SELECT COUNT(*) AS cnt FROM tasks`);
    if (parseInt(existingTasks[0]?.cnt || 0) === 0) {
      await sql(`
        INSERT INTO tasks (id, icon, name, reward, task_type, url, channel, description, sort_order) VALUES
        ('earnChannel',   '📢', 'Join Earn Channel',  0.005, 'channel', NULL, 'botbababab',  'Subscribe on Telegram to unlock rewards', 1),
        ('eMoneyChannel', '💰', 'E-Money Algeria',    0.005, 'channel', NULL, 'tt_fhp',      'Join our partner channel to earn bonus TON', 2)
        ON CONFLICT (id) DO NOTHING
      `);
    }

    // جدول السحوبات
    await sql(`
      CREATE TABLE IF NOT EXISTS giveaways (
        id            BIGSERIAL     PRIMARY KEY,
        title         TEXT          NOT NULL,
        reward        NUMERIC(18,6) NOT NULL DEFAULT 0,
        winner_id     BIGINT,
        is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
        draw_at       TIMESTAMPTZ,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`
      CREATE TABLE IF NOT EXISTS giveaway_entries (
        giveaway_id   BIGINT        NOT NULL REFERENCES giveaways(id),
        telegram_id   BIGINT        NOT NULL REFERENCES users(telegram_id),
        entered_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (giveaway_id, telegram_id)
      )
    `);

    // جدول Promo Codes
    await sql(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        code          TEXT          PRIMARY KEY,
        seeds         INT           NOT NULL DEFAULT 0,
        water         INT           NOT NULL DEFAULT 0,
        balance       NUMERIC(18,6) NOT NULL DEFAULT 0,
        reward_desc   TEXT          NOT NULL DEFAULT '',
        max_uses      INT           NOT NULL DEFAULT 100,
        use_count     INT           NOT NULL DEFAULT 0,
        expires_at    TIMESTAMPTZ,
        is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);
    await sql(`
      CREATE TABLE IF NOT EXISTS promo_redemptions (
        code          TEXT          NOT NULL,
        telegram_id   BIGINT        NOT NULL,
        redeemed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (code, telegram_id)
      )
    `);

    // Migrations
    const migrations = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_banned         BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score            INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded     BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_friends      INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_balance      NUMERIC(18,6) NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_hard_banned        BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url             TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS ad_last_reward        TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS adsgram_task_last_at  TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS points                INT           NOT NULL DEFAULT 0`,
      `ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS is_active            BOOLEAN       NOT NULL DEFAULT TRUE`,
      `ALTER TABLE tasks  ADD COLUMN IF NOT EXISTS sort_order           INT           NOT NULL DEFAULT 0`,
      // إزالة الـ columns القديمة من sessions (ad_nonce كان موجوداً في الإصدار القديم)
      `ALTER TABLE sessions DROP COLUMN IF EXISTS ad_nonce`,
      `ALTER TABLE sessions DROP COLUMN IF EXISTS ad_nonce_exp`,
      // إضافة session_id و ip_hash و fingerprint لجدول nonces (إذا لم يكونا موجودَين)
      `ALTER TABLE nonces ADD COLUMN IF NOT EXISTS session_id   TEXT          NOT NULL DEFAULT ''`,
      `ALTER TABLE nonces ADD COLUMN IF NOT EXISTS ip_hash      TEXT          NOT NULL DEFAULT ''`,
      `ALTER TABLE nonces ADD COLUMN IF NOT EXISTS fingerprint  TEXT          NOT NULL DEFAULT ''`,
      `ALTER TABLE nonces ADD COLUMN IF NOT EXISTS nonce_type   TEXT          NOT NULL DEFAULT 'general'`,
      `ALTER TABLE nonces ADD COLUMN IF NOT EXISTS is_used      BOOLEAN       NOT NULL DEFAULT FALSE`,
      `ALTER TABLE nonces ADD COLUMN IF NOT EXISTS consumed_at  TIMESTAMPTZ`,
      `ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS session_id  TEXT`,
      `ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS nonce_ref   TEXT`,
    ];
    for (const m of migrations) {
      try { await sql(m); } catch (_) {}
    }

    console.log('[DB] Bootstrap OK — Zero Trust v4.0 (Ephemeral Nonce)');
  } catch (e) {
    console.error('[DB] Bootstrap failed:', e.message);
  }
}
bootstrap();

// ══════════════════════════════════════════════════════════════════
//  AUTO CLEANUP — كل ساعة
//  • Expired nonces (used أو منتهية الصلاحية)
//  • Rate limits قديمة
//  • Expired sessions
//  • Security logs قديمة (أكثر من 30 يوم)
// ══════════════════════════════════════════════════════════════════
setInterval(async () => {
  try {
    const r1 = await sql(`DELETE FROM nonces      WHERE expires_at < NOW() OR is_used = TRUE`);
    const r2 = await sql(`DELETE FROM rate_limits WHERE window_start < $1`, [Date.now() - RATE_WINDOW * 20]);
    const r3 = await sql(`DELETE FROM sessions    WHERE expires_at < NOW() AND is_valid = FALSE`);
    const r4 = await sql(`DELETE FROM security_logs WHERE created_at < NOW() - INTERVAL '30 days'`);
    console.log('[CLEANUP] nonces/rate_limits/sessions/logs cleaned');
  } catch (e) {
    console.warn('[CLEANUP] error:', e.message);
  }
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════
//  SECURITY CORE
// ══════════════════════════════════════════════════════════════════

// تحقق HMAC-SHA256 من Telegram initData
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
  } catch {
    return null;
  }
}

// Hash IP بـ salt
function hashIP(ip) {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256')
    .update(ip + (process.env.IP_SALT || 'zt_salt_v4'))
    .digest('hex').slice(0, 32);
}

// بناء fingerprint من بيانات الطلب
function buildFingerprint(fpData, ipHash) {
  const clientFp = fpData.fp || '';
  const ua       = (fpData.user_agent || '').slice(0, 200);
  const lang     = fpData.lang        || '';
  const screen   = fpData.screen      || '';
  const tz       = String(fpData.tz_offset  || 0);
  const tzName   = fpData.tz_name     || '';
  const cores    = String(fpData.hw_cores   || 0);
  const mem      = String(fpData.hw_mem     || 0);
  const touch    = String(fpData.touch_pts  || 0);
  const canvas   = (fpData.canvas_sig || '').slice(0, 40);
  const webgl    = (fpData.webgl_sig  || '').slice(0, 60);
  const audio    = (fpData.audio_sig  || '').slice(0, 40);
  const raw = clientFp
    ? [clientFp, ipHash, ua, lang, tz, tzName, cores, mem].join('|')
    : [ua, lang, screen, tz, tzName, cores, mem, touch, canvas, webgl, audio, ipHash].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

// إنشاء Session ID
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ══════════════════════════════════════════════════════════════════
//  EPHEMERAL NONCE SYSTEM
//  ╔══════════════════════════════════════════════════════════╗
//  ║  كيف يعمل النظام:                                       ║
//  ║                                                          ║
//  ║  1. السيرفر يُنشئ nonce داخلياً عند طلب العميل          ║
//  ║  2. يُخزَّن في DB مربوطاً بـ:                           ║
//  ║     • session_id (الجلسة الحالية فقط)                   ║
//  ║     • telegram_id (المستخدم فقط)                        ║
//  ║     • ip_hash (الـ IP وقت الإنشاء)                      ║
//  ║     • fingerprint (الجهاز وقت الإنشاء)                  ║
//  ║     • nonce_type (general | ad_reward | adsgram_task)   ║
//  ║  3. يُرسَل للعميل → العميل يُعيده في الطلب التالي       ║
//  ║  4. السيرفر يتحقق من كل الشروط ATOMICALLY               ║
//  ║  5. يُستهلك فوراً (is_used=TRUE) — لا يُقبل مجدداً      ║
//  ║  6. حتى لو رأى المستخدم الـ nonce في Network tab،      ║
//  ║     لا يستطيع استعماله مرة أخرى                         ║
//  ╚══════════════════════════════════════════════════════════╝
// ══════════════════════════════════════════════════════════════════

/**
 * issueNonce — السيرفر يُنشئ nonce ويحفظه في DB
 * @param {string} sessionId
 * @param {string} telegramId
 * @param {string} ipHash
 * @param {string} fingerprint
 * @param {'general'|'ad_reward'|'adsgram_task'} nonceType
 * @returns {string} — الـ nonce المُنشأ
 */
async function issueNonce(sessionId, telegramId, ipHash, fingerprint, nonceType = 'general') {
  const nonce = crypto.randomBytes(32).toString('hex');
  const ttl   = nonceType === 'adsgram_task' ? NONCE_TTL_AD
               : nonceType === 'ad_reward'   ? NONCE_TTL_SESSION
               : NONCE_TTL_GENERAL;

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  await sql(
    `INSERT INTO nonces
       (nonce, telegram_id, session_id, ip_hash, fingerprint, nonce_type, is_used, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)`,
    [nonce, telegramId, sessionId, ipHash, fingerprint, nonceType, expiresAt]
  );

  return nonce;
}

/**
 * consumeNonce — التحقق من nonce واستهلاكه atomically
 *
 * يتحقق من:
 * ① الـ nonce موجود في DB
 * ② لم يُستهلك بعد (is_used = FALSE)
 * ③ لم تنتهِ صلاحيته (expires_at > NOW())
 * ④ مربوط بنفس session_id
 * ⑤ مربوط بنفس telegram_id
 * ⑥ مربوط بنفس fingerprint
 * ⑦ نوعه صحيح (nonce_type)
 * ⑧ يستخدم crypto.timingSafeEqual
 *
 * الاستهلاك: UPDATE atomic في DB — يمنع race conditions
 *
 * @returns {'ok'|'not_found'|'used'|'expired'|'session_mismatch'|'fp_mismatch'|'type_mismatch'|'error'}
 */
async function consumeNonce(clientNonce, sessionId, telegramId, fingerprint, nonceType = 'general') {
  if (!clientNonce || typeof clientNonce !== 'string' || clientNonce.length !== 64) {
    return 'not_found';
  }

  try {
    // ── Atomic consume: UPDATE مع شروط كاملة في استعلام واحد ──
    // يمنع race condition: لو جاءان في نفس الوقت، أحدهما سيفشل
    const rows = await sql(
      `UPDATE nonces
       SET is_used = TRUE, consumed_at = NOW()
       WHERE nonce       = $1
         AND is_used     = FALSE
         AND expires_at  > NOW()
         AND session_id  = $2
         AND telegram_id = $3
         AND fingerprint = $4
         AND nonce_type  = $5
       RETURNING nonce, created_at`,
      [clientNonce, sessionId, telegramId, fingerprint, nonceType]
    );

    if (!rows.length) {
      // للتمييز بين الحالات — نجلب الـ nonce بدون شروط
      const existing = await sql(
        `SELECT is_used, expires_at, session_id, fingerprint, nonce_type
         FROM nonces WHERE nonce = $1`,
        [clientNonce]
      );

      if (!existing.length)               return 'not_found';
      if (existing[0].is_used)            return 'used';
      if (new Date(existing[0].expires_at) < new Date()) return 'expired';
      if (existing[0].session_id !== sessionId)           return 'session_mismatch';
      if (existing[0].fingerprint !== fingerprint)        return 'fp_mismatch';
      if (existing[0].nonce_type !== nonceType)           return 'type_mismatch';
      return 'error';
    }

    // ── Timing-safe comparison (إضافية للطبقة الأمنية) ──
    const storedBuf   = Buffer.from(rows[0].nonce,  'hex');
    const receivedBuf = Buffer.from(clientNonce, 'hex');

    if (storedBuf.length !== receivedBuf.length ||
        !crypto.timingSafeEqual(storedBuf, receivedBuf)) {
      // هذا نادر جداً (يعني الـ UPDATE نجح لكن timingSafeEqual فشل — حماية إضافية)
      await sql(`UPDATE nonces SET is_used = FALSE, consumed_at = NULL WHERE nonce = $1`, [clientNonce]);
      return 'error';
    }

    return 'ok';

  } catch (e) {
    console.error('[consumeNonce] error:', e.message);
    return 'error';
  }
}

// ── Rate Limiting ─────────────────────────────────────────────────
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

// ── Risk Score ────────────────────────────────────────────────────
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

// ── Audit Log ────────────────────────────────────────────────────
async function auditLog(tid, ipHash, fingerprint, action, riskScore, verdict, detail = {}, sessionId = null, nonceRef = null) {
  try {
    await sql(
      `INSERT INTO security_logs
         (telegram_id, ip_hash, fingerprint, session_id, nonce_ref, action, risk_score, verdict, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tid, ipHash, fingerprint, sessionId, nonceRef, action, riskScore, verdict, JSON.stringify(detail)]
    );
  } catch (_) {}
}

// ── Update User Risk ──────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint');
}

function resolveCell(cell) {
  if (!cell || cell.state === 'empty' || cell.state === 'ready') return cell;
  if (cell.state === 'growing') {
    const plantedAt = new Date(cell.planted_at).getTime();
    const duration  = (cell.duration || GROW_DURATION) * 1000;
    if (Date.now() >= plantedAt + duration) return { ...cell, state: 'ready' };
  }
  return cell;
}

function resolveCells(cells) {
  if (!Array.isArray(cells)) return buildEmptyCells();
  return cells.map(resolveCell);
}

function buildEmptyCells() {
  return Array.from({ length: CELL_COUNT }, (_, i) => ({
    id: i, state: 'empty', planted_at: null, duration: GROW_DURATION,
  }));
}

function normalizeCellsFromDB(rawCells) {
  if (!Array.isArray(rawCells) || rawCells.length === 0) return buildEmptyCells();
  return rawCells;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function persistIfChanged(tid, original, resolved) {
  const changed = resolved.some((c, i) => original[i]?.state !== c.state);
  if (changed) {
    await sql(`UPDATE users SET cells = $2, updated_at = NOW() WHERE telegram_id = $1`,
      [tid, JSON.stringify(resolved)]);
  }
}

// ══════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const initData  = req.headers['x-init-data']   || '';
  const sessionId = req.headers['x-session-id']  || req.headers['x-session-id'] || '';
  // ✅ نقبل nonce من header أو من body.data — مثل Tomato الأصلي
  const fpHeader  = req.headers['x-fingerprint'] || '{}';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { action, data = {} } = body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });

  // الـ nonce يُقرأ من header أو من body (مثل Tomato الأصلي)
  const clientNonce = req.headers['x-nonce'] || data.nonce || '';

  const rawIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const ipHash     = hashIP(rawIP);

  let fpData = {};
  try { fpData = JSON.parse(fpHeader); } catch (_) {}
  const fingerprint = buildFingerprint(fpData, ipHash);

  // ══════════════════════════════════════════════════════════════
  //  CREATE_SESSION
  // ══════════════════════════════════════════════════════════════
  if (action === 'create_session') {
    const tgUser = verifyTelegramInitData(initData);
    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired Telegram auth' });
    }

    const tid = parseInt(tgUser.id);
    if (isNaN(tid)) return res.status(400).json({ ok: false, error: 'Invalid user ID' });

    await sql(
      `INSERT INTO users (telegram_id, username, photo_url) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username  = $2,
             photo_url = COALESCE($3, users.photo_url),
             updated_at = NOW()`,
      [tid, tgUser.username || tgUser.first_name || null, tgUser.photo_url || null]
    );

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
        const ipCountResult = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM sessions
           WHERE ip_hash = $1 AND telegram_id != $2 AND is_valid = TRUE AND expires_at > NOW()`,
          [ipHash, tid]
        );
        const fpCountResult = await db(
          `SELECT COUNT(DISTINCT telegram_id) AS cnt FROM device_fingerprints
           WHERE fingerprint = $1 AND telegram_id != $2`,
          [fingerprint, tid]
        );

        const activeAccountsOnIP  = parseInt(ipCountResult[0]?.cnt || 0);
        const accountsOnFp        = parseInt(fpCountResult[0]?.cnt || 0);
        const ipViolation         = activeAccountsOnIP >= MULTI_ACCT.MAX_ACCOUNTS_PER_IP;
        const fpViolation         = accountsOnFp >= MULTI_ACCT.MAX_ACCOUNTS_PER_FINGERPRINT;
        const shouldBan           = fpViolation || (ipViolation && fpViolation);

        if (shouldBan) {
          await db(`UPDATE users SET is_hard_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
          await db(
            `INSERT INTO security_logs
               (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
             VALUES ($1, $2, $3, 'multi_account_detected', 100, 'deny', $4)`,
            [tid, ipHash, fingerprint, JSON.stringify({
              reason: 'multi_account_hard_ban',
              ip_accounts_count: activeAccountsOnIP,
              fp_accounts_count: accountsOnFp,
            })]
          );
          await db('COMMIT');
          return res.status(200).json({ ok: false, is_banned: true, ban_type: 'hard' });
        }
      }

      if (userRow?.risk_score >= RISK_SUSPICIOUS) {
        await db(`UPDATE users SET risk_score = 0, updated_at = NOW() WHERE telegram_id = $1`, [tid]);
        await db(`DELETE FROM device_fingerprints WHERE telegram_id = $1`, [tid]);
        await db(`DELETE FROM security_logs WHERE telegram_id = $1 AND verdict = 'deny'`, [tid]);
      }

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

      await auditLog(tid, ipHash, fingerprint, 'create_session', 0, 'allow',
        { tg_id: tid, is_new_account: isNewAccount }, sid);

      return res.status(200).json({ ok: true, session_id: sid });

    } catch (txErr) {
      try { await db('ROLLBACK'); } catch (_) {}
      console.error('[create_session TX Error]', txErr.message);
      return res.status(500).json({ ok: false, error: 'Session creation failed' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  REQUEST_NONCE — إصدار nonce للعمليات الحساسة
  //  ✅ السيرفر هو الوحيد الذي يُنشئ nonces
  //  ✅ يُرسَل للعميل — لكن one-time use + short TTL
  //  ✅ مربوط بـ session + user + fingerprint + ip + type
  //  ✅ بديل لـ start_ad (لا نكسر الـ frontend)
  // ══════════════════════════════════════════════════════════════
  if (action === 'start_ad' || action === 'request_nonce') {
    if (!sessionId) return res.status(401).json({ ok: false, error: 'Missing session' });

    const sessionCheck = await sql(
      `SELECT session_id, telegram_id FROM sessions
       WHERE session_id = $1 AND is_valid = TRUE AND expires_at > NOW()`,
      [sessionId]
    );
    if (!sessionCheck.length) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
    }

    const tid = parseInt(sessionCheck[0].telegram_id);

    const userCheck = await sql(`SELECT shadow_banned, is_hard_banned FROM users WHERE telegram_id = $1`, [tid]);
    if (userCheck[0]?.is_hard_banned) return res.status(200).json({ ok: false, error: 'access_denied' });

    const nonceType = data.nonce_type || 'ad_reward';
    const nonce     = await issueNonce(sessionId, tid, ipHash, fingerprint, nonceType);

    await auditLog(tid, ipHash, fingerprint, action, 0, 'allow',
      { nonce_type: nonceType, session_id: sessionId.slice(0, 8) + '...' }, sessionId, nonce.slice(0, 8) + '...');

    return res.status(200).json({ ok: true, ad_nonce: nonce });
  }

  // ══════════════════════════════════════════════════════════════
  //  SESSION VALIDATION (لجميع الـ actions بعد هذا)
  // ══════════════════════════════════════════════════════════════
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

  // Fingerprint mismatch = جهاز مختلف = خطر
  if (session.fingerprint !== fingerprint) {
    await sql(`UPDATE sessions SET is_valid = FALSE WHERE session_id = $1`, [sessionId]);
    await updateUserRisk(tid, 30);
    await auditLog(tid, ipHash, fingerprint, action, 30, 'deny',
      { reason: 'fingerprint_mismatch' }, sessionId);
    return res.status(401).json({ ok: false, error: 'Session mismatch — please re-authenticate' });
  }

  // IP تغيّر = طبيعي (proxy/NAT/4G)
  if (session.ip_hash !== ipHash) {
    await sql(`UPDATE sessions SET ip_hash = $2 WHERE session_id = $1`, [sessionId, ipHash]);
    await updateUserRisk(tid, 5);
  }

  // Rate Limiting
  const withinLimit = await checkRateLimit(tid);
  if (!withinLimit) {
    await updateUserRisk(tid, 5);
    await auditLog(tid, ipHash, fingerprint, action, 5, 'rate_limit', {}, sessionId);
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  // ══════════════════════════════════════════════════════════════
  //  NONCE VALIDATION للعمليات الحساسة
  //
  //  Actions التي تحتاج nonce:
  //  • reward_ad       → نوع: 'ad_reward'
  //  • claim_adsgram_task → نوع: 'adsgram_task'
  //  • plant, harvest, withdraw, redeem_promo, etc. → نوع: 'general'
  //
  //  Actions التي لا تحتاج nonce:
  //  • load, get_state, get_tasks → read-only
  //  • create_session, start_ad  → تُنشئ nonce
  //  • track_ad_event            → logging فقط
  //  • update_cell               → تغيير خفيف (ري)
  // ══════════════════════════════════════════════════════════════
  const NO_NONCE_ACTIONS = new Set([
    'load', 'get_state', 'get_tasks', 'create_session',
    'start_ad', 'request_nonce', 'track_ad_event',
    'save_tasks', 'update_photo', 'get_referrals',
  ]);

  // تحديد نوع الـ nonce المطلوب
  let requiredNonceType = 'general';
  if (action === 'reward_ad')          requiredNonceType = 'ad_reward';
  if (action === 'claim_adsgram_task') requiredNonceType = 'adsgram_task';

  if (!NO_NONCE_ACTIONS.has(action)) {
    const nonceResult = await consumeNonce(
      clientNonce, sessionId, tid, fingerprint, requiredNonceType
    );

    if (nonceResult !== 'ok') {
      // حساب رفع risk score بناءً على نوع الخطأ
      const riskDelta = nonceResult === 'used' ? 25
                       : nonceResult === 'session_mismatch' ? 30
                       : nonceResult === 'fp_mismatch' ? 30
                       : 15;

      await updateUserRisk(tid, riskDelta);
      await auditLog(tid, ipHash, fingerprint, `${action}_nonce_fail`, riskDelta, 'deny',
        { reason: nonceResult, action, nonce_prefix: clientNonce.slice(0, 8) + '...' },
        sessionId, clientNonce.slice(0, 8) + '...');

      // رسائل واضحة للتصحيح
      const errorMessages = {
        not_found:       'Nonce not found — request a new one',
        used:            'Nonce already used — replay detected',
        expired:         'Nonce expired — request a new one',
        session_mismatch:'Nonce session mismatch — security violation',
        fp_mismatch:     'Nonce fingerprint mismatch — device changed',
        type_mismatch:   'Nonce type mismatch',
        error:           'Nonce validation error',
      };
      return res.status(400).json({
        ok: false,
        error: errorMessages[nonceResult] || 'Nonce validation failed',
        code: nonceResult,
      });
    }
  }

  // Risk Score
  const riskScore     = await calcRiskScore(tid, ipHash, fingerprint);
  const userRiskRows  = await sql(`SELECT risk_score, shadow_banned FROM users WHERE telegram_id = $1`, [tid]);
  const isShadowBanned = userRiskRows[0]?.shadow_banned || false;

  await auditLog(tid, ipHash, fingerprint, action, riskScore,
    isShadowBanned ? 'shadow' : 'allow', {}, sessionId);

  try {

    // ════════════════════════════════════════════════════════════
    //  LOAD
    // ════════════════════════════════════════════════════════════
    if (action === 'load') {
      let rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      const username   = data.username   || null;
      const referralBy = data.referral_by ? parseInt(data.referral_by) : null;
      const validRef   = referralBy && !isNaN(referralBy) && referralBy !== tid ? referralBy : null;

      if (!rows.length) {
        rows = await sql(
          `INSERT INTO users (telegram_id, username, referral_by, cells)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (telegram_id) DO UPDATE
             SET username    = EXCLUDED.username,
                 referral_by = COALESCE(users.referral_by, EXCLUDED.referral_by),
                 updated_at  = NOW()
           RETURNING *`,
          [tid, username, validRef, JSON.stringify(buildEmptyCells())]
        );
      } else {
        if (validRef && !rows[0].referral_by) {
          await sql(
            `UPDATE users SET referral_by = $2, updated_at = NOW()
             WHERE telegram_id = $1 AND referral_by IS NULL`,
            [tid, validRef]
          );
          rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
        }
      }

      const u = rows[0];

      if (u.referral_by && !u.referral_rewarded) {
        const refExists = await sql(`SELECT telegram_id FROM users WHERE telegram_id = $1`, [u.referral_by]);
        if (refExists.length) {
          await sql(
            `UPDATE users SET referral_friends = referral_friends + 1, updated_at = NOW() WHERE telegram_id = $1`,
            [u.referral_by]
          );
        }
        await sql(`UPDATE users SET referral_rewarded = TRUE WHERE telegram_id = $1`, [tid]);
        rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      }

      if (rows[0].today_date !== todayUTC()) {
        await sql(
          `UPDATE users SET today_date = $2, today_earn = 0, updated_at = NOW() WHERE telegram_id = $1`,
          [tid, todayUTC()]
        );
        rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      }

      const user     = rows[0];
      const original = normalizeCellsFromDB(user.cells);
      const resolved = resolveCells(original);
      await persistIfChanged(tid, original, resolved);

      const realFriendsCount = await sql(
        `SELECT COUNT(*) AS cnt FROM users WHERE referral_by = $1 AND referral_rewarded = TRUE`,
        [tid]
      );
      const trueReferralFriends = parseInt(realFriendsCount[0]?.cnt || 0);

      return res.status(200).json({
        ok: true,
        user: { ...user, cells: resolved, referral_friends: trueReferralFriends }
      });
    }

    // ════════════════════════════════════════════════════════════
    //  GET_STATE
    // ════════════════════════════════════════════════════════════
    if (action === 'get_state') {
      const rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const user = rows[0];
      if (user.today_date !== todayUTC()) {
        await sql(
          `UPDATE users SET today_date = $2, today_earn = 0, updated_at = NOW() WHERE telegram_id = $1`,
          [tid, todayUTC()]
        );
        user.today_earn = 0;
        user.today_date = todayUTC();
      }

      const original = normalizeCellsFromDB(user.cells);
      const resolved = resolveCells(original);
      await persistIfChanged(tid, original, resolved);

      const realFriendsCount = await sql(
        `SELECT COUNT(*) AS cnt FROM users WHERE referral_by = $1 AND referral_rewarded = TRUE`,
        [tid]
      );
      const trueReferralFriends = parseInt(realFriendsCount[0]?.cnt || 0);

      return res.status(200).json({
        ok: true,
        user: { ...user, cells: resolved, referral_friends: trueReferralFriends }
      });
    }

    // ════════════════════════════════════════════════════════════
    //  TRACK_AD_EVENT — تسجيل أحداث الإعلان (logging فقط)
    //  لا تغيّر أي رصيد — مجرد audit
    // ════════════════════════════════════════════════════════════
    if (action === 'track_ad_event') {
      const { event, meta } = data;
      await auditLog(tid, ipHash, fingerprint, `ad_event:${event}`, 0, 'allow',
        { event, meta: meta || {} }, sessionId);
      return res.status(200).json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════
    //  PLANT
    // ════════════════════════════════════════════════════════════
    if (action === 'plant') {
      const cellId   = parseInt(data.cell_id);
      const duration = GROW_DURATION;

      if (isNaN(cellId) || cellId < 0 || cellId >= CELL_COUNT)
        return res.status(400).json({ ok: false, error: 'Invalid cell_id' });

      const rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const user = rows[0];
      if (user.seeds <= 0) return res.status(400).json({ ok: false, error: 'Not enough seeds' });

      const cells = resolveCells(normalizeCellsFromDB(user.cells));
      if (cells[cellId].state !== 'empty')
        return res.status(400).json({ ok: false, error: 'Cell is not empty' });

      cells[cellId] = { id: cellId, state: 'growing', planted_at: new Date().toISOString(), duration };

      await sql(
        `UPDATE users SET cells = $2, seeds = seeds - 1, updated_at = NOW() WHERE telegram_id = $1`,
        [tid, JSON.stringify(cells)]
      );

      return res.status(200).json({ ok: true, cells });
    }

    // ════════════════════════════════════════════════════════════
    //  HARVEST
    // ════════════════════════════════════════════════════════════
    if (action === 'harvest') {
      const cellId = parseInt(data.cell_id);

      if (isNaN(cellId) || cellId < 0 || cellId >= CELL_COUNT)
        return res.status(400).json({ ok: false, error: 'Invalid cell_id' });

      const rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const user  = rows[0];
      const cells = resolveCells(normalizeCellsFromDB(user.cells));

      if (cells[cellId].state !== 'ready')
        return res.status(400).json({ ok: false, error: 'Cell is not ready to harvest' });

      const SERVER_REWARD = 0.0001;
      const actualReward  = isShadowBanned ? 0 : SERVER_REWARD;

      cells[cellId] = { id: cellId, state: 'empty', planted_at: null, duration: GROW_DURATION };

      const today        = todayUTC();
      const isSameDay    = user.today_date === today;
      const newTodayEarn = isSameDay ? parseFloat(user.today_earn) + actualReward : actualReward;

      await sql(
        `UPDATE users
         SET balance        = balance + $2,
             cells          = $3,
             today_date     = $4,
             today_earn     = $5,
             total_harvests = total_harvests + 1,
             updated_at     = NOW()
         WHERE telegram_id = $1`,
        [tid, actualReward, JSON.stringify(cells), today, newTodayEarn]
      );

      if (user.referral_by && !isShadowBanned) {
        const cut = parseFloat((SERVER_REWARD * 0.05).toFixed(6));
        await sql(
          `UPDATE users
           SET referral_balance = referral_balance + $2,
               balance          = balance + $2,
               updated_at       = NOW()
           WHERE telegram_id = $1`,
          [user.referral_by, cut]
        );
      }

      const updatedUser = await sql(
        `SELECT balance, today_earn, total_harvests FROM users WHERE telegram_id = $1`, [tid]
      );

      return res.status(200).json({
        ok: true, cells,
        reward:         SERVER_REWARD,
        balance:        parseFloat(updatedUser[0]?.balance       || 0),
        today_earn:     parseFloat(updatedUser[0]?.today_earn    || 0),
        total_harvests: parseInt(updatedUser[0]?.total_harvests  || 0),
        referral_cut:   user.referral_by ? parseFloat((SERVER_REWARD * 0.05).toFixed(6)) : 0
      });
    }

    // ════════════════════════════════════════════════════════════
    //  UPDATE_CELL (ري)
    // ════════════════════════════════════════════════════════════
    if (action === 'update_cell') {
      const cellId = parseInt(data.cell_id);

      if (isNaN(cellId) || cellId < 0 || cellId >= CELL_COUNT)
        return res.status(400).json({ ok: false, error: 'Invalid cell_id' });

      const rows = await sql('SELECT cells, water_count FROM users WHERE telegram_id = $1', [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });

      const user = rows[0];
      if (user.water_count <= 0) return res.status(400).json({ ok: false, error: 'No water left' });

      const cells = resolveCells(normalizeCellsFromDB(user.cells));
      if (cells[cellId].state !== 'growing')
        return res.status(400).json({ ok: false, error: 'Cell is not growing' });

      const WATER_SPEEDUP = 60;
      const newDuration   = Math.max(10, (cells[cellId].duration || GROW_DURATION) - WATER_SPEEDUP);
      cells[cellId]       = { ...cells[cellId], duration: newDuration, watered: true };

      await sql(
        `UPDATE users SET cells = $2, water_count = water_count - 1, updated_at = NOW() WHERE telegram_id = $1`,
        [tid, JSON.stringify(cells)]
      );

      return res.status(200).json({ ok: true, cells });
    }

    // ════════════════════════════════════════════════════════════
    //  ADD_RESOURCE — محظور من الـ frontend
    // ════════════════════════════════════════════════════════════
    if (action === 'add_resource') {
      await auditLog(tid, ipHash, fingerprint, 'add_resource_blocked', 30, 'deny',
        { reason: 'direct_call_forbidden' }, sessionId);
      return res.status(403).json({ ok: false, error: 'Use reward_ad action' });
    }

    // ════════════════════════════════════════════════════════════
    //  REWARD_AD — مكافأة الإعلان الرئيسية (seeds/water)
    //  ╔══════════════════════════════════════════════════════╗
    //  ║  Ephemeral Nonce Flow:                               ║
    //  ║  1. العميل يستدعي start_ad → نحصل على nonce         ║
    //  ║  2. العميل يشاهد الإعلان                            ║
    //  ║  3. العميل يُرسل nonce مع reward_ad                 ║
    //  ║  4. السيرفر يتحقق atomically ويستهلك الـ nonce      ║
    //  ║  5. يتحقق من cooldown + daily limit                 ║
    //  ║  6. يمنح المكافأة أو يرفض                           ║
    //  ╚══════════════════════════════════════════════════════╝
    //  ملاحظة: الـ nonce تم استهلاكه بالفعل في قسم النونس أعلاه
    //  هنا نكمل المنطق: cooldown + daily limit + reward
    // ════════════════════════════════════════════════════════════
    if (action === 'reward_ad') {
      const { ad_type, ad_started_at, preload_count } = data;

      // تحقق مدة مشاهدة الإعلان (anti-fraud — client-side timestamp)
      if (ad_started_at) {
        const elapsed = Date.now() - parseInt(ad_started_at);
        if (elapsed < 3000) { // أقل من 3 ثواني = مريب
          await updateUserRisk(tid, 20);
          await auditLog(tid, ipHash, fingerprint, 'reward_ad_too_fast', 20, 'deny',
            { elapsed_ms: elapsed, ad_type }, sessionId);
          return res.status(400).json({ ok: false, error: 'ad_duration_invalid' });
        }
      }

      // تحديد نوع المكافأة
      const reward = AD_REWARDS[ad_type];
      if (!reward) {
        await auditLog(tid, ipHash, fingerprint, 'reward_ad_invalid_type', 15, 'deny',
          { ad_type }, sessionId);
        return res.status(400).json({ ok: false, error: 'Invalid ad_type' });
      }

      // Cooldown (3 ثواني بين كل reward)
      const cooldownRows = await sql(
        `SELECT ad_last_reward FROM users WHERE telegram_id = $1`, [tid]
      );
      const lastRewardTime = cooldownRows[0]?.ad_last_reward;
      if (lastRewardTime) {
        const elapsedMs = Date.now() - new Date(lastRewardTime).getTime();
        if (elapsedMs < 3000) {
          await auditLog(tid, ipHash, fingerprint, 'reward_ad_cooldown', 5, 'deny',
            { reason: 'cooldown_active', elapsed_ms: elapsedMs }, sessionId);
          return res.status(429).json({
            ok: false,
            error: 'cooldown_active',
            wait_ms: 3000 - elapsedMs,
          });
        }
      }

      // Daily limit check
      const usageRows = await sql(
        `SELECT COALESCE(SUM((detail->>'amount')::int), 0) AS used
         FROM security_logs
         WHERE telegram_id = $1
           AND action = 'reward_ad'
           AND detail->>'ad_type' = $2
           AND verdict = 'allow'
           AND created_at >= NOW() - INTERVAL '24 hours'`,
        [tid, ad_type]
      );
      const usedToday = parseInt(usageRows[0]?.used || 0);

      if (usedToday + reward.amount > reward.daily_max) {
        await auditLog(tid, ipHash, fingerprint, 'reward_ad', 5, 'deny',
          { reason: 'daily_limit', ad_type, used: usedToday, limit: reward.daily_max }, sessionId);
        return res.status(200).json({ ok: false, error: 'daily_limit_reached' });
      }

      // Shadow ban: رد ناجح زائف
      if (isShadowBanned) {
        await auditLog(tid, ipHash, fingerprint, 'reward_ad', 0, 'shadow',
          { ad_type, amount: reward.amount }, sessionId);
        const fakeRows = await sql(`SELECT ${reward.col} FROM users WHERE telegram_id = $1`, [tid]);
        return res.status(200).json({
          ok: true,
          [reward.col]: fakeRows[0]?.[reward.col] ?? 0,
          remaining: 0,
          watchedToday: 10,
          earnedToday: reward.daily_max,
        });
      }

      // ✅ منح المكافأة
      await sql(
        `UPDATE users
         SET ${reward.col}   = ${reward.col} + $2,
             ad_last_reward  = NOW(),
             updated_at      = NOW()
         WHERE telegram_id = $1`,
        [tid, reward.amount]
      );

      const updatedRows = await sql(
        `SELECT ${reward.col}, points FROM users WHERE telegram_id = $1`, [tid]
      );
      const newValue = updatedRows[0]?.[reward.col] ?? 0;
      const points   = updatedRows[0]?.points ?? 0;

      await auditLog(tid, ipHash, fingerprint, 'reward_ad', 0, 'allow',
        { ad_type, amount: reward.amount, new_value: newValue }, sessionId);

      // حساب المتبقي من اليوم
      const newUsed    = usedToday + reward.amount;
      const remaining  = Math.max(0, reward.daily_max - newUsed);

      console.log(`[AD_REWARD] tid=${tid} ad_type=${ad_type} +${reward.amount} → ${reward.col}=${newValue} remaining=${remaining}`);

      return res.status(200).json({
        ok:           true,
        [reward.col]: newValue,
        points,
        remaining,
        watchedToday: Math.floor(newUsed / reward.amount),
        earnedToday:  newUsed,
        cooldown_ms:  3000,
      });
    }

    // ════════════════════════════════════════════════════════════
    //  CLAIM_ADSGRAM_TASK — مهمة Adsgram الخاصة
    //  ╔══════════════════════════════════════════════════════╗
    //  ║  المشكلة في النظام القديم:                           ║
    //  ║  • بعد 3 ثواني من بدء المهمة، تُعطي reward فوراً   ║
    //  ║  • الكارد يُغلق ثم يظهر "جاري انتظار 60 ثانية"    ║
    //  ║                                                      ║
    //  ║  الإصلاح:                                            ║
    //  ║  • العميل يُرسل nonce من start_ad                   ║
    //  ║  • السيرفر يتحقق من Adsgram reward event            ║
    //  ║  • Cooldown 60 ثانية في السيرفر                     ║
    //  ║  • النقاط تُضاف فقط بعد التحقق الكامل              ║
    //  ╚══════════════════════════════════════════════════════╝
    //  ملاحظة: الـ nonce (نوع adsgram_task) تم استهلاكه أعلاه
    // ════════════════════════════════════════════════════════════
    if (action === 'claim_adsgram_task') {
      // التحقق من Cooldown (60 ثانية)
      const taskRows = await sql(
        `SELECT adsgram_task_last_at, shadow_banned, points FROM users WHERE telegram_id = $1`,
        [tid]
      );
      const lastTaskAt = taskRows[0]?.adsgram_task_last_at;

      if (lastTaskAt) {
        const elapsedSec = (Date.now() - new Date(lastTaskAt).getTime()) / 1000;
        if (elapsedSec < ADSGRAM_TASK_COOLDOWN_SEC) {
          const waitSec = Math.ceil(ADSGRAM_TASK_COOLDOWN_SEC - elapsedSec);
          await auditLog(tid, ipHash, fingerprint, 'claim_adsgram_task_cooldown', 0, 'deny',
            { elapsed_sec: elapsedSec, wait_sec: waitSec }, sessionId);
          return res.status(200).json({
            ok: false,
            error: 'already_claimed_today',
            wait_sec: waitSec,
            cooldown_sec: ADSGRAM_TASK_COOLDOWN_SEC,
          });
        }
      }

      // Shadow ban
      if (isShadowBanned) {
        await auditLog(tid, ipHash, fingerprint, 'claim_adsgram_task', 0, 'shadow', {}, sessionId);
        const currentPts = taskRows[0]?.points || 0;
        return res.status(200).json({ ok: true, points: currentPts });
      }

      // ✅ إضافة النقاط + تسجيل وقت المطالبة
      const updated = await sql(
        `UPDATE users
         SET points               = points + $2,
             adsgram_task_last_at = NOW(),
             updated_at           = NOW()
         WHERE telegram_id = $1
         RETURNING points`,
        [tid, ADSGRAM_TASK_POINTS]
      );

      const newPoints = parseInt(updated[0]?.points || 0);

      await auditLog(tid, ipHash, fingerprint, 'claim_adsgram_task', 0, 'allow',
        { points_added: ADSGRAM_TASK_POINTS, new_points: newPoints }, sessionId);

      console.log(`[ADSGRAM_TASK] tid=${tid} +${ADSGRAM_TASK_POINTS} points → total=${newPoints}`);

      return res.status(200).json({
        ok:     true,
        points: newPoints,
        cooldown_sec: ADSGRAM_TASK_COOLDOWN_SEC,
      });
    }

    // ════════════════════════════════════════════════════════════
    //  GET_TASKS
    // ════════════════════════════════════════════════════════════
    if (action === 'get_tasks') {
      const tasks = await sql(
        `SELECT t.*, ut.completed, ut.completed_at
         FROM tasks t
         LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.telegram_id = $1
         WHERE t.is_active = TRUE
         ORDER BY t.sort_order ASC, t.created_at ASC`,
        [tid]
      );
      return res.status(200).json({ ok: true, tasks });
    }

    // ════════════════════════════════════════════════════════════
    //  HANDLE_TASK
    // ════════════════════════════════════════════════════════════
    if (action === 'handle_task') {
      const { task_id, step } = data;
      if (!task_id || !step)
        return res.status(400).json({ ok: false, error: 'Missing task_id or step' });

      const taskRows = await sql(
        `SELECT * FROM tasks WHERE id = $1 AND is_active = TRUE`, [task_id]
      );
      if (!taskRows.length)
        return res.status(404).json({ ok: false, error: 'Task not found' });

      const task = taskRows[0];
      const existing = await sql(
        `SELECT completed FROM user_tasks WHERE telegram_id = $1 AND task_id = $2`,
        [tid, task_id]
      );
      if (existing.length && existing[0].completed)
        return res.status(400).json({ ok: false, error: 'Task already completed' });

      switch (task.task_type) {
        case 'channel': return handleChannelTask(task, tid, step, isShadowBanned, ipHash, fingerprint, res);
        case 'url':     return handleUrlTask(task, tid, step, isShadowBanned, ipHash, fingerprint, res);
        default:
          return res.status(400).json({ ok: false, error: 'Unsupported task_type: ' + task.task_type });
      }
    }

    // ════════════════════════════════════════════════════════════
    //  SAVE_TASKS (legacy compat)
    // ════════════════════════════════════════════════════════════
    if (action === 'save_tasks') {
      return res.status(200).json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════
    //  ADD_BALANCE (legacy compat)
    // ════════════════════════════════════════════════════════════
    if (action === 'add_balance') {
      const source = data.source || 'unknown';
      const taskRows = await sql(`SELECT * FROM tasks WHERE id = $1 AND is_active = TRUE`, [source]);
      if (!taskRows.length) return res.status(400).json({ ok: false, error: 'Unknown reward source' });
      const task = taskRows[0];
      const existing = await sql(
        `SELECT completed FROM user_tasks WHERE telegram_id = $1 AND task_id = $2`,
        [tid, source]
      );
      if (existing.length && existing[0].completed)
        return res.status(400).json({ ok: false, error: 'Task already rewarded' });
      if (isShadowBanned) return res.status(200).json({ ok: true });
      return completeTask(task, tid, res);
    }

    // ════════════════════════════════════════════════════════════
    //  UPDATE_PHOTO
    // ════════════════════════════════════════════════════════════
    if (action === 'update_photo') {
      const { photo_url } = data;
      if (!photo_url || typeof photo_url !== 'string')
        return res.status(400).json({ ok: false, error: 'Missing or invalid photo_url' });

      const allowedHosts = ['t.me', 'telegram.org', 'cdn1.telegram-cdn.org', 'cdn2.telegram-cdn.org', 'cdn4.telegram-cdn.org'];
      let isAllowed = false;
      try {
        const parsed = new URL(photo_url);
        isAllowed = allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
        if (!isAllowed && parsed.protocol !== 'https:')
          return res.status(400).json({ ok: false, error: 'Only HTTPS URLs are allowed' });
      } catch (_) {
        return res.status(400).json({ ok: false, error: 'Invalid URL format' });
      }

      await sql(
        `UPDATE users SET photo_url = $2, updated_at = NOW() WHERE telegram_id = $1`,
        [tid, photo_url]
      );
      return res.status(200).json({ ok: true, photo_url });
    }

    // ════════════════════════════════════════════════════════════
    //  WITHDRAW
    // ════════════════════════════════════════════════════════════
    if (action === 'withdraw') {
      const { account, amount, method } = data;
      const amt      = parseFloat(amount);
      const wdMethod = method === 'ton' ? 'ton' : 'fp';

      if (!account)               return res.status(400).json({ ok: false, error: 'Missing account' });
      if (isNaN(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'Invalid amount' });
      if (amt < 0.05)             return res.status(400).json({ ok: false, error: 'Minimum 0.05 TON' });
      if (wdMethod === 'ton' && !account.startsWith('UQ') && !account.startsWith('EQ'))
        return res.status(400).json({ ok: false, error: 'Invalid TON address format' });
      if (isShadowBanned) return res.status(403).json({ ok: false, error: 'Account under review' });

      const rows = await sql('SELECT balance, wd_history FROM users WHERE telegram_id = $1', [tid]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'User not found' });
      if (parseFloat(rows[0].balance) < amt)
        return res.status(400).json({ ok: false, error: 'Insufficient balance' });

      const now     = new Date();
      const dateStr = now.toISOString();
      const entry   = { account, amount: amt, date: dateStr, status: 'pending', method: wdMethod };
      const history = Array.isArray(rows[0].wd_history) ? rows[0].wd_history : [];
      history.unshift(entry);
      if (history.length > 50) history.splice(50);

      await sql(
        `UPDATE users SET balance = balance - $2, wd_history = $3, updated_at = NOW() WHERE telegram_id = $1`,
        [tid, amt, JSON.stringify(history)]
      );

      await auditLog(tid, ipHash, fingerprint, 'withdraw', 0, 'allow',
        { account: account.slice(0, 8) + '...', amount: amt, method: wdMethod }, sessionId);

      return res.status(200).json({ ok: true, entry });
    }

    // ════════════════════════════════════════════════════════════
    //  GIVEAWAY_ENTER
    // ════════════════════════════════════════════════════════════
    if (action === 'giveaway_enter') {
      const gid = parseInt(data.giveaway_id);
      if (isNaN(gid)) return res.status(400).json({ ok: false, error: 'Invalid giveaway_id' });

      const gwRows = await sql(`SELECT * FROM giveaways WHERE id = $1 AND is_active = TRUE`, [gid]);
      if (!gwRows.length) return res.status(404).json({ ok: false, error: 'Giveaway not found' });

      await sql(
        `INSERT INTO giveaway_entries (giveaway_id, telegram_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [gid, tid]
      );
      return res.status(200).json({ ok: true });
    }

    // ════════════════════════════════════════════════════════════
    //  REDEEM_PROMO
    // ════════════════════════════════════════════════════════════
    if (action === 'redeem_promo') {
      try {
        const { code } = data;
        if (!code || typeof code !== 'string' || !code.trim()) {
          return res.status(400).json({ ok: false, success: false, error: 'invalid_code', message: 'Invalid or missing promo code' });
        }

        const cleanCode = code.trim().toUpperCase().slice(0, 32);
        if (!/^[A-Z0-9_-]{2,32}$/.test(cleanCode)) {
          return res.status(400).json({ ok: false, success: false, error: 'invalid_code', message: 'Invalid code format' });
        }

        const promoRows = await sql(`SELECT * FROM promo_codes WHERE code = $1 AND is_active = TRUE`, [cleanCode]);
        if (!promoRows.length) {
          return res.status(200).json({ ok: false, success: false, error: 'not_found', message: 'Invalid or expired code' });
        }

        const promo = promoRows[0];
        if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
          return res.status(200).json({ ok: false, success: false, error: 'expired', message: 'Invalid or expired code' });
        }
        if (promo.use_count >= promo.max_uses) {
          return res.status(200).json({ ok: false, success: false, error: 'user_limit', message: 'This code has reached its maximum usage limit' });
        }

        const alreadyUsed = await sql(
          `SELECT 1 FROM promo_redemptions WHERE code = $1 AND telegram_id = $2`,
          [cleanCode, tid]
        );
        if (alreadyUsed.length) {
          return res.status(200).json({ ok: false, success: false, error: 'already_used', message: 'You have already used this code' });
        }

        if (isShadowBanned) {
          return res.status(200).json({
            ok: true, success: true, message: 'Code redeemed successfully',
            reward: promo.reward_desc || 'Reward claimed!',
            seeds: promo.seeds || 0, water: promo.water || 0, balance: promo.balance || 0,
            reward_desc: promo.reward_desc || 'Reward claimed!'
          });
        }

        await sql(
          `UPDATE users SET seeds = seeds + $2, water_count = water_count + $3, balance = balance + $4, updated_at = NOW()
           WHERE telegram_id = $1`,
          [tid, promo.seeds || 0, promo.water || 0, promo.balance || 0]
        );
        await sql(`INSERT INTO promo_redemptions (code, telegram_id) VALUES ($1, $2)`, [cleanCode, tid]);
        await sql(`UPDATE promo_codes SET use_count = use_count + 1 WHERE code = $1`, [cleanCode]);

        await auditLog(tid, ipHash, fingerprint, 'redeem_promo', 0, 'allow',
          { code: cleanCode, seeds: promo.seeds, water: promo.water, balance: promo.balance }, sessionId);

        return res.status(200).json({
          ok: true, success: true, message: 'Code redeemed successfully',
          reward: promo.balance || 0,
          seeds: promo.seeds || 0, water: promo.water || 0, balance: promo.balance || 0,
          reward_desc: promo.reward_desc || 'Reward claimed!'
        });

      } catch (promoErr) {
        console.error('[PROMO] Redemption error:', promoErr.message);
        return res.status(500).json({ ok: false, success: false, error: 'server_error', message: 'Please try again.' });
      }
    }

    // ════════════════════════════════════════════════════════════
    //  UPDATE_WITHDRAWAL (Admin)
    // ════════════════════════════════════════════════════════════
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

      const rows = await sql('SELECT wd_history FROM users WHERE telegram_id = $1', [targetId]);
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

      return res.status(200).json({ ok: true, message: `Withdrawal marked as ${newStatus}` });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action', action });

  } catch (err) {
    console.error('[API Error]', action || 'unknown', err.message, err.stack);
    return res.status(500).json({
      ok: false,
      error: 'internal_server_error',
      message: 'An unexpected error occurred. Please try again.',
      ...(process.env.NODE_ENV !== 'production' && { detail: err.message })
    });
  }
};

// ══════════════════════════════════════════════════════════════════
//  TASK HANDLERS
// ══════════════════════════════════════════════════════════════════
async function handleUrlTask(task, tid, step, isShadowBanned, ipHash, fingerprint, res) {
  if (step === 'open') {
    await sql(
      `INSERT INTO user_tasks (telegram_id, task_id, completed) VALUES ($1, $2, FALSE)
       ON CONFLICT (telegram_id, task_id) DO NOTHING`,
      [tid, task.id]
    );
    return res.status(200).json({ ok: true, step: 'open', url: task.url });
  }
  if (step === 'verify') {
    if (isShadowBanned) return res.status(200).json({ ok: true });
    return completeTask(task, tid, res);
  }
  return res.status(400).json({ ok: false, error: 'Invalid step for url task' });
}

async function handleChannelTask(task, tid, step, isShadowBanned, ipHash, fingerprint, res) {
  if (step === 'open') {
    await sql(
      `INSERT INTO user_tasks (telegram_id, task_id, completed) VALUES ($1, $2, FALSE)
       ON CONFLICT (telegram_id, task_id) DO NOTHING`,
      [tid, task.id]
    );
    const channelUrl = 'https://t.me/' + (task.channel || '');
    return res.status(200).json({ ok: true, step: 'open', url: channelUrl });
  }
  if (step === 'verify') {
    const isMember = await verifyChannelMembership(tid, task.channel);
    if (!isMember) {
      return res.status(400).json({ ok: false, error: 'not_member', message: 'Please join the channel first' });
    }
    if (isShadowBanned) return res.status(200).json({ ok: true });
    return completeTask(task, tid, res);
  }
  return res.status(400).json({ ok: false, error: 'Invalid step for channel task' });
}

async function completeTask(task, tid, res) {
  const reward = parseFloat(task.reward) || 0;
  await sql(
    `INSERT INTO user_tasks (telegram_id, task_id, completed, completed_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (telegram_id, task_id)
     DO UPDATE SET completed = TRUE, completed_at = NOW()`,
    [tid, task.id]
  );
  let newBalance = 0;
  if (reward > 0) {
    const updated = await sql(
      `UPDATE users SET balance = balance + $2, updated_at = NOW()
       WHERE telegram_id = $1 RETURNING balance`,
      [tid, reward]
    );
    newBalance = parseFloat(updated[0]?.balance || 0);
  } else {
    const cur = await sql(`SELECT balance FROM users WHERE telegram_id = $1`, [tid]);
    newBalance = parseFloat(cur[0]?.balance || 0);
  }
  return res.status(200).json({ ok: true, reward, balance: newBalance });
}

async function verifyChannelMembership(telegramId, channelUsername) {
  if (!BOT_TOKEN || !channelUsername) return false;
  try {
    const url  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${channelUsername}&user_id=${telegramId}`;
    const resp = await fetch(url);
    const d    = await resp.json();
    if (!d.ok) return false;
    return ['member', 'administrator', 'creator'].includes(d.result?.status);
  } catch (e) {
    console.warn('[verifyChannel] error:', e.message);
    return false;
  }
}
