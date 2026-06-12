// ══════════════════════════════════════════════════════════════════════════════
//  api/index.js  —  BigLeague · Vercel Serverless Function
//  Routes: POST /api  →  { type, data }
//          GET  /api  →  health check
//
//  ENV VARS required:
//    DATABASE_URL   — Neon connection string
//    BOT_TOKEN      — Telegram bot token (for sendMessage + initData verify)
//
//  Frontend must send initData in every POST body:
//    body: JSON.stringify({ type, data, initData: window.Telegram.WebApp.initData })
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

// ── SQL executor — single connection reused across invocations (Neon best practice) ──
const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Schema — idempotent, runs on every cold start
// ══════════════════════════════════════════════════════════════════════════════
async function ensureSchema() {
  await sql(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      telegram_id   BIGINT  UNIQUE NOT NULL,
      username      TEXT,
      first_name    TEXT,
      pts           BIGINT  NOT NULL DEFAULT 0,         -- tickets / coins
      balance_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,  -- USDT balance
      referral_code TEXT    UNIQUE,
      referred_by   BIGINT  REFERENCES users(telegram_id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id         SERIAL PRIMARY KEY,
      user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      address    TEXT NOT NULL,
      memo       TEXT,
      amount     NUMERIC(10,2) NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS ad_watches (
      id         SERIAL PRIMARY KEY,
      user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reward     INT NOT NULL DEFAULT 750,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id         SERIAL PRIMARY KEY,
      user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action     TEXT NOT NULL,                       -- ref_copy | share | ...
      meta       JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Index to speed up leaderboard queries
  await sql(`
    CREATE INDEX IF NOT EXISTS idx_users_pts ON users (pts DESC)
  `);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram initData verification  (HMAC-SHA256)
//  Returns parsed user object { id, username, first_name, … } or null
// ══════════════════════════════════════════════════════════════════════════════
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;

    params.delete('hash');

    // Build data-check-string: sorted key=value pairs joined by \n
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (!crypto.timingSafeEqual(
      Buffer.from(expectedHash, 'hex'),
      Buffer.from(receivedHash,  'hex')
    )) return null;

    // Reject stale tokens (> 1 hour)
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Date.now() / 1000 - authDate > 3600) return null;

    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  DB Helpers
// ══════════════════════════════════════════════════════════════════════════════

// Upsert user from Telegram data, return full DB row
async function upsertUser(tgUser) {
  const { id: telegram_id, username = null, first_name = null } = tgUser;
  const refCode = `REF${telegram_id}`;

  await sql(`
    INSERT INTO users (telegram_id, username, first_name, referral_code)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username   = EXCLUDED.username,
      first_name = EXCLUDED.first_name
  `, [telegram_id, username, first_name, refCode]);

  const rows = await sql(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegram_id]
  );
  return rows[0];
}

// Rank of a user among all users (1 = highest pts)
async function getUserRank(userId) {
  const rows = await sql(`
    SELECT (COUNT(*) + 1)::INT AS rank
    FROM users
    WHERE pts > (SELECT pts FROM users WHERE id = $1)
  `, [userId]);
  return rows[0]?.rank ?? 1;
}

// Top N users for leaderboard
async function getLeaderboard(limit = 8) {
  return await sql(`
    SELECT
      telegram_id,
      COALESCE(first_name, username, 'Anonymous') AS name,
      pts,
      RANK() OVER (ORDER BY pts DESC)::INT AS rank
    FROM users
    ORDER BY pts DESC
    LIMIT $1
  `, [limit]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram Bot API — sendMessage
// ══════════════════════════════════════════════════════════════════════════════
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN not set' };

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    String(chatId),
        text,
        parse_mode: 'Markdown'
      })
    }
  );
  return await res.json();
}

// ══════════════════════════════════════════════════════════════════════════════
//  Route Handlers
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api ── health probe ─────────────────────────────────────────────────
async function handleGet(_req, res) {
  return res.status(200).json({ ok: true, service: 'BigLeague API', ts: Date.now() });
}

