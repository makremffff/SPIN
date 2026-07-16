// ══════════════════════════════════════════════════════════════════════════════
//  api/index.js  —  BigLeague · Vercel Serverless Function
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');
const crypto   = require('crypto');

const DATABASE_URL    = process.env.DATABASE_URL;
const BOT_TOKEN       = process.env.BOT_TOKEN;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET; // ← أضفه في Vercel env vars

// 💎 TON Deposits — عنوان الخزينة اللي المستخدمين يرسلون له TON، ومفتاح TonCenter الاختياري
const TREASURY_WALLET_ADDRESS = 'UQABsMMUakTi2iRO5pox4DDR--0J7uqsULYqHDv4Zo3w0E-T';
const TONCENTER_API_KEY       = process.env.TONCENTER_API_KEY || ''; // اختياري، يرفع الـ rate limit
const TONCENTER_BASE          = process.env.TONCENTER_BASE || 'https://toncenter.com/api/v2';

// 📢 قناة الاشتراك الإجباري قبل السحب — بدون @ — لازم يطابق CHANNEL_LINK في config.js
// ⚠️ البوت يجب أن يكون عضو/أدمن في القناة حتى يقدر يستخدم getChatMember
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || 'withdrawlProof2026';

// 🛡️ يتحقق من عضوية المستخدم في القناة عبر Telegram Bot API — تحقق فوري، بدون تخزين وسيط
async function isChannelMember(telegramId) {
  if (!BOT_TOKEN || !CHANNEL_USERNAME) return true; // fail-open لو غير مُهيّأ
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL_USERNAME}&user_id=${telegramId}`
    );
    const j = await r.json();
    if (!j.ok) return false;
    const status = j.result?.status;
    return ['creator', 'administrator', 'member'].includes(status);
  } catch (e) {
    console.error('[channel check]', e.message);
    return false; // fail-closed عند خطأ فعلي بالتحقق
  }
}

// ── Anti-abuse config ─────────────────────────────────────────────────────────
const CFG = {
  AD_COOLDOWN_SEC:    300,   // cooldown بين إعلانين
  AD_DAILY_MAX:       3000,   // أكثر إعلان يومي
  IP_MAX_ADS_PER_HR:  40,   // أكثر إعلان لكل IP بالساعة
  IP_MAX_REQ_PER_MIN: 60,   // أكثر طلب عام لكل IP بالدقيقة
  RISK_BAN_THRESHOLD: 100,  // risk score يؤدي لـ shadow ban
  TS_DRIFT_SEC:       300,  // أكثر فرق مقبول بالـ timestamp
  AD_TIMING_TOLERANCE_SEC: 2,
  RISK_DECAY_PER_DAY: 10,

  // 🎮 Coin Rain mini-game — جلسة سيرفر لكل جولة، لا تُرسَل نقاط من العميل أبداً
  GAME_ROUND_TICKETS:         600,   // تذاكر ثابتة لكل جولة مكتملة (السيرفر يقرر، لا العميل)
  GAME_ROUND_DURATION_SEC:     40,   // مدة الجولة الفعلية — لا تقبل إرسال أسرع من هذا
  GAME_ROUND_SESSION_TTL_SEC: 300,   // أقصى وقت لإرسال الجولة بعد بدئها (5 دقائق)
};

// ── App business-logic config (synced to frontend via init response) ──────────
const APP_CFG = {
  REF_TICKET_REWARD : 5000,   // competition tickets per referral
  REF_USDT_REWARD   : 0.03,  // USDT added to referrer balance per referral
  AD_USD_REWARD     : 0.001,  // USD per ad
  AD_DAILY_MAX      : CFG.AD_DAILY_MAX,
  WITHDRAW_MIN      : 0.07,
  PODIUM_PRIZES     : { first: 25, second: 10, third: 7 },
  LB_PRIZE_LABEL    : 'Each $1',
  // 💎 باقات شراء التذاكر مقابل TON — نفس القيم لازم تطابق أي عرض بالواجهة
  TICKET_PACKAGES: [
    { id: 'pkg_1',  tickets: 15000,  ton: 0.1  },
    { id: 'pkg_2',  tickets: 40000,  ton: 0.25 },
    { id: 'pkg_3',  tickets: 100000,  ton: 0.5  },
    { id: 'pkg_4',  tickets: 250000, ton: 1    },
  ],
  // توقيت المسابقة — اضبط COMPETITION_END_MS في Vercel env (Unix ms timestamp)
  // مثال: Date.now() + 20 * 24 * 60 * 60 * 1000 ← 20 يوم من الآن
  // للتعيين: node -e "console.log(Date.now() + 20*24*60*60*1000)"
  COMPETITION_END_MS: process.env.COMPETITION_END_MS
    ? parseInt(process.env.COMPETITION_END_MS, 10)
    : Date.now() + 20 * 24 * 60 * 60 * 1000,
};

// 🛡️ مدة المشاهدة المطلوبة — لكل شبكة إعلانات مدتها الحقيقية (عدّل القيم حسب شبكتك)
const AD_DURATIONS = {
  adsgram: 15,
  monetag: 16,
  telega:  16,
  default: 16,
};
// نافذة استخدام الـ token بعد انتهاء المدة المطلوبة — صلاحية ضيقة بدل 5 دقائق ثابتة
const AD_GRACE_SEC = 90;

// 🎯 عتبة المشاهدة الكاملة — أقل من هذه القيمة يُمنح 50% فقط من المكافأة
const AD_FULL_REWARD_MIN_SEC = 35;

const _db = neon(DATABASE_URL);
async function sql(query, params = []) {
  return await _db(query, params);
}

// ══════════════════════════════════════════════════════════════════════════════
//  TonCenter — التحقق الفعلي من وصول معاملة TON للخزينة قبل تسليم أي تذاكر
//  المطابقة الأساسية: التعليق on-chain (نص = telegram_id المستخدم، decoded تلقائياً
//  من toncenter بحقل in_msg.message لأنه simple comment) + المبلغ بالنانوتون + التوقيت.
//  عنوان المرسل (raw) يُستخدم كتأكيد إضافي لو موجود ومتطابق، لكن مش شرط أساسي —
//  لأن بعض المحافظ ممكن ترجع عنوان "غير bounceable/bounceable" مختلف شكلاً عن اللي
//  خزّناه من TonConnect، فيما التعليق + المبلغ كفاية للتأكد بدقة عالية.
//  لا نثق أبداً بمجرد رد "نجاح" من TonConnect بالفرونت.
// ══════════════════════════════════════════════════════════════════════════════
function normalizeTonAddr(addr) {
  if (!addr) return '';
  const parts = String(addr).trim().toLowerCase().split(':');
  if (parts.length !== 2) return String(addr).trim().toLowerCase();
  return `${parts[0]}:${parts[1].replace(/^0+/, '') || '0'}`;
}

async function findConfirmingTonTransaction({ treasury, senderRaw, nanotons, memo, sinceMs, depositId }) {
  if (!treasury) throw new Error('TREASURY_WALLET_ADDRESS not configured');

  const url = new URL(`${TONCENTER_BASE}/getTransactions`);
  url.searchParams.set('address', treasury);
  url.searchParams.set('limit', '40');
  if (TONCENTER_API_KEY) url.searchParams.set('api_key', TONCENTER_API_KEY);

  const resp = await fetch(url.toString());
  const rawBody = await resp.text();

  if (!resp.ok) {
    // 🪵 لوجينغ حقيقي — يظهر في Vercel logs بدل ما يُبلع بصمت كـ "pending"
    console.error(`[deposit#${depositId}] TonCenter HTTP ${resp.status}: ${rawBody.slice(0, 300)}`);
    throw new Error(`TonCenter HTTP ${resp.status}`);
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { console.error(`[deposit#${depositId}] TonCenter returned non-JSON: ${rawBody.slice(0, 300)}`); throw new Error('TonCenter bad JSON'); }

  if (!body?.ok || !Array.isArray(body.result)) {
    console.error(`[deposit#${depositId}] TonCenter body not ok:`, JSON.stringify(body).slice(0, 300));
    return null;
  }

  const wantSender = normalizeTonAddr(senderRaw);
  const wantValue  = String(nanotons);
  const wantMemo   = String(memo).trim();
  const sinceSec   = Math.floor(sinceMs / 1000) - 120; // هامش دقيقتين لفروق الساعة/الأرشيف

  console.error(`[deposit#${depositId}] checking ${body.result.length} txs on treasury — want value=${wantValue} memo="${wantMemo}" sender=${wantSender} since=${sinceSec}`);

  for (const tx of body.result) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    if (Number(tx.utime) < sinceSec) continue;
    if (String(inMsg.value) !== wantValue) continue;

    const txMemo = (inMsg.message || '').trim();
    const memoMatches   = wantMemo && txMemo === wantMemo;
    const senderMatches = inMsg.source && normalizeTonAddr(inMsg.source) === wantSender;

    // ✅ نقبل لو التعليق مطابق (الأقوى) أو لو العنوان مطابق — طالما المبلغ والتوقيت صح
    if (memoMatches || senderMatches) {
      console.error(`[deposit#${depositId}] MATCH found — memoMatches=${memoMatches} senderMatches=${senderMatches} hash=${tx.transaction_id?.hash}`);
      return { hash: tx.transaction_id?.hash || null, utime: tx.utime };
    }
  }

  console.error(`[deposit#${depositId}] no match in this batch`);
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Ad Token — موقّع (HMAC) وغير قابل للتزوير، يُنشأ على السيرفر فقط
// ══════════════════════════════════════════════════════════════════════════════
// 🛡️ بدون INTERNAL_SECRET، أي شخص يقدر يحسب AD_TOKEN_KEY ويولّد ad tokens مزوّرة
// (كان فيه fallback ثابت ومكتوب بالكود — ثغرة). الآن: fail-closed بدل تشغيل غير آمن.
if (!INTERNAL_SECRET) {
  throw new Error('[FATAL] INTERNAL_SECRET env var is not set — refusing to run with an insecure fallback key');
}

