// ══════════════════════════════════════════════════════════════════════════════
//  api/adsgram-reward.js — Adsgram Reward URL (server-to-server postback)
// ══════════════════════════════════════════════════════════════════════════════
//  هذا الـ endpoint يُستدعى من سيرفرات Adsgram مباشرة (GET) بعد التأكد فعلياً
//  أن المستخدم شاهد الإعلان كاملاً — لا يمر أبداً من متصفح/جهاز المستخدم،
//  وبالتالي لا يمكن لأي مستخدم أو سكربت تزويره أو رؤيته.
//
//  اضبط في partner.adsgram.ai → Ad unit → Reward URL:
//    https://<your-domain>/api/adsgram-reward?secret=<ADSGRAM_REWARD_SECRET>&userid=[userId]
//
//  [userId] هو placeholder حرفي — Adsgram تستبدله بـ Telegram ID الخاص بالمستخدم.
//  ADSGRAM_REWARD_SECRET سرّ عشوائي طويل تضبطه في Vercel env vars وتستخدم نفس
//  القيمة في الرابط أعلاه — هو الحماية الوحيدة لأن Adsgram لا توقّع الطلب.
// ══════════════════════════════════════════════════════════════════════════════

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL          = process.env.DATABASE_URL;
const ADSGRAM_REWARD_SECRET = process.env.ADSGRAM_REWARD_SECRET;

const sql = neon(DATABASE_URL);

async function ensureTable() {
  await sql(`CREATE TABLE IF NOT EXISTS ad_reward_confirmations (
    id          SERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    consumed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await sql(`CREATE INDEX IF NOT EXISTS idx_arc_lookup ON ad_reward_confirmations (telegram_id, consumed, created_at)`);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  // 🛡️ السر داخل الرابط هو الحماية الوحيدة هنا — لازم يطابق ما تم ضبطه في Vercel env
  if (!ADSGRAM_REWARD_SECRET) {
    console.error('[adsgram-reward] ADSGRAM_REWARD_SECRET not set in env');
    return res.status(503).send('Not configured');
  }
  if (req.query.secret !== ADSGRAM_REWARD_SECRET) {
    return res.status(403).send('Forbidden');
  }

  // Adsgram تستبدل [userId] بـ Telegram ID رقمي
  const telegramId = parseInt(req.query.userid, 10);
  if (!req.query.userid || !Number.isFinite(telegramId) || telegramId <= 0) {
    return res.status(400).send('Bad userid');
  }

  try {
    await ensureTable();

    // تنظيف السجلات القديمة (احتياط فقط)
    await sql(`DELETE FROM ad_reward_confirmations WHERE created_at < NOW() - INTERVAL '1 day'`);

    await sql(`INSERT INTO ad_reward_confirmations (telegram_id) VALUES ($1)`, [telegramId]);

    console.log(`[adsgram-reward] confirmed ad view for telegram_id=${telegramId}`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[adsgram-reward] error:', err.message);
    return res.status(500).send('Server error');
  }
};
