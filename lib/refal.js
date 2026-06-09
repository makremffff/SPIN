'use strict';

/**
 * refal.js — نظام الإحالات
 * ─────────────────────────
 * المنطق الكامل للإحالات في ملف واحد منفصل.
 *
 * الدورة:
 *  1. مستخدم جديد يفتح التطبيق عبر رابط ref_XXXXX
 *     → registerReferral()  يسجّل الإحالة (activated=FALSE)
 *     → إشعار للمحيل: "انضم صديقك"
 *
 *  2. المستخدم المُحال يشاهد أول إعلان
 *     → activateReferral()  تُفعَّل الإحالة، يُضاف USDT للمحيل
 *     → إشعار للمحيل: "أصبح صديقك نشطاً"
 *
 *  3. كل إعلان يشاهده المُحال بعد التفعيل
 *     → giveAdCommission()  5% عمولة للمحيل
 *
 *  4. جلب قائمة الإحالات للعرض في الواجهة
 *     → getReferrals()
 */

const { CONFIG, CFG, BOT_TOKEN } = require('./lib/config');
const { sql }                    = require('./lib/db');
const { writeAudit }             = require('./lib/security');
const { computeLevel }           = require('./lib/utils');

// ── helpers ──────────────────────────────────────────────────────────────────

async function _bot(tgId, text) {
  if (!BOT_TOKEN || !tgId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: tgId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.warn('[REFAL] bot send failed:', e.message);
  }
}

