'use strict';

/**
 * GET /api/cron-remind
 * Vercel Cron Job — يُشغَّل كل ساعة
 * يرسل تذكيراً لكل المستخدمين النشطين (آخر 7 أيام) لفتح البوت واللعب.
 *
 * أضف في vercel.json:
 * {
 *   "crons": [{ "path": "/api/cron-remind", "schedule": "0 * * * *" }]
 * }
 */

const { sql, ensureBootstrap } = require('../lib/db');
const { BOT_TOKEN }            = require('../lib/config');

const CRON_SECRET = process.env.CRON_SECRET || '';

const MESSAGES = [
  '🎮 هل نسيتنا؟ ادخل الآن واكسب نقاطك اليومية! 💰',
  '⏰ وقت اللعب! شاهد إعلاناً واربح نقاطاً الآن 🚀',
  '💎 نقاطك في انتظارك! افتح البوت واجمع مكافآتك اليومية',
  '🎁 هدية يومية تنتظرك! لا تفوّت مكافأتك اليوم 🌟',
  '🔥 المتصدرون يلعبون الآن — لا تتأخر وابقَ في المنافسة!',
];

async function sendMessage(tgId, text) {
  if (!BOT_TOKEN || !tgId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgId, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  // حماية: فقط Vercel Cron أو من يعرف CRON_SECRET
  const authHeader = req.headers['authorization'] || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    await ensureBootstrap();

    // جلب المستخدمين النشطين في آخر 7 أيام (لديهم tg_id)
    const users = await sql(`
      SELECT tg_id FROM users
      WHERE tg_id IS NOT NULL
        AND is_banned = FALSE
        AND updated_at >= NOW() - INTERVAL '7 days'
      LIMIT 5000
    `);

    if (!users.length) return res.status(200).json({ sent: 0 });

    // اختيار رسالة عشوائية
    const text = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

    // إرسال بشكل تسلسلي مع تأخير بسيط لتجنب flood
    let sent = 0;
    for (const u of users) {
      await sendMessage(u.tg_id, text);
      sent++;
      // تأخير 50ms بين كل رسالة (تيليجرام يسمح ~30 رسالة/ثانية للـ bots)
      await new Promise(r => setTimeout(r, 50));
    }

    console.info(`[CRON-REMIND] Sent ${sent} reminders`);
    return res.status(200).json({ ok: true, sent });

  } catch (e) {
    console.error('[CRON-REMIND] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
