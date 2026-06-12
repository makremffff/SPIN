// ══════════════════════════════════════════════════════════════════════════════
//  api/index.js  —  BigLeague · Vercel Serverless Function
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN    = process.env.BOT_TOKEN;

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Schema
// ══════════════════════════════════════════════════════════════════════════════
async function ensureSchema() {
  await sql(`CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    telegram_id   BIGINT  UNIQUE NOT NULL,
    username      TEXT,
    first_name    TEXT,
    photo_url     TEXT,
    pts           BIGINT  NOT NULL DEFAULT 0,
    balance_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
    referral_code TEXT    UNIQUE,
    referred_by   BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Backfill for tables created before photo_url existed
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT`);
  await sql(`CREATE TABLE IF NOT EXISTS withdrawals (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address    TEXT NOT NULL,
    memo       TEXT,
    amount     NUMERIC(10,2) NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE TABLE IF NOT EXISTS ad_watches (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward     INT NOT NULL DEFAULT 750,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE TABLE IF NOT EXISTS activity_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    meta       JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_users_pts ON users (pts DESC)`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram initData verification
// ══════════════════════════════════════════════════════════════════════════════
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (expectedHash !== receivedHash) return null;
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
async function upsertUser(tgUser, startParam = null) {
  const { id: telegram_id, username = null, first_name = null, photo_url = null } = tgUser;
  const refCode = `REF${telegram_id}`;

  // Only brand-new users can be attached to a referrer, and only once.
  const existing = await sql('SELECT id FROM users WHERE telegram_id = $1', [telegram_id]);

  let referredBy = null;
  if (existing.length === 0 && startParam) {
    const m = /^ref_(\d+)$/.exec(String(startParam).trim());
    if (m && m[1] !== String(telegram_id)) {
      const refUser = await sql('SELECT telegram_id FROM users WHERE telegram_id = $1', [m[1]]);
      if (refUser.length > 0) referredBy = m[1];
    }
  }

  await sql(`
    INSERT INTO users (telegram_id, username, first_name, photo_url, referral_code, referred_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (telegram_id) DO UPDATE SET
      username   = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      photo_url  = COALESCE(EXCLUDED.photo_url, users.photo_url)
  `, [telegram_id, username, first_name, photo_url, refCode, referredBy]);

  // Credit 5000 pts to referrer and send bot notification — only for brand-new users
  if (existing.length === 0 && referredBy) {
    await sql('UPDATE users SET pts = pts + 5000 WHERE telegram_id = $1', [referredBy]);
    const joinerName = first_name || username || 'Someone';
    await sendTelegramMessage(
      referredBy,
      `🎉 *${joinerName}* joined BigLeague using your referral link!\n\nYou earned *+5,000 competition points* 🏆\n\nKeep sharing to climb the leaderboard!`
    );
  }

  const rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
  return rows[0];
}

async function getUserRank(userId) {
  const rows = await sql(`
    SELECT (COUNT(*) + 1)::INT AS rank
    FROM users WHERE pts > (SELECT pts FROM users WHERE id = $1)
  `, [userId]);
  return rows[0]?.rank ?? 1;
}

async function getLeaderboard(limit = 8) {
  return await sql(`
    SELECT telegram_id,
           COALESCE(first_name, username, 'Anonymous') AS name,
           pts,
           photo_url,
           ROW_NUMBER() OVER (ORDER BY pts DESC, telegram_id ASC)::INT AS rank
    FROM users ORDER BY pts DESC, telegram_id ASC LIMIT $1
  `, [limit]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram Bot API
// ══════════════════════════════════════════════════════════════════════════════
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' })
  });
  return await res.json();
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main Export
// ══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.json({ ok: true, service: 'BigLeague API', ts: Date.now() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('[Schema error]', err.message);
    return res.status(500).json({ ok: false, error: 'DB schema error: ' + err.message });
  }

  const body              = req.body || {};
  const { type, data = {} } = body;
  const rawInitData       = body.initData || req.headers['x-telegram-init-data'] || '';

  // ── Auth ──────────────────────────────────────────────────────────────────
  let tgUser = null;
  let dbUser = null;

  if (type !== 'sendBotMsg') {
    tgUser = verifyInitData(rawInitData);

    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
      dbUser = await upsertUser(tgUser, data.startParam || null);
    } catch (err) {
      console.error('[upsertUser error]', err.message);
      return res.status(500).json({ ok: false, error: 'DB error: ' + err.message });
    }
  }

  // ── Router ─────────────────────────────────────────────────────────────────
  try {
    switch (type) {

      case 'init': {
        const [userRank, leaderboard, refStats] = await Promise.all([
          getUserRank(dbUser.id),
          getLeaderboard(8),
          sql(`SELECT COUNT(*)::INT AS ref_count, (COUNT(*)*5000)::INT AS ref_earned
               FROM users WHERE referred_by = $1`, [dbUser.telegram_id])
        ]);
        return res.json({
          ok: true,
          user: {
            id:            dbUser.id,
            telegram_id:   Number(dbUser.telegram_id),
            name:          dbUser.first_name || dbUser.username || 'You',
            photo_url:     dbUser.photo_url || null,
            pts:           Number(dbUser.pts),
            balance_usd:   parseFloat(dbUser.balance_usd),
            referral_code: dbUser.referral_code,
            rank:          userRank
          },
          leaderboard: leaderboard.map(r => ({
            telegram_id: Number(r.telegram_id),
            name: r.name,
            photo_url: r.photo_url || null,
            pts:  Number(r.pts),
            rank: r.rank
          })),
          referral: {
            count:  refStats[0]?.ref_count  ?? 0,
            earned: refStats[0]?.ref_earned ?? 0
          }
        });
      }

      case 'watchAd': {
        const AD_REWARD  = 750;
        const rankBefore = await getUserRank(dbUser.id);
        await sql('UPDATE users SET pts = pts + $1 WHERE id = $2', [AD_REWARD, dbUser.id]);
        await sql('INSERT INTO ad_watches (user_id, reward) VALUES ($1, $2)', [dbUser.id, AD_REWARD]);
        const rankAfter  = await getUserRank(dbUser.id);
        const rankUp     = rankAfter < rankBefore;
        return res.json({
          ok:        true,
          reward:    AD_REWARD,
          rankUp,
          newRank:   rankAfter,
          rankDelta: rankUp ? rankBefore - rankAfter : 0,
          chatId:    rankUp ? Number(dbUser.telegram_id) : null
        });
      }

      case 'withdraw': {
        const { address, memo, amount } = data;
        if (!address?.trim()) return res.status(400).json({ ok: false, error: 'Wallet address required' });
        const amt = parseFloat(amount);
        if (isNaN(amt) || amt < 1) return res.status(400).json({ ok: false, error: 'Minimum withdrawal is $1.00' });
        if (parseFloat(dbUser.balance_usd) < amt) return res.status(400).json({ ok: false, error: 'Insufficient balance' });
        await sql('UPDATE users SET balance_usd = balance_usd - $1 WHERE id = $2', [amt, dbUser.id]);
        await sql('INSERT INTO withdrawals (user_id, address, memo, amount) VALUES ($1,$2,$3,$4)',
          [dbUser.id, address.trim(), memo?.trim() || null, amt]);
        return res.json({ ok: true, chatId: Number(dbUser.telegram_id) });
      }

      case 'sendBotMsg': {
        const { chatId, text } = data;
        if (!chatId || !text) return res.status(400).json({ ok: false, error: 'chatId and text required' });
        const result = await sendTelegramMessage(chatId, text);
        return res.json({ ok: !!result.ok });
      }

      case 'logRefCopy': {
        await sql("INSERT INTO activity_logs (user_id, action) VALUES ($1, 'ref_copy')", [dbUser.id]);
        return res.json({ ok: true });
      }

      case 'logShare': {
        await sql("INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'share', $2)",
          [dbUser.id, JSON.stringify({ platform: data.platform || 'unknown' })]);
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unknown type: "${type}"` });
    }
  } catch (err) {
    console.error('[Handler error]', type, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