async function _syncLevel(userId) {
  try {
    const r = (await sql(`SELECT points, xp FROM users WHERE id=$1`, [userId]))[0];
    if (!r) return;
    const lvl = computeLevel(parseInt(r.xp) || 0);
    await sql(`UPDATE users SET level=$1 WHERE id=$2`, [lvl, userId]);
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. REGISTER — عند أول فتح عبر رابط الإحالة
// ─────────────────────────────────────────────────────────────────────────────

/**
 * registerReferral(referredUserId, referrerTgId, newUserName)
 *
 * يُستدعى من handleCreateSession عندما يوجد start_param=ref_XXXXX
 * لا يُعطي مكافأة هنا — فقط يسجّل الإحالة وينتظر التفعيل.
 *
 * @param {number} referredUserId  - DB id للمستخدم الجديد
 * @param {number} referrerTgId   - tg_id للمحيل (من الرابط)
 * @param {number} referredTgId   - tg_id للمستخدم الجديد (لمنع self-referral)
 * @param {string} newUserName    - اسم المستخدم الجديد للإشعار
 */
async function registerReferral(referredUserId, referrerTgId, referredTgId, newUserName) {
  // منع الإحالة الذاتية
  if (referrerTgId === referredTgId) {
    console.info(`[REFAL] self-referral blocked tg_id=${referredTgId}`);
    return;
  }

  // جلب DB id للمحيل
  const rr = await sql(`SELECT id, tg_id FROM users WHERE tg_id=$1`, [referrerTgId]);
  if (!rr.length) return;
  const referrer = rr[0];

  // منع التسجيل المكرر
  const existing = await sql(
    `SELECT id FROM referrals WHERE referred_id=$1`,
    [referredUserId]
  );
  if (existing.length) return;

  // تسجيل الإحالة
  await sql(
    `INSERT INTO referrals(referrer_id, referred_id, points_given, activated)
     VALUES($1,$2,0,FALSE)
     ON CONFLICT(referred_id) DO NOTHING`,
    [referrer.id, referredUserId]
  );
  await sql(
    `UPDATE users SET referrer_id=$1 WHERE id=$2 AND referrer_id IS NULL`,
    [referrer.id, referredUserId]
  );

  console.info(`[REFAL] registered referrer=${referrer.id} referred=${referredUserId}`);

  // إشعار المحيل
  const name = newUserName || 'مستخدم جديد';
  await _bot(
    referrer.tg_id,
    `🎉 انضم <b>${name}</b> عبر رابط دعوتك!\n\n` +
    `💡 سيُضاف رصيدك فور مشاهدته أول إعلان.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ACTIVATE — عند مشاهدة أول إعلان
// ─────────────────────────────────────────────────────────────────────────────

/**
 * activateReferral(referredUserId)
 *
 * يُستدعى من handleWatchAd / handleAdsgramCallback بعد منح المكافأة.
 * آمن للاستدعاء أكثر من مرة — يتجاهل إذا كانت مفعّلة مسبقاً.
 *
 * @param {number} referredUserId - DB id للمستخدم الذي شاهد الإعلان
 */
async function activateReferral(referredUserId) {
  // جلب الإحالة المعلّقة
  const pending = (await sql(
    `SELECT id, referrer_id FROM referrals
     WHERE referred_id=$1 AND activated=FALSE
     LIMIT 1`,
    [referredUserId]
  ))[0];

  if (!pending) return; // لا توجد إحالة أو مفعّلة بالفعل

  // تفعيل atomic — يمنع التكرار
  const done = await sql(
    `UPDATE referrals
     SET activated=TRUE, activated_at=NOW(), points_given=$1
     WHERE id=$2 AND activated=FALSE
     RETURNING id`,
    [CONFIG.rewards.referral, pending.id]
  );
  if (!done.length) return; // سبق تفعيلها في طلب موازٍ

  const usdtReward = CONFIG.rewards.referral;

  // إضافة USDT للمحيل + رفع عداد الإحالات
  await sql(
    `UPDATE users
     SET usdt_balance=usdt_balance+$1,
         total_referrals=total_referrals+1,
         updated_at=NOW()
     WHERE id=$2`,
    [usdtReward, pending.referrer_id]
  );
  await _syncLevel(pending.referrer_id);

  // فحص مهمة "3 إحالات اليوم"
  const todayCnt = parseInt(
    (await sql(
      `SELECT COUNT(*) AS c FROM referrals
       WHERE referrer_id=$1 AND activated=TRUE AND DATE(activated_at)=CURRENT_DATE`,
      [pending.referrer_id]
    ))[0]?.c
  ) || 0;

  if (todayCnt >= 3) {
    await sql(
      `INSERT INTO user_tasks(user_id,task_type,completed,completed_at,task_date)
       VALUES($1,'daily_refs_3',TRUE,NOW(),CURRENT_DATE)
       ON CONFLICT(user_id,task_type,task_date) DO UPDATE SET completed=TRUE,completed_at=NOW()`,
      [pending.referrer_id]
    );
  }

  await writeAudit(pending.referrer_id, null, 'referral_activated', 'ok', null, null, {
    referred_id: referredUserId,
    usdt_reward: usdtReward,
  });
  console.info(`[REFAL] activated referrer=${pending.referrer_id} referred=${referredUserId} usdt=${usdtReward}`);

  // إشعار المحيل
  const referrer = (await sql(`SELECT tg_id FROM users WHERE id=$1`, [pending.referrer_id]))[0];
  if (referrer?.tg_id) {
    await _bot(
      referrer.tg_id,
      `✅ <b>إحالتك أصبحت نشطة!</b>\n\n` +
      `🎁 تم إضافة <b>${usdtReward} USDT</b> إلى رصيدك.\n\n` +
      `استمر بدعوة المزيد لتربح أكثر 💎`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. AD COMMISSION — 5% عمولة عند كل إعلان بعد التفعيل
// ─────────────────────────────────────────────────────────────────────────────

/**
 * giveAdCommission(referredUserId, adUsdtEarned)
 *
 * يُستدعى من handleWatchAd / handleAdsgramCallback بعد التفعيل.
 * يتجاهل بصمت إذا لم تكن الإحالة مفعّلة.
 *
 * @param {number} referredUserId  - DB id للمستخدم الذي شاهد الإعلان
 * @param {number} adUsdtEarned   - USDT التي ربحها المُحال من الإعلان
 */
async function giveAdCommission(referredUserId, adUsdtEarned) {
  try {
    const row = (await sql(
      `SELECT referrer_id FROM referrals
       WHERE referred_id=$1 AND activated=TRUE
       LIMIT 1`,
      [referredUserId]
    ))[0];
    if (!row) return;

    const commission = Math.max(0.000001, adUsdtEarned * 0.05);
    const referrerId = row.referrer_id;

    await sql(
      `UPDATE users
       SET usdt_balance=usdt_balance+$1,
           earned_from_refs=earned_from_refs+$1,
           updated_at=NOW()
       WHERE id=$2`,
      [commission, referrerId]
    );

    console.info(`[REFAL] commission referrer=${referrerId} referred=${referredUserId} usdt=${commission}`);
  } catch (e) {
    console.error('[REFAL] giveAdCommission error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET REFERRALS — لصفحة الإحالات في الواجهة
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getReferrals(userId)
 *
 * @param {number} userId - DB id للمستخدم
 * @returns {{ ok, total, activated, earned_usdt, pts_per_referral, tg_id, list }}
 */
async function getReferrals(userId) {
  const user = (await sql(
    `SELECT tg_id, earned_from_refs FROM users WHERE id=$1`,
    [userId]
  ))[0];
  if (!user) return { ok: false, error: 'user_not_found' };

  const list = await sql(
    `SELECT u.tg_first_name, u.tg_username, u.created_at, r.activated,
            up.photo_url
     FROM referrals r
     JOIN users u ON u.id=r.referred_id
     LEFT JOIN user_photos up ON up.user_id=r.referred_id
     WHERE r.referrer_id=$1
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [userId]
  );

  return {
    ok:               true,
    total:            list.length,
    activated:        list.filter(x => x.activated).length,
    earned_usdt:      parseFloat(user.earned_from_refs) || 0,
    pts_per_referral: CONFIG.rewards.referral,
    tg_id:            user.tg_id,
    list: list.map(x => ({
      name:      x.tg_first_name || x.tg_username || 'مستخدم',
      ts:        new Date(x.created_at).getTime(),
      activated: !!x.activated,
      photo_url: x.photo_url || null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { registerReferral, activateReferral, giveAdCommission, getReferrals };