const AD_TOKEN_KEY = crypto
  .createHmac('sha256', 'ad-token-v1')
  .update(INTERNAL_SECRET)
  .digest();

function signAdToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AD_TOKEN_KEY).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyAdToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', AD_TOKEN_KEY).update(b64).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
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
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_updated_at TIMESTAMPTZ`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_seen BOOLEAN NOT NULL DEFAULT FALSE`);
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_game_round TIMESTAMPTZ`); // 🎮 Coin Rain — آخر جولة لعبة أُرسلت
  // 🟢 last_seen_at — نبضة "أونلاين" تتحدث مع كل طلب من المستخدم (يستخدمها أدمن بانل لعرض المتصلين الآن)
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
  // 🎮 عملات الدولار داخل اللعبة (0.0001 USDT للعملة) — توسيع الدقة العشرية لدعم مبالغ صغيرة جداً
  await sql(`ALTER TABLE users ALTER COLUMN balance_usd TYPE NUMERIC(14,6)`);

  // 🎮 جلسات اللعبة — تُنشأ من السيرفر حصراً، لا تُرسَل نقاط من العميل أبداً
  await sql(`CREATE TABLE IF NOT EXISTS game_sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used            BOOLEAN     NOT NULL DEFAULT FALSE,
    double_approved BOOLEAN     NOT NULL DEFAULT FALSE,
    seed            INT,
    sequence_json   TEXT
  )`);
  await sql(`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS seed INT`);
  await sql(`ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS sequence_json TEXT`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_game_sessions_user ON game_sessions(user_id, used, created_at)`);

  // جلسات الإعلانات — كل إعلان له token مؤقت (موقّع HMAC، غير قابل للتزوير)
  await sql(`CREATE TABLE IF NOT EXISTS ad_sessions (
    token      TEXT PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ad_type    TEXT NOT NULL DEFAULT 'default',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used       BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await sql(`ALTER TABLE ad_sessions ADD COLUMN IF NOT EXISTS ad_type TEXT NOT NULL DEFAULT 'default'`);
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
  // 💎 ايداعات TON — شراء تذاكر المسابقة عبر TonConnect
  // status: pending → confirmed (بعد التحقق من TonCenter) أو failed (انتهت المهلة بدون إيجاد المعاملة)
  await sql(`CREATE TABLE IF NOT EXISTS deposits (
    id              SERIAL PRIMARY KEY,
    user_id         INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    package_id      TEXT NOT NULL,
    tickets         INT  NOT NULL,
    ton_amount      NUMERIC(18,9) NOT NULL,
    wallet_address  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    tx_hash         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at    TIMESTAMPTZ
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, status)`);
  // 🛡️ منع التلاعب: نفس معاملة TON (tx_hash) ميقدرش يأكد غير صف ايداع واحد بس —
  // بيمنع المستخدم من عمل عدة depositInit لنفس الباكدج ودفع مرة وحدة عشان
  // ياخد التذاكر مضاعفة عن طريق إعادة polling كل صف على حدة (replay attack).
  await sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_txhash_unique ON deposits(tx_hash) WHERE tx_hash IS NOT NULL`);
  await sql(`CREATE TABLE IF NOT EXISTS ad_watches (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward     NUMERIC(14,6) NOT NULL DEFAULT 0.001,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // 💵 صارت مكافأة الإعلان دولار (0.001$) بدل تذاكر — توسيع الدقة العشرية لدعم القيم الصغيرة
  await sql(`ALTER TABLE ad_watches ALTER COLUMN reward TYPE NUMERIC(14,6)`);
  await sql(`ALTER TABLE ad_watches ALTER COLUMN reward SET DEFAULT 0.001`);

  // 📊 إجمالي الإعلانات اليومي لكل المستخدمين مجتمعين — صف واحد لكل يوم، يُحدَّث ذرياً
  // (بدل COUNT(*) على ad_watches اللي بتكبر بمرور الوقت — قراءة/كتابة O(1))
  await sql(`CREATE TABLE IF NOT EXISTS ad_daily_stats (
    day         DATE PRIMARY KEY,
    total_count INT  NOT NULL DEFAULT 0
  )`);

  // 📊 جدول مستقل تماماً — فقط لتتبّع عدد إعلانات "مضاعفة اللعبة" (double reward)
  // لا علاقة له بـ daily_ads ولا بـ AD_DAILY_MAX ولا بأي حد آخر — عدّاد إحصائي بحت
  await sql(`CREATE TABLE IF NOT EXISTS game_double_ad_stats (
    day         DATE PRIMARY KEY,
    total_count INT  NOT NULL DEFAULT 0
  )`);

  // 🛡️ تأكيدات Adsgram Reward URL — server-to-server، لا تمر من متصفح المستخدم أبداً
  // كل صف يعني "Adsgram أكّد أن هذا المستخدم شاهد إعلاناً فعلياً الآن"
  await sql(`CREATE TABLE IF NOT EXISTS ad_reward_confirmations (
    id          SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_arc_lookup ON ad_reward_confirmations (telegram_id, consumed, created_at)`);
  await sql(`CREATE TABLE IF NOT EXISTS activity_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL,
    meta       JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_users_pts ON users (pts DESC)`);

  // 🛡️ Device fingerprints — سجل تاريخي (many-to-many) لكل الحسابات اللي ظهرت
  // على كل فنغربرنت، للمراجعة الإدارية فقط — القرار الفعلي بيتحدد من device_fp_owner
  await sql(`CREATE TABLE IF NOT EXISTS device_fingerprints (
    fingerprint  TEXT    NOT NULL,
    telegram_id  BIGINT  NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (fingerprint, telegram_id)
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_device_fp ON device_fingerprints(fingerprint)`);

  // 🛡️ Device fingerprint ownership — UNIQUE(fingerprint) لضمان حجز atomic
  // (INSERT...ON CONFLICT DO NOTHING RETURNING) بدل SELECT-ثم-INSERT اللي فيه race condition
  await sql(`CREATE TABLE IF NOT EXISTS device_fp_owner (
    fingerprint  TEXT PRIMARY KEY,
    telegram_id  BIGINT  NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // 🔄 Backfill لمرة واحدة: أقدم telegram_id مسجّل لكل فنغربرنت في السجل التاريخي
  // يصير هو المالك الرسمي، عشان أول طلب جديد بعد النشر ما "يسرقش" الملكية
  await sql(`
    INSERT INTO device_fp_owner (fingerprint, telegram_id, created_at)
    SELECT fingerprint, telegram_id, created_at FROM (
      SELECT fingerprint, telegram_id, created_at,
             ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY created_at ASC) AS rn
      FROM device_fingerprints
    ) t
    WHERE rn = 1
    ON CONFLICT (fingerprint) DO NOTHING
  `);

  // 🎁 تتبع حالة الإحالة — referral_activated يصير TRUE بعد الوصول لـ 3000 نقطة
  await sql(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_activated BOOLEAN NOT NULL DEFAULT FALSE`);

  // جدول المسابقات — يخزن توقيت كل موسم (start/end)
  // السرفر يقرأ منه ويرسل COMPETITION_END_MS للفرونت عبر init response
  await sql(`CREATE TABLE IF NOT EXISTS competition (
    id         SERIAL PRIMARY KEY,
    name       TEXT        NOT NULL DEFAULT 'Season 1',
    start_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 days',
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // seed: لو ما في موسم نشط → أنشئ واحد تلقائي 20 يوم من الآن
  await sql(`
    INSERT INTO competition (name, start_at, end_at, active)
    SELECT 'Season 1', NOW(), NOW() + INTERVAL '20 days', TRUE
    WHERE NOT EXISTS (SELECT 1 FROM competition WHERE active = TRUE)
  `);

  // 🏆 يتتبّع أي موسم تم توزيع جوائزه فعلاً — يمنع التوزيع المكرر
  await sql(`ALTER TABLE competition ADD COLUMN IF NOT EXISTS prize_distributed BOOLEAN NOT NULL DEFAULT FALSE`);
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

// ══════════════════════════════════════════════════════
// 🎮 Seed-based sequence generator — mirrors client PRNG
//    نفس Mulberry32 المستخدم في game.js (يجب أن يبقيا متطابقين)
// ══════════════════════════════════════════════════════
function _makePrng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 🎮 عدد عملات USDT الثابت لكل جولة — عدّل هذا الرقم فقط للتحكم بالعدد
const GAME_USDT = 2;
// 🎮 قيمة عملة الدولار الواحدة (0.0001 × GAME_USDT = الحد الأقصى لكل جولة)
const GAME_DOLLAR_VALUE = 0.0001;

// ticket/bomb فقط — بدون دولار (الدولار يُفرض في فتحات ثابتة عبر _pickDollarSlots أدناه)
const _GAME_TYPES   = [{ w: 58, val: 4 }, { w: 20, val: 16 }, { w: 22, val: -3 }];
const _GAME_TOTAL_W = _GAME_TYPES.reduce((a, t) => a + t.w, 0); // 100
const _GAME_SEQ_LEN = 90; // أقصى عدد عناصر يمكن أن تظهر في 40 ثانية

// 🎮 يختار GAME_USDT فتحة ثابتة (indices) من التسلسل ستكون عملات دولار — عبر PRNG منفصل
// تماماً عن تسلسل الأنواع الأساسي (type/spawnCd/x/bias) حتى لا يؤثر على عددها المُستهلَك
function _pickDollarSlots(seed) {
  const rng2 = _makePrng((seed + 0x9E3779B9) >>> 0);
  const slots = new Set();
  let guard = 0;
  while (slots.size < GAME_USDT && guard < 500) {
    guard++;
    slots.add(Math.floor(rng2() * _GAME_SEQ_LEN));
  }
  return slots;
}

function generateGameSequence(seed) {
  const rng = _makePrng(seed);
  const dollarSlots = _pickDollarSlots(seed);
  const seq = [];
  for (let i = 0; i < _GAME_SEQ_LEN; i++) {
    const typeRoll = rng(); // استهلاك 1: نوع العنصر  (mirrors pickType)
    rng();                  // استهلاك 2: spawnCd      (mirrors spawnItem)
    const xRnd    = rng(); // استهلاك 3: موقع X        (mirrors spawnItem)
    const biasRnd = rng(); // استهلاك 4: center-bias   (mirrors spawnItem — مُستهلَك دائماً)

    let val = _GAME_TYPES[0].val, isBomb = false;
    let r = typeRoll * _GAME_TOTAL_W, pushed = false;
    for (const t of _GAME_TYPES) {
      r -= t.w;
      if (r <= 0) { val = t.val; isBomb = t.val < 0; pushed = true; break; }
    }
    if (!pushed) isBomb = false;

    const isDollar = dollarSlots.has(i);
    if (isDollar) { val = 0; isBomb = false; } // فتحة مفروضة كعملة دولار — تتجاوز النوع العشوائي

    // 🛡️ x مُعيَّن بـ seed — قنابل: 80% في المنتصف (30%–70%) ، 20% عشوائي
    const xNorm = isBomb
      ? (biasRnd < 0.80
          ? 0.30 + xRnd * 0.40   // zone مركزية
          : 0.05 + xRnd * 0.90)  // كامل العرض
      : 0.05 + xRnd * 0.90;      // تذاكر/دولار: عشوائي كامل

    seq.push({ val, x: xNorm, d: isDollar ? 1 : 0 }); // { val: -3|0|4|16, x: 0.00–1.00, d: عملة دولار؟ }
  }
  return seq;
}

async function addRisk(userId, points, reason) {
  console.warn(`[RISK] user=${userId} +${points} reason=${reason}`);
  const rows = await sql(
    `UPDATE users SET risk_score = risk_score + $1, risk_updated_at = NOW() WHERE id = $2
     RETURNING risk_score, shadow_banned`,
    [points, userId]
  );
  if (!rows[0].shadow_banned && rows[0].risk_score >= CFG.RISK_BAN_THRESHOLD) {
    await sql(`UPDATE users SET shadow_banned = TRUE WHERE id = $1`, [userId]);
    console.warn(`[SHADOWBAN] auto-banned user=${userId}`);
  }
}

// 🛡️ يقلل risk_score تدريجياً مع الوقت (RISK_DECAY_PER_DAY نقطة/يوم) — يمنع
// تراكم دائم من false positives، ويرفع shadow ban تلقائياً لو رجع الـ score صفر
async function decayRisk(userId) {
  const rows = await sql(`
    WITH decayed AS (
      SELECT id,
             GREATEST(0, risk_score - FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(risk_updated_at, created_at))) / 86400) * $2)::INT AS new_score
      FROM users WHERE id = $1
    )
    UPDATE users u SET
      risk_score      = d.new_score,
      risk_updated_at = NOW(),
      shadow_banned   = CASE WHEN d.new_score = 0 THEN FALSE ELSE u.shadow_banned END
    FROM decayed d
    WHERE u.id = d.id
    RETURNING u.risk_score, u.shadow_banned
  `, [userId, CFG.RISK_DECAY_PER_DAY]);
  return rows[0];
}

// 🛡️ هاش لكل (initData + token) لا لكل initData لحالها.
// initData بتيليجرام ثابتة طوال الجلسة (~ساعة، نفس مدة TTL تحت)، فلو اعتمدنا
// عليها فقط، أي إعلان ثاني بنفس الجلسة كان يُرفض كـ "مكرر". إضافة الـ token
// (فريد ومُصدَر لكل إعلان) تحل التضارب وتحافظ على نفس مستوى الحماية ضد replay.
async function checkAndMarkInitHash(initData, token) {
  const hash = crypto.createHash('sha256').update(initData + ':watchAd:' + token).digest('hex');
  await sql(`DELETE FROM used_init_hashes WHERE used_at < NOW() - INTERVAL '1 hour'`);
  try {
    await sql(`INSERT INTO used_init_hashes (hash) VALUES ($1)`, [hash]);
    return true;  // جديد ✓
  } catch {
    return false; // مكرر ✗
  }
}

// 📊 يزيد إجمالي إعلانات اليوم (كل المستخدمين) بشكل ذري — تُستدعى من watchAd و gameAdVerify
async function bumpAdDailyStat() {
  await sql(`
    INSERT INTO ad_daily_stats (day, total_count)
    VALUES (CURRENT_DATE, 1)
    ON CONFLICT (day) DO UPDATE SET total_count = ad_daily_stats.total_count + 1
  `);
}

// 📊 عدّاد مستقل بحت لإعلانات مضاعفة اللعبة فقط — لا يمس daily_ads ولا AD_DAILY_MAX إطلاقاً
async function bumpGameDoubleAdStat() {
  await sql(`
    INSERT INTO game_double_ad_stats (day, total_count)
    VALUES (CURRENT_DATE, 1)
    ON CONFLICT (day) DO UPDATE SET total_count = game_double_ad_stats.total_count + 1
  `);
}

// 🛡️ يستهلك تأكيد Adsgram (إن وُجد) لهذا المستخدم — يُستدعى من watchAd
// يعيد true فقط لو وصل تأكيد server-to-server حقيقي من Adsgram لم يُستهلك بعد
async function consumeAdsgramConfirmation(telegramId) {
  await sql(`DELETE FROM ad_reward_confirmations WHERE created_at < NOW() - INTERVAL '10 minutes'`);
  const rows = await sql(`
    UPDATE ad_reward_confirmations
    SET consumed = TRUE
    WHERE id = (
      SELECT id FROM ad_reward_confirmations
      WHERE telegram_id = $1 AND consumed = FALSE
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING id
  `, [telegramId]);
  return rows.length > 0;
}

async function upsertUser(tgUser, startParam = null, fp = null) {
  const { id: telegram_id, username = null, first_name = null, photo_url = null } = tgUser;
  const refCode = `REF${telegram_id}`;

  // Only brand-new users can be attached to a referrer, and only once.
  const existing = await sql('SELECT id FROM users WHERE telegram_id = $1', [telegram_id]);
  const isNewUser = existing.length === 0;

  let referredBy = null;
  if (isNewUser && startParam) {
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

  // 🛡️ Device fingerprint — يحظر فقط الحسابات الجديدة من نفس الجهاز
  // ⚠️ الحجز atomic عبر device_fp_owner (UNIQUE fingerprint) بدل SELECT-ثم-INSERT
  // (على Neon مافيش transaction بين الاستعلامات، فـ check-then-act كان بيسمح
  // لحسابين يسجلوا بنفس اللحظة تقريباً ويفوتوا الحظر — race condition)
  if (fp) {
    try {
      if (isNewUser) {
        const claim = await sql(
          `INSERT INTO device_fp_owner (fingerprint, telegram_id)
           VALUES ($1, $2)
           ON CONFLICT (fingerprint) DO NOTHING
           RETURNING telegram_id`,
          [fp, telegram_id]
        );

        if (claim.length === 0) {
          // الفنغربرنت محجوز فعلاً لحساب تاني → احظر الحساب الجديد فوراً
          const owner = await sql(
            'SELECT telegram_id FROM device_fp_owner WHERE fingerprint = $1',
            [fp]
          );
          await sql('UPDATE users SET banned = TRUE WHERE telegram_id = $1', [telegram_id]);
          console.warn(`[DEVICE-BAN] banned NEW account ${telegram_id} — device already owned by ${owner[0]?.telegram_id}`);
        } else {
          console.log(`[DEVICE-FP] owner registered for ${telegram_id}`);
        }
      }

      // سجل تاريخي (many-to-many) لكل الحسابات اللي ظهرت على هذا الفنغربرنت — للمراجعة الإدارية بس
      await sql(
        'INSERT INTO device_fingerprints (fingerprint, telegram_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [fp, telegram_id]
      );
    } catch (fpErr) {
      console.error('[DEVICE-FP] error:', fpErr.message);
    }
  }

  // 🕐 إشعار "إحالة معلّقة" عند التسجيل — المكافأة الفعلية تُعطى فقط عند الوصول لـ 3000 نقطة
  if (isNewUser && referredBy) {
    const joinerName = first_name || username || 'Someone';

    let pendingReferrals = 1;
    try {
      const cntRows = await sql(
        'SELECT COUNT(*)::INT AS cnt FROM users WHERE referred_by = $1 AND referral_activated = FALSE',
        [referredBy]
      );
      pendingReferrals = cntRows[0]?.cnt ?? 1;
    } catch (_) {}

    sendTelegramMessage(
      referredBy,
      `🔔 *New Pending Referral!*\n\n` +
      `👤 *${joinerName}* just joined using your link.\n\n` +
      `📊 Status: *⏳ Pending*\n` +
      `🎯 Condition: *Reach 3,000 pts to activate*\n` +
      `👥 *Total Pending: ${pendingReferrals}*\n\n` +
      `💡 Once they hit 3,000 pts you'll get your reward automatically!`
    ).catch(e => console.error('[referral-pending bot notify]', e.message));
  }

  const rows = await sql('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
  return rows[0];
}

// 🎁 فحص وتفعيل الإحالة — يُستدعى بعد كل مكافأة نقاط
// يعطي المُحيل مكافأته فوراً عند وصول المُحال لـ 3000 نقطة
async function checkReferralActivation(userId) {
  try {
    const rows = await sql(
      'SELECT referred_by, referral_activated, pts, first_name, username FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0] || !rows[0].referred_by || rows[0].referral_activated) return;
    if (Number(rows[0].pts) < 3000) return;

    // ✅ وصل للـ 3000 — فعّل الإحالة وامنح المُحيل مكافأته
    await sql('UPDATE users SET referral_activated = TRUE WHERE id = $1', [userId]);

    try {
      await sql(`
        UPDATE users
        SET pts         = pts + $1,
            balance_usd = balance_usd + $2
        WHERE telegram_id = $3
      `, [APP_CFG.REF_TICKET_REWARD, APP_CFG.REF_USDT_REWARD, rows[0].referred_by]);
      console.log(`[referral] activated & credited — user=${userId} referrer=${rows[0].referred_by}`);
    } catch (creditErr) {
      console.error('[referral-activate] credit SQL failed:', creditErr.message);
    }

    // إحصاء الإحالات المفعّلة للمُحيل
    let activeReferrals = 1;
    try {
      const cntRows = await sql(
        'SELECT COUNT(*)::INT AS cnt FROM users WHERE referred_by = $1 AND referral_activated = TRUE',
        [rows[0].referred_by]
      );
      activeReferrals = cntRows[0]?.cnt ?? 1;
    } catch (_) {}

    const joinerName = rows[0].first_name || rows[0].username || 'Someone';

    sendTelegramMessage(
      rows[0].referred_by,
      `🎉 *New Referral Activated!*\n\n` +
      `Welcome, your referral is now active.\n\n` +
      `👤 *${joinerName}*\n` +
      `✅ Active\n\n` +
      `🎁 *You Earned*\n` +
      `🪙 *${APP_CFG.REF_TICKET_REWARD.toLocaleString()} Points*\n` +
      `💵 *${APP_CFG.REF_USDT_REWARD} USDT*\n\n` +
      `👥 *Total Active Referrals: ${activeReferrals}*\n\n` +
      `🚀 Keep inviting friends to maximize your earnings!`
    ).catch(e => console.error('[referral-activate bot notify]', e.message));
  } catch (err) {
    console.error('[checkReferralActivation] error:', err.message);
  }
}

async function getUserRank(userId) {
  const rows = await sql(`
    SELECT (COUNT(*) + 1)::INT AS rank
    FROM users WHERE pts > (SELECT pts FROM users WHERE id = $1)
  `, [userId]);
  return rows[0]?.rank ?? 1;
}

async function getActiveCompetition() {
  const rows = await sql(`
    SELECT id, name, start_at, end_at
    FROM competition
    WHERE active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return rows[0] || null;
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
//  🏆 توزيع جوائز المسابقة — تُستدعى مع كل طلب
//
//  لو انتهى وقت الموسم النشط (end_at <= NOW) ولم تُوزَّع جوائزه بعد:
//   1. كل مستخدم يأخذ حصته من الجوائز في balance_usd حسب ترتيبه النهائي
//      (المركز 1/2/3 → PODIUM_PRIZES، المراكز 4-11 → $1 لكل واحد، نفس
//      الترتيب المعروض في الـ leaderboard/podium).
//   2. تصفير نقاط الجميع (pts = 0) وبدء موسم جديد تلقائياً لمدة 20 يوم.
//
//  🛡️ آمنة عند التشغيل المتزامن (Vercel serverless = عدة invocations بنفس
//  اللحظة): الـ UPDATE الأول بالأسفل يعمل "claim" ذرّي — فقط الـ invocation
//  اللي يرجّع صف هو المسؤول عن التوزيع، والباقي يرجعوا فوراً بدون أي تأثير.
// ══════════════════════════════════════════════════════════════════════════════
async function distributeSeasonPrizes() {
  const claimed = await sql(`
    UPDATE competition
    SET active = FALSE, prize_distributed = TRUE
    WHERE active = TRUE AND prize_distributed = FALSE AND end_at <= NOW()
    RETURNING id, name
  `);
  if (claimed.length === 0) return; // لا يوجد موسم منتهٍ بانتظار التوزيع

  const endedComp = claimed[0];
  const { first, second, third } = APP_CFG.PODIUM_PRIZES;
  const OTHERS_PRIZE = 1; // "Each $1" — المراكز 4 إلى 11 (نفس LB_PRIZE_LABEL)

  // 🏆 منح الجوائز دفعة واحدة على balance_usd حسب نفس ترتيب getLeaderboard
  // (pts DESC, telegram_id ASC) — pts > 0 فقط، لمنع منح جوائز لحسابات لم تشارك
  const winners = await sql(`
    WITH ranked AS (
      SELECT id, telegram_id,
             ROW_NUMBER() OVER (ORDER BY pts DESC, telegram_id ASC) AS rnk
      FROM users
      WHERE pts > 0
    ),
    prized AS (
      SELECT id, telegram_id, rnk,
        CASE
          WHEN rnk = 1 THEN $1::NUMERIC
          WHEN rnk = 2 THEN $2::NUMERIC
          WHEN rnk = 3 THEN $3::NUMERIC
          WHEN rnk BETWEEN 4 AND 11 THEN $4::NUMERIC
          ELSE 0
        END AS prize
      FROM ranked
      WHERE rnk <= 11
    )
    UPDATE users u
    SET balance_usd = balance_usd + p.prize
    FROM prized p
    WHERE u.id = p.id AND p.prize > 0
    RETURNING u.telegram_id, p.rnk, p.prize
  `, [first, second, third, OTHERS_PRIZE]);

  // 🔄 تصفير نقاط الجميع — موسم جديد يبدأ بترتيب نظيف للكل
  await sql(`UPDATE users SET pts = 0`);

  // ▶️ إنشاء الموسم التالي (الاسم: "Season N" → "Season N+1")
  const m       = /(\d+)\s*$/.exec(endedComp.name || '');
  const nextNum = m ? (parseInt(m[1], 10) + 1) : 2;
  const nextName = m
    ? endedComp.name.replace(/\d+\s*$/, String(nextNum))
    : `${endedComp.name || 'Season'} ${nextNum}`;

  await sql(`
    INSERT INTO competition (name, start_at, end_at, active, prize_distributed)
    VALUES ($1, NOW(), NOW() + INTERVAL '20 days', TRUE, FALSE)
  `, [nextName]);

  console.log(`[competition] "${endedComp.name}" ended — ${winners.length} prizes paid, started "${nextName}"`);

  // ✅ إشعار بوت للفائزين (best-effort — لا يوقف التنفيذ)
  for (const w of winners) {
    const prizeAmount = parseFloat(w.prize);
    sendTelegramMessage(
      Number(w.telegram_id),
      `🏆 *${endedComp.name} Has Ended!*\n\nYou finished *#${w.rnk}* on the leaderboard and won *+$${prizeAmount.toFixed(2)}* 🎉\n\nIt's already credited to your balance — withdraw anytime!\n\nA new season just started. Good luck! 🚀`
    ).catch(e => console.error('[prize bot notify]', e.message));
  }
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

  // 🏆 توزيع جوائز المسابقة فور انتهائها وبدء موسم جديد — best-effort،
  // لا يوقف الطلب الحالي حتى لو فشل (سيُعاد المحاولة في الطلب التالي)
  try {
    await distributeSeasonPrizes();
  } catch (err) {
    console.error('[Prize distribution error]', err.message);
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
      dbUser = await upsertUser(tgUser, data.startParam || null, body.fp || null);
    } catch (err) {
      console.error('[upsertUser error]', err.message);
      return res.status(500).json({ ok: false, error: 'DB error: ' + err.message });
    }

    // 🟢 نبضة أونلاين — best-effort وغير محجوبة (fire-and-forget) عشان ما تبطئش الرد على المستخدم
    sql(`UPDATE users SET last_seen_at = NOW() WHERE id = $1`, [dbUser.id])
      .catch(err => console.error('[last_seen_at update]', err.message));

    // 🛡️ تلاشي تدريجي لـ risk_score مع الوقت + رفع شادو-بان تلقائي لو رجع الـ score صفر
    if (dbUser.risk_score > 0 || dbUser.shadow_banned) {
      try {
        const decayed = await decayRisk(dbUser.id);
        if (decayed) {
          dbUser.risk_score    = decayed.risk_score;
          dbUser.shadow_banned = decayed.shadow_banned;
        }
      } catch (err) {
        console.error('[decayRisk error]', err.message);
      }
    }
    // ملاحظة: شيلنا الرد العام الموحّد لـ shadow ban (كان يكسر صفحات مثل init
    // لكل المحظورين). صار التعامل معه داخل كل case على حدة (watchAd / withdraw)
    // فقط — أي الأماكن اللي فيها مكسب فعلي (نقاط / فلوس).
  }

  // ── Router ─────────────────────────────────────────────────────────────────
  try {
    switch (type) {

      case 'init': {
        const [userRank, leaderboard, refStats, competition] = await Promise.all([
          getUserRank(dbUser.id),
          getLeaderboard(11),
          sql(`SELECT
                COUNT(*)::INT                                        AS ref_count,
                COUNT(*) FILTER (WHERE referral_activated = TRUE)::INT  AS active_count,
                COUNT(*) FILTER (WHERE referral_activated = FALSE)::INT AS pending_count,
                (COUNT(*) FILTER (WHERE referral_activated = TRUE) * $2)::INT AS ref_earned
               FROM users WHERE referred_by = $1`, [dbUser.telegram_id, APP_CFG.REF_TICKET_REWARD]),
          getActiveCompetition()
        ]);

        // دمج توقيت المسابقة من DB في الـ config
        const configWithCompetition = {
          ...APP_CFG,
          COMPETITION_END_MS:   competition ? new Date(competition.end_at).getTime()   : APP_CFG.COMPETITION_END_MS,
          COMPETITION_START_MS: competition ? new Date(competition.start_at).getTime() : Date.now(),
          COMPETITION_NAME:     competition?.name ?? 'Season 1',
        };
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
            rank:          userRank,
            banned:        dbUser.banned || false,
            onboarding_seen: dbUser.onboarding_seen || false
          },
          leaderboard: leaderboard.map(r => ({
            telegram_id: Number(r.telegram_id),
            name: r.name,
            photo_url: r.photo_url || null,
            pts:  Number(r.pts),
            rank: r.rank
          })),
          referral: {
            count:   refStats[0]?.ref_count    ?? 0,
            active:  refStats[0]?.active_count  ?? 0,
            pending: refStats[0]?.pending_count ?? 0,
            earned:  refStats[0]?.ref_earned    ?? 0
          },
          config: configWithCompetition
        });
      }

      // ✅ markOnboardingSeen — يُسجَّل في DB بدل localStorage (يضمن مشاهدة واحدة فقط حتى بعد مسح الكاش)
      case 'markOnboardingSeen': {
        await sql(`UPDATE users SET onboarding_seen = TRUE WHERE id = $1`, [dbUser.id]);
        return res.json({ ok: true });
      }

      // 🛡️ startAd — الخطوة الأولى: احجز token موقّع قبل تشغيل الإعلان
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

        // 🛡️ مدة المشاهدة تُحدَّد من السيرفر حسب نوع الإعلان — لا توجد قيمة ثابتة 30s
        const adType = (typeof data.adType === 'string' ? data.adType.toLowerCase() : 'default');
        const dur    = AD_DURATIONS[adType] || AD_DURATIONS.default;

        // 🔒 Payload موقّع HMAC — لا يمكن للعميل تعديل uid/adType/iat/dur ولا إنشاء token بدون السر
        const token = signAdToken({ uid: dbUser.id, adType, dur, iat: Date.now() });

        await sql(`INSERT INTO ad_sessions (token, user_id, ad_type) VALUES ($1, $2, $3)`, [token, dbUser.id, adType]);
        return res.json({ ok: true, token });
      }

      case 'watchAd': {
        const { token } = data;

        // 🛡️ تحقق التوقيع أولاً — أي تلاعب أو تزوير يُرفض فوراً قبل أي وصول لقاعدة البيانات
        const payload = verifyAdToken(token);
        if (!payload || typeof payload.uid !== 'number' || typeof payload.iat !== 'number') {
          await addRisk(dbUser.id, 30, 'no_token');
          return res.status(400).json({ ok: false, error: 'Invalid session' });
        }

        // 🛡️ التحقق إن الـ token صادر لهذا المستخدم بالضبط
        if (payload.uid !== dbUser.id) {
          await addRisk(dbUser.id, 80, 'token_stolen');
          return res.status(403).json({ ok: false, error: 'Session mismatch' });
        }

        // 🛡️ IP limit للإعلانات
        const ipAdOk = await checkIPLimit(clientIP, 'hr');
        if (!ipAdOk) return res.status(429).json({ ok: false, error: 'Too many ads from this network' });

        // جلب الجلسة (one-time use — حماية إضافية حتى لو التوقيع صحيح)
        const sessions = await sql(`SELECT * FROM ad_sessions WHERE token = $1`, [token]);
        if (sessions.length === 0) {
          await addRisk(dbUser.id, 40, 'fake_token');
          return res.status(400).json({ ok: false, error: 'Invalid session' });
        }
        const session = sessions[0];

        if (session.user_id !== dbUser.id) {
          await addRisk(dbUser.id, 80, 'token_stolen');
          return res.status(403).json({ ok: false, error: 'Session mismatch' });
        }

        if (session.used) {
          await addRisk(dbUser.id, 60, 'used_token');
          return res.status(400).json({ ok: false, error: 'Session already used' });
        }

        // 🛡️ مدة المشاهدة المطلوبة محسوبة من التوكن نفسه (موقّعة من السيرفر، لا يتحكم بها العميل)
        const requiredDur = AD_DURATIONS[payload.adType] || AD_DURATIONS.default;
        const sessionAge  = (Date.now() - payload.iat) / 1000;

        // 🛡️ لازم مضى وقت كافٍ — إثبات المشاهدة الفعلية
        // (مع هامش صغير لفروقات الشبكة/الجهاز — تحميل SDK وعرض الإعلان
        // عادة بياخذوا أطول من requiredDur أصلاً)
        if (sessionAge < requiredDur - CFG.AD_TIMING_TOLERANCE_SEC) {
          await addRisk(dbUser.id, 70, `too_fast_${Math.round(sessionAge)}s`);
          return res.status(400).json({ ok: false, error: 'Ad not fully watched' });
        }

        // 🛡️ نافذة صلاحية ضيقة (مدة الإعلان + هامش صغير) بدل صلاحية ثابتة 5 دقائق
        if (sessionAge > requiredDur + AD_GRACE_SEC) {
          await sql(`DELETE FROM ad_sessions WHERE token = $1`, [token]);
          await addRisk(dbUser.id, 20, `token_expired_${Math.round(sessionAge)}s`);
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

        // 🛡️ بوابة Adsgram Reward URL — تمنع السكربتات من تزوير "المشاهدة" بمجرد الانتظار
        // مفعّلة فقط لـ adType === 'adsgram' وفقط بعد ضبط ADSGRAM_REWARD_SECRET في env
        // لازم وصل تأكيد server-to-server حقيقي من Adsgram لهذا المستخدم قبل منح النقاط
        if (payload.adType === 'adsgram' && process.env.ADSGRAM_REWARD_SECRET) {
          const confirmed = await consumeAdsgramConfirmation(dbUser.telegram_id);
          if (!confirmed) {
            // قد يكون تأكيد Adsgram لم يصل بعد (تأخير شبكة) — اطلب من العميل إعادة المحاولة بعد قليل
            return res.status(202).json({ ok: false, error: 'pending_confirmation', retryAfterMs: 1500 });
          }
        }

        // 🛡️ منع replay — يُسجَّل هنا فقط بعد تأكيد Adsgram حتى تنجح إعادة المحاولة عند pending_confirmation
        const hashOk = await checkAndMarkInitHash(rawInitData, token);
        if (!hashOk) {
          await addRisk(dbUser.id, 50, 'replay_initData');
          return res.status(400).json({ ok: false, error: 'Duplicate request' });
        }

        const AD_REWARD = APP_CFG.AD_USD_REWARD;

        // 🎯 تحديد المكافأة: أقل من AD_FULL_REWARD_MIN_SEC → 50% فقط
        const isPartialWatch = sessionAge < AD_FULL_REWARD_MIN_SEC;
        const actualReward   = isPartialWatch ? +(AD_REWARD * 0.5).toFixed(6) : AD_REWARD;

        // 🛡️ Shadow ban — كل الفحوصات أعلاه نجحت بشكل طبيعي (نفس تجربة مستخدم حقيقي)،
        // بس ما رايح نمنح نقاط فعلية. الرد يبدو ناجح عشان المخترق ما يلاحظ شي،
        // وما عاد بيؤثر على باقي الصفحات (init وغيرها) كما كان سابقاً.
        if (dbUser.shadow_banned) {
          await sql(`UPDATE ad_sessions SET used = TRUE WHERE token = $1`, [token]);
          const fakeRank = await getUserRank(dbUser.id);
          return res.json({
            ok:        true,
            reward:    actualReward,
            partial:   isPartialWatch,
            rankUp:    false,
            newRank:   fakeRank,
            rankDelta: 0,
            chatId:    null
          });
        }

        const rankBefore = await getUserRank(dbUser.id);

        // 🔒 Atomic update
        await sql(`
          UPDATE users SET
            balance_usd   = balance_usd + $1,
            last_ad_watch = NOW(),
            daily_ads     = CASE WHEN last_ad_date = CURRENT_DATE THEN daily_ads + 1 ELSE 1 END,
            last_ad_date  = CURRENT_DATE
          WHERE id = $2
        `, [actualReward, dbUser.id]);

        // وسّم الـ token كمستخدم
        await sql(`UPDATE ad_sessions SET used = TRUE WHERE token = $1`, [token]);
        await sql('INSERT INTO ad_watches (user_id, reward) VALUES ($1, $2)', [dbUser.id, actualReward]);
        await bumpAdDailyStat(); // 📊 إجمالي إعلانات اليوم لكل المستخدمين

        // 🎁 فحص تفعيل الإحالة — await لضمان إرسال الإشعار قبل انتهاء الدالة
        await checkReferralActivation(dbUser.id);

        const rankAfter  = await getUserRank(dbUser.id);
        const rankUp     = rankAfter < rankBefore;

        // ✅ إشعار rank-up مباشر من الباكند
        if (rankUp) {
          sendTelegramMessage(
            Number(dbUser.telegram_id),
            `🏆 *Rank Up!*\n\n` +
            `You just climbed to *#${rankAfter}* on the leaderboard!\n\n` +
            `📈 *Current Rank:* #${rankAfter}\n` +
            `🎯 Keep watching ads to hold your spot!\n\n` +
            `Stay on top and secure your prize! 🔥`
          ).catch(e => console.error('[rankup bot notify]', e.message));
        }

        return res.json({
          ok:        true,
          reward:    actualReward,
          partial:   isPartialWatch,
          rankUp,
          newRank:   rankAfter,
          rankDelta: rankUp ? rankBefore - rankAfter : 0
        });
      }

      // ══════════════════════════════════════════════════════════════════
      // 🎮 gameRoundStart — ينشئ جلسة جولة على السيرفر ويعيد UUID معتم
      //    العميل لا يرسل أي نقاط — السيرفر يحدد المكافأة داخلياً
      // ══════════════════════════════════════════════════════════════════
      case 'gameRoundStart': {
        // كولداون: يمنع إنشاء جلسات أسرع من مدة الجولة الفعلية
        const gRows = await sql(`SELECT last_game_round FROM users WHERE id = $1`, [dbUser.id]);
        const lastRound = gRows[0]?.last_game_round;
        if (lastRound) {
          const secSince = (Date.now() - new Date(lastRound).getTime()) / 1000;
          if (secSince < CFG.GAME_ROUND_DURATION_SEC - 5) {
            return res.status(429).json({ ok: false, error: 'Please wait', waitSec: Math.ceil(CFG.GAME_ROUND_DURATION_SEC - 5 - secSince) });
          }
        }
        // تنظيف جلسات قديمة غير مُستخدَمة لهذا المستخدم
        await sql(`DELETE FROM game_sessions WHERE user_id = $1 AND used = FALSE AND created_at < NOW() - INTERVAL '6 minutes'`, [dbUser.id]);
        // إنشاء seed + تسلسل عناصر محدد مسبقاً (السيرفر يعرف كل عنصر سيظهر)
        const seed     = (Math.random() * 2 ** 31) >>> 0;
        const sequence = generateGameSequence(seed);
        const sRows    = await sql(
          `INSERT INTO game_sessions (user_id, seed, sequence_json) VALUES ($1, $2, $3) RETURNING id`,
          [dbUser.id, seed, JSON.stringify(sequence)]
        );
        // _t = token معتم، seed للـ PRNG على العميل — لا يوجد "sessionId" في الـ JSON
        return res.json({ ok: true, _t: sRows[0].id, seed });
      }

      // ══════════════════════════════════════════════════════════════════
      // 🎮 gameAdVerify — يتحقق من تأكيد Adsgram S2S ويُفعّل المضاعفة
      //    على الجلسة داخلياً بدون إرسال أي قيمة من العميل
      // ══════════════════════════════════════════════════════════════════
      case 'gameAdVerify': {
        const { _t: gAvSid } = data;
        if (!gAvSid) return res.status(400).json({ ok: false, error: 'Missing token' });

        const gAvRows = await sql(
          `SELECT id, user_id, used, double_approved FROM game_sessions WHERE id = $1`,
          [gAvSid]
        );
        if (!gAvRows.length || gAvRows[0].user_id !== dbUser.id)
          return res.status(403).json({ ok: false, error: 'Invalid token' });
        if (gAvRows[0].used)
          return res.status(400).json({ ok: false, error: 'Session already used' });
        if (gAvRows[0].double_approved)
          return res.status(400).json({ ok: false, error: 'Double already applied' });

        // 🛡️ تأكيد Adsgram S2S — نفس آلية الإعلانات الرئيسية
        if (process.env.ADSGRAM_REWARD_SECRET) {
          const confirmed = await consumeAdsgramConfirmation(dbUser.telegram_id);
          if (!confirmed) {
            return res.status(202).json({ ok: false, error: 'pending_confirmation', retryAfterMs: 1500 });
          }
        }

        await sql(`UPDATE game_sessions SET double_approved = TRUE WHERE id = $1`, [gAvSid]);

        // 📊 تتبّع عدد فقط — جدول مستقل خاص بإعلانات مضاعفة اللعبة، لا علاقة له
        // بـ daily_ads ولا بحد AD_DAILY_MAX إطلاقاً (لا يُقرأ ولا يُكتب هنا)
        await bumpGameDoubleAdStat();

        return res.json({ ok: true });
      }

      // ══════════════════════════════════════════════════════════════════
      // 🎮 gameRoundEnd — يستهلك الجلسة ويمنح مكافأة ثابتة من السيرفر
      //    لا يقبل أي نقاط أو score من العميل
      // ══════════════════════════════════════════════════════════════════
      case 'gameRoundEnd': {
        // c = caught indices (مؤشرات العناصر التي صادها اللاعب)
        // n = totalSpawned  (كم عنصر ظهر فعلاً في هذه الجولة)
        // _t = token معتم (يُستخدم داخلياً فقط — لا يُعرض في UI)
        const { _t: gReSid, c: rawCaught, n: totalSpawned } = data;
        if (!gReSid) return res.status(400).json({ ok: false, error: 'Missing token' });

        const gReRows = await sql(
          `SELECT id, user_id, used, double_approved, created_at, sequence_json FROM game_sessions WHERE id = $1`,
          [gReSid]
        );
        if (!gReRows.length || gReRows[0].user_id !== dbUser.id) {
          await addRisk(dbUser.id, 40, 'game_invalid_token');
          return res.status(403).json({ ok: false, error: 'Invalid token' });
        }
        const gs = gReRows[0];
        if (gs.used) {
          await addRisk(dbUser.id, 30, 'game_replay');
          return res.status(400).json({ ok: false, error: 'Session already used' });
        }

        // 🛡️ تحقق من التوقيت
        const elapsed = (Date.now() - new Date(gs.created_at).getTime()) / 1000;
        if (elapsed < CFG.GAME_ROUND_DURATION_SEC - 5) {
          await addRisk(dbUser.id, 60, `game_too_fast_${Math.round(elapsed)}s`);
          return res.status(400).json({ ok: false, error: 'Round not complete' });
        }
        if (elapsed > CFG.GAME_ROUND_SESSION_TTL_SEC) {
          await sql(`UPDATE game_sessions SET used = TRUE WHERE id = $1`, [gReSid]);
          return res.status(400).json({ ok: false, error: 'Session expired' });
        }

        // 🛡️ تحقق من بيانات الصيد
        const sequence    = gs.sequence_json ? JSON.parse(gs.sequence_json) : null;
        const spawnedCount = Math.min(Math.max(0, parseInt(totalSpawned) || 0), _GAME_SEQ_LEN);
        const caughtIds   = Array.isArray(rawCaught) ? rawCaught : [];

        // 🛡️ التحقق من سجل موقع السلة (bLog)
        // العميل يرسل مصفوفة x مُعيَّر (0-1) كل 500ms طوال الجولة
        const rawBLog = data.bLog;
        const bLog = Array.isArray(rawBLog)
          ? rawBLog.filter(v => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1).slice(0, 200)
          : [];

        if (bLog.length < 8) {
          // سجل مفقود أو شحيح جداً — شك في التلاعب عبر API مباشرة
          await addRisk(dbUser.id, 30, `game_missing_basket_log_n${bLog.length}`);
        } else {
          // تحقق من حركة السلة: سلة ثابتة = بوت
          const mean   = bLog.reduce((a, b) => a + b, 0) / bLog.length;
          const stdDev = Math.sqrt(bLog.reduce((a, x) => a + (x - mean) ** 2, 0) / bLog.length);
          if (stdDev < 0.02) {
            await addRisk(dbUser.id, 55, `game_static_basket_std${stdDev.toFixed(4)}`);
          }
        }

        let score = 0;
        let dollarCount = 0;
        if (sequence) {
          const seen = new Set();
          for (const idx of caughtIds) {
            const i = parseInt(idx);
            if (!Number.isInteger(i) || i < 0 || i >= spawnedCount || seen.has(i)) continue;
            seen.add(i);
            const entry = sequence[i];
            score += (typeof entry === 'object' ? entry?.val : entry) ?? 0;
            if (entry && typeof entry === 'object' && entry.d) dollarCount++;
          }
          score = Math.max(0, score);
          dollarCount = Math.min(dollarCount, GAME_USDT);

          // 🛡️ نسبة صيد مشبوهة (> 95% من كل العناصر)
          if (spawnedCount > 10 && seen.size / spawnedCount > 0.95) {
            await addRisk(dbUser.id, 25, `game_catch_rate_${Math.round(seen.size / spawnedCount * 100)}pct`);
          }

          // 🛡️ تحقق مكاني: تذكرة في منطقة بعيدة يجب أن يكون السلة قريبة منها
          if (bLog.length >= 8) {
            for (const idx of seen) {
              const entry = sequence[idx];
              if (!entry || typeof entry !== 'object' || entry.val <= 0) continue;
              const itemX = entry.x; // 0-1 normalized
              // منطقة حافة (< 18% أو > 82% من عرض الشاشة)
              if (itemX < 0.18 || itemX > 0.82) {
                const basketReached = bLog.some(bx => Math.abs(bx - itemX) < 0.20);
                if (!basketReached) {
                  await addRisk(dbUser.id, 50, `game_impossible_catch_x${itemX.toFixed(2)}_idx${idx}`);
                  break; // نقطة واحدة تكفي للتنبيه
                }
              }
            }
          }
        } else {
          // جلسة قديمة بدون sequence — مكافأة ثابتة fallback
          score = CFG.GAME_ROUND_TICKETS;
        }

        // استهلاك الجلسة atomic
        const consumed = await sql(
          `UPDATE game_sessions SET used = TRUE WHERE id = $1 AND used = FALSE RETURNING id`,
          [gReSid]
        );
        if (!consumed.length) return res.status(400).json({ ok: false, error: 'Session already used' });

        const doubled     = gs.double_approved;
        const awarded     = doubled ? score * 2 : score;
        const usdAwarded  = +((doubled ? dollarCount * 2 : dollarCount) * GAME_DOLLAR_VALUE).toFixed(6); // 🎮 USDT من عملات الدولار (تُضاعَف كالتذاكر)

        await sql(`UPDATE users SET last_game_round = NOW() WHERE id = $1`, [dbUser.id]);

        // 🛡️ Shadow ban
        if (dbUser.shadow_banned) return res.json({ ok: true, awarded, doubled, usdAwarded });

        await sql(`UPDATE users SET pts = pts + $1, balance_usd = balance_usd + $2 WHERE id = $3`, [awarded, usdAwarded, dbUser.id]);
        await sql(`INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'game_round', $2)`,
          [dbUser.id, JSON.stringify({ score, awarded, doubled, usdAwarded, dollarCount, spawned: spawnedCount, caught: caughtIds.length })]);

        // 🎁 فحص تفعيل الإحالة — await لضمان إرسال الإشعار قبل انتهاء الدالة
        await checkReferralActivation(dbUser.id);

        return res.json({ ok: true, awarded, doubled, usdAwarded });
      }

      case 'withdraw': {
        const { address, memo, amount, fee } = data;
        if (!address?.trim()) return res.status(400).json({ ok: false, error: 'Wallet address required' });
        const amt    = parseFloat(amount);           // الإجمالي — يُخصم من رصيد المستخدم
        const feeAmt = parseFloat(fee) || 0;          // رسوم المنصة
        const netAmt = Math.max(0, Math.round((amt - feeAmt) * 100) / 100); // الصافي — يُسجَّل كمبلغ السحب المستحق فعلياً
        if (isNaN(amt) || amt < APP_CFG.WITHDRAW_MIN) return res.status(400).json({ ok: false, error: `Minimum withdrawal is $${APP_CFG.WITHDRAW_MIN.toFixed(2)}` });
        if (parseFloat(dbUser.balance_usd) < amt) return res.status(400).json({ ok: false, error: 'Insufficient balance' });

        // 📢 اشتراك إجباري بالقناة قبل أي سحب — تحقق فوري عبر Telegram Bot API
        const isMember = await isChannelMember(dbUser.telegram_id);
        if (!isMember) {
          return res.status(403).json({ ok: false, error: 'channel_required', channel: CHANNEL_USERNAME });
        }

        // 🛡️ Shadow ban — رد ناجح وهمي بدون خصم رصيد فعلي أو تسجيل سحب حقيقي
        if (dbUser.shadow_banned) {
          return res.json({ ok: true });
        }

        const feeMemo  = feeAmt > 0 ? `Fee: $${feeAmt.toFixed(3).replace(/0$/, '')} (gross $${amt.toFixed(2)})` : null;
        const fullMemo = [memo?.trim(), feeMemo].filter(Boolean).join(' | ') || null;

        await sql('UPDATE users SET balance_usd = balance_usd - $1 WHERE id = $2', [amt, dbUser.id]);
        await sql('INSERT INTO withdrawals (user_id, address, memo, amount) VALUES ($1,$2,$3,$4)',
          [dbUser.id, address.trim(), fullMemo, netAmt]);

        // ✅ إشعار بوت مباشر من الباكند
        sendTelegramMessage(
          Number(dbUser.telegram_id),
          `✅ *Withdrawal Request Submitted*\n\n` +
          `Your request has been received and is being processed.\n\n` +
          `💎 *Amount:* $${netAmt.toFixed(2)} USDT\n` +
          `👛 *Wallet:* \`${address.trim()}\`\n\n` +
          `🕒 *Processing...* We'll notify you once it's confirmed.`
        ).catch(e => console.error('[withdraw bot notify]', e.message));

        return res.json({ ok: true });
      }

      // 📢 فحص عضوية القناة فقط — يُستخدم من زر "I Joined - Verify" بعد السحب المرفوض
      case 'checkChannel': {
        const isMember = await isChannelMember(dbUser.telegram_id);
        return res.json({ ok: isMember, channel: CHANNEL_USERNAME });
      }

      // 💎 depositInit — يحجز صف "pending" قبل ما نرسل المستخدم يوقّع بمحفظته
      case 'depositInit': {
        const { packageId, walletAddress } = data;
        const pkg = APP_CFG.TICKET_PACKAGES.find(p => p.id === packageId);
        if (!pkg) return res.status(400).json({ ok: false, error: 'Invalid package' });
        if (!walletAddress?.trim()) return res.status(400).json({ ok: false, error: 'Wallet not connected' });
        if (!TREASURY_WALLET_ADDRESS) return res.status(500).json({ ok: false, error: 'Deposits are temporarily unavailable' });

        if (dbUser.shadow_banned) {
          // 🛡️ نفس منطق الـ shadow ban بالسحب — نرجّع depositId وهمي بدون تسجيل حقيقي
          return res.json({ ok: true, depositId: 0 });
        }

        const rows = await sql(
          `INSERT INTO deposits (user_id, package_id, tickets, ton_amount, wallet_address, status)
           VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
          [dbUser.id, pkg.id, pkg.tickets, pkg.ton, walletAddress.trim()]
        );

        return res.json({ ok: true, depositId: rows[0].id, treasury: TREASURY_WALLET_ADDRESS });
      }

      // 💎 depositStatus — يتحقق فعلياً من TonCenter قبل ما يسلّم أي تذكرة
      case 'depositStatus': {
        const depositId = parseInt(data.depositId, 10);
        if (!depositId) return res.json({ ok: true, status: 'pending' });

        const rows = await sql(
          `SELECT * FROM deposits WHERE id = $1 AND user_id = $2`,
          [depositId, dbUser.id]
        );
        const dep = rows[0];
        if (!dep) return res.status(404).json({ ok: false, error: 'Deposit not found' });

        if (dep.status !== 'pending') {
          return res.json({ ok: true, status: dep.status });
        }

        // ⏱️ بعد 15 دقيقة بدون العثور على المعاملة → فشل نهائي
        const ageMs = Date.now() - new Date(dep.created_at).getTime();
        if (ageMs > 15 * 60 * 1000) {
          await sql(`UPDATE deposits SET status = 'failed' WHERE id = $1`, [dep.id]);
          return res.json({ ok: true, status: 'failed' });
        }

        try {
          const nanotons = Math.round(parseFloat(dep.ton_amount) * 1e9);
          const found = await findConfirmingTonTransaction({
            treasury:  TREASURY_WALLET_ADDRESS,
            senderRaw: dep.wallet_address,
            nanotons,
            memo:      dbUser.telegram_id,
            sinceMs:   new Date(dep.created_at).getTime(),
            depositId: dep.id
          });

          if (!found) return res.json({ ok: true, status: 'pending' });

          // ✅ المعاملة موجودة فعلياً على السلسلة — نحاول نحجزها ذرياً لهذا الصف فقط
          const txHashHex = found.hash ? Buffer.from(found.hash, 'base64').toString('hex') : null;
          const finalHash = txHashHex || found.hash;

          let claimed;
          try {
            claimed = await sql(
              `UPDATE deposits SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW()
               WHERE id = $2 AND status = 'pending' RETURNING id`,
              [finalHash, dep.id]
            );
          } catch (e) {
            // 🛡️ 23505 = unique_violation → نفس tx_hash اتاستخدم بالفعل لتأكيد صف تاني
            // (محاولة تلاعب عبر عدة depositInit لنفس الدفعة، أو سباق race بين طلبين)
            if (e?.code === '23505' || /duplicate key/i.test(String(e?.message))) {
              await sql(`UPDATE deposits SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [dep.id]);
              console.error(`[deposit#${dep.id}] BLOCKED — tx already claimed by another deposit row`);
              return res.json({ ok: true, status: 'failed', error: 'This transaction was already used for another deposit' });
            }
            throw e;
          }

          if (!claimed || !claimed.length) {
            // سباق: طلب متزامن آخر لنفس الصف أكّده أول منا — منرجعش نضيف نقاط تاني
            return res.json({ ok: true, status: 'confirmed' });
          }

          // ✅ نجحنا فعلاً في حجز هذه المعاملة لهذا الصف فقط — الآن فقط نسلّم التذاكر
          await sql(`UPDATE users SET pts = pts + $1 WHERE id = $2`, [dep.tickets, dbUser.id]);

          const explorerLine = txHashHex
            ? `🔗 *TX:* [tonviewer.com/transaction/${txHashHex.slice(0, 10)}…](https://tonviewer.com/transaction/${txHashHex})\n\n`
            : '';

          sendTelegramMessage(
            Number(dbUser.telegram_id),
            `💎 *Deposit Confirmed!*\n\n` +
            `✅ *${dep.tickets.toLocaleString()} Tickets* added to your balance\n` +
            `💰 *Amount:* ${parseFloat(dep.ton_amount)} TON\n` +
            explorerLine +
            `Good luck in the competition! 🏆`
          ).catch(e => console.error('[deposit bot notify]', e.message));

          return res.json({ ok: true, status: 'confirmed', txHash: txHashHex });
        } catch (e) {
          console.error('[depositStatus] TonCenter check failed:', e.message);
          return res.json({ ok: true, status: 'pending' }); // نحاول تاني بالبوّلينغ الجاي
        }
      }

      case 'banUser': {
        // 🛡️ أدمن فقط — محمي بـ INTERNAL_SECRET
        const providedSecret = req.headers['x-internal-secret'] || data.secret || '';
        if (!INTERNAL_SECRET || providedSecret !== INTERNAL_SECRET) {
          return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const targetId = data.telegram_id;
        const unban    = data.unban === true;
        if (!targetId) return res.status(400).json({ ok: false, error: 'telegram_id required' });
        const rows = await sql(
          `UPDATE users SET banned = $1 WHERE telegram_id = $2 RETURNING id, telegram_id`,
          [!unban, targetId]
        );
        if (rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
        console.log(`[ban] telegram_id=${targetId} banned=${!unban}`);
        return res.json({ ok: true, banned: !unban });
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

      case 'logSecEvent': {
        const event  = String(data.event  || 'unknown').slice(0, 64);
        const detail = data.detail ? JSON.stringify(data.detail).slice(0, 256) : null;
        await sql(
          `INSERT INTO activity_logs (user_id, action, meta) VALUES ($1, 'sec_event', $2)`,
          [dbUser.id, JSON.stringify({ event, detail })]
        );
        console.warn(`[sec_event] user=${dbUser.id} event=${event}`);
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