// ── POST /api ── main gateway ────────────────────────────────────────────────
async function handlePost(req, res) {
  const body               = req.body || {};
  const { type, data = {} } = body;

  // initData can arrive in body OR in the X-Telegram-Init-Data header
  const rawInitData =
    body.initData ||
    req.headers['x-telegram-init-data'] ||
    null;

  // ── Auth gate (all actions except sendBotMsg require a valid Telegram user) ──
  let tgUser = null;
  let dbUser = null;

  if (type !== 'sendBotMsg') {
    tgUser = verifyInitData(rawInitData);

    // ⚠️  DEV MODE — remove in production!
    //  If BOT_TOKEN is missing or initData is absent, fall back to a test user.
    if (!tgUser && process.env.NODE_ENV !== 'production') {
      console.warn('[DEV] initData verification skipped — using mock user');
      tgUser = { id: 999999999, username: 'devuser', first_name: 'Dev' };
    }

    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    dbUser = await upsertUser(tgUser);
  }

  // ── Action router ────────────────────────────────────────────────────────────
  switch (type) {

    // ── init — called on page load; returns user profile + leaderboard + referral stats
    case 'init': {
      const [userRank, leaderboard, refStats] = await Promise.all([
        getUserRank(dbUser.id),
        getLeaderboard(8),
        sql(`
          SELECT
            COUNT(*)::INT           AS ref_count,
            (COUNT(*) * 5000)::INT  AS ref_earned
          FROM users
          WHERE referred_by = $1
        `, [dbUser.telegram_id])
      ]);

      return res.json({
        ok: true,
        user: {
          id:            dbUser.id,
          telegram_id:   Number(dbUser.telegram_id),
          name:          dbUser.first_name || dbUser.username || 'You',
          pts:           Number(dbUser.pts),
          balance_usd:   parseFloat(dbUser.balance_usd),
          referral_code: dbUser.referral_code,
          rank:          userRank
        },
        leaderboard: leaderboard.map(r => ({
          telegram_id: Number(r.telegram_id),
          name:        r.name,
          pts:         Number(r.pts),
          rank:        r.rank
        })),
        referral: {
          count:  refStats[0]?.ref_count  ?? 0,
          earned: refStats[0]?.ref_earned ?? 0
        }
      });
    }

    // ── watchAd — reward user + detect rank change
    case 'watchAd': {
      const AD_REWARD = 750;

      const rankBefore = await getUserRank(dbUser.id);

      await sql(
        'UPDATE users SET pts = pts + $1 WHERE id = $2',
        [AD_REWARD, dbUser.id]
      );

      await sql(
        'INSERT INTO ad_watches (user_id, reward) VALUES ($1, $2)',
        [dbUser.id, AD_REWARD]
      );

      const rankAfter = await getUserRank(dbUser.id);
      const rankUp    = rankAfter < rankBefore;
      const rankDelta = rankBefore - rankAfter;

      return res.json({
        ok:        true,
        reward:    AD_REWARD,
        rankUp,
        newRank:   rankAfter,
        rankDelta: rankUp ? rankDelta : 0,
        chatId:    rankUp ? Number(dbUser.telegram_id) : null
      });
    }

    // ── withdraw — validate + deduct balance + create pending record
    case 'withdraw': {
      const { address, memo, amount } = data;

      // Validate inputs
      if (!address || typeof address !== 'string' || !address.trim()) {
        return res.status(400).json({ ok: false, error: 'Wallet address required' });
      }

      const amt = parseFloat(amount);
      if (isNaN(amt) || amt < 1) {
        return res.status(400).json({ ok: false, error: 'Minimum withdrawal is $1.00' });
      }

      const balance = parseFloat(dbUser.balance_usd);
      if (balance < amt) {
        return res.status(400).json({ ok: false, error: 'Insufficient balance' });
      }

      // Atomic: deduct first, then insert record
      await sql(
        'UPDATE users SET balance_usd = balance_usd - $1 WHERE id = $2',
        [amt, dbUser.id]
      );

      await sql(
        'INSERT INTO withdrawals (user_id, address, memo, amount) VALUES ($1, $2, $3, $4)',
        [dbUser.id, address.trim(), memo?.trim() || null, amt]
      );

      return res.json({
        ok:     true,
        chatId: Number(dbUser.telegram_id)
      });
    }

    // ── sendBotMsg — proxy to Telegram Bot API (BOT_TOKEN stays server-side)
    case 'sendBotMsg': {
      const { chatId, text } = data;

      if (!chatId || !text) {
        return res.status(400).json({ ok: false, error: 'chatId and text are required' });
      }

      const result = await sendTelegramMessage(chatId, text);
      return res.json({ ok: !!result.ok });
    }

    // ── logRefCopy — user tapped "Copy Link"
    case 'logRefCopy': {
      await sql(
        "INSERT INTO activity_logs (user_id, action) VALUES ($1, 'ref_copy')",
        [dbUser.id]
      );
      return res.json({ ok: true });
    }

    // ── logShare — user shared via Facebook / WhatsApp
    case 'logShare': {
      const { platform = 'unknown' } = data;
      await sql(
        "INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'share', $2)",
        [dbUser.id, JSON.stringify({ platform })]
      );
      return res.json({ ok: true });
    }

    default:
      return res.status(400).json({ ok: false, error: `Unknown action type: "${type}"` });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main export — Vercel serverless handler
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // Ensure tables exist (no-op if already created)
    await ensureSchema();

    if (req.method === 'GET')  return await handleGet(req, res);
    if (req.method === 'POST') return await handlePost(req, res);

    return res.status(405).json({ ok: false, error: 'Method not allowed' });

  } catch (err) {
    console.error('[API] Unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};
