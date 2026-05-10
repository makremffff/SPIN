'use strict';

const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

/* ══════════════════════════════════════════════════════════
   HOURLY CLEANUP — runs once per process lifetime
══════════════════════════════════════════════════════════ */
let _cleanupStarted = false;
function startCleanup(sql) {
  if (_cleanupStarted) return;
  _cleanupStarted = true;
  setInterval(async () => {
    try {
      await sql`DELETE FROM nonces WHERE expires_at < NOW()`;
      await sql`DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '10 seconds'`;
      await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
      console.log('[Cleanup] Expired nonces, rate limits, and sessions removed');
    } catch (e) {
      console.error('[Cleanup] Error:', e.message);
    }
  }, 3600 * 1000);
}

/* ══════════════════════════════════════════════════════════
   BOOTSTRAP — idempotent schema creation
══════════════════════════════════════════════════════════ */
let _bootstrapped = false;
async function bootstrap(sql) {
  if (_bootstrapped) return;
  _bootstrapped = true;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id       BIGINT PRIMARY KEY,
      username          TEXT,
      first_name        TEXT,
      last_name         TEXT,
      points            BIGINT NOT NULL DEFAULT 0,
      level             INT NOT NULL DEFAULT 1,
      streak_day        INT NOT NULL DEFAULT 0,
      last_gift_date    DATE,
      tg_verified       BOOLEAN NOT NULL DEFAULT FALSE,
      ads_watched_today INT NOT NULL DEFAULT 0,
      ads_reset_date    DATE,
      risk_score        INT NOT NULL DEFAULT 0,
      is_shadow_banned  BOOLEAN NOT NULL DEFAULT FALSE,
      is_hard_banned    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT PRIMARY KEY,
      telegram_id       BIGINT NOT NULL,
      ip_hash           TEXT NOT NULL,
      fingerprint_hash  TEXT NOT NULL,
      ad_nonce          TEXT,
      ad_nonce_exp      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nonces (
      nonce_id      TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      used          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key           TEXT PRIMARY KEY,
      count         INT NOT NULL DEFAULT 1,
      window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS security_logs (
      id            BIGSERIAL PRIMARY KEY,
      telegram_id   BIGINT,
      ip_hash       TEXT,
      fingerprint   TEXT,
      action        TEXT,
      risk_score    INT,
      verdict       TEXT,
      detail        JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS device_fingerprints (
      fingerprint_hash  TEXT NOT NULL,
      telegram_id       BIGINT NOT NULL,
      first_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fingerprint_hash, telegram_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id            BIGSERIAL PRIMARY KEY,
      telegram_id   BIGINT NOT NULL,
      address       TEXT NOT NULL,
      pts           BIGINT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  /* safe migrations */
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS copy_link_count INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce TEXT`;
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ad_nonce_exp TIMESTAMPTZ`;

  /* indexes */
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_telegram_id ON sessions(telegram_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nonces_session_id ON nonces(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_security_logs_telegram_id ON security_logs(telegram_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id ON withdrawals(telegram_id)`;
}

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function hashIp(ip, salt) {
  return crypto.createHash('sha256').update(ip + salt).digest('hex').slice(0, 40);
}

function buildFingerprint(fpHeader, ipHash) {
  try {
    const fp = typeof fpHeader === 'string' ? JSON.parse(fpHeader) : (fpHeader || {});
    const parts = [
      fp.fp || '',
      fp.user_agent || '',
      fp.lang || '',
      fp.screen || '',
      String(fp.tz_offset || ''),
      fp.tz_name || '',
      String(fp.hw_cores || ''),
      String(fp.hw_mem || ''),
      String(fp.touch_pts || ''),
      fp.canvas_sig || '',
      fp.webgl_sig || '',
      fp.audio_sig || '',
      String(fp.dpr || ''),
      String(fp.color_depth || ''),
      ipHash,
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
  } catch {
    return crypto.createHash('sha256').update(ipHash + (fpHeader || '')).digest('hex').slice(0, 40);
  }
}

function genRandom(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function auditLog(sql, { telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail }) {
  try {
    await sql`
      INSERT INTO security_logs (telegram_id, ip_hash, fingerprint, action, risk_score, verdict, detail)
      VALUES (${telegram_id || null}, ${ip_hash}, ${fingerprint}, ${action}, ${risk_score || 0}, ${verdict}, ${JSON.stringify(detail || {})})
    `;
  } catch (e) {
    console.error('[AuditLog] Failed:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════
   TELEGRAM INIT DATA VERIFICATION
══════════════════════════════════════════════════════════ */
function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    const authDate = parseInt(params.get('auth_date') || '0');
    if (!authDate || Date.now() / 1000 - authDate > 3600) return null;

    params.delete('hash');
    const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'))) return null;

    const userParam = params.get('user');
    if (!userParam) return null;
    return JSON.parse(userParam);
  } catch (e) {
    console.error('[TgAuth] Verify error:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════
   SESSION VERIFICATION
══════════════════════════════════════════════════════════ */
async function verifySession(sql, sessionId, fpHash, ipHash) {
  if (!sessionId) return { ok: false, error: 'no_session' };
  const rows = await sql`
    SELECT s.*, u.is_shadow_banned, u.is_hard_banned, u.risk_score, u.telegram_id AS uid
    FROM sessions s
    JOIN users u ON u.telegram_id = s.telegram_id
    WHERE s.session_id = ${sessionId} AND s.expires_at > NOW()
  `;
  if (!rows.length) return { ok: false, error: 'session_expired' };

  const session = rows[0];

  if (session.is_hard_banned) return { ok: false, error: 'hard_banned' };

  let riskDelta = 0;
  let fpChanged = false;
  let ipChanged = false;

  if (session.fingerprint_hash !== fpHash) {
    riskDelta += 25;
    fpChanged = true;
  }
  if (session.ip_hash !== ipHash) {
    riskDelta += 5;
    ipChanged = true;
    /* Update session IP silently */
    await sql`UPDATE sessions SET ip_hash = ${ipHash} WHERE session_id = ${sessionId}`;
  }

  if (fpChanged) {
    /* Different device — invalidate immediately */
    await sql`DELETE FROM sessions WHERE session_id = ${sessionId}`;
    await sql`
      UPDATE users SET risk_score = LEAST(risk_score + 30, 100)
      WHERE telegram_id = ${session.telegram_id}
    `;
    return { ok: false, error: 'fingerprint_mismatch' };
  }

  if (riskDelta > 0) {
    await sql`
      UPDATE users SET risk_score = LEAST(risk_score + ${riskDelta}, 100)
      WHERE telegram_id = ${session.telegram_id}
    `;
  }

  return { ok: true, session, ipChanged };
}

/* ══════════════════════════════════════════════════════════
   RATE LIMIT CHECK
══════════════════════════════════════════════════════════ */
async function checkRateLimit(sql, telegramId) {
  const key = `rl:${telegramId}`;
  const now = new Date();
  const windowSecs = 5;

  const rows = await sql`
    INSERT INTO rate_limits (key, count, window_start)
    VALUES (${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
            WHEN rate_limits.window_start > NOW() - INTERVAL '5 seconds' THEN rate_limits.count + 1
            ELSE 1
          END,
          window_start = CASE
            WHEN rate_limits.window_start > NOW() - INTERVAL '5 seconds' THEN rate_limits.window_start
            ELSE ${now}
          END
    RETURNING count, window_start
  `;

  const count = rows[0]?.count || 1;
  return count > 10;
}

/* ══════════════════════════════════════════════════════════
   RISK SCORE UPDATE
══════════════════════════════════════════════════════════ */
async function calcAndApplyRisk(sql, telegramId, ipHash, fpHash) {
  const recentDenied = await sql`
    SELECT COUNT(*) AS cnt FROM security_logs
    WHERE telegram_id = ${telegramId}
      AND verdict IN ('deny','rate_limit')
      AND created_at > NOW() - INTERVAL '1 minute'
  `;
  const deniedCount = parseInt(recentDenied[0]?.cnt) || 0;
  const riskFromDenied = Math.min(deniedCount * 10, 30);

  if (riskFromDenied > 0) {
    const result = await sql`
      UPDATE users SET risk_score = LEAST(risk_score + ${riskFromDenied}, 100)
      WHERE telegram_id = ${telegramId}
      RETURNING risk_score, is_shadow_banned
    `;
    const newScore = result[0]?.risk_score || 0;
    if (newScore >= 71 && !result[0]?.is_shadow_banned) {
      await sql`UPDATE users SET is_shadow_banned = TRUE WHERE telegram_id = ${telegramId}`;
    }
    return newScore;
  }

  const row = await sql`SELECT risk_score FROM users WHERE telegram_id = ${telegramId}`;
  return parseInt(row[0]?.risk_score) || 0;
}

/* ══════════════════════════════════════════════════════════
   NONCE VERIFY & BURN
══════════════════════════════════════════════════════════ */
async function verifyAndBurnNonce(sql, nonceId, sessionId) {
  if (!nonceId) return { ok: false, error: 'missing_nonce' };
  const rows = await sql`
    SELECT * FROM nonces
    WHERE nonce_id = ${nonceId}
      AND session_id = ${sessionId}
      AND used = FALSE
      AND expires_at > NOW()
  `;
  if (!rows.length) return { ok: false, error: 'invalid_nonce' };
  await sql`UPDATE nonces SET used = TRUE WHERE nonce_id = ${nonceId}`;
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════
   CORS HELPER
══════════════════════════════════════════════════════════ */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, X-Session-Id, X-Nonce, X-Init-Data, X-Fingerprint');
}

function safeNum(val, def = 0) {
  const n = parseFloat(val);
  return isNaN(n) ? def : n;
}

function safeInt(val, def = 0) {
  const n = parseInt(val);
  return isNaN(n) ? def : n;
}

function safeUser(row) {
  if (!row) return { points: 0, level: 1, streak_day: 0, ads_watched_today: 0, tg_verified: false };
  return {
    points: safeInt(row.points),
    level: safeInt(row.level, 1),
    streak_day: safeInt(row.streak_day),
    ads_watched_today: safeInt(row.ads_watched_today),
    tg_verified: !!row.tg_verified,
    last_gift_date: row.last_gift_date || null,
  };
}

/* ══════════════════════════════════════════════════════════
   MAIN HANDLER
══════════════════════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const sql = neon(process.env.DATABASE_URL);
  await bootstrap(sql);
  startCleanup(sql);

  /* ── Parse headers ── */
  const rawIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '0.0.0.0';
  const ipHash = hashIp(rawIp, process.env.IP_SALT || 'default_salt');

  const sessionId  = req.headers['x-session-id'] || null;
  const nonceId    = req.headers['x-nonce'] || null;
  const fpHeader   = req.headers['x-fingerprint'] || null;
  const initDataH  = req.headers['x-init-data'] || '';

  const fpHash = buildFingerprint(fpHeader, ipHash);

  let body = {};
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    res.status(400).json({ ok: false, error: 'invalid_json', action: 'parse' });
    return;
  }

  const { type: action, data = {} } = body;

  if (!action) {
    res.status(400).json({ ok: false, error: 'missing_action' });
    return;
  }

  /* ══════════════════════════════════════════════════════
     ACTION: create_session
  ══════════════════════════════════════════════════════ */
  if (action === 'create_session') {
    try {
      const initData = initDataH || data.initData || '';
      const tgUser   = verifyTelegramInitData(initData, process.env.BOT_TOKEN);

      if (!tgUser || !tgUser.id) {
        await auditLog(sql, { ip_hash: ipHash, fingerprint: fpHash, action: 'create_session', verdict: 'deny', detail: { reason: 'invalid_init_data' } });
        res.status(401).json({ ok: false, error: 'invalid_telegram_auth' });
        return;
      }

      const telegramId = tgUser.id;

      /* Upsert user */
      await sql`
        INSERT INTO users (telegram_id, username, first_name, last_name)
        VALUES (${telegramId}, ${tgUser.username || null}, ${tgUser.first_name || null}, ${tgUser.last_name || null})
        ON CONFLICT (telegram_id) DO UPDATE
          SET username   = COALESCE(EXCLUDED.username, users.username),
              first_name = COALESCE(EXCLUDED.first_name, users.first_name),
              last_name  = COALESCE(EXCLUDED.last_name, users.last_name)
      `;

      const [userRow] = await sql`SELECT * FROM users WHERE telegram_id = ${telegramId}`;

      if (userRow.is_hard_banned) {
        await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action: 'create_session', verdict: 'deny', detail: { reason: 'hard_banned' } });
        res.status(200).json({ ok: true, is_banned: true });
        return;
      }

      /* Multi-account detection — advisory lock per IP */
      const lockKey = parseInt(ipHash.slice(0, 8), 16) % 2147483647;
      await sql`SELECT pg_advisory_xact_lock(${lockKey})`;

      const isNewAccount = (Date.now() - new Date(userRow.created_at).getTime()) < 3 * 86400 * 1000;

      if (isNewAccount) {
        /* Check if fingerprint belongs to another account */
        const fpConflict = await sql`
          SELECT telegram_id FROM device_fingerprints
          WHERE fingerprint_hash = ${fpHash}
            AND telegram_id != ${telegramId}
          LIMIT 1
        `;
        if (fpConflict.length > 0) {
          await sql`UPDATE users SET is_hard_banned = TRUE WHERE telegram_id = ${telegramId}`;
          await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action: 'create_session', verdict: 'hard_ban', detail: { reason: 'fingerprint_conflict', conflicting_tid: fpConflict[0].telegram_id } });
          res.status(200).json({ ok: true, is_banned: true });
          return;
        }

        /* Check IP multi-account (warning only if fingerprint is unique) */
        const ipAccounts = await sql`
          SELECT COUNT(DISTINCT telegram_id) AS cnt
          FROM sessions
          WHERE ip_hash = ${ipHash}
            AND expires_at > NOW()
            AND telegram_id != ${telegramId}
        `;
        const ipCount = safeInt(ipAccounts[0]?.cnt);
        if (ipCount >= 3) {
          await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action: 'create_session', verdict: 'warn', detail: { reason: 'ip_multi_account', count: ipCount } });
        }
      }

      /* Record fingerprint */
      await sql`
        INSERT INTO device_fingerprints (fingerprint_hash, telegram_id)
        VALUES (${fpHash}, ${telegramId})
        ON CONFLICT DO NOTHING
      `;

      /* Invalidate old sessions */
      await sql`DELETE FROM sessions WHERE telegram_id = ${telegramId}`;

      /* Create new session */
      const newSessionId = genRandom(32);
      await sql`
        INSERT INTO sessions (session_id, telegram_id, ip_hash, fingerprint_hash)
        VALUES (${newSessionId}, ${telegramId}, ${ipHash}, ${fpHash})
      `;

      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action: 'create_session', verdict: 'allow', detail: {} });

      const u = safeUser(userRow);

      res.status(200).json({
        ok: true,
        is_banned: false,
        session_id: newSessionId,
        user: {
          telegram_id: telegramId,
          username: tgUser.username || null,
          first_name: tgUser.first_name || null,
          ...u,
        },
      });
    } catch (e) {
      console.error('[create_session]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'session_create_failed', action });
    }
    return;
  }

  /* ══════════════════════════════════════════════════════
     ACTION: get_nonce
  ══════════════════════════════════════════════════════ */
  if (action === 'get_nonce') {
    try {
      const sv = await verifySession(sql, sessionId, fpHash, ipHash);
      if (!sv.ok) {
        res.status(401).json({ ok: false, error: sv.error, action });
        return;
      }
      const nonceVal = genRandom(32);
      await sql`
        INSERT INTO nonces (nonce_id, session_id)
        VALUES (${nonceVal}, ${sessionId})
      `;
      res.status(200).json({ ok: true, nonce: nonceVal });
    } catch (e) {
      console.error('[get_nonce]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'nonce_create_failed', action });
    }
    return;
  }

  /* ══════════════════════════════════════════════════════
     ACTION: start_ad
  ══════════════════════════════════════════════════════ */
  if (action === 'start_ad') {
    try {
      const sv = await verifySession(sql, sessionId, fpHash, ipHash);
      if (!sv.ok) {
        res.status(401).json({ ok: false, error: sv.error, action });
        return;
      }
      const adNonce = genRandom(32);
      const exp = new Date(Date.now() + 10 * 60 * 1000); // 10 min
      await sql`
        UPDATE sessions SET ad_nonce = ${adNonce}, ad_nonce_exp = ${exp}
        WHERE session_id = ${sessionId}
      `;
      res.status(200).json({ ok: true, ad_nonce: adNonce });
    } catch (e) {
      console.error('[start_ad]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'start_ad_failed', action });
    }
    return;
  }

  /* ══════════════════════════════════════════════════════
     ALL OTHER ACTIONS — full pipeline
  ══════════════════════════════════════════════════════ */

  /* 1. Verify session */
  let sv;
  try {
    sv = await verifySession(sql, sessionId, fpHash, ipHash);
  } catch (e) {
    console.error('[session_verify]', e.message);
    res.status(500).json({ ok: false, error: 'session_verify_failed', action });
    return;
  }

  if (!sv.ok) {
    res.status(401).json({ ok: false, error: sv.error, action });
    return;
  }

  const { session } = sv;
  const telegramId = session.telegram_id;

  /* 2. Rate limit */
  try {
    const limited = await checkRateLimit(sql, telegramId);
    if (limited) {
      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, verdict: 'rate_limit', detail: {} });
      res.status(429).json({ ok: false, error: 'rate_limited', action });
      return;
    }
  } catch (e) {
    console.error('[rate_limit]', e.message);
  }

  /* 3. Verify nonce for write operations (skip for read-only) */
  const READ_ONLY_ACTIONS = new Set(['load', 'get_state']);
  const AD_REWARD_ACTION  = 'watch_ad';

  if (!READ_ONLY_ACTIONS.has(action) && action !== AD_REWARD_ACTION) {
    const nv = await verifyAndBurnNonce(sql, nonceId, sessionId);
    if (!nv.ok) {
      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, verdict: 'deny', detail: { reason: nv.error } });
      res.status(403).json({ ok: false, error: nv.error, action });
      return;
    }
  }

  if (action === AD_REWARD_ACTION) {
    /* Verify ad nonce from session row */
    const adNonce = data.ad_nonce;
    if (!adNonce || session.ad_nonce !== adNonce || !session.ad_nonce_exp || new Date(session.ad_nonce_exp) < new Date()) {
      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, verdict: 'deny', detail: { reason: 'invalid_ad_nonce' } });
      res.status(403).json({ ok: false, error: 'invalid_ad_nonce', action });
      return;
    }
    /* Burn ad nonce */
    await sql`UPDATE sessions SET ad_nonce = NULL, ad_nonce_exp = NULL WHERE session_id = ${sessionId}`;
  }

  /* 4. Risk score */
  let riskScore = 0;
  try {
    riskScore = await calcAndApplyRisk(sql, telegramId, ipHash, fpHash);
  } catch (e) {
    console.error('[risk]', e.message);
  }

  /* 5. Shadow ban check */
  const [freshUser] = await sql`SELECT * FROM users WHERE telegram_id = ${telegramId}`;
  const isShadow = freshUser?.is_shadow_banned || riskScore >= 71;

  if (isShadow && !READ_ONLY_ACTIONS.has(action)) {
    /* Shadow — return plausible fake success, write nothing */
    await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'shadow', detail: {} });
    const u = safeUser(freshUser);
    res.status(200).json({ ok: true, shadow: true, ...u });
    return;
  }

  /* ══════════════════════════════════════════════════════
     ACTIONS
  ══════════════════════════════════════════════════════ */

  /* ── load / get_state ── */
  if (action === 'load' || action === 'get_state') {
    try {
      const [u] = await sql`SELECT * FROM users WHERE telegram_id = ${telegramId}`;
      const today = new Date().toISOString().slice(0, 10);

      let adsWatched = safeInt(u?.ads_watched_today);
      if (u?.ads_reset_date !== today) {
        await sql`UPDATE users SET ads_watched_today = 0, ads_reset_date = ${today} WHERE telegram_id = ${telegramId}`;
        adsWatched = 0;
      }

      const withdrawRows = await sql`
        SELECT * FROM withdrawals WHERE telegram_id = ${telegramId} ORDER BY created_at DESC LIMIT 20
      `;

      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'allow', detail: {} });

      res.status(200).json({
        ok: true,
        points: safeInt(u?.points),
        level: safeInt(u?.level, 1),
        streak_day: safeInt(u?.streak_day),
        tg_verified: !!u?.tg_verified,
        last_gift_date: u?.last_gift_date || null,
        ads_watched_today: adsWatched,
        ads_total: 10,
        ads_remaining: Math.max(0, 10 - adsWatched),
        withdrawals: withdrawRows.map(w => ({
          pts: safeInt(w.pts),
          address: w.address || '',
          ts: new Date(w.created_at).getTime(),
          status: w.status || 'pending',
        })),
      });
    } catch (e) {
      console.error('[load]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'load_failed', action });
    }
    return;
  }

  /* ── watch_ad ── */
  if (action === 'watch_ad') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [u] = await sql`SELECT * FROM users WHERE telegram_id = ${telegramId}`;

      let adsWatched = safeInt(u?.ads_watched_today);
      if (u?.ads_reset_date !== today) {
        adsWatched = 0;
        await sql`UPDATE users SET ads_watched_today = 0, ads_reset_date = ${today} WHERE telegram_id = ${telegramId}`;
      }

      if (adsWatched >= 10) {
        res.status(200).json({ ok: false, error: 'ads_exhausted', remaining: 0, watchedToday: 10, earnedToday: safeInt(u?.ads_watched_today) * 50 });
        return;
      }

      const PTS_PER_AD = 50;
      const result = await sql`
        UPDATE users
        SET points            = points + ${PTS_PER_AD},
            ads_watched_today = ads_watched_today + 1,
            ads_reset_date    = ${today}
        WHERE telegram_id = ${telegramId}
        RETURNING points, ads_watched_today
      `;

      const newWatched  = safeInt(result[0]?.ads_watched_today);
      const remaining   = Math.max(0, 10 - newWatched);
      const earnedToday = newWatched * PTS_PER_AD;

      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'allow', detail: { pts_added: PTS_PER_AD } });

      res.status(200).json({
        ok: true,
        points: safeInt(result[0]?.points),
        remaining,
        watchedToday: newWatched,
        earnedToday,
      });
    } catch (e) {
      console.error('[watch_ad]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'watch_ad_failed', action });
    }
    return;
  }

  /* ── claim_gift ── */
  if (action === 'claim_gift') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [u] = await sql`SELECT * FROM users WHERE telegram_id = ${telegramId}`;

      if (u?.last_gift_date === today) {
        res.status(200).json({ ok: false, error: 'already_claimed_today' });
        return;
      }

      const GIFT_PTS = [100, 150, 200, 250, 300, 400, 750];
      const lastDate = u?.last_gift_date;
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
      const isConsecutive = lastDate === yesterday;
      const currentStreak = isConsecutive ? safeInt(u?.streak_day, 0) + 1 : 1;
      const clampedDay = Math.min(currentStreak, 7);
      const pts = GIFT_PTS[clampedDay - 1] || 100;

      const result = await sql`
        UPDATE users
        SET points         = points + ${pts},
            streak_day     = ${currentStreak},
            last_gift_date = ${today}
        WHERE telegram_id  = ${telegramId}
        RETURNING points, streak_day
      `;

      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'allow', detail: { pts, day: clampedDay } });

      res.status(200).json({
        ok: true,
        pts,
        day: clampedDay,
        streak_day: safeInt(result[0]?.streak_day),
        points: safeInt(result[0]?.points),
      });
    } catch (e) {
      console.error('[claim_gift]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'claim_gift_failed', action });
    }
    return;
  }

  /* ── verify_tg_membership ── */
  if (action === 'verify_tg_membership') {
    try {
      const [u] = await sql`SELECT tg_verified FROM users WHERE telegram_id = ${telegramId}`;

      if (u?.tg_verified) {
        res.status(200).json({ ok: true, already_verified: true });
        return;
      }

      /* Call Telegram Bot API to check channel membership */
      const channelUsername = process.env.CHANNEL_USERNAME || '@YourChannelUsername';
      const botToken        = process.env.BOT_TOKEN;

      let isMember = false;
      try {
        const tgRes = await fetch(
          `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(channelUsername)}&user_id=${telegramId}`
        );
        const tgJson = await tgRes.json();
        const status = tgJson?.result?.status || '';
        isMember = ['member', 'administrator', 'creator'].includes(status);
      } catch (e2) {
        console.error('[verify_tg_membership] Telegram API error:', e2.message);
        res.status(500).json({ ok: false, error: 'telegram_api_error', action });
        return;
      }

      if (!isMember) {
        await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'deny', detail: { reason: 'not_member' } });
        res.status(200).json({ ok: false, error: 'not_member' });
        return;
      }

      const BONUS_PTS = 2500;
      const result = await sql`
        UPDATE users
        SET tg_verified = TRUE, points = points + ${BONUS_PTS}
        WHERE telegram_id = ${telegramId}
        RETURNING points
      `;

      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'allow', detail: { pts_added: BONUS_PTS } });

      res.status(200).json({
        ok: true,
        points: safeInt(result[0]?.points),
        pts_awarded: BONUS_PTS,
      });
    } catch (e) {
      console.error('[verify_tg_membership]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'verify_tg_failed', action });
    }
    return;
  }

  /* ── track_copy_link ── */
  if (action === 'track_copy_link') {
    try {
      await sql`
        UPDATE users SET copy_link_count = copy_link_count + 1
        WHERE telegram_id = ${telegramId}
      `;
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[track_copy_link]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'track_copy_failed', action });
    }
    return;
  }

  /* ── submit_withdraw ── */
  if (action === 'submit_withdraw') {
    try {
      const address = (data.address || '').trim();
      const isValid = (address.startsWith('EQ') || address.startsWith('UQ') || address.startsWith('0:')) && address.length >= 48;

      if (!isValid) {
        res.status(200).json({ ok: false, error: 'invalid_address' });
        return;
      }

      const MIN_PTS = 50000;
      const [u] = await sql`SELECT points, level FROM users WHERE telegram_id = ${telegramId}`;
      const userPoints = safeInt(u?.points);
      const userLevel  = safeInt(u?.level, 1);

      if (userLevel < 5) {
        res.status(200).json({ ok: false, error: 'level_too_low' });
        return;
      }
      if (userPoints < MIN_PTS) {
        res.status(200).json({ ok: false, error: 'insufficient_balance' });
        return;
      }

      const result = await sql`
        UPDATE users SET points = points - ${userPoints}
        WHERE telegram_id = ${telegramId} AND points >= ${MIN_PTS}
        RETURNING points
      `;

      if (!result.length) {
        res.status(200).json({ ok: false, error: 'insufficient_balance' });
        return;
      }

      const withdrawal = await sql`
        INSERT INTO withdrawals (telegram_id, address, pts)
        VALUES (${telegramId}, ${address}, ${userPoints})
        RETURNING id, created_at
      `;

      await auditLog(sql, { telegram_id: telegramId, ip_hash: ipHash, fingerprint: fpHash, action, risk_score: riskScore, verdict: 'allow', detail: { pts: userPoints, address } });

      res.status(200).json({
        ok: true,
        pts: userPoints,
        address,
        ts: new Date(withdrawal[0].created_at).getTime(),
        new_balance: safeInt(result[0]?.points),
      });
    } catch (e) {
      console.error('[submit_withdraw]', e.message, e.stack);
      res.status(500).json({ ok: false, error: 'withdraw_failed', action });
    }
    return;
  }

  /* ── Unknown action ── */
  res.status(400).json({ ok: false, error: 'unknown_action', action });
};
