// ══════════════════════════════════════════════════════════════════════════════
//  api/index.js  —  BigLeague · Vercel Serverless Function
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL    = process.env.DATABASE_URL;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET; // ← أضفه في Vercel env vars

// ── Anti-abuse config ─────────────────────────────────────────────────────────
const CFG = {
  AD_MIN_WATCH_SEC:   28,   // ثواني لازم تمر بين startAd و watchAd
  AD_SESSION_TTL_SEC: 300,  // صلاحية الـ token (5 دقائق)
  AD_COOLDOWN_SEC:    60,   // cooldown بين إعلانين
  AD_DAILY_MAX:       30,   // أكثر إعلان يومي
  IP_MAX_ADS_PER_HR:  40,   // أكثر إعلان لكل IP بالساعة
  IP_MAX_REQ_PER_MIN: 60,   // أكثر طلب عام لكل IP بالدقيقة
  RISK_BAN_THRESHOLD: 100,  // risk score يؤدي لـ shadow ban
  TS_DRIFT_SEC:       90,   // أكثر فرق مقبول بالـ timestamp
};

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
  // Backfill columns — آمن على جداول قديمة
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url     TEXT`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ad_watch TIMESTAMPTZ`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_ads     INT NOT NULL DEFAULT 0`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ad_date  DATE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score    INT NOT NULL DEFAULT 0`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_banned BOOLEAN NOT NULL DEFAULT FALSE`);

  // جلسات الإعلانات — كل إعلان له token مؤقت
  await sql(`CREATE TABLE IF NOT EXISTS ad_sessions (
    token      TEXT PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used       BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_ad_sessions_user ON ad_sessions(user_id)`);

  // Rate limiting بالـ IP
  await sql(`CREATE TABLE IF NOT EXISTS ip_limits (
    ip           TEXT NOT NULL,
    window_type  TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count        INT NOT NULL DEFAULT 0,
    PRIMARY KEY (ip, window_type, window_start)
  )`);

  // منع replay نفس initData
  await sql(`CREATE TABLE IF NOT EXISTS used_init_hashes (
    hash    TEXT PRIMARY KEY,
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
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
    if (!crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(receivedHash))) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (Date.now() / 1000 - authDate > 3600) return null;
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  🛡️  Helpers: IP · Rate Limit · Risk Score · InitData Hash
// ══════════════════════════════════════════════════════════════════════════════
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function checkIPLimit(ip, type) {
  // type: 'min' = دقيقة عام | 'hr' = ساعة للإعلانات
  const max     = type === 'min' ? CFG.IP_MAX_REQ_PER_MIN : CFG.IP_MAX_ADS_PER_HR;
  const trunc   = type === 'min' ? `DATE_TRUNC('minute', NOW())` : `DATE_TRUNC('hour', NOW())`;
  const interval = type === 'min' ? '2 minutes' : '2 hours';
  await sql(`DELETE FROM ip_limits WHERE window_start < NOW() - INTERVAL '${interval}'`);
  const rows = await sql(
    `INSERT INTO ip_limits (ip, window_type, window_start, count)
     VALUES ($1, $2, ${trunc}, 1)
     ON CONFLICT (ip, window_type, window_start)
     DO UPDATE SET count = ip_limits.count + 1
     RETURNING count`,
    [ip, type]
  );
  return rows[0].count <= max; // true = مسموح
}

async function addRisk(userId, points, reason) {
  console.warn(`[RISK] user=${userId} +${points} reason=${reason}`);
  const rows = await sql(
    `UPDATE users SET risk_score = risk_score + $1 WHERE id = $2
     RETURNING risk_score, shadow_banned`,
    [points, userId]
  );
  if (!rows[0].shadow_banned && rows[0].risk_score >= CFG.RISK_BAN_THRESHOLD) {
    await sql(`UPDATE users SET shadow_banned = TRUE WHERE id = $1`, [userId]);
    console.warn(`[SHADOWBAN] auto-banned user=${userId}`);
  }
}

async function checkAndMarkInitHash(initData) {
  const hash = crypto.createHash('sha256').update(initData + ':watchAd').digest('hex');
  await sql(`DELETE FROM used_init_hashes WHERE used_at < NOW() - INTERVAL '1 hour'`);
  try {
    await sql(`INSERT INTO used_init_hashes (hash) VALUES ($1)`, [hash]);
    return true;  // جديد ✓
  } catch {
    return false; // مكرر ✗
  }
}
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
  // ── CORS محدود — مش wildcard ────────────────────────────────────────────────
  const allowedOrigins = ['https://web.telegram.org','https://webk.telegram.org','https://webz.telegram.org'];
  const origin = req.headers['origin'] || '';
  res.setHeader('Access-Control-Allow-Origin',  allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('[Schema error]', err.message);
    return res.status(500).json({ ok: false, error: 'DB schema error: ' + err.message });
  }

  // 🛡️ IP rate limit عام
  const clientIP = getClientIP(req);
  try {
    const ipOk = await checkIPLimit(clientIP, 'min');
    if (!ipOk) return res.status(429).json({ ok: false, error: 'Too many requests' });
  } catch (err) {
    console.error('[IP limit error]', err.message);
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

    // 🛡️ فحص timestamp العميل — يمنع replay متأخر
    if (data.ts) {
      const drift = Math.abs(Date.now() / 1000 - parseInt(data.ts, 10));
      if (drift > CFG.TS_DRIFT_SEC) {
        return res.status(400).json({ ok: false, error: 'Request expired' });
      }
    }

    try {
      dbUser = await upsertUser(tgUser, data.startParam || null);
    } catch (err) {
      console.error('[upsertUser error]', err.message);
      return res.status(500).json({ ok: false, error: 'DB error: ' + err.message });
    }

    // 🛡️ Shadow ban — رد وهمي عشان المخترق ما يعرف
    if (dbUser.shadow_banned) {
      return res.json({ ok: true, reward: 750, shadowBanned: true });
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

      // 🛡️ startAd — الخطوة الأولى: احجز token قبل تشغيل الإعلان
      case 'startAd': {
        const today = new Date().toISOString().slice(0, 10);
        const uRows = await sql(`SELECT last_ad_watch, daily_ads, last_ad_date FROM users WHERE id = $1`, [dbUser.id]);
        const u = uRows[0];
        const sameDay = u.last_ad_date && String(u.last_ad_date).slice(0, 10) === today;
        const dailyCount = sameDay ? u.daily_ads : 0;

        if (dailyCount >= CFG.AD_DAILY_MAX) {
          return res.status(429).json({ ok: false, error: 'Daily ad limit reached' });
        }
        if (u.last_ad_watch) {
          const secSince = (Date.now() - new Date(u.last_ad_watch).getTime()) / 1000;
          if (secSince < CFG.AD_COOLDOWN_SEC) {
            return res.status(429).json({ ok: false, error: 'Please wait', waitSec: Math.ceil(CFG.AD_COOLDOWN_SEC - secSince) });
          }
        }

        // 🛡️ احذف أي token قديم غير مستخدم — يمنع تجميع tokens
        await sql(`DELETE FROM ad_sessions WHERE user_id = $1 AND used = FALSE`, [dbUser.id]);

        const token = crypto.randomBytes(32).toString('hex');
        await sql(`INSERT INTO ad_sessions (token, user_id) VALUES ($1, $2)`, [token, dbUser.id]);
        return res.json({ ok: true, token });
      }

      case 'watchAd': {
        const { token } = data;

        // 🛡️ لازم يكون فيه token صحيح
        if (!token || typeof token !== 'string' || token.length !== 64) {
          await addRisk(dbUser.id, 30, 'no_token');
          return res.status(400).json({ ok: false, error: 'Invalid session' });
        }

        // 🛡️ IP limit للإعلانات
        const ipAdOk = await checkIPLimit(clientIP, 'hr');
        if (!ipAdOk) return res.status(429).json({ ok: false, error: 'Too many ads from this network' });

        // 🛡️ منع replay نفس الـ initData
        const hashOk = await checkAndMarkInitHash(rawInitData);
        if (!hashOk) {
          await addRisk(dbUser.id, 50, 'replay_initData');
          return res.status(400).json({ ok: false, error: 'Duplicate request' });
        }

        // جلب الجلسة
        const sessions = await sql(`SELECT * FROM ad_sessions WHERE token = $1`, [token]);
        if (sessions.length === 0) {
          await addRisk(dbUser.id, 40, 'fake_token');
          return res.status(400).json({ ok: false, error: 'Invalid session' });
        }
        const session = sessions[0];

        // 🛡️ التحقق إن الـ token يخص هاد المستخدم
        if (session.user_id !== dbUser.id) {
          await addRisk(dbUser.id, 80, 'token_stolen');
          return res.status(403).json({ ok: false, error: 'Session mismatch' });
        }

        if (session.used) {
          await addRisk(dbUser.id, 60, 'used_token');
          return res.status(400).json({ ok: false, error: 'Session already used' });
        }

        const sessionAge = (Date.now() - new Date(session.created_at).getTime()) / 1000;

        // 🛡️ لازم مضى وقت كافي — إثبات المشاهدة
        if (sessionAge < CFG.AD_MIN_WATCH_SEC) {
          await addRisk(dbUser.id, 70, `too_fast_${Math.round(sessionAge)}s`);
          return res.status(400).json({ ok: false, error: 'Ad not fully watched' });
        }

        // 🛡️ الـ token انتهت صلاحيته
        if (sessionAge > CFG.AD_SESSION_TTL_SEC) {
          await sql(`DELETE FROM ad_sessions WHERE token = $1`, [token]);
          return res.status(400).json({ ok: false, error: 'Session expired' });
        }

        // فحص الـ daily limit مرة ثانية (atomic)
        const today = new Date().toISOString().slice(0, 10);
        const uRows = await sql(`SELECT daily_ads, last_ad_date, last_ad_watch FROM users WHERE id = $1`, [dbUser.id]);
        const u2 = uRows[0];
        const sameDay = u2.last_ad_date && String(u2.last_ad_date).slice(0, 10) === today;
        if ((sameDay ? u2.daily_ads : 0) >= CFG.AD_DAILY_MAX) {
          return res.status(429).json({ ok: false, error: 'Daily ad limit reached' });
        }

        // 🛡️ فحص cooldown داخل watchAd أيضاً — لو تجاوز startAd بطريقة ما
        if (u2.last_ad_watch) {
          const secSince = (Date.now() - new Date(u2.last_ad_watch).getTime()) / 1000;
          if (secSince < CFG.AD_COOLDOWN_SEC) {
            await addRisk(dbUser.id, 40, `cooldown_bypass_${Math.round(secSince)}s`);
            return res.status(429).json({ ok: false, error: 'Please wait between ads' });
          }
        }

        const AD_REWARD  = 750;
        const rankBefore = await getUserRank(dbUser.id);

        // 🔒 Atomic update
        await sql(`
          UPDATE users SET
            pts           = pts + $1,
            last_ad_watch = NOW(),
            daily_ads     = CASE WHEN last_ad_date = CURRENT_DATE THEN daily_ads + 1 ELSE 1 END,
            last_ad_date  = CURRENT_DATE
          WHERE id = $2
        `, [AD_REWARD, dbUser.id]);

        // وسّم الـ token كمستخدم
        await sql(`UPDATE ad_sessions SET used = TRUE WHERE token = $1`, [token]);
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
        // 🛡️ محمي بـ INTERNAL_SECRET — منع أي شخص خارجي
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (!INTERNAL_SECRET || providedSecret !== INTERNAL_SECRET) {
          return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
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
